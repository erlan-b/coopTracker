// Отмена своего действия (DESIGN.md, «Undo»). Записи из Changes возвращаются к состоянию «до»,
// кроме того, что с тех пор изменили другие. По сути это трёхстороннее слияние: база — граф
// после вашего действия, ваша сторона — «до», другая — текущий граф. Где другой уже поменял
// поле, остаётся его значение, а поле попадает в список пропущенного (подсказка в интерфейсе).

import { sourceKey } from './consequences';
import type { GraphDraft } from './draft';
import type { GraphError } from './errors';
import type { EdgeId, NodeId, TaskId, UserId } from './ids';
import { knownEdge, knownNode, knownTask } from './fields';
import { checkStep, putEdgesIfValid } from './invariants';
import { LIMITS } from './types';
import type { Changes, GraphEdge, GraphNode, RecordChange, Task, TaskWarning } from './types';
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

/** Слияние может вернуть больше предупреждений, чем допустимо: уходят самые старые по времени. */
function keepNewestWarnings(warnings: readonly TaskWarning[]): readonly TaskWarning[] {
  if (warnings.length <= LIMITS.maxWarnings) return warnings;
  const byTime = [...warnings].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return byTime.slice(-LIMITS.maxWarnings);
}

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
      if (key === 'warnings') value = keepNewestWarnings(value as TaskWarning[]);
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

/** Как читать и писать записи одного вида в рабочей копии. */
type Access<K extends string, V> = {
  readonly get: (id: K) => V | undefined;
  readonly put: (value: V) => void;
  readonly remove: (id: K) => void;
  /** Запись только из известных полей: Changes приходит от клиента. */
  readonly known: (value: V) => V;
};

/**
 * Созданное действием удаляется, если с тех пор не менялось; удалённое — запоминается для
 * восстановления; изменённое — сливается по полям.
 */
function revertRecords<K extends string, V extends { readonly id: K }>(
  record: RecordKind,
  list: readonly RecordChange<V>[],
  access: Access<K, V>,
  skipped: RevertSkip[],
): { readonly removed: V[]; readonly toRestore: V[] } {
  const removed: V[] = [];
  const toRestore: V[] = [];
  for (const { before, after } of list) {
    const id = (before ?? after)?.id;
    if (id === undefined) continue;
    const current = access.get(id);
    if (before === null) {
      if (current === undefined) continue;
      if (sameValue(current, after)) {
        access.remove(id);
        removed.push(current);
      } else {
        skipped.push({ record, id, field: null, reason: 'changed', by: lastEditor(current) });
      }
    } else if (after === null) {
      // Если запись уже вернули (например, из корзины), делать нечего.
      if (current === undefined) toRestore.push(access.known(before));
    } else if (current === undefined) {
      skipped.push({ record, id, field: null, reason: 'deleted', by: null });
    } else {
      const merged = mergeRecord(before, after, current);
      for (const field of merged.conflicts) {
        skipped.push({ record, id, field, reason: 'changed', by: lastEditor(current) });
      }
      const result = access.known(merged.record);
      if (!sameValue(result, current)) access.put(result);
    }
  }
  return { removed, toRestore };
}

/** Не удаляем созданное вами, если на него уже ссылается чужое: задачи, ноды внутри, стрелки. */
function keepUsedRecords(
  draft: GraphDraft,
  removedNodes: readonly GraphNode[],
  removedTasks: readonly Task[],
  skipped: RevertSkip[],
): void {
  const used = (id: NodeId): boolean =>
    draft.childrenOf(id).size > 0 ||
    draft.tasksIn(id).size > 0 ||
    draft.edgesInto(id).size > 0 ||
    draft.edgesOut(id).size > 0;
  for (;;) {
    const keepNodes = removedNodes.filter((node) => !draft.node(node.id) && used(node.id));
    const keepTasks = removedTasks.filter(
      (task) => !draft.task(task.id) && draft.edgesFromTask(task.id).size > 0,
    );
    if (keepNodes.length === 0 && keepTasks.length === 0) return;
    for (const node of keepNodes) {
      draft.putNode(node);
      skipped.push({ record: 'node', id: node.id, field: null, reason: 'in_use', by: null });
    }
    for (const task of keepTasks) {
      draft.putTask(task);
      skipped.push({ record: 'task', id: task.id, field: null, reason: 'in_use', by: null });
    }
  }
}

/**
 * Отмена в рабочей копии. Последствия (предупреждения и пометки) ставит settle после шага:
 * предупреждения получают только задачи, изменённые после отменяемого действия, — быстрая
 * отмена ошибки никого не дёргает. Права на статусы не проверяются — это возврат прежнего
 * состояния; если граф после отмены нарушил бы инвариант, отмена отклоняется целиком.
 */
export function revertInto(
  draft: GraphDraft,
  changes: Changes,
  skipped: RevertSkip[],
): GraphError | null {
  const nodePlan = revertRecords<NodeId, GraphNode>(
    'node',
    changes.nodes,
    {
      get: (id) => draft.node(id),
      put: (node) => draft.putNode(node),
      remove: (id) => draft.removeNode(id),
      known: knownNode,
    },
    skipped,
  );
  const taskPlan = revertRecords<TaskId, Task>(
    'task',
    changes.tasks,
    {
      get: (id) => draft.task(id),
      put: (task) => draft.putTask(task),
      remove: (id) => draft.removeTask(id),
      known: knownTask,
    },
    skipped,
  );
  const edgePlan = revertRecords<EdgeId, GraphEdge>(
    'edge',
    changes.edges,
    {
      get: (id) => draft.edge(id),
      put: (edge) => draft.putEdge(edge),
      remove: (id) => draft.removeEdge(id),
      known: knownEdge,
    },
    skipped,
  );
  keepUsedRecords(draft, nodePlan.removed, taskPlan.removed, skipped);

  // Восстановление удалённого: сначала роадмапы, потом ноды внутри них, потом задачи и стрелки.
  const unrestorable = (record: RecordKind, id: string) =>
    skipped.push({ record, id, field: null, reason: 'unrestorable', by: null });
  const nodesToRestore = [...nodePlan.toRestore].sort(
    (a, b) => Number(a.type !== 'roadmap') - Number(b.type !== 'roadmap'),
  );
  for (const node of nodesToRestore) {
    const parent = node.parentId === null ? undefined : draft.node(node.parentId);
    const placed =
      node.parentId === null || (node.type !== 'roadmap' && parent?.type === 'roadmap');
    if (placed) draft.putNode(node);
    else unrestorable('node', node.id);
  }
  for (const task of taskPlan.toRestore) {
    if (draft.node(task.blockId)?.type === 'block') draft.putTask(task);
    else unrestorable('task', task.id);
  }
  for (const edge of putEdgesIfValid(draft, edgePlan.toRestore)) unrestorable('edge', edge.id);

  return checkStep(draft, draft.peekStep());
}
