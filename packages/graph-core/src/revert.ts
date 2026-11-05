// Отмена своего действия (DESIGN.md, «Undo»). Записи из Changes возвращаются к состоянию «до»,
// кроме того, что с тех пор изменили другие. По сути это трёхстороннее слияние: база — граф
// после вашего действия, ваша сторона — «до», другая — текущий граф. Где другой уже поменял
// поле, остаётся его значение, а поле попадает в список пропущенного (подсказка в интерфейсе).

import { settle, sourceKey } from './consequences';
import type { Result } from './errors';
import type { NodeId, TaskId, UserId } from './ids';
import { checkEdge, checkGraph, cycleError } from './invariants';
import { getOwn, putAll, removeAll, valuesOf } from './records';
import type {
  ApplyContext,
  Changes,
  Graph,
  GraphEdge,
  GraphNode,
  RecordChange,
  Task,
  TaskWarning,
} from './types';
import { ownField, sameValue } from './values';

/** Что отмена не вернула. */
export type RevertSkip = {
  readonly record: 'node' | 'task' | 'edge';
  readonly id: string;
  /** Поле, которое не вернулось; null — запись целиком. */
  readonly field: string | null;
  /**
   * changed — с тех пор запись или поле изменил другой; deleted — запись уже удалена;
   * in_use — созданное вами не удалено: в нём или на нём уже чужое (задачи, ноды, стрелки);
   * unrestorable — удалённое вами не вернуть: нет блока, родителя или конца стрелки,
   * такая стрелка уже есть или получился бы цикл.
   */
  readonly reason: 'changed' | 'deleted' | 'in_use' | 'unrestorable';
  /** Кто последним менял запись — для подсказки «уже изменил {имя}». */
  readonly by: UserId | null;
};

export type Reverted = { readonly graph: Graph; readonly skipped: readonly RevertSkip[] };

/**
 * Отмена целиком: граф после отмены (с предупреждениями и пометками) и что не вернулось.
 * Предупреждения получают только задачи, изменённые после отменяемого действия: быстрая
 * отмена ошибки никого не дёргает. Права на статусы не проверяются — это возврат прежнего
 * состояния; если граф после отмены нарушил бы инвариант, отмена отклоняется целиком.
 */
export function planRevert(current: Graph, changes: Changes, ctx: ApplyContext): Result<Reverted> {
  const candidate = revertCandidate(current, changes, ctx);
  if (!candidate.ok || candidate.value.graph === current) return candidate;
  const graph = settle(current, candidate.value.graph, ctx, {
    keepDone: false,
    warnOnlyChangedAfter: changes.at,
  });
  return { ok: true, value: { graph, skipped: candidate.value.skipped } };
}

// ---- Черновик: изменения поверх текущих записей без мутаций ----

type Draft<K extends string, V extends { readonly id: K }> = {
  readonly get: (id: K) => V | undefined;
  readonly put: (value: V) => void;
  readonly remove: (id: K) => void;
  readonly unremove: (id: K) => void;
  readonly isRemoved: (id: K) => boolean;
  readonly values: () => V[];
  readonly toRecord: () => Readonly<Record<K, V>>;
};

function draftOf<K extends string, V extends { readonly id: K }>(
  base: Readonly<Record<K, V>>,
): Draft<K, V> {
  const puts = new Map<K, V>();
  const removed = new Set<K>();
  return {
    get: (id) => (removed.has(id) ? undefined : (puts.get(id) ?? getOwn(base, id))),
    put: (value) => {
      removed.delete(value.id);
      puts.set(value.id, value);
    },
    remove: (id) => {
      puts.delete(id);
      removed.add(id);
    },
    unremove: (id) => removed.delete(id),
    isRemoved: (id) => removed.has(id),
    values: () => [
      ...valuesOf(base).filter((value) => !removed.has(value.id) && !puts.has(value.id)),
      ...puts.values(),
    ],
    toRecord: () => removeAll(putAll(base, [...puts.values()]), removed),
  };
}

// ---- Слияние одной записи по полям ----

/** Поля, которые меняются сами вместе с правкой. Расхождение в них — не повод для подсказки. */
const AUTHORSHIP_FIELDS: ReadonlySet<string> = new Set(['updatedBy', 'updatedAt']);

/** Списки сливаются как множества: ваше добавление убирается, ваше удаление возвращается, чужое остаётся. */
const SET_FIELDS: Readonly<Record<string, (item: unknown) => string>> = {
  labelIds: String,
  assigneeIds: String,
  warnings: (item) => {
    const warning = item as TaskWarning;
    return `${sourceKey(warning.source)}@${warning.at}`;
  },
};

function mergeSet(
  before: readonly unknown[],
  after: readonly unknown[],
  current: readonly unknown[],
  keyOf: (item: unknown) => string,
): unknown[] {
  const beforeKeys = new Set(before.map(keyOf));
  const afterKeys = new Set(after.map(keyOf));
  const kept = current.filter((item) => {
    const key = keyOf(item);
    return !afterKeys.has(key) || beforeKeys.has(key);
  });
  const keptKeys = new Set(kept.map(keyOf));
  const returned = before.filter((item) => {
    const key = keyOf(item);
    return !afterKeys.has(key) && !keptKeys.has(key);
  });
  return [...kept, ...returned];
}

/**
 * Поле возвращается к «до», если сейчас в нём всё ещё ваше «после». Иначе остаётся текущее
 * значение, а поле попадает в conflicts. Списки — как множества (SET_FIELDS).
 */
function mergeRecord<V extends object>(
  before: V,
  after: V,
  current: V,
): { readonly record: V; readonly conflicts: readonly string[] } {
  const result: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  const conflicts: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = ownField(before, key);
    const became = ownField(after, key);
    if (sameValue(was, became)) continue;
    const now = ownField(current, key);
    let value: unknown;
    const keyOf = Object.hasOwn(SET_FIELDS, key) ? SET_FIELDS[key] : undefined;
    if (sameValue(now, became)) {
      value = was;
    } else if (keyOf && Array.isArray(was) && Array.isArray(became) && Array.isArray(now)) {
      value = mergeSet(was, became, now, keyOf);
    } else {
      if (!AUTHORSHIP_FIELDS.has(key)) conflicts.push(key);
      continue;
    }
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { record: result as V, conflicts };
}

// ---- Решение по каждой записи ----

type RecordKind = RevertSkip['record'];

function lastEditor(record: object | undefined): UserId | null {
  const by = record === undefined ? undefined : ownField(record, 'updatedBy');
  return typeof by === 'string' ? (by as UserId) : null;
}

/**
 * Созданное действием удаляется, если с тех пор не менялось; удалённое — запоминается для
 * восстановления; изменённое — сливается по полям.
 */
function revertRecords<K extends string, V extends { readonly id: K }>(
  record: RecordKind,
  list: readonly RecordChange<V>[],
  draft: Draft<K, V>,
  skipped: RevertSkip[],
): { readonly removed: K[]; readonly toRestore: V[] } {
  const removed: K[] = [];
  const toRestore: V[] = [];
  for (const { before, after } of list) {
    const id = (before ?? after)?.id;
    if (id === undefined) continue;
    const current = draft.get(id);
    if (before === null) {
      if (current === undefined) continue;
      if (sameValue(current, after)) {
        draft.remove(id);
        removed.push(id);
      } else {
        skipped.push({ record, id, field: null, reason: 'changed', by: lastEditor(current) });
      }
    } else if (after === null) {
      // Если запись уже вернули (например, из корзины), делать нечего.
      if (current === undefined) toRestore.push(before);
    } else if (current === undefined) {
      skipped.push({ record, id, field: null, reason: 'deleted', by: null });
    } else {
      const merged = mergeRecord(before, after, current);
      for (const field of merged.conflicts) {
        skipped.push({ record, id, field, reason: 'changed', by: lastEditor(current) });
      }
      if (!sameValue(merged.record, current)) draft.put(merged.record);
    }
  }
  return { removed, toRestore };
}

/** Не удаляем созданное вами, если на него уже ссылается чужое: задачи, ноды внутри, стрелки. */
function keepUsedRecords(
  nodes: Draft<NodeId, GraphNode>,
  tasks: Draft<TaskId, Task>,
  edges: Draft<GraphEdge['id'], GraphEdge>,
  removedNodes: readonly NodeId[],
  removedTasks: readonly TaskId[],
  skipped: RevertSkip[],
): void {
  for (;;) {
    const usedNodes = new Set<NodeId>();
    const usedTasks = new Set<TaskId>();
    for (const node of nodes.values()) if (node.parentId !== null) usedNodes.add(node.parentId);
    for (const task of tasks.values()) usedNodes.add(task.blockId);
    for (const edge of edges.values()) {
      usedNodes.add(edge.target.nodeId);
      if (edge.source.kind === 'node') usedNodes.add(edge.source.nodeId);
      else usedTasks.add(edge.source.taskId);
    }
    const keepNodes = removedNodes.filter((id) => nodes.isRemoved(id) && usedNodes.has(id));
    const keepTasks = removedTasks.filter((id) => tasks.isRemoved(id) && usedTasks.has(id));
    if (keepNodes.length === 0 && keepTasks.length === 0) return;
    for (const id of keepNodes) {
      nodes.unremove(id);
      skipped.push({ record: 'node', id, field: null, reason: 'in_use', by: null });
    }
    for (const id of keepTasks) {
      tasks.unremove(id);
      skipped.push({ record: 'task', id, field: null, reason: 'in_use', by: null });
    }
  }
}

/**
 * Граф после отмены без последствий (предупреждений и пометок) и что не вернулось.
 * Нужна отдельно для превью: что отмена снова заблокирует.
 */
export function revertCandidate(
  current: Graph,
  changes: Changes,
  ctx: ApplyContext,
): Result<Reverted> {
  if (ctx.actor.role === 'viewer') {
    return { ok: false, error: { code: 'FORBIDDEN', reason: 'viewer' } };
  }
  const skipped: RevertSkip[] = [];
  const nodes = draftOf(current.nodes);
  const tasks = draftOf(current.tasks);
  const edges = draftOf(current.edges);

  const nodePlan = revertRecords('node', changes.nodes, nodes, skipped);
  const taskPlan = revertRecords('task', changes.tasks, tasks, skipped);
  const edgePlan = revertRecords('edge', changes.edges, edges, skipped);
  keepUsedRecords(nodes, tasks, edges, nodePlan.removed, taskPlan.removed, skipped);

  // Восстановление удалённого: сначала роадмапы, потом ноды внутри них, потом задачи и стрелки.
  const unrestorable = (record: RecordKind, id: string) =>
    skipped.push({ record, id, field: null, reason: 'unrestorable', by: null });
  const nodesToRestore = [...nodePlan.toRestore].sort(
    (a, b) => Number(a.type !== 'roadmap') - Number(b.type !== 'roadmap'),
  );
  for (const node of nodesToRestore) {
    const parent = node.parentId === null ? null : nodes.get(node.parentId);
    const placed =
      node.parentId === null || (node.type !== 'roadmap' && parent?.type === 'roadmap');
    if (placed) nodes.put(node);
    else unrestorable('node', node.id);
  }
  for (const task of taskPlan.toRestore) {
    if (nodes.get(task.blockId)?.type === 'block') tasks.put(task);
    else unrestorable('task', task.id);
  }
  const graphNow = (): Graph => ({
    ...current,
    nodes: nodes.toRecord(),
    tasks: tasks.toRecord(),
    edges: edges.toRecord(),
  });
  for (const edge of edgePlan.toRestore) {
    const before = graphNow();
    const withEdge: Graph = { ...before, edges: putAll(before.edges, [edge]) };
    if (checkEdge(before, edge) === null && cycleError(withEdge) === null) edges.put(edge);
    else unrestorable('edge', edge.id);
  }

  const graph = graphNow();
  if (
    graph.nodes === current.nodes &&
    graph.tasks === current.tasks &&
    graph.edges === current.edges
  ) {
    return { ok: true, value: { graph: current, skipped } };
  }
  const broken = checkGraph(graph);
  if (broken) return { ok: false, error: broken };
  return { ok: true, value: { graph, skipped } };
}
