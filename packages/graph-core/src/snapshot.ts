// Граф ↔ снимок для JSON. Внутри graph-core записи лежат в Map (types.ts, Graph); на границе —
// списками: WebSocket, экспорт, IndexedDB, БД.

import type { GraphError, Result } from './errors';
import { knownEdge, knownNode, knownTask } from './fields';
import { checkGraph } from './invariants';
import { LIMITS } from './types';
import type { Graph, GraphSnapshot } from './types';

export function toSnapshot(graph: Graph): GraphSnapshot {
  return {
    nodes: [...graph.nodes.values()],
    tasks: [...graph.tasks.values()],
    edges: [...graph.edges.values()],
  };
}

/** Записи по id, только известные поля; повторные id попадают в duplicates. */
function byId<V extends { readonly id: string }>(
  items: readonly V[],
  known: (item: V) => V,
  duplicates: string[],
): Map<V['id'], V> {
  const map = new Map<V['id'], V>();
  for (const item of items) {
    if (map.has(item.id)) duplicates.push(item.id);
    else map.set(item.id, known(item));
  }
  return map;
}

/** Размер графа в пределах LIMITS. */
function checkSize(snapshot: GraphSnapshot): GraphError | null {
  const limits = [
    ['nodes', LIMITS.maxNodes],
    ['tasks', LIMITS.maxTasks],
    ['edges', LIMITS.maxEdges],
  ] as const;
  for (const [records, limit] of limits) {
    if (snapshot[records].length > limit) return { code: 'LIMIT_EXCEEDED', records, limit };
  }
  return null;
}

/**
 * Граф из снимка с проверкой: размер в пределах LIMITS, id без повторов, только известные поля
 * и все инварианты (checkGraph). Форму данных (типы полей) проверяет схема на входе — до этой
 * функции.
 */
export function graphFromSnapshot(snapshot: GraphSnapshot): Result<Graph> {
  const tooBig = checkSize(snapshot);
  if (tooBig) return { ok: false, error: tooBig };
  const duplicates: string[] = [];
  const graph: Graph = {
    nodes: byId(snapshot.nodes, knownNode, duplicates),
    tasks: byId(snapshot.tasks, knownTask, duplicates),
    edges: byId(snapshot.edges, knownEdge, duplicates),
  };
  const [duplicate] = duplicates;
  if (duplicate !== undefined) return { ok: false, error: { code: 'DUPLICATE_ID', id: duplicate } };
  const problem = checkGraph(graph);
  return problem ? { ok: false, error: problem } : { ok: true, value: graph };
}
