// Заготовки для тестов graph-core. Из пакета не экспортируются.

import { applyOp } from './apply';
import type { GraphError, Result } from './errors';
import { asEdgeId, asNodeId, asTaskId, asUserId } from './ids';
import type { ApplyContext, EnviRole, Graph, GraphSettings, Op, TaskStatus } from './types';

export const NOW = '2026-11-05T10:00:00.000Z';
export const LATER = '2026-11-05T12:30:00.000Z';
export const EMPTY: Graph = { nodes: {}, tasks: {}, edges: {} };

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

/** Замораживает объект целиком: если graph-core попробует что-то изменить, тест упадёт. */
export function deepFreeze<V>(value: V): V {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** applyOp с замороженными графом и операцией. */
export function apply(graph: Graph, op: Op, context: ApplyContext = ctx()): Result<Graph> {
  return applyOp(deepFreeze(graph), deepFreeze(op), context);
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
