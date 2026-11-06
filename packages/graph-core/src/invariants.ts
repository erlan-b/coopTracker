// Инварианты графа (DESIGN.md, «Инварианты»): проверки для отдельных операций, для изменённого
// операцией и для графа целиком.

import { viewOf } from './draft';
import type { GraphDraft, Step } from './draft';
import type { GraphError } from './errors';
import type { EdgeId, NodeId, TaskId } from './ids';
import { dependencyOrder, edgeCycle, findCycle, hasCycle, isForward } from './structure';
import type { DependencyOrder } from './structure';
import { LIMITS } from './types';
import type { EdgeSource, Graph, GraphEdge, GraphNode, NodeType, Task } from './types';
import {
  checkCoordinates,
  checkNodeFields,
  checkOrder,
  checkTaskFields,
  invalidValue,
} from './validate';

/** parentId ведёт к роадмапе, а роадмапа стоит только на корневом уровне. */
export function checkPlacement(
  view: GraphDraft,
  node: { readonly id: NodeId; readonly type: NodeType; readonly parentId: NodeId | null },
): GraphError | null {
  if (node.parentId === null) return null;
  if (node.type === 'roadmap') return { code: 'NESTING_TOO_DEEP', id: node.id };
  return view.node(node.parentId)?.type === 'roadmap'
    ? null
    : { code: 'INVALID_PARENT', parentId: node.parentId };
}

/** Задачи лежат только в блоках. */
export function checkBlock(view: GraphDraft, id: NodeId): GraphError | null {
  const node = view.node(id);
  if (!node) return { code: 'NODE_NOT_FOUND', id };
  return node.type === 'block' ? null : { code: 'WRONG_NODE_TYPE', id, expected: 'block' };
}

function sameSource(a: EdgeSource, b: EdgeSource): boolean {
  return a.kind === 'node'
    ? b.kind === 'node' && a.nodeId === b.nodeId
    : b.kind === 'task' && a.taskId === b.taskId;
}

/** Концы стрелки существуют и это не петля (в том числе от задачи к её же блоку). */
function checkEndpoints(view: GraphDraft, edge: GraphEdge): GraphError | null {
  const { source, target } = edge;
  let fromNodeId: NodeId;
  if (source.kind === 'node') {
    if (!view.node(source.nodeId)) return { code: 'NODE_NOT_FOUND', id: source.nodeId };
    fromNodeId = source.nodeId;
  } else {
    const task = view.task(source.taskId);
    if (!task) return { code: 'TASK_NOT_FOUND', id: source.taskId };
    fromNodeId = task.blockId;
  }
  if (!view.node(target.nodeId)) return { code: 'NODE_NOT_FOUND', id: target.nodeId };
  return fromNodeId === target.nodeId ? { code: 'SELF_LOOP', edgeId: edge.id } : null;
}

/**
 * Другая стрелка с тем же началом и концом. Перебирается меньший из двух списков: стрелки от
 * того же начала или в тот же конец. Иначе на ноде с тысячами стрелок (у шапки и у её задач)
 * каждая проверка перебирала бы их все, и пакет или слияние стали бы квадратичными.
 */
function twinOf(view: GraphDraft, edge: GraphEdge): GraphEdge | undefined {
  const { source } = edge;
  const sameStart =
    source.kind === 'node' ? view.edgesOut(source.nodeId) : view.edgesFromTask(source.taskId);
  const sameEnd = view.edgesInto(edge.target.nodeId);
  for (const otherId of sameStart.size <= sameEnd.size ? sameStart : sameEnd) {
    if (otherId === edge.id) continue;
    const other = view.edge(otherId);
    if (other && sameSource(other.source, source) && other.target.nodeId === edge.target.nodeId) {
      return other;
    }
  }
  return undefined;
}

/** Новая стрелка: концы существуют, не петля и такой стрелки ещё нет. Циклы — edgeCycleError. */
export function checkEdge(view: GraphDraft, edge: GraphEdge): GraphError | null {
  const problem = checkEndpoints(view, edge);
  if (problem) return problem;
  const twin = twinOf(view, edge);
  return twin ? { code: 'DUPLICATE_EDGE', edgeId: twin.id } : null;
}

/**
 * Ставит стрелки, которые могут встать: концы есть, такой стрелки ещё нет, цикла не будет.
 * Возвращает те, что не встали. Обычно цикла нет вовсе, поэтому сначала ставятся все и граф
 * проверяется на циклы один раз. Если цикл есть — заново по одной, в порядке списка: стрелка
 * «вперёд» по порядку зависимостей встаёт без обхода, обход нужен только для стрелок «назад».
 */
export function putEdgesIfValid(draft: GraphDraft, edges: readonly GraphEdge[]): GraphEdge[] {
  const rejected = new Set<EdgeId>();
  const added: GraphEdge[] = [];
  for (const edge of edges) {
    if (checkEdge(draft, edge) === null) {
      draft.putEdge(edge);
      added.push(edge);
    } else {
      rejected.add(edge.id);
    }
  }
  if (added.length > 0 && hasCycle(draft)) {
    for (const edge of added) draft.removeEdge(edge.id);
    // Стрелка «вперёд» не ломает порядок и проверяется без обхода. После первой вставленной
    // стрелки «назад» порядок уже неверен — дальше каждую проверяет обход, как без порядка.
    let order: DependencyOrder | null = dependencyOrder(draft);
    for (const edge of added) {
      if (checkEdge(draft, edge) !== null) {
        rejected.add(edge.id);
      } else if (order && isForward(order, draft, edge)) {
        draft.putEdge(edge);
      } else if (edgeCycle(draft, edge) === null) {
        draft.putEdge(edge);
        order = null;
      } else {
        rejected.add(edge.id);
      }
    }
  }
  return edges.filter((edge) => rejected.has(edge.id));
}

/** Нода целиком: место в графе, координаты и поля. */
export const checkNode = (view: GraphDraft, node: GraphNode): GraphError | null =>
  checkPlacement(view, node) ?? checkCoordinates(node.x, node.y) ?? checkNodeFields(node);

/** Задача целиком: блок, порядок, поля и число предупреждений. */
export const checkTask = (view: GraphDraft, task: Task): GraphError | null =>
  checkBlock(view, task.blockId) ??
  checkOrder(task.order) ??
  checkTaskFields(task) ??
  (task.warnings.length > LIMITS.maxWarnings ? invalidValue('warnings', 'too_many') : null);

/**
 * Весь граф целиком: первое нарушение инвариантов или null. Для графа, собранного не
 * операциями: снимок из сети или файла, а позже слияние и импорт.
 */
export function checkGraph(graph: Graph): GraphError | null {
  const view = viewOf(graph);
  for (const node of graph.nodes.values()) {
    const problem = checkNode(view, node);
    if (problem) return problem;
  }
  for (const task of graph.tasks.values()) {
    const problem = checkTask(view, task);
    if (problem) return problem;
  }
  const checked = new Set<EdgeId>();
  for (const edge of graph.edges.values()) {
    const problem = checkEndpoints(view, edge);
    if (problem) return problem;
    const twin = twinOf(view, edge);
    if (twin && checked.has(twin.id)) return { code: 'DUPLICATE_EDGE', edgeId: twin.id };
    checked.add(edge.id);
  }
  return hasCycle(view) ? { code: 'CYCLE', path: findCycle(view) ?? [] } : null;
}

/**
 * Цикл или тупик где-либо в графе. Если структура зависимостей в копии не менялась, граф
 * остался без циклов и проверять нечего. Иначе — один проход, который заодно строит порядок
 * зависимостей для пересчёта выполненности.
 */
export function cycleError(view: GraphDraft): GraphError | null {
  if (!view.structureChanged) return null;
  return hasCycle(view) ? { code: 'CYCLE', path: findCycle(view) ?? [] } : null;
}

/** Шаг поменял структуру зависимостей: ноды, роадмапы, стрелки или блок задачи со стрелками. */
function structureChanged(view: GraphDraft, step: Step): boolean {
  if (step.edges.size > 0) return true;
  for (const [id, before] of step.nodes) {
    const after = view.node(id);
    if (!before || !after || before.type !== after.type || before.parentId !== after.parentId) {
      return true;
    }
  }
  for (const [id, before] of step.tasks) {
    if (view.edgesFromTask(id).size > 0 && before?.blockId !== view.task(id)?.blockId) return true;
  }
  return false;
}

/**
 * Инварианты для того, что изменил шаг, и всего, что на это ссылается. Если граф до шага был
 * корректен, результат тот же, что у checkGraph, но без перебора всего графа. Для операций,
 * которые меняют много записей сразу: отмена.
 */
export function checkStep(view: GraphDraft, step: Step): GraphError | null {
  const nodes = new Set<NodeId>();
  const tasks = new Set<TaskId>();
  const edges = new Set<EdgeId>();
  for (const id of step.nodes.keys()) {
    nodes.add(id);
    for (const childId of view.childrenOf(id)) nodes.add(childId);
    for (const taskId of view.tasksIn(id)) tasks.add(taskId);
    for (const edgeId of view.edgesInto(id)) edges.add(edgeId);
    for (const edgeId of view.edgesOut(id)) edges.add(edgeId);
  }
  for (const id of step.tasks.keys()) {
    tasks.add(id);
    for (const edgeId of view.edgesFromTask(id)) edges.add(edgeId);
  }
  for (const id of step.edges.keys()) edges.add(id);

  for (const id of nodes) {
    const node = view.node(id);
    const problem = node && checkNode(view, node);
    if (problem) return problem;
  }
  for (const id of tasks) {
    const task = view.task(id);
    const problem = task && checkTask(view, task);
    if (problem) return problem;
  }
  for (const id of edges) {
    const edge = view.edge(id);
    const problem = edge && checkEdge(view, edge);
    if (problem) return problem;
  }
  return structureChanged(view, step) ? cycleError(view) : null;
}
