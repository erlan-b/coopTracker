// Применение операции к графу: сначала права и инварианты (DESIGN.md, «Инварианты»),
// потом новый граф и последствия: предупреждения и пометки «засчитано». Входной граф не
// меняется. Ноды, задачи и стрелки, которых операция не коснулась, переходят в новый граф
// теми же объектами; если операция ничего не меняет, возвращается тот же граф.

import { doneness } from './doneness';
import type { Doneness } from './doneness';
import type { GraphError, Result } from './errors';
import type { EdgeId, NodeId, TaskId } from './ids';
import { getOwn, putAll, removeAll, valuesOf } from './records';
import { checkStatusChange, isTaskCompleted, WARNED_STATUSES } from './status';
import { downstreamTasks, findCycle, spreadLoss, taskEdgeTargets } from './structure';
import type { SpreadStart } from './structure';
import { EDITABLE_NODE_FIELDS } from './types';
import type {
  ApplyContext,
  BlockNode,
  EdgeSource,
  Graph,
  GraphEdge,
  GraphNode,
  GraphSettings,
  NewNode,
  NewTask,
  NodeMove,
  NodePatch,
  NodePatchField,
  NodeType,
  Op,
  RoadmapNode,
  Task,
  TaskPatch,
  WarningSource,
} from './types';
import {
  checkCoordinates,
  checkNodeFields,
  checkOrder,
  checkTaskFields,
  invalidValue,
} from './validate';

export function applyOp(graph: Graph, op: Op, ctx: ApplyContext): Result<Graph> {
  const changed = applyChange(graph, op, ctx);
  if (!changed.ok || changed.value === graph || !mayChangeDoneness(op)) return changed;
  return ok(settle(graph, changed.value, op, ctx));
}

/** Что операция снова заблокирует — для диалога «блокировать / не блокировать / отмена». */
export type Relock = {
  /** Выполненные ноды, которые перестанут быть выполненными; при «не блокировать» получат «засчитано». */
  readonly nodes: readonly NodeId[];
  /** Задачи, которые окажутся заблокированы. Начатые и выполненные получат предупреждение. */
  readonly tasks: readonly TaskId[];
};

/**
 * Проверяет операцию и говорит, что она снова заблокирует, ничего не меняя. Пустой результат —
 * спрашивать не о чем. Ошибки — те же, что у applyOp.
 */
export function previewRelock(graph: Graph, op: Op, ctx: ApplyContext): Result<Relock> {
  const changed = applyChange(graph, op, ctx);
  if (!changed.ok) return changed;
  const after = changed.value;
  if (after === graph || !mayChangeDoneness(op))
    return { ok: true, value: { nodes: [], tasks: [] } };
  const was = doneness(graph, ctx.settings);
  const reached = lossSpread(graph, after, op, ctx.settings, was, doneness(after, ctx.settings));
  return {
    ok: true,
    value: {
      nodes: doneness(after, ctx.settings, was.done).toCount,
      tasks: [...reached.keys()],
    },
  };
}

// ---- Последствия: предупреждения и «засчитано» ----

/** Перемещение, снятие предупреждений и правка текста выполненность нод не меняют. */
function mayChangeDoneness(op: Op): boolean {
  switch (op.kind) {
    case 'moveNodes':
    case 'dismissWarnings':
      return false;
    case 'updateNode':
      return Object.hasOwn(op.patch, 'countedDone');
    case 'updateTask':
      return Object.hasOwn(op.patch, 'status');
    default:
      return true;
  }
}

function sourceKey(source: WarningSource): string {
  return source.kind === 'node' ? `node:${source.nodeId}` : `task:${source.taskId}`;
}

function withWarning(task: Task, source: WarningSource, at: string): Task {
  const key = sourceKey(source);
  const others = task.warnings.filter((warning) => sourceKey(warning.source) !== key);
  return { ...task, warnings: [...others, { source, at }] };
}

/** Задача, которую эта операция вывела из выполненного состояния. */
function reopenedTask(before: Graph, after: Graph, op: Op, settings: GraphSettings): TaskId | null {
  if (op.kind !== 'updateTask') return null;
  const was = getOwn(before.tasks, op.id);
  const now = getOwn(after.tasks, op.id);
  return was &&
    now &&
    isTaskCompleted(was.status, settings) &&
    !isTaskCompleted(now.status, settings)
    ? op.id
    : null;
}

/**
 * Кого затрагивает операция и от какого источника. Переоткрытая задача — источник для всего:
 * и по её собственным стрелкам, и по нодам, которые из-за неё перестали быть выполненными.
 * Иначе источник — первая в цепочке нода, которая перестала быть выполненной.
 */
function lossSpread(
  before: Graph,
  after: Graph,
  op: Op,
  settings: GraphSettings,
  was: Doneness,
  now: Doneness,
): Map<TaskId, WarningSource> {
  const lost = now.order.filter((id) => was.done.has(id) && !now.done.has(id));
  const reopened = reopenedTask(before, after, op, settings);
  const starts: SpreadStart<WarningSource>[] = reopened
    ? [
        {
          tag: { kind: 'task', taskId: reopened },
          locked: taskEdgeTargets(after, reopened),
          notDone: lost,
        },
      ]
    : lost.map((id) => ({ tag: { kind: 'node', nodeId: id }, locked: [], notDone: [id] }));
  const reached = spreadLoss(after, starts);
  if (reopened) reached.delete(reopened);
  return reached;
}

/**
 * После изменения: с «не блокировать» нодам, которые перестали быть выполненными, ставится
 * «засчитано»; пометка снимается там, где нода снова выполнена по-настоящему; начатые и
 * выполненные задачи, которые оказались заблокированы, получают предупреждение.
 */
function settle(before: Graph, after: Graph, op: Op, ctx: ApplyContext): Graph {
  const was = doneness(before, ctx.settings);
  const now = doneness(after, ctx.settings, op.keepDone === true ? was.done : undefined);

  const marked: GraphNode[] = [];
  for (const id of now.toCount) {
    const node = getOwn(after.nodes, id);
    if (node) marked.push({ ...node, countedDone: { by: ctx.actor.id, at: ctx.now } });
  }
  for (const id of now.countedNoLongerNeeded) {
    const node = getOwn(after.nodes, id);
    if (node) marked.push({ ...node, countedDone: null });
  }

  const warned: Task[] = [];
  for (const [taskId, source] of lossSpread(before, after, op, ctx.settings, was, now)) {
    const task = getOwn(after.tasks, taskId);
    if (task && WARNED_STATUSES.has(task.status)) warned.push(withWarning(task, source, ctx.now));
  }

  if (marked.length === 0 && warned.length === 0) return after;
  return { ...after, nodes: putAll(after.nodes, marked), tasks: putAll(after.tasks, warned) };
}

// ---- Само изменение ----

function applyChange(graph: Graph, op: Op, ctx: ApplyContext): Result<Graph> {
  if (ctx.actor.role === 'viewer') return fail({ code: 'FORBIDDEN', reason: 'viewer' });
  switch (op.kind) {
    case 'createNode':
      return createNode(graph, op.node, ctx);
    case 'updateNode':
      return updateNode(graph, op.id, op.patch, ctx);
    case 'moveNodes':
      return moveNodes(graph, op.moves);
    case 'deleteNode':
      return deleteNode(graph, op.id);
    case 'blockToRoadmap':
      return blockToRoadmap(graph, op.id, op.innerBlockId, ctx);
    case 'roadmapToBlock':
      return roadmapToBlock(graph, op.id, ctx);
    case 'createTask':
      return createTask(graph, op.task, ctx);
    case 'updateTask':
      return updateTask(graph, op.id, op.patch, ctx);
    case 'moveTask':
      return moveTask(graph, op.id, op.blockId, op.order);
    case 'deleteTask':
      return deleteTask(graph, op.id);
    case 'createEdge':
      return createEdge(graph, op.edge);
    case 'deleteEdge':
      return deleteEdge(graph, op.id);
    case 'dismissWarnings':
      return dismissWarnings(graph, op.taskId, op.scope);
    case 'restore':
      return restore(graph, op.nodes, op.tasks, op.edges);
  }
}

// ---- Общее ----

const ok = (value: Graph): Result<Graph> => ({ ok: true, value });
const fail = (error: GraphError): Result<Graph> => ({ ok: false, error });

// Читаем из изменения только известные поля: лишнее (id, type, parentId, number...) из
// сообщения в граф не попадёт. Record заставляет перечислить все поля типа.
const NODE_PATCH_FIELDS = Object.keys({
  title: true,
  description: true,
  deadline: true,
  labelIds: true,
  countedDone: true,
} satisfies Record<NodePatchField, true>) as NodePatchField[];

type TaskPatchField = keyof TaskPatch;
const TASK_PATCH_FIELDS = Object.keys({
  title: true,
  description: true,
  status: true,
  assigneeIds: true,
  deadline: true,
  priority: true,
  labelIds: true,
  estimate: true,
} satisfies Record<TaskPatchField, true>) as TaskPatchField[];

const authorship = (ctx: ApplyContext) => ({
  createdBy: ctx.actor.id,
  createdAt: ctx.now,
  updatedBy: ctx.actor.id,
  updatedAt: ctx.now,
});

/** Отметка «кто и когда менял». Ставится при изменении содержимого, но не при перемещении. */
const edited = (ctx: ApplyContext) => ({ updatedBy: ctx.actor.id, updatedAt: ctx.now });

/** Сравнение значений полей: строки, числа, null, списки и сроки. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]))
    );
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/** Поля изменения, которые действительно отличаются от текущих; null — менять нечего. */
function changedFields<P extends object>(
  current: object,
  patch: P,
  fields: readonly (keyof P & string)[],
): Partial<P> | null {
  let changes: Partial<P> | null = null;
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    if (value === undefined || sameValue((current as Record<string, unknown>)[field], value)) {
      continue;
    }
    changes = { ...changes, [field]: value } as Partial<P>;
  }
  return changes;
}

/** parentId ведёт к роадмапе, а роадмапа стоит только на корневом уровне. */
function checkPlacement(
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
function checkBlock(graph: Graph, id: NodeId): GraphError | null {
  const node = getOwn(graph.nodes, id);
  if (!node) return { code: 'NODE_NOT_FOUND', id };
  return node.type === 'block' ? null : { code: 'WRONG_NODE_TYPE', id, expected: 'block' };
}

function sameSource(a: EdgeSource, b: EdgeSource): boolean {
  return a.kind === 'node'
    ? b.kind === 'node' && a.nodeId === b.nodeId
    : b.kind === 'task' && a.taskId === b.taskId;
}

/** Концы стрелки существуют, это не петля и такой стрелки ещё нет. Циклы — отдельно. */
function checkEdge(graph: Graph, edge: GraphEdge): GraphError | null {
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
  if (fromNodeId === target.nodeId) return { code: 'SELF_LOOP', edgeId: edge.id };
  const twin = valuesOf(graph.edges).find(
    (other) => sameSource(other.source, source) && other.target.nodeId === target.nodeId,
  );
  return twin ? { code: 'DUPLICATE_EDGE', edgeId: twin.id } : null;
}

function cycleError(graph: Graph): GraphError | null {
  const path = findCycle(graph);
  return path ? { code: 'CYCLE', path } : null;
}

// ---- Ноды ----

/** Нода из операции: только поля своего типа, лишнее из сообщения отбрасывается. */
function makeNode(node: NewNode, ctx: ApplyContext): GraphNode {
  const base = {
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    description: node.description,
    x: node.x,
    y: node.y,
    countedDone: null,
    ...authorship(ctx),
  };
  switch (node.type) {
    case 'block':
      return { ...base, type: 'block', deadline: node.deadline, labelIds: node.labelIds };
    case 'roadmap':
      return { ...base, type: 'roadmap', deadline: node.deadline, labelIds: node.labelIds };
    case 'milestone':
      return { ...base, type: 'milestone', deadline: node.deadline };
  }
}

function createNode(graph: Graph, node: NewNode, ctx: ApplyContext): Result<Graph> {
  if (Object.hasOwn(graph.nodes, node.id)) return fail({ code: 'DUPLICATE_ID', id: node.id });
  const problem =
    checkPlacement(graph.nodes, node) ?? checkCoordinates(node.x, node.y) ?? checkNodeFields(node);
  if (problem) return fail(problem);
  return ok({ ...graph, nodes: putAll(graph.nodes, [makeNode(node, ctx)]) });
}

function updateNode(graph: Graph, id: NodeId, patch: NodePatch, ctx: ApplyContext): Result<Graph> {
  const node = getOwn(graph.nodes, id);
  if (!node) return fail({ code: 'NODE_NOT_FOUND', id });
  const editable: readonly NodePatchField[] = EDITABLE_NODE_FIELDS[node.type];
  const notApplicable = NODE_PATCH_FIELDS.find(
    (field) => Object.hasOwn(patch, field) && !editable.includes(field),
  );
  if (notApplicable) {
    return fail({ code: 'FIELD_NOT_APPLICABLE', field: notApplicable, nodeType: node.type });
  }
  // «Засчитано» можно только снять: ставит его выбор «не блокировать» (Op.keepDone).
  if (Object.hasOwn(patch, 'countedDone') && patch.countedDone !== null) {
    return fail(invalidValue('countedDone', 'bad_format'));
  }
  const problem = checkNodeFields(patch);
  if (problem) return fail(problem);
  const changes = changedFields(node, patch, NODE_PATCH_FIELDS);
  if (!changes) return ok(graph);
  const updated = { ...node, ...changes, ...edited(ctx) } as GraphNode;
  return ok({ ...graph, nodes: putAll(graph.nodes, [updated]) });
}

function moveNodes(graph: Graph, moves: readonly NodeMove[]): Result<Graph> {
  const seen = new Set<NodeId>();
  const moved: GraphNode[] = [];
  for (const move of moves) {
    if (seen.has(move.id)) return fail(invalidValue('moves', 'duplicate'));
    seen.add(move.id);
    const node = getOwn(graph.nodes, move.id);
    if (!node) return fail({ code: 'NODE_NOT_FOUND', id: move.id });
    const problem = checkCoordinates(move.x, move.y);
    if (problem) return fail(problem);
    if (node.x !== move.x || node.y !== move.y) moved.push({ ...node, x: move.x, y: move.y });
  }
  if (moved.length === 0) return ok(graph);
  return ok({ ...graph, nodes: putAll(graph.nodes, moved) });
}

/** Удаляет ноду, её задачи и все связанные стрелки; у роадмапы — и всё внутри. */
function deleteNode(graph: Graph, id: NodeId): Result<Graph> {
  const node = getOwn(graph.nodes, id);
  if (!node) return fail({ code: 'NODE_NOT_FOUND', id });

  const nodeIds = new Set<NodeId>([id]);
  if (node.type === 'roadmap') {
    for (const child of valuesOf(graph.nodes)) if (child.parentId === id) nodeIds.add(child.id);
  }
  const taskIds = new Set<TaskId>();
  for (const task of valuesOf(graph.tasks)) if (nodeIds.has(task.blockId)) taskIds.add(task.id);
  const edgeIds = new Set<EdgeId>();
  for (const edge of valuesOf(graph.edges)) {
    const { source } = edge;
    const fromRemoved =
      source.kind === 'node' ? nodeIds.has(source.nodeId) : taskIds.has(source.taskId);
    if (fromRemoved || nodeIds.has(edge.target.nodeId)) edgeIds.add(edge.id);
  }

  return ok({
    ...graph,
    nodes: removeAll(graph.nodes, nodeIds),
    tasks: removeAll(graph.tasks, taskIds),
    edges: removeAll(graph.edges, edgeIds),
  });
}

/**
 * Блок → роадмапа: нода сохраняет id, поля и стрелки, а задачи переезжают в новый блок внутри.
 * Цикл появиться не может: всё, что ждало блок, теперь ждёт начало роадмапы, а за ним — тот
 * же внутренний блок; всё, что шло от блока, идёт от её конца или от внутреннего блока.
 */
function blockToRoadmap(
  graph: Graph,
  id: NodeId,
  innerBlockId: NodeId,
  ctx: ApplyContext,
): Result<Graph> {
  const node = getOwn(graph.nodes, id);
  if (!node) return fail({ code: 'NODE_NOT_FOUND', id });
  if (node.type !== 'block') return fail({ code: 'WRONG_NODE_TYPE', id, expected: 'block' });
  if (node.parentId !== null) return fail({ code: 'NESTING_TOO_DEEP', id });
  if (Object.hasOwn(graph.nodes, innerBlockId)) {
    return fail({ code: 'DUPLICATE_ID', id: innerBlockId });
  }

  const asRoadmap: RoadmapNode = { ...node, type: 'roadmap', ...edited(ctx) };
  const inner: BlockNode = {
    id: innerBlockId,
    type: 'block',
    parentId: id,
    title: node.title,
    description: '',
    x: 0,
    y: 0,
    deadline: null,
    labelIds: [],
    countedDone: null,
    ...authorship(ctx),
  };
  const movedTasks = valuesOf(graph.tasks)
    .filter((task) => task.blockId === id)
    .map((task) => ({ ...task, blockId: innerBlockId }));

  return ok({
    ...graph,
    nodes: putAll(graph.nodes, [asRoadmap, inner]),
    tasks: putAll(graph.tasks, movedTasks),
  });
}

/** Обратно в блок — только пустая роадмапа. */
function roadmapToBlock(graph: Graph, id: NodeId, ctx: ApplyContext): Result<Graph> {
  const node = getOwn(graph.nodes, id);
  if (!node) return fail({ code: 'NODE_NOT_FOUND', id });
  if (node.type !== 'roadmap') return fail({ code: 'WRONG_NODE_TYPE', id, expected: 'roadmap' });
  if (valuesOf(graph.nodes).some((child) => child.parentId === id)) {
    return fail({ code: 'ROADMAP_NOT_EMPTY', id });
  }
  const asBlock: BlockNode = { ...node, type: 'block', ...edited(ctx) };
  return ok({ ...graph, nodes: putAll(graph.nodes, [asBlock]) });
}

// ---- Задачи ----

function createTask(graph: Graph, task: NewTask, ctx: ApplyContext): Result<Graph> {
  if (Object.hasOwn(graph.tasks, task.id)) return fail({ code: 'DUPLICATE_ID', id: task.id });
  const problem =
    checkStatusChange(null, task.status, ctx) ??
    checkBlock(graph, task.blockId) ??
    checkOrder(task.order) ??
    checkTaskFields(task);
  if (problem) return fail(problem);

  const created: Task = {
    id: task.id,
    blockId: task.blockId,
    order: task.order,
    number: null,
    title: task.title,
    description: task.description,
    status: task.status,
    assigneeIds: task.assigneeIds,
    deadline: task.deadline,
    priority: task.priority,
    labelIds: task.labelIds,
    estimate: task.estimate,
    warnings: [],
    ...authorship(ctx),
  };
  return ok({ ...graph, tasks: putAll(graph.tasks, [created]) });
}

/** Изменение полей задачи. Предупреждения при выходе из выполненного состояния ставит settle. */
function updateTask(graph: Graph, id: TaskId, patch: TaskPatch, ctx: ApplyContext): Result<Graph> {
  const task = getOwn(graph.tasks, id);
  if (!task) return fail({ code: 'TASK_NOT_FOUND', id });
  const problem =
    (patch.status === undefined ? null : checkStatusChange(task.status, patch.status, ctx)) ??
    checkTaskFields(patch);
  if (problem) return fail(problem);
  const changes = changedFields(task, patch, TASK_PATCH_FIELDS);
  if (!changes) return ok(graph);
  const updated: Task = { ...task, ...changes, ...edited(ctx) };
  return ok({ ...graph, tasks: putAll(graph.tasks, [updated]) });
}

/** Порядок в блоке или перенос в другой блок (в том числе на другой уровень). */
function moveTask(graph: Graph, id: TaskId, blockId: NodeId, order: string): Result<Graph> {
  const task = getOwn(graph.tasks, id);
  if (!task) return fail({ code: 'TASK_NOT_FOUND', id });
  const problem = checkBlock(graph, blockId) ?? checkOrder(order);
  if (problem) return fail(problem);
  if (task.blockId === blockId && task.order === order) return ok(graph);

  const next: Graph = { ...graph, tasks: putAll(graph.tasks, [{ ...task, blockId, order }]) };
  if (blockId !== task.blockId) {
    // Стрелки задачи теперь идут от нового блока: проверяем петли и циклы.
    const own = valuesOf(graph.edges).filter(
      (edge) => edge.source.kind === 'task' && edge.source.taskId === id,
    );
    const loop = own.find((edge) => edge.target.nodeId === blockId);
    if (loop) return fail({ code: 'SELF_LOOP', edgeId: loop.id });
    const cycle = own.length > 0 ? cycleError(next) : null;
    if (cycle) return fail(cycle);
  }
  return ok(next);
}

/** Удаляет задачу и её стрелки. */
function deleteTask(graph: Graph, id: TaskId): Result<Graph> {
  if (!Object.hasOwn(graph.tasks, id)) return fail({ code: 'TASK_NOT_FOUND', id });
  const edgeIds = new Set<EdgeId>();
  for (const edge of valuesOf(graph.edges)) {
    if (edge.source.kind === 'task' && edge.source.taskId === id) edgeIds.add(edge.id);
  }
  return ok({
    ...graph,
    tasks: removeAll(graph.tasks, new Set([id])),
    edges: removeAll(graph.edges, edgeIds),
  });
}

/**
 * Снимает предупреждения. 'this' — все у этой задачи. 'downstream' — у неё и у задач после неё,
 * но только от тех же источников, что у неё: чужие предупреждения дальше по цепочке остаются.
 */
function dismissWarnings(
  graph: Graph,
  taskId: TaskId,
  scope: 'this' | 'downstream',
): Result<Graph> {
  const task = getOwn(graph.tasks, taskId);
  if (!task) return fail({ code: 'TASK_NOT_FOUND', id: taskId });
  if (task.warnings.length === 0) return ok(graph);

  const touched: Task[] = [{ ...task, warnings: [] }];
  if (scope === 'downstream') {
    const sources = new Set(task.warnings.map((warning) => sourceKey(warning.source)));
    for (const downId of downstreamTasks(graph, taskId)) {
      const down = getOwn(graph.tasks, downId);
      if (!down) continue;
      const kept = down.warnings.filter((warning) => !sources.has(sourceKey(warning.source)));
      if (kept.length !== down.warnings.length) touched.push({ ...down, warnings: kept });
    }
  }
  return ok({ ...graph, tasks: putAll(graph.tasks, touched) });
}

// ---- Стрелки ----

function createEdge(graph: Graph, edge: GraphEdge): Result<Graph> {
  if (Object.hasOwn(graph.edges, edge.id)) return fail({ code: 'DUPLICATE_ID', id: edge.id });
  const problem = checkEdge(graph, edge);
  if (problem) return fail(problem);
  const stored: GraphEdge = {
    id: edge.id,
    source:
      edge.source.kind === 'node'
        ? { kind: 'node', nodeId: edge.source.nodeId }
        : { kind: 'task', taskId: edge.source.taskId },
    target: { kind: 'node', nodeId: edge.target.nodeId },
  };
  const next: Graph = { ...graph, edges: putAll(graph.edges, [stored]) };
  const cycle = cycleError(next);
  return cycle ? fail(cycle) : ok(next);
}

function deleteEdge(graph: Graph, id: EdgeId): Result<Graph> {
  if (!Object.hasOwn(graph.edges, id)) return fail({ code: 'EDGE_NOT_FOUND', id });
  return ok({ ...graph, edges: removeAll(graph.edges, new Set([id])) });
}

// ---- Восстановление ----

function firstTakenId<K extends string, V extends { readonly id: K }>(
  existing: Readonly<Record<K, V>>,
  items: readonly V[],
): K | null {
  const seen = new Set<K>();
  for (const item of items) {
    if (Object.hasOwn(existing, item.id) || seen.has(item.id)) return item.id;
    seen.add(item.id);
  }
  return null;
}

/**
 * Возвращает удалённое как было — с теми же id, номерами, статусами и авторством. Права на
 * статусы не проверяются: это не новая правка, а возврат прежнего состояния. Стрелки, которые
 * встать обратно не могут (конца больше нет, такая стрелка уже есть, получился бы цикл),
 * пропускаются; остальное проверяется как при создании.
 */
function restore(
  graph: Graph,
  nodes: readonly GraphNode[],
  tasks: readonly Task[],
  edges: readonly GraphEdge[],
): Result<Graph> {
  const taken =
    firstTakenId(graph.nodes, nodes) ??
    firstTakenId(graph.tasks, tasks) ??
    firstTakenId(graph.edges, edges);
  if (taken !== null) return fail({ code: 'DUPLICATE_ID', id: taken });

  let next: Graph = {
    ...graph,
    nodes: putAll(graph.nodes, nodes),
    tasks: putAll(graph.tasks, tasks),
  };
  for (const node of nodes) {
    const problem =
      checkPlacement(next.nodes, node) ?? checkCoordinates(node.x, node.y) ?? checkNodeFields(node);
    if (problem) return fail(problem);
  }
  for (const task of tasks) {
    const problem =
      checkBlock(next, task.blockId) ?? checkOrder(task.order) ?? checkTaskFields(task);
    if (problem) return fail(problem);
  }
  for (const edge of edges) {
    if (checkEdge(next, edge) !== null) continue;
    const withEdge: Graph = { ...next, edges: putAll(next.edges, [edge]) };
    if (findCycle(withEdge) === null) next = withEdge;
  }

  const unchanged =
    next.nodes === graph.nodes && next.tasks === graph.tasks && next.edges === graph.edges;
  return ok(unchanged ? graph : next);
}
