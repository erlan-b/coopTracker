// Структура зависимостей: циклы, порядок обхода и то, что идёт «после» задачи или ноды.

import { asNodeId } from './ids';
import type { NodeId, TaskId } from './ids';
import { getOwn, valuesOf } from './records';
import type { EdgeSource, Graph, GraphNode } from './types';

// ---- Граф зависимостей ----

/**
 * Граф зависимостей. Вершина — нода, но роадмапа R — две вершины:
 * «начало R» (в него входят стрелки к R, из него — путь к каждой ноде внутри)
 * и «конец R» (в него — от каждой ноды внутри, из него — стрелки от R).
 * Так тупик через границу роадмапы становится обычным циклом.
 * Стрелка от задачи идёт от вершины её блока.
 */
type Vertex = string;

const startOf = (node: GraphNode): Vertex =>
  node.type === 'roadmap' ? `s:${node.id}` : `n:${node.id}`;
const endOf = (node: GraphNode): Vertex =>
  node.type === 'roadmap' ? `e:${node.id}` : `n:${node.id}`;
const nodeIdOf = (vertex: Vertex): NodeId => asNodeId(vertex.slice(2));

function sourceNode(graph: Graph, source: EdgeSource): GraphNode | undefined {
  if (source.kind === 'node') return getOwn(graph.nodes, source.nodeId);
  const task = getOwn(graph.tasks, source.taskId);
  return task && getOwn(graph.nodes, task.blockId);
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function dependencyGraph(graph: Graph): Map<Vertex, Vertex[]> {
  const next = new Map<Vertex, Vertex[]>();
  for (const node of valuesOf(graph.nodes)) {
    // Пустая роадмапа пропускает зависимость насквозь: X → R → Y — это всё ещё X → Y.
    if (node.type === 'roadmap') append(next, startOf(node), endOf(node));
    const parent = node.parentId === null ? undefined : getOwn(graph.nodes, node.parentId);
    if (parent) {
      append(next, startOf(parent), startOf(node));
      append(next, endOf(node), endOf(parent));
    }
  }
  for (const edge of valuesOf(graph.edges)) {
    const from = sourceNode(graph, edge.source);
    const to = getOwn(graph.nodes, edge.target.nodeId);
    if (from && to) append(next, endOf(from), startOf(to));
  }
  return next;
}

// ---- Циклы ----

/**
 * Первый найденный цикл или тупик: ноды в порядке обхода, без повторов (для подсветки).
 * null — циклов нет. Обход без рекурсии, чтобы длинная цепочка не переполнила стек.
 */
export function findCycle(graph: Graph): NodeId[] | null {
  const next = dependencyGraph(graph);
  const finished = new Set<Vertex>();
  const depthOnPath = new Map<Vertex, number>();

  for (const root of next.keys()) {
    if (finished.has(root)) continue;
    const path: Vertex[] = [root];
    const cursor: number[] = [0];
    depthOnPath.set(root, 0);

    while (path.length > 0) {
      const depth = path.length - 1;
      const vertex = path[depth]!;
      const out = next.get(vertex) ?? [];
      const i = cursor[depth]!;
      if (i < out.length) {
        cursor[depth] = i + 1;
        const to = out[i]!;
        const cycleStart = depthOnPath.get(to);
        if (cycleStart !== undefined) {
          return [...new Set(path.slice(cycleStart).map(nodeIdOf))];
        }
        if (!finished.has(to)) {
          depthOnPath.set(to, path.length);
          path.push(to);
          cursor.push(0);
        }
      } else {
        finished.add(vertex);
        depthOnPath.delete(vertex);
        path.pop();
        cursor.pop();
      }
    }
  }
  return null;
}

// ---- Порядок зависимостей ----

/** Шаг обхода: 'enter' — вход ноды (у роадмапы — её начало), 'exit' — выход (у роадмапы — конец). */
export type OrderStep = { readonly step: 'enter' | 'exit'; readonly id: NodeId };

/**
 * Ноды в порядке зависимостей: вход ноды идёт после выходов всех, кого она ждёт, и после входа
 * её роадмапы; выход роадмапы — после выходов всех нод внутри. У блока и milestone вход и выход —
 * соседние шаги. Граф без циклов (инвариант), поэтому в порядок попадают все ноды.
 */
export function dependencyOrder(graph: Graph): OrderStep[] {
  const next = dependencyGraph(graph);
  const vertices: Vertex[] = [];
  for (const node of valuesOf(graph.nodes)) {
    vertices.push(startOf(node));
    if (node.type === 'roadmap') vertices.push(endOf(node));
  }
  const indegree = new Map<Vertex, number>(vertices.map((vertex) => [vertex, 0]));
  for (const targets of next.values()) {
    for (const to of targets) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const queue = vertices.filter((vertex) => indegree.get(vertex) === 0);
  const steps: OrderStep[] = [];
  for (let i = 0; i < queue.length; i++) {
    const vertex = queue[i]!;
    const id = nodeIdOf(vertex);
    if (vertex.startsWith('s:')) steps.push({ step: 'enter', id });
    else if (vertex.startsWith('e:')) steps.push({ step: 'exit', id });
    else steps.push({ step: 'enter', id }, { step: 'exit', id });
    for (const to of next.get(vertex) ?? []) {
      const left = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, left);
      if (left === 0) queue.push(to);
    }
  }
  return steps;
}

// ---- Что идёт после ----

/** Откуда начинается распространение потери выполненности. */
export type SpreadStart<Tag> = {
  /** Метка, которую получат задачи, до которых дойдёт этот старт (источник предупреждения). */
  readonly tag: Tag;
  /** Ноды, которые блокируются. */
  readonly locked: readonly NodeId[];
  /** Ноды, которые перестают быть выполненными. */
  readonly notDone: readonly NodeId[];
};

/**
 * Задачи, которые затрагивает потеря выполненности, с меткой старта, который дошёл до них первым:
 * - нода перестала быть выполненной → блокируется всё по стрелкам от неё, а роадмапа, внутри
 *   которой она лежит, тоже перестаёт быть выполненной;
 * - заблокированная нода перестаёт быть выполненной, её задачи затронуты, а у роадмапы
 *   блокируется всё внутри.
 *
 * Стрелки от задач заблокированного блока дальше не ведут: сами эти задачи остаются
 * выполненными, и то, что ждёт только их, не блокируется.
 */
export function spreadLoss<Tag>(
  graph: Graph,
  starts: readonly SpreadStart<Tag>[],
): Map<TaskId, Tag> {
  const fromNode = new Map<NodeId, NodeId[]>();
  for (const edge of valuesOf(graph.edges)) {
    if (edge.source.kind === 'node') append(fromNode, edge.source.nodeId, edge.target.nodeId);
  }
  const children = new Map<NodeId, NodeId[]>();
  for (const node of valuesOf(graph.nodes)) {
    if (node.parentId !== null) append(children, node.parentId, node.id);
  }
  const tasksIn = new Map<NodeId, TaskId[]>();
  for (const task of valuesOf(graph.tasks)) append(tasksIn, task.blockId, task.id);

  const locked = new Set<NodeId>();
  const notDone = new Set<NodeId>();
  const reached = new Map<TaskId, Tag>();
  for (const start of starts) {
    const queue: { readonly lock: boolean; readonly id: NodeId }[] = [
      ...start.locked.map((id) => ({ lock: true, id })),
      ...start.notDone.map((id) => ({ lock: false, id })),
    ];
    for (let i = 0; i < queue.length; i++) {
      const { lock, id } = queue[i]!;
      if (lock) {
        if (locked.has(id)) continue;
        locked.add(id);
        for (const taskId of tasksIn.get(id) ?? []) reached.set(taskId, start.tag);
        for (const child of children.get(id) ?? []) queue.push({ lock: true, id: child });
        queue.push({ lock: false, id });
      } else {
        if (notDone.has(id)) continue;
        notDone.add(id);
        for (const target of fromNode.get(id) ?? []) queue.push({ lock: true, id: target });
        const parentId = getOwn(graph.nodes, id)?.parentId;
        if (parentId) queue.push({ lock: false, id: parentId });
      }
    }
  }
  return reached;
}

/** Куда ведут стрелки от выхода задачи. */
export function taskEdgeTargets(graph: Graph, taskId: TaskId): NodeId[] {
  return valuesOf(graph.edges)
    .filter((edge) => edge.source.kind === 'task' && edge.source.taskId === taskId)
    .map((edge) => edge.target.nodeId);
}

/** Задачи после этой задачи: те, что окажутся заблокированы, если она и её блок перестанут быть выполненными. */
export function downstreamTasks(graph: Graph, taskId: TaskId): TaskId[] {
  const task = getOwn(graph.tasks, taskId);
  if (!task) return [];
  const reached = spreadLoss(graph, [
    { tag: true, locked: taskEdgeTargets(graph, taskId), notDone: [task.blockId] },
  ]);
  reached.delete(taskId);
  return [...reached.keys()];
}
