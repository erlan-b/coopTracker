// Состояния для интерфейса: что показывать у каждой ноды и задачи (DESIGN.md, «Вычисляемые
// состояния», «Задачи не по порядку», «Просрочка», «Сводка блока»). Строятся на выполненности
// нод (doneness.ts); граф не меняется.
//
// С прошлым результатом (previous) пересчитывается только то, что задела разница графов, а
// неизменённые состояния остаются теми же объектами; если не изменилось ничего — возвращается
// сам прошлый результат. Интерфейс перерисовывает только то, что поменялось.

import { donenessOf } from './doneness';
import type { DonenessState } from './doneness';
import { lineageOf, viewOf } from './draft';
import type { GraphDraft } from './draft';
import type { EdgeId, NodeId, TaskId, UserId } from './ids';
import { isTaskCompleted } from './status';
import type {
  Deadline,
  Graph,
  GraphEdge,
  GraphNode,
  GraphSettings,
  Task,
  TaskStatus,
} from './types';

/** Состояние задачи. «Заблокирована» — только у не начатой задачи в заблокированном блоке. */
export type TaskState = 'locked' | 'available' | 'in_progress' | 'in_review' | 'done';

/** Состояние ноды. «Пусто» — блок без задач, роадмапа без нод, milestone без входящих стрелок. */
export type NodeState = 'locked' | 'available' | 'in_progress' | 'done' | 'empty';

export type TaskView = {
  /** По статусу задачи; не начатая — «заблокирована» или «доступна» по своему блоку. */
  readonly state: TaskState;
  /** «Досрочно»: задача начата или выполнена, а её блок заблокирован. */
  readonly early: boolean;
  /** Срок прошёл, а задача не done. */
  readonly overdue: boolean;
  /**
   * Стрелка от задачи пропускает дальше: done, а «на проверке» — при reviewUnlocks.
   * Поэтому задача может быть «на проверке» и при этом уже разблокировать следующие.
   */
  readonly unblocks: boolean;
};

/** Сводка по задачам блока, а у роадмапы — всех блоков внутри. */
export type Summary = {
  readonly total: number;
  readonly byStatus: Readonly<Record<TaskStatus, number>>;
  /** Сумма оценок задач, у которых она есть. */
  readonly estimate: number;
  /** Сумма оценок задач, которые ещё не done. */
  readonly estimateLeft: number;
  /** Задач без оценки. */
  readonly unestimated: number;
  /** Все ответственные задач, без повторов, по id. */
  readonly assigneeIds: readonly UserId[];
};

export type NodeView = {
  /**
   * Настоящее состояние ноды. У ноды с пометкой «засчитано» оно не done, пока в ней есть
   * невыполненное, хотя для всего после неё она выполнена (см. unblocks).
   */
  readonly state: NodeState;
  /** Всё, что ждёт эту ноду, может идти: она выполнена по-настоящему или «засчитана». */
  readonly unblocks: boolean;
  /** Прошёл собственный срок ноды, а она не выполнена. */
  readonly overdue: boolean;
  /** У блока и роадмапы; у milestone — null. */
  readonly summary: Summary | null;
};

export type GraphStates = {
  readonly nodes: ReadonlyMap<NodeId, NodeView>;
  readonly tasks: ReadonlyMap<TaskId, TaskView>;
};

/**
 * Момент, на который считается просрочка. Интерфейсу хватает обновлять его раз в минуту:
 * с тем же графом и тем же моментом результат берётся готовым.
 */
export type Now = {
  /** Текущий момент в UTC, ровно в виде toISOString(): для сроков с временем. */
  readonly at: string;
  /** Сегодняшняя дата 'YYYY-MM-DD' в часовом поясе того, кто смотрит: для сроков-дат. */
  readonly today: string;
};

/**
 * Срок прошёл. Дата — включительно: 15 ноября в срок весь день 15-го по часовому поясу того,
 * кто смотрит, просрочено с 16-го. Срок с временем — сразу после этого момента. Обе записи
 * сравниваются как строки: формат у них один на каждый момент (validate.ts).
 */
export function deadlinePassed(deadline: Deadline | null, now: Now): boolean {
  if (deadline === null) return false;
  return deadline.kind === 'date' ? now.today > deadline.date : now.at > deadline.at;
}

// ---- Готовый результат и прошлые результаты ----

/** Для какого графа, настроек и момента посчитан результат. */
type Basis = { readonly graph: Graph; readonly key: string };

const results = new WeakMap<Graph, { readonly key: string; readonly states: GraphStates }>();
const bases = new WeakMap<GraphStates, Basis>();

const keyOf = (settings: GraphSettings, now: Now): string =>
  `${settings.statusMode}/${String(settings.reviewUnlocks)}/${now.at}/${now.today}`;

/**
 * Состояния всех нод и задач. previous — прошлый результат того же envi: если граф получен из
 * его графа операциями (а настройки и момент те же), пересчитывается только задетое.
 */
export function graphStates(
  graph: Graph,
  settings: GraphSettings,
  now: Now,
  previous?: GraphStates,
): GraphStates {
  const key = keyOf(settings, now);
  const cached = results.get(graph);
  if (cached?.key === key && (previous === undefined || cached.states === previous)) {
    return cached.states;
  }
  const basis = previous && bases.get(previous);
  const touched = basis?.key === key ? touchedSince(graph, basis.graph) : null;
  const states =
    previous && basis && touched
      ? update(previous, basis.graph, graph, touched, settings, now)
      : fromScratch(graph, settings, now, previous);
  results.set(graph, { key, states });
  bases.set(states, { graph, key });
  return states;
}

/** Состояния с нуля. Для тестов — эталон, с которым сверяется пересчёт задетого. */
export function statesFromScratch(graph: Graph, settings: GraphSettings, now: Now): GraphStates {
  return fromScratch(graph, settings, now, undefined);
}

// ---- Что изменилось между графами ----

type Touched = {
  readonly nodes: ReadonlyMap<NodeId, GraphNode | undefined>;
  readonly tasks: ReadonlyMap<TaskId, Task | undefined>;
  readonly edges: ReadonlyMap<EdgeId, GraphEdge | undefined>;
};

/** Шагов истории, которые ещё стоит пройти; дальше дешевле посчитать с нуля. */
const MAX_STEPS = 32;

/**
 * Что изменилось от ancestor до graph по истории рабочих копий (draft.ts, Lineage): id записей
 * и их значения в ancestor. null — graph получен не из ancestor (или история уже забыта).
 */
function touchedSince(graph: Graph, ancestor: Graph): Touched | null {
  if (graph === ancestor) return { nodes: new Map(), tasks: new Map(), edges: new Map() };
  const steps: Touched[] = [];
  let current: Graph | undefined = graph;
  while (current !== ancestor) {
    if (current === undefined || steps.length === MAX_STEPS) return null;
    const lineage = lineageOf(current);
    if (!lineage) return null;
    steps.push(lineage.touched);
    current = lineage.parent.deref();
  }
  if (steps.length === 1) return steps[0] ?? null;
  // Значение «до» — из самого раннего шага, где запись менялась.
  const nodes = new Map<NodeId, GraphNode | undefined>();
  const tasks = new Map<TaskId, Task | undefined>();
  const edges = new Map<EdgeId, GraphEdge | undefined>();
  for (const step of steps.reverse()) {
    for (const [id, was] of step.nodes) if (!nodes.has(id)) nodes.set(id, was);
    for (const [id, was] of step.tasks) if (!tasks.has(id)) tasks.set(id, was);
    for (const [id, was] of step.edges) if (!edges.has(id)) edges.set(id, was);
  }
  return { nodes, tasks, edges };
}

// ---- Состояния ----

/** Всё, из чего считаются состояния графа. */
type Context = {
  readonly graph: Graph;
  readonly view: GraphDraft;
  readonly doneness: DonenessState;
  readonly settings: GraphSettings;
  readonly now: Now;
};

function contextOf(graph: Graph, settings: GraphSettings, now: Now): Context {
  return { graph, view: viewOf(graph), doneness: donenessOf(graph, settings), settings, now };
}

/** Состояние задачи; прошлое — тем же объектом, если не изменилось. */
function taskView(ctx: Context, task: Task, old: TaskView | undefined): TaskView {
  const blockLocked = ctx.doneness.locked.has(task.blockId);
  const state: TaskState =
    task.status === 'todo' ? (blockLocked ? 'locked' : 'available') : task.status;
  const early = task.status !== 'todo' && blockLocked;
  const overdue = task.status !== 'done' && deadlinePassed(task.deadline, ctx.now);
  const unblocks = isTaskCompleted(task.status, ctx.settings);
  return old?.state === state &&
    old.early === early &&
    old.overdue === overdue &&
    old.unblocks === unblocks
    ? old
    : { state, early, overdue, unblocks };
}

/** Сводка блока по его задачам или роадмапы по блокам внутри; у milestone — null. */
function summaryOf(
  ctx: Context,
  node: GraphNode,
  blockSummary: (blockId: NodeId) => Summary | null,
): Summary | null {
  switch (node.type) {
    case 'block': {
      const tasks: Task[] = [];
      for (const taskId of ctx.view.tasksIn(node.id)) {
        const task = ctx.graph.tasks.get(taskId);
        if (task) tasks.push(task);
      }
      return summarize(tasks);
    }
    case 'roadmap': {
      const parts: Summary[] = [];
      for (const childId of ctx.view.childrenOf(node.id)) {
        const part = blockSummary(childId);
        if (part) parts.push(part);
      }
      return combine(parts);
    }
    case 'milestone':
      return null;
  }
}

/** Состояние ноды; прошлое — тем же объектом, если не изменилось. */
function nodeView(
  ctx: Context,
  node: GraphNode,
  fresh: Summary | null,
  old: NodeView | undefined,
): NodeView {
  const summary = old?.summary && fresh && sameSummary(old.summary, fresh) ? old.summary : fresh;
  const state = nodeState(ctx, node, summary);
  const unblocks = ctx.doneness.done.has(node.id);
  const overdue = state !== 'done' && deadlinePassed(node.deadline, ctx.now);
  return old?.state === state &&
    old.unblocks === unblocks &&
    old.overdue === overdue &&
    old.summary === summary
    ? old
    : { state, unblocks, overdue, summary };
}

/**
 * Настоящее состояние ноды: заблокирована → выполнена → пусто → в работе → доступна.
 * «Засчитанная» нода выполнена только тогда, когда выполнена по-настоящему.
 */
function nodeState(ctx: Context, node: GraphNode, summary: Summary | null): NodeState {
  const { view, doneness } = ctx;
  if (doneness.locked.has(node.id)) return 'locked';
  const empty =
    node.type === 'block'
      ? view.tasksIn(node.id).size === 0
      : node.type === 'roadmap'
        ? view.childrenOf(node.id).size === 0
        : view.edgesInto(node.id).size === 0;
  if (empty) return 'empty';
  if (doneness.done.has(node.id) && (node.countedDone === null || reallyDone(ctx, node))) {
    return 'done';
  }
  if (summary && summary.total > summary.byStatus.todo) return 'in_progress';
  return 'available';
}

/** «Засчитанная» нода, которая не заблокирована и не пуста, выполнена и по-настоящему. */
function reallyDone(ctx: Context, node: GraphNode): boolean {
  switch (node.type) {
    case 'block':
      for (const taskId of ctx.view.tasksIn(node.id)) {
        const task = ctx.graph.tasks.get(taskId);
        if (task && !isTaskCompleted(task.status, ctx.settings)) return false;
      }
      return true;
    case 'roadmap':
      for (const childId of ctx.view.childrenOf(node.id)) {
        if (!ctx.doneness.done.has(childId)) return false;
      }
      return true;
    case 'milestone':
      return true; // не заблокирован и есть входы — значит, все входы выполнены
  }
}

// ---- С нуля ----

function fromScratch(
  graph: Graph,
  settings: GraphSettings,
  now: Now,
  previous: GraphStates | undefined,
): GraphStates {
  const ctx = contextOf(graph, settings, now);
  let changed = previous === undefined;

  const tasks = new Map<TaskId, TaskView>();
  for (const task of graph.tasks.values()) {
    const old = previous?.tasks.get(task.id);
    const next = taskView(ctx, task, old);
    if (next !== old) changed = true;
    tasks.set(task.id, next);
  }

  // Сводки блоков нужны роадмапам, поэтому сначала все блоки.
  const blockSummaries = new Map<NodeId, Summary | null>();
  for (const node of graph.nodes.values()) {
    if (node.type === 'block')
      blockSummaries.set(
        node.id,
        summaryOf(ctx, node, () => null),
      );
  }
  const blockSummary = (id: NodeId) => blockSummaries.get(id) ?? null;

  const nodes = new Map<NodeId, NodeView>();
  for (const node of graph.nodes.values()) {
    const fresh =
      node.type === 'block' ? blockSummary(node.id) : summaryOf(ctx, node, blockSummary);
    const old = previous?.nodes.get(node.id);
    const next = nodeView(ctx, node, fresh, old);
    if (next !== old) changed = true;
    nodes.set(node.id, next);
  }

  const sameSize = previous?.tasks.size === tasks.size && previous.nodes.size === nodes.size;
  return previous && !changed && sameSize ? previous : { nodes, tasks };
}

// ---- Только задетое ----

/** Ноды, у которых выполненность или блокировка разные. */
function doneOrLockChanged(before: DonenessState, after: DonenessState): Set<NodeId> {
  const result = new Set<NodeId>();
  for (const [was, now] of [
    [before.done, after.done],
    [before.locked, after.locked],
  ] as const) {
    if (was === now) continue;
    for (const id of was) if (!now.has(id)) result.add(id);
    for (const id of now) if (!was.has(id)) result.add(id);
  }
  return result;
}

/**
 * Пересчёт только задетого. От чего зависит состояние:
 * - задачи — от неё самой и от блокировки её блока;
 * - ноды — от неё самой, её выполненности и блокировки, её задач (сводка, «пусто»), нод внутри
 *   роадмапы (сводка, «пусто», выполненность «засчитанной») и входящих стрелок («пусто» у
 *   milestone).
 */
function update(
  previous: GraphStates,
  basisGraph: Graph,
  graph: Graph,
  touched: Touched,
  settings: GraphSettings,
  now: Now,
): GraphStates {
  const ctx = contextOf(graph, settings, now);
  const flipped = doneOrLockChanged(donenessOf(basisGraph, settings), ctx.doneness);

  const taskIds = new Set<TaskId>(touched.tasks.keys());
  const blockIds = new Set<NodeId>();
  for (const [id, was] of touched.tasks) {
    if (was) blockIds.add(was.blockId);
    const task = graph.tasks.get(id);
    if (task) blockIds.add(task.blockId);
  }
  const nodeIds = new Set<NodeId>([...touched.nodes.keys(), ...flipped, ...blockIds]);
  for (const id of flipped) for (const taskId of ctx.view.tasksIn(id)) taskIds.add(taskId);
  for (const [id, was] of touched.edges) {
    if (was) nodeIds.add(was.target.nodeId);
    const edge = graph.edges.get(id);
    if (edge) nodeIds.add(edge.target.nodeId);
  }
  // Роадмапа зависит от нод внутри: и где нода лежит сейчас, и где лежала.
  for (const id of [...nodeIds]) {
    const parentNow = graph.nodes.get(id)?.parentId;
    if (parentNow) nodeIds.add(parentNow);
    const parentWas = (touched.nodes.get(id) ?? basisGraph.nodes.get(id))?.parentId;
    if (parentWas) nodeIds.add(parentWas);
  }

  let changed = false;
  const tasks = new Map(previous.tasks);
  for (const id of taskIds) {
    const task = graph.tasks.get(id);
    const old = previous.tasks.get(id);
    if (!task) {
      if (tasks.delete(id)) changed = true;
      continue;
    }
    const next = taskView(ctx, task, old);
    if (next !== old) {
      tasks.set(id, next);
      changed = true;
    }
  }

  const fresh = new Map<NodeId, Summary | null>();
  const blockSummary = (id: NodeId): Summary | null => {
    const known = fresh.get(id);
    if (known !== undefined) return known;
    if (!nodeIds.has(id)) return previous.nodes.get(id)?.summary ?? null;
    const node = graph.nodes.get(id);
    const summary = node?.type === 'block' ? summaryOf(ctx, node, () => null) : null;
    fresh.set(id, summary);
    return summary;
  };
  const nodes = new Map(previous.nodes);
  for (const id of nodeIds) {
    const node = graph.nodes.get(id);
    const old = previous.nodes.get(id);
    if (!node) {
      if (nodes.delete(id)) changed = true;
      continue;
    }
    const summary = node.type === 'block' ? blockSummary(id) : summaryOf(ctx, node, blockSummary);
    const next = nodeView(ctx, node, summary, old);
    if (next !== old) {
      nodes.set(id, next);
      changed = true;
    }
  }
  return changed ? { nodes, tasks } : previous;
}

// ---- Сводки ----

const NO_STATUSES: Readonly<Record<TaskStatus, number>> = {
  todo: 0,
  in_progress: 0,
  in_review: 0,
  done: 0,
};

function summarize(tasks: readonly Task[]): Summary {
  const byStatus = { ...NO_STATUSES };
  let estimate = 0;
  let estimateLeft = 0;
  let unestimated = 0;
  const assignees = new Set<UserId>();
  for (const task of tasks) {
    byStatus[task.status]++;
    if (task.estimate === null) {
      unestimated++;
    } else {
      estimate += task.estimate;
      if (task.status !== 'done') estimateLeft += task.estimate;
    }
    for (const id of task.assigneeIds) assignees.add(id);
  }
  return {
    total: tasks.length,
    byStatus,
    estimate,
    estimateLeft,
    unestimated,
    assigneeIds: [...assignees].sort(byId),
  };
}

function combine(parts: readonly Summary[]): Summary {
  const byStatus = { ...NO_STATUSES };
  let total = 0;
  let estimate = 0;
  let estimateLeft = 0;
  let unestimated = 0;
  const assignees = new Set<UserId>();
  for (const part of parts) {
    total += part.total;
    for (const status of Object.keys(byStatus) as TaskStatus[]) {
      byStatus[status] += part.byStatus[status];
    }
    estimate += part.estimate;
    estimateLeft += part.estimateLeft;
    unestimated += part.unestimated;
    for (const id of part.assigneeIds) assignees.add(id);
  }
  return {
    total,
    byStatus,
    estimate,
    estimateLeft,
    unestimated,
    assigneeIds: [...assignees].sort(byId),
  };
}

function sameSummary(a: Summary, b: Summary): boolean {
  return (
    a.total === b.total &&
    a.byStatus.todo === b.byStatus.todo &&
    a.byStatus.in_progress === b.byStatus.in_progress &&
    a.byStatus.in_review === b.byStatus.in_review &&
    a.byStatus.done === b.byStatus.done &&
    a.estimate === b.estimate &&
    a.estimateLeft === b.estimateLeft &&
    a.unestimated === b.unestimated &&
    a.assigneeIds.length === b.assigneeIds.length &&
    a.assigneeIds.every((id, i) => id === b.assigneeIds[i])
  );
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
