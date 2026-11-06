// Эталон для property-based тестов (подшаг 1f): выполненность нод, пометки «засчитано»
// и предупреждения, написанные заново и в лоб — по DESIGN.md («Вычисляемые состояния»,
// «Предупреждение…», «Когда выполненное снова не выполнено»). Без указателей, без запомненного,
// без пересчёта только задетого: каждый вызов перебирает граф целиком, поэтому годится только
// для маленьких графов. Из graph-core ничего не берёт, кроме типов и LIMITS. Из пакета не
// экспортируется.

import type { NodeId, TaskId } from './ids';
import { LIMITS } from './types';
import type {
  ApplyContext,
  GraphEdge,
  Graph,
  GraphNode,
  GraphSettings,
  Task,
  TaskStatus,
  WarningSource,
} from './types';

const completedStatus = (status: TaskStatus, settings: GraphSettings): boolean =>
  status === 'done' ||
  (status === 'in_review' && settings.statusMode === 'review' && settings.reviewUnlocks);

const tasksOf = (graph: Graph, blockId: NodeId): Task[] =>
  [...graph.tasks.values()].filter((task) => task.blockId === blockId);

const childrenOf = (graph: Graph, id: NodeId): GraphNode[] =>
  [...graph.nodes.values()].filter((node) => node.parentId === id);

const edgesInto = (graph: Graph, id: NodeId): GraphEdge[] =>
  [...graph.edges.values()].filter((edge) => edge.target.nodeId === id);

/** Нода, из которой выходит стрелка: сама нода или блок задачи. */
const sourceNodeOf = (graph: Graph, edge: GraphEdge): NodeId | undefined =>
  edge.source.kind === 'node' ? edge.source.nodeId : graph.tasks.get(edge.source.taskId)?.blockId;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type ModelDoneness = {
  /** Выполнена для всего после неё: по-настоящему или с пометкой «засчитано». */
  readonly done: ReadonlySet<NodeId>;
  readonly locked: ReadonlySet<NodeId>;
  /** Выполнена по-настоящему, без пометки. */
  readonly reallyDone: ReadonlySet<NodeId>;
  /** С «не блокировать»: ноды, которые получат пометку «засчитано». */
  readonly toCount: readonly NodeId[];
};

/**
 * Выполненность по определению, рекурсией от каждой ноды. Нода заблокирована, если заблокирована
 * её роадмапа или не выполнен источник хоть одной входящей стрелки. Выполнена по-настоящему, если
 * не заблокирована и: у блока есть задачи и все выполнены, у роадмапы есть ноды внутри и все
 * выполнены, у milestone есть входящие стрелки. Пометка «засчитано» делает ноду выполненной.
 *
 * wasDone — «не блокировать»: нода без пометки, которая была выполнена, а теперь нет, получает
 * пометку и считается выполненной. Рекурсия решает про ноду после всех, от кого она зависит,
 * поэтому пометку получают только первые в цепочке.
 */
export function modelDoneness(
  graph: Graph,
  settings: GraphSettings,
  wasDone?: ReadonlySet<NodeId>,
): ModelDoneness {
  const lockedMemo = new Map<NodeId, boolean>();
  const doneMemo = new Map<NodeId, boolean>();
  const reallyDone = new Set<NodeId>();
  const toCount: NodeId[] = [];

  const sourceDone = (edge: GraphEdge): boolean => {
    if (edge.source.kind === 'task') {
      const task = graph.tasks.get(edge.source.taskId);
      return task !== undefined && completedStatus(task.status, settings);
    }
    const node = graph.nodes.get(edge.source.nodeId);
    return node !== undefined && isDone(node);
  };

  const isLocked = (node: GraphNode): boolean => {
    const known = lockedMemo.get(node.id);
    if (known !== undefined) return known;
    const parent = node.parentId === null ? undefined : graph.nodes.get(node.parentId);
    const result =
      (parent !== undefined && isLocked(parent)) ||
      edgesInto(graph, node.id).some((edge) => !sourceDone(edge));
    lockedMemo.set(node.id, result);
    return result;
  };

  const ownCondition = (node: GraphNode): boolean => {
    switch (node.type) {
      case 'block': {
        const tasks = tasksOf(graph, node.id);
        return tasks.length > 0 && tasks.every((task) => completedStatus(task.status, settings));
      }
      case 'roadmap': {
        const inside = childrenOf(graph, node.id);
        return inside.length > 0 && inside.every(isDone);
      }
      case 'milestone':
        return edgesInto(graph, node.id).length > 0;
    }
  };

  const isDone = (node: GraphNode): boolean => {
    const known = doneMemo.get(node.id);
    if (known !== undefined) return known;
    let result = false;
    if (!isLocked(node) && ownCondition(node)) {
      reallyDone.add(node.id);
      result = true;
    } else if (node.countedDone !== null) {
      result = true;
    } else if (wasDone?.has(node.id) === true) {
      toCount.push(node.id);
      result = true;
    }
    doneMemo.set(node.id, result);
    return result;
  };

  const done = new Set<NodeId>();
  const locked = new Set<NodeId>();
  for (const node of graph.nodes.values()) {
    if (isDone(node)) done.add(node.id);
    if (isLocked(node)) locked.add(node.id);
  }
  return { done, locked, reallyDone, toCount };
}

/**
 * Ноды в порядке зависимостей — по выходам. Порядок Кана, из готовых вершин берётся меньшая по
 * id (у роадмапы начало раньше конца). Вершины: у блока и milestone одна, у роадмапы R — начало
 * (в него стрелки к R, из него — к каждой ноде внутри) и конец (в него — от каждой ноды внутри,
 * из него — стрелки от R). Стрелка от задачи идёт от её блока.
 */
export function modelOrder(graph: Graph): NodeId[] {
  type Vertex = { readonly id: NodeId; readonly end: boolean };
  const key = (v: Vertex): string => `${v.end ? 'e' : 's'}:${v.id}`;
  const start = (node: GraphNode): Vertex => ({ id: node.id, end: false });
  const finish = (node: GraphNode): Vertex => ({ id: node.id, end: node.type === 'roadmap' });

  const vertices = new Map<string, Vertex>();
  for (const node of graph.nodes.values()) {
    vertices.set(key(start(node)), start(node));
    vertices.set(key(finish(node)), finish(node));
  }
  const links: [Vertex, Vertex][] = [];
  for (const node of graph.nodes.values()) {
    if (node.type === 'roadmap') links.push([start(node), finish(node)]);
    const parent = node.parentId === null ? undefined : graph.nodes.get(node.parentId);
    if (parent) links.push([start(parent), start(node)], [finish(node), finish(parent)]);
  }
  for (const edge of graph.edges.values()) {
    const fromId = sourceNodeOf(graph, edge);
    const from = fromId === undefined ? undefined : graph.nodes.get(fromId);
    const to = graph.nodes.get(edge.target.nodeId);
    if (from && to) links.push([finish(from), start(to)]);
  }

  const result: NodeId[] = [];
  const placed = new Set<string>();
  for (;;) {
    let next: Vertex | undefined;
    for (const vertex of vertices.values()) {
      if (placed.has(key(vertex))) continue;
      const waiting = links.some(([from, to]) => key(to) === key(vertex) && !placed.has(key(from)));
      if (waiting) continue;
      if (
        next === undefined ||
        vertex.id < next.id ||
        (vertex.id === next.id && !vertex.end && next.end)
      ) {
        next = vertex;
      }
    }
    if (next === undefined) break;
    placed.add(key(next));
    const node = graph.nodes.get(next.id);
    if (node && key(finish(node)) === key(next)) result.push(next.id);
  }
  return result;
}

type Start = {
  readonly source: WarningSource;
  readonly locked: readonly NodeId[];
  readonly notDone: readonly NodeId[];
};

/**
 * Задачи, до которых доходит потеря выполненности от одного старта. Заблокированная нода:
 * её задачи затронуты, всё внутри неё заблокировано, сама она не выполнена. Невыполненная нода
 * (если она не осталась выполненной благодаря пометке): блокирует ноды по стрелкам от своего
 * выхода (не от своих задач — те остались выполненными) и её роадмапа тоже не выполнена.
 */
function reachOf(graph: Graph, start: Start, staysDone: ReadonlySet<NodeId>): Set<TaskId> {
  const reached = new Set<TaskId>();
  const locked = new Set<NodeId>();
  const notDone = new Set<NodeId>();
  const lock = (id: NodeId): void => {
    if (locked.has(id)) return;
    locked.add(id);
    for (const task of tasksOf(graph, id)) reached.add(task.id);
    for (const child of childrenOf(graph, id)) lock(child.id);
    lose(id);
  };
  const lose = (id: NodeId): void => {
    if (notDone.has(id) || staysDone.has(id)) return;
    notDone.add(id);
    for (const edge of graph.edges.values()) {
      if (edge.source.kind === 'node' && edge.source.nodeId === id) lock(edge.target.nodeId);
    }
    const parentId = graph.nodes.get(id)?.parentId;
    if (parentId !== undefined && parentId !== null) lose(parentId);
  };
  for (const id of start.locked) lock(id);
  for (const id of start.notDone) lose(id);
  return reached;
}

/**
 * Кто затронут изменением before → after и от какого источника: первый старт, который дошёл до
 * задачи. Старты: переоткрытые задачи по id (их стрелки и их блок, если он перестал быть
 * выполненным), потом ноды, переставшие быть выполненными, в порядке зависимостей. Сами
 * переоткрытые задачи не затронуты.
 */
function lossOf(
  before: Graph,
  after: Graph,
  settings: GraphSettings,
  wasDone: ReadonlySet<NodeId>,
  now: ModelDoneness,
): Map<TaskId, WarningSource> {
  const lost = modelOrder(after).filter((id) => wasDone.has(id) && !now.done.has(id));
  const reopened = [...after.tasks.values()]
    .filter((task) => {
      const was = before.tasks.get(task.id);
      return (
        was !== undefined &&
        completedStatus(was.status, settings) &&
        !completedStatus(task.status, settings)
      );
    })
    .map((task) => task.id)
    .sort(byId);

  const starts: Start[] = [];
  for (const taskId of reopened) {
    const blockId = after.tasks.get(taskId)!.blockId;
    starts.push({
      source: { kind: 'task', taskId },
      locked: [...after.edges.values()]
        .filter((edge) => edge.source.kind === 'task' && edge.source.taskId === taskId)
        .map((edge) => edge.target.nodeId),
      notDone: lost.includes(blockId) ? [blockId] : [],
    });
  }
  for (const nodeId of lost)
    starts.push({ source: { kind: 'node', nodeId }, locked: [], notDone: [nodeId] });

  const result = new Map<TaskId, WarningSource>();
  for (const start of starts) {
    for (const taskId of reachOf(after, start, now.done)) {
      if (!result.has(taskId)) result.set(taskId, start.source);
    }
  }
  for (const taskId of reopened) result.delete(taskId);
  return result;
}

const sameSource = (a: WarningSource, b: WarningSource): boolean =>
  a.kind === 'task'
    ? b.kind === 'task' && a.taskId === b.taskId
    : b.kind === 'node' && a.nodeId === b.nodeId;

export type ModelSettleOptions = {
  readonly keepDone: boolean;
  readonly warnOnlyChangedAfter: string | null;
};

/**
 * Граф после последствий изменения before → after (after — граф операции без последствий):
 * пометки «засчитано» с «не блокировать», снятие пометок у нод, выполненных по-настоящему,
 * предупреждения начатым и выполненным задачам, до которых дошла потеря выполненности.
 */
export function modelSettle(
  before: Graph,
  after: Graph,
  ctx: ApplyContext,
  options: ModelSettleOptions,
): Graph {
  const { settings } = ctx;
  const wasDone = modelDoneness(before, settings).done;
  const now = modelDoneness(after, settings, options.keepDone ? wasDone : undefined);

  const nodes = new Map(after.nodes);
  for (const id of now.toCount) {
    nodes.set(id, { ...after.nodes.get(id)!, countedDone: { by: ctx.actor.id, at: ctx.now } });
  }
  for (const node of after.nodes.values()) {
    if (node.countedDone !== null && now.reallyDone.has(node.id)) {
      nodes.set(node.id, { ...node, countedDone: null });
    }
  }

  const tasks = new Map(after.tasks);
  const since = options.warnOnlyChangedAfter;
  for (const [taskId, source] of lossOf(before, after, settings, wasDone, now)) {
    const task = after.tasks.get(taskId)!;
    if (task.status === 'todo') continue;
    if (since !== null && !(task.updatedAt > since)) continue;
    const warnings = [
      ...task.warnings.filter((warning) => !sameSource(warning.source, source)),
      { source, at: ctx.now },
    ].slice(-LIMITS.maxWarnings);
    tasks.set(taskId, { ...task, warnings });
  }
  return { nodes, tasks, edges: after.edges };
}

/** Что изменение before → after заблокирует (как previewRelock): ноды для пометок и задачи. */
export function modelRelock(
  before: Graph,
  after: Graph,
  settings: GraphSettings,
): { readonly nodes: readonly NodeId[]; readonly tasks: readonly TaskId[] } {
  const wasDone = modelDoneness(before, settings).done;
  const blocking = lossOf(before, after, settings, wasDone, modelDoneness(after, settings));
  const keeping = modelDoneness(after, settings, wasDone);
  return { nodes: [...keeping.toCount].sort(byId), tasks: [...blocking.keys()].sort(byId) };
}
