// Инварианты графа (DESIGN.md, «Инварианты»): проверки для отдельных операций и для графа целиком.

import type { GraphError } from './errors';
import type { NodeId } from './ids';
import { getOwn, valuesOf } from './records';
import { findCycle } from './structure';
import type { EdgeSource, Graph, GraphEdge, NodeType } from './types';
import { checkCoordinates, checkNodeFields, checkOrder, checkTaskFields } from './validate';

/** parentId ведёт к роадмапе, а роадмапа стоит только на корневом уровне. */
export function checkPlacement(
  nodes: Graph['nodes'],
  node: { readonly id: NodeId; readonly type: NodeType; readonly parentId: NodeId | null },
): GraphError | null {
  if (node.parentId === null) return null;
  if (node.type === 'roadmap') return { code: 'NESTING_TOO_DEEP', id: node.id };
  return getOwn(nodes, node.parentId)?.type === 'roadmap'
    ? null
    : { code: 'INVALID_PARENT', parentId: node.parentId };
}

/** Задачи лежат только в блоках. */
export function checkBlock(graph: Graph, id: NodeId): GraphError | null {
  const node = getOwn(graph.nodes, id);
  if (!node) return { code: 'NODE_NOT_FOUND', id };
  return node.type === 'block' ? null : { code: 'WRONG_NODE_TYPE', id, expected: 'block' };
}

function sameSource(a: EdgeSource, b: EdgeSource): boolean {
  return a.kind === 'node'
    ? b.kind === 'node' && a.nodeId === b.nodeId
    : b.kind === 'task' && a.taskId === b.taskId;
}

/** Концы стрелки существуют и это не петля (в том числе от задачи к её же блоку). */
function checkEndpoints(graph: Graph, edge: GraphEdge): GraphError | null {
  const { source, target } = edge;
  let fromNodeId: NodeId;
  if (source.kind === 'node') {
    if (!Object.hasOwn(graph.nodes, source.nodeId)) {
      return { code: 'NODE_NOT_FOUND', id: source.nodeId };
    }
    fromNodeId = source.nodeId;
  } else {
    const task = getOwn(graph.tasks, source.taskId);
    if (!task) return { code: 'TASK_NOT_FOUND', id: source.taskId };
    fromNodeId = task.blockId;
  }
  if (!Object.hasOwn(graph.nodes, target.nodeId)) {
    return { code: 'NODE_NOT_FOUND', id: target.nodeId };
  }
  return fromNodeId === target.nodeId ? { code: 'SELF_LOOP', edgeId: edge.id } : null;
}

/** Новая стрелка: концы существуют, не петля и такой стрелки ещё нет. Циклы — отдельно. */
export function checkEdge(graph: Graph, edge: GraphEdge): GraphError | null {
  const problem = checkEndpoints(graph, edge);
  if (problem) return problem;
  const twin = valuesOf(graph.edges).find(
    (other) => sameSource(other.source, edge.source) && other.target.nodeId === edge.target.nodeId,
  );
  return twin ? { code: 'DUPLICATE_EDGE', edgeId: twin.id } : null;
}

export function cycleError(graph: Graph): GraphError | null {
  const path = findCycle(graph);
  return path ? { code: 'CYCLE', path } : null;
}

const edgeKey = (edge: GraphEdge): string =>
  `${edge.source.kind === 'node' ? `n:${edge.source.nodeId}` : `t:${edge.source.taskId}`}>${edge.target.nodeId}`;

/**
 * Весь граф целиком: первое нарушение инвариантов или null. Нужна там, где граф собирается не
 * одной операцией, а сразу из многих записей: отмена, а позже слияние и импорт.
 */
export function checkGraph(graph: Graph): GraphError | null {
  for (const node of valuesOf(graph.nodes)) {
    const problem =
      checkPlacement(graph.nodes, node) ??
      checkCoordinates(node.x, node.y) ??
      checkNodeFields(node);
    if (problem) return problem;
  }
  for (const task of valuesOf(graph.tasks)) {
    const problem =
      checkBlock(graph, task.blockId) ?? checkOrder(task.order) ?? checkTaskFields(task);
    if (problem) return problem;
  }
  const seen = new Map<string, GraphEdge>();
  for (const edge of valuesOf(graph.edges)) {
    const problem = checkEndpoints(graph, edge);
    if (problem) return problem;
    const twin = seen.get(edgeKey(edge));
    if (twin) return { code: 'DUPLICATE_EDGE', edgeId: twin.id };
    seen.set(edgeKey(edge), edge);
  }
  return cycleError(graph);
}
