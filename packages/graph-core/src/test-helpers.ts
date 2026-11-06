// Заготовки для тестов graph-core. Из пакета не экспортируются.

import { expect } from 'vitest';
import { applyOp, applyOps } from './apply';
import type { Applied } from './apply';
import { evaluate } from './doneness';
import { buildIndex, cachedDerived, viewOf } from './draft';
import { merge } from './merge';
import type { MergeOptions, Merged } from './merge';
import type { GraphError, Result } from './errors';
import { asEdgeId, asNodeId, asTaskId, asUserId } from './ids';
import { checkGraph } from './invariants';
import { dependencyOrder } from './structure';
import { LIMITS } from './types';
import type {
  ApplyContext,
  Changes,
  EnviRole,
  Graph,
  GraphSettings,
  Op,
  RecordChange,
  TaskStatus,
} from './types';

export const NOW = '2026-11-05T10:00:00.000Z';
export const LATER = '2026-11-05T12:30:00.000Z';
export const EMPTY: Graph = { nodes: new Map(), tasks: new Map(), edges: new Map() };

export const N = asNodeId;
export const T = asTaskId;
export const E = asEdgeId;

/** Контекст операции. По умолчанию — master в envi со свободными статусами. id участника = роль. */
export function ctx(
  role: EnviRole = 'master',
  settings: Partial<GraphSettings> = {},
  now: string = NOW,
): ApplyContext {
  return {
    actor: { id: asUserId(role), role },
    settings: { statusMode: 'free', reviewUnlocks: false, ...settings },
    now,
  };
}

const MUTATORS = ['set', 'add', 'delete', 'clear'];

/**
 * Замораживает объект целиком: если graph-core попробует что-то изменить, тест упадёт.
 * Object.freeze не мешает Map.set, поэтому у Map и Set методы записи заменяются на ошибку.
 */
export function deepFreeze<V>(value: V): V {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  if (value instanceof Map || value instanceof Set) {
    for (const method of MUTATORS) {
      Object.defineProperty(value, method, {
        value: () => {
          throw new TypeError('graph-core изменил Map или Set');
        },
      });
    }
    Object.freeze(value);
    for (const item of value.values()) deepFreeze(item);
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const settingsOfKey = (key: string): GraphSettings => {
  const [statusMode, reviewUnlocks] = key.split('/');
  return {
    statusMode: statusMode === 'review' ? 'review' : 'free',
    reviewUnlocks: reviewUnlocks === 'true',
  };
};

/**
 * Запомненное для графа (указатели, порядок, выполненность) совпадает с посчитанным заново.
 * Так каждый тест операции заодно проверяет пересчёт только изменённого.
 */
export function expectDerivedConsistent(graph: Graph): void {
  const derived = cachedDerived(graph);
  if (!derived) return;
  expect(derived.index).toEqual(buildIndex(graph));
  const view = viewOf(graph);
  const order = dependencyOrder(view);
  if (derived.order) expect(derived.order).toEqual(order);
  for (const [key, state] of derived.doneness) {
    const fresh = evaluate(view, settingsOfKey(key), order, null, 'all', false).state;
    expect(state).toEqual(fresh);
  }
}

// ---- Эталон изменений: написан отдельно от changes.ts и values.ts ----

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .map((key) => [key, canonical(record[key])]);
}

const equalValues = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function referenceDiff<V>(
  before: ReadonlyMap<string, V>,
  after: ReadonlyMap<string, V>,
): RecordChange<V>[] {
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const result: RecordChange<V>[] = [];
  for (const id of ids) {
    const was = before.get(id);
    const now = after.get(id);
    if (was !== undefined && now !== undefined && equalValues(was, now)) {
      // Запись с тем же значением должна остаться тем же объектом: иначе лишняя перерисовка.
      expect(now, `запись ${id} пересоздана без изменений`).toBe(was);
      continue;
    }
    result.push({ before: was ?? null, after: now ?? null });
  }
  return result;
}

export function referenceChanges(before: Graph, after: Graph, at: string): Changes {
  return {
    at,
    nodes: referenceDiff(before.nodes, after.nodes),
    tasks: referenceDiff(before.tasks, after.tasks),
    edges: referenceDiff(before.edges, after.edges),
  };
}

/** Запомненное для графа тоже замораживается: копия операции не должна писать в общие множества. */
function freezeDerived(graph: Graph): void {
  const derived = cachedDerived(graph);
  if (!derived) return;
  deepFreeze(derived.index);
  if (derived.order) deepFreeze(derived.order);
  for (const state of derived.doneness.values()) deepFreeze(state);
}

/**
 * applyOp с замороженными графом и операцией. После успеха проверяет: граф корректен целиком,
 * изменения совпадают с полным сравнением графов, запомненное совпадает с посчитанным заново.
 */
export function applyFull(graph: Graph, op: Op, context: ApplyContext = ctx()): Result<Applied> {
  return applyOpsFull(graph, [op], context);
}

/** applyOps с теми же проверками, что у applyFull. Одна операция идёт через applyOp. */
export function applyOpsFull(
  graph: Graph,
  ops: readonly Op[],
  context: ApplyContext = ctx(),
): Result<Applied> {
  deepFreeze(graph);
  freezeDerived(graph);
  deepFreeze(ops);
  const [single] = ops;
  const result =
    ops.length === 1 && single ? applyOp(graph, single, context) : applyOps(graph, ops, context);
  if (result.ok) {
    const after = result.value.graph;
    expect(checkGraph(after)).toBeNull();
    expect(result.value.changes).toEqual(referenceChanges(graph, after, context.now));
    if (result.value.changes.nodes.length + result.value.changes.tasks.length === 0) {
      if (result.value.changes.edges.length === 0) expect(after).toBe(graph);
    }
    expectDerivedConsistent(graph);
    expectDerivedConsistent(after);
  }
  return result;
}

export function apply(graph: Graph, op: Op, context: ApplyContext = ctx()): Result<Graph> {
  const result = applyFull(graph, op, context);
  return result.ok ? { ok: true, value: result.value.graph } : result;
}

export function applyOpsOk(graph: Graph, ops: readonly Op[], context: ApplyContext = ctx()): Graph {
  const result = applyOpsFull(graph, ops, context);
  if (!result.ok) throw new Error(`пакет отклонён: ${JSON.stringify(result.error)}`);
  return result.value.graph;
}

export function applyOk(graph: Graph, op: Op, context: ApplyContext = ctx()): Graph {
  const result = apply(graph, op, context);
  if (!result.ok) throw new Error(`${op.kind} отклонена: ${JSON.stringify(result.error)}`);
  return result.value;
}

export function errorOf(result: Result<Graph>): GraphError {
  if (result.ok) throw new Error('ожидалась ошибка, а операция прошла');
  return result.error;
}

/** Граф из операций. Строит master в режиме review, чтобы можно было задать любой статус. */
export function build(...ops: readonly Op[]): Graph {
  const context = ctx('master', { statusMode: 'review' });
  return ops.reduce<Graph>((graph, op) => applyOk(graph, op, context), EMPTY);
}

/** Граф из многих операций — пакетами по LIMITS.maxOpsPerBatch. Без проверок applyFull: для больших графов. */
export function buildLarge(
  ops: readonly Op[],
  context: ApplyContext = ctx('master', { statusMode: 'review' }),
): Graph {
  let graph = EMPTY;
  for (let i = 0; i < ops.length; i += LIMITS.maxOpsPerBatch) {
    const result = applyOps(graph, ops.slice(i, i + LIMITS.maxOpsPerBatch), context);
    if (!result.ok) throw new Error(`пакет отклонён: ${JSON.stringify(result.error)}`);
    graph = result.value.graph;
  }
  return graph;
}

/** Значение, которое точно есть: для доступа к записям графа в тестах. */
export function must<V>(value: V | undefined): V {
  if (value === undefined) throw new Error('значения нет');
  return value;
}

// ---- Операции ----

type NodeOptions = {
  readonly parent?: string;
  readonly title?: string;
  readonly x?: number;
  readonly y?: number;
};

function nodeBase(id: string, options: NodeOptions) {
  return {
    id: N(id),
    parentId: options.parent === undefined ? null : N(options.parent),
    title: options.title ?? id,
    description: '',
    x: options.x ?? 0,
    y: options.y ?? 0,
  };
}

export const block = (id: string, options: NodeOptions = {}): Op => ({
  kind: 'createNode',
  node: { ...nodeBase(id, options), type: 'block', deadline: null, labelIds: [] },
});

export const roadmap = (id: string, options: NodeOptions = {}): Op => ({
  kind: 'createNode',
  node: { ...nodeBase(id, options), type: 'roadmap', deadline: null, labelIds: [] },
});

export const milestone = (id: string, options: NodeOptions = {}): Op => ({
  kind: 'createNode',
  node: { ...nodeBase(id, options), type: 'milestone', deadline: null },
});

type TaskOptions = { readonly status?: TaskStatus; readonly order?: string };

export const task = (id: string, blockId: string, options: TaskOptions = {}): Op => ({
  kind: 'createTask',
  task: {
    id: T(id),
    blockId: N(blockId),
    order: options.order ?? 'a0',
    title: id,
    description: '',
    status: options.status ?? 'todo',
    assigneeIds: [],
    deadline: null,
    priority: 'none',
    labelIds: [],
    estimate: null,
  },
});

/** Стрелка от выхода ноды. */
export const edge = (id: string, from: string, to: string): Op => ({
  kind: 'createEdge',
  edge: {
    id: E(id),
    source: { kind: 'node', nodeId: N(from) },
    target: { kind: 'node', nodeId: N(to) },
  },
});

/** Стрелка от выхода задачи. */
export const taskEdge = (id: string, fromTask: string, to: string): Op => ({
  kind: 'createEdge',
  edge: {
    id: E(id),
    source: { kind: 'task', taskId: T(fromTask) },
    target: { kind: 'node', nodeId: N(to) },
  },
});

export const setStatus = (id: string, status: TaskStatus): Op => ({
  kind: 'updateTask',
  id: T(id),
  patch: { status },
});

// ---- Слияние ----

/**
 * merge с замороженными графами. Проверяет: результат корректен целиком, изменения совпадают
 * с полным сравнением целевого графа и результата (неизменённое — те же объекты), запомненное
 * для результата совпадает с посчитанным заново.
 */
export function mergeChecked(
  base: Graph,
  branch: Graph,
  target: Graph,
  context: ApplyContext,
  options: MergeOptions = {},
): Merged {
  for (const graph of [base, branch, target]) deepFreeze(graph);
  const result = merge(base, branch, target, context, options);
  if (!result.ok) throw new Error(`слияние отклонено: ${JSON.stringify(result.error)}`);
  const { graph, changes } = result.value;
  expect(checkGraph(graph)).toBeNull();
  expect(changes).toEqual(referenceChanges(target, graph, context.now));
  expectDerivedConsistent(graph);
  return result.value;
}
