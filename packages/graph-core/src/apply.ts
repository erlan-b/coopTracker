// Применение операций к графу: сначала права и инварианты (DESIGN.md, «Инварианты»),
// потом новый граф и последствия: предупреждения и пометки «засчитано» (consequences.ts).
// Входной граф не меняется. Ноды, задачи и стрелки, которых операция не коснулась, переходят
// в новый граф теми же объектами; если операция ничего не меняет, возвращается тот же граф.

import { changesOfDraft } from './changes';
import { relockOf, settle, sourceKey } from './consequences';
import type { Relock } from './consequences';
import { GraphDraft } from './draft';
import type { GraphError, Result } from './errors';
import type { EdgeId, NodeId, TaskId } from './ids';
import { knownEdge, knownNode, knownTask } from './fields';
import {
  checkBlock,
  checkEdge,
  checkNode,
  checkPlacement,
  checkTask,
  cycleError,
  putEdgesIfValid,
} from './invariants';
import { revertInto } from './revert';
import type { RevertSkip } from './revert';
import { checkStatusChange } from './status';
import { downstreamTasks } from './structure';
import { EDITABLE_NODE_FIELDS, LIMITS } from './types';
import type {
  ApplyContext,
  BlockNode,
  Changes,
  Graph,
  GraphEdge,
  GraphNode,
  NewNode,
  NewTask,
  NodeMove,
  NodePatch,
  NodePatchField,
  Op,
  RoadmapNode,
  Task,
  TaskPatch,
} from './types';
import {
  checkCoordinates,
  checkNodeFields,
  checkOrder,
  checkTaskFields,
  invalidValue,
} from './validate';
import { ownField, sameValue } from './values';

export type { Relock } from './consequences';

/** Результат операции. */
export type Applied = {
  readonly graph: Graph;
  /**
   * Что изменилось, включая каскад и последствия: шаг отмены, запись в лог операций и в таблицы
   * БД. Записи упорядочены по id.
   */
  readonly changes: Changes;
  /** Только у отмены: что не вернулось (подсказка «не отменено: поле уже изменил {имя}»). */
  readonly skipped: readonly RevertSkip[];
};

export function applyOp(graph: Graph, op: Op, ctx: ApplyContext): Result<Applied> {
  return applyOps(graph, [op], ctx);
}

/**
 * Несколько операций как одно действие: либо применяются все, либо ни одной (ошибка первой
 * неудавшейся). Граф копируется один раз, циклы проверяются и последствия (предупреждения,
 * «засчитано») считаются один раз — по итогу всего пакета. Поэтому пакет из тысячи операций
 * стоит как одна большая, а не как тысяча. «Не блокировать» (keepDone) — у пакета целиком,
 * если оно стоит хоть у одной операции. Изменения — одним списком: это один шаг отмены.
 *
 * Пакет с отменой (revert) применяется по шагам: последствия считаются после каждой операции,
 * потому что у отмены свои правила предупреждений.
 */
export function applyOps(graph: Graph, ops: readonly Op[], ctx: ApplyContext): Result<Applied> {
  if (ops.length > LIMITS.maxOpsPerBatch) {
    return {
      ok: false,
      error: { code: 'LIMIT_EXCEEDED', records: 'ops', limit: LIMITS.maxOpsPerBatch },
    };
  }
  const draft = new GraphDraft(graph);
  const skipped: RevertSkip[] = [];
  if (ops.some((op) => op.kind === 'revert')) {
    for (const op of ops) {
      const problem = applyWithoutConsequences(draft, [op], ctx, skipped);
      if (problem) return { ok: false, error: problem };
      settle(draft, ctx, {
        keepDone: op.keepDone === true,
        warnOnlyChangedAfter: op.kind === 'revert' ? op.changes.at : null,
      });
    }
  } else {
    const problem = applyWithoutConsequences(draft, ops, ctx, skipped);
    if (problem) return { ok: false, error: problem };
    settle(draft, ctx, {
      keepDone: ops.some((op) => op.keepDone === true),
      warnOnlyChangedAfter: null,
    });
  }
  const changes = changesOfDraft(draft, ctx.now);
  return { ok: true, value: { graph: draft.finish(), changes, skipped } };
}

/**
 * Проверяет операцию и говорит, что она снова заблокирует, ничего не меняя. Пустой результат —
 * спрашивать не о чем. Ошибки — те же, что у applyOp.
 */
export function previewRelock(graph: Graph, op: Op, ctx: ApplyContext): Result<Relock> {
  const draft = new GraphDraft(graph);
  const problem = applyWithoutConsequences(draft, [op], ctx, []);
  if (problem) return { ok: false, error: problem };
  return { ok: true, value: relockOf(draft, ctx.settings) };
}

/**
 * Операции без последствий (предупреждений и пометок «засчитано»): права, инварианты, лимиты,
 * в конце — проверка циклов. Внутри пакета цикл может временно появиться и исчезнуть.
 * Экспортируется для эталона в тестах: он считает последствия заново по этому графу.
 */
export function applyWithoutConsequences(
  draft: GraphDraft,
  ops: readonly Op[],
  ctx: ApplyContext,
  skipped: RevertSkip[],
): GraphError | null {
  for (const op of ops) {
    const problem = applyToDraft(draft, op, ctx, skipped) ?? checkLimits(draft);
    if (problem) return problem;
  }
  return cycleError(draft);
}

function applyToDraft(
  draft: GraphDraft,
  op: Op,
  ctx: ApplyContext,
  skipped: RevertSkip[],
): GraphError | null {
  if (ctx.actor.role === 'viewer') return { code: 'FORBIDDEN', reason: 'viewer' };
  switch (op.kind) {
    case 'createNode':
      return createNode(draft, op.node, ctx);
    case 'updateNode':
      return updateNode(draft, op.id, op.patch, ctx);
    case 'moveNodes':
      return moveNodes(draft, op.moves);
    case 'deleteNode':
      return deleteNode(draft, op.id);
    case 'blockToRoadmap':
      return blockToRoadmap(draft, op.id, op.innerBlockId, ctx);
    case 'roadmapToBlock':
      return roadmapToBlock(draft, op.id, ctx);
    case 'createTask':
      return createTask(draft, op.task, ctx);
    case 'updateTask':
      return updateTask(draft, op.id, op.patch, ctx);
    case 'moveTask':
      return moveTask(draft, op.id, op.blockId, op.order);
    case 'deleteTask':
      return deleteTask(draft, op.id);
    case 'createEdge':
      return createEdge(draft, op.edge);
    case 'deleteEdge':
      return deleteEdge(draft, op.id);
    case 'dismissWarnings':
      return dismissWarnings(draft, op.taskId, op.scope);
    case 'restore':
      return restore(draft, op.nodes, op.tasks, op.edges);
    case 'revert':
      return revertInto(draft, op.changes, skipped);
  }
}

/** Граф ветки не растёт сверх LIMITS. Если он уже больше (лимит уменьшили), расти ему нельзя. */
export function checkLimits(draft: GraphDraft): GraphError | null {
  const { base } = draft;
  const over = (records: 'nodes' | 'tasks' | 'edges', limit: number): GraphError | null =>
    draft[records].size > limit && draft[records].size > base[records].size
      ? { code: 'LIMIT_EXCEEDED', records, limit }
      : null;
  return (
    over('nodes', LIMITS.maxNodes) ??
    over('tasks', LIMITS.maxTasks) ??
    over('edges', LIMITS.maxEdges)
  );
}

// ---- Общее ----

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

/** Поля изменения, которые действительно отличаются от текущих; null — менять нечего. */
function changedFields<P extends object>(
  current: object,
  patch: P,
  fields: readonly (keyof P & string)[],
): Partial<P> | null {
  const changes: Partial<P> = {};
  let changed = false;
  for (const field of fields) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    if (value === undefined || sameValue(ownField(current, field), value)) continue;
    changes[field] = value;
    changed = true;
  }
  return changed ? changes : null;
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

function createNode(draft: GraphDraft, node: NewNode, ctx: ApplyContext): GraphError | null {
  if (draft.node(node.id)) return { code: 'DUPLICATE_ID', id: node.id };
  const problem =
    checkPlacement(draft, node) ?? checkCoordinates(node.x, node.y) ?? checkNodeFields(node);
  if (problem) return problem;
  draft.putNode(makeNode(node, ctx));
  return null;
}

function updateNode(
  draft: GraphDraft,
  id: NodeId,
  patch: NodePatch,
  ctx: ApplyContext,
): GraphError | null {
  const node = draft.node(id);
  if (!node) return { code: 'NODE_NOT_FOUND', id };
  const editable: readonly NodePatchField[] = EDITABLE_NODE_FIELDS[node.type];
  const notApplicable = NODE_PATCH_FIELDS.find(
    (field) => Object.hasOwn(patch, field) && !editable.includes(field),
  );
  if (notApplicable) {
    return { code: 'FIELD_NOT_APPLICABLE', field: notApplicable, nodeType: node.type };
  }
  // «Засчитано» можно только снять: ставит его выбор «не блокировать» (Op.keepDone).
  if (Object.hasOwn(patch, 'countedDone') && patch.countedDone !== null) {
    return invalidValue('countedDone', 'bad_format');
  }
  const problem = checkNodeFields(patch);
  if (problem) return problem;
  const changes = changedFields(node, patch, NODE_PATCH_FIELDS);
  if (changes) draft.putNode({ ...node, ...changes, ...edited(ctx) });
  return null;
}

function moveNodes(draft: GraphDraft, moves: readonly NodeMove[]): GraphError | null {
  const seen = new Set<NodeId>();
  const moved: GraphNode[] = [];
  for (const move of moves) {
    if (seen.has(move.id)) return invalidValue('moves', 'duplicate');
    seen.add(move.id);
    const node = draft.node(move.id);
    if (!node) return { code: 'NODE_NOT_FOUND', id: move.id };
    const problem = checkCoordinates(move.x, move.y);
    if (problem) return problem;
    if (node.x !== move.x || node.y !== move.y) moved.push({ ...node, x: move.x, y: move.y });
  }
  for (const node of moved) draft.putNode(node);
  return null;
}

/** Удаляет ноду, её задачи и все связанные стрелки; у роадмапы — и всё внутри. */
function deleteNode(draft: GraphDraft, id: NodeId): GraphError | null {
  const node = draft.node(id);
  if (!node) return { code: 'NODE_NOT_FOUND', id };
  const nodeIds = node.type === 'roadmap' ? [...draft.childrenOf(id), id] : [id];
  for (const nodeId of nodeIds) {
    for (const edgeId of [...draft.edgesInto(nodeId), ...draft.edgesOut(nodeId)]) {
      draft.removeEdge(edgeId);
    }
  }
  for (const nodeId of nodeIds) {
    for (const taskId of [...draft.tasksIn(nodeId)]) draft.removeTask(taskId);
  }
  for (const nodeId of nodeIds) draft.removeNode(nodeId);
  return null;
}

/**
 * Блок → роадмапа: нода сохраняет id, поля и стрелки, а задачи переезжают в новый блок внутри.
 * Цикл появиться не может: всё, что ждало блок, теперь ждёт начало роадмапы, а за ним — тот
 * же внутренний блок; всё, что шло от блока, идёт от её конца или от внутреннего блока.
 */
function blockToRoadmap(
  draft: GraphDraft,
  id: NodeId,
  innerBlockId: NodeId,
  ctx: ApplyContext,
): GraphError | null {
  const node = draft.node(id);
  if (!node) return { code: 'NODE_NOT_FOUND', id };
  if (node.type !== 'block') return { code: 'WRONG_NODE_TYPE', id, expected: 'block' };
  if (node.parentId !== null) return { code: 'NESTING_TOO_DEEP', id };
  if (draft.node(innerBlockId)) return { code: 'DUPLICATE_ID', id: innerBlockId };

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
  draft.putNode(asRoadmap);
  draft.putNode(inner);
  for (const taskId of [...draft.tasksIn(id)]) {
    const task = draft.task(taskId);
    if (task) draft.putTask({ ...task, blockId: innerBlockId });
  }
  return null;
}

/** Обратно в блок — только пустая роадмапа. */
function roadmapToBlock(draft: GraphDraft, id: NodeId, ctx: ApplyContext): GraphError | null {
  const node = draft.node(id);
  if (!node) return { code: 'NODE_NOT_FOUND', id };
  if (node.type !== 'roadmap') return { code: 'WRONG_NODE_TYPE', id, expected: 'roadmap' };
  if (draft.childrenOf(id).size > 0) return { code: 'ROADMAP_NOT_EMPTY', id };
  const asBlock: BlockNode = { ...node, type: 'block', ...edited(ctx) };
  draft.putNode(asBlock);
  return null;
}

// ---- Задачи ----

function createTask(draft: GraphDraft, task: NewTask, ctx: ApplyContext): GraphError | null {
  if (draft.task(task.id)) return { code: 'DUPLICATE_ID', id: task.id };
  const problem =
    checkStatusChange(null, task.status, ctx) ??
    checkBlock(draft, task.blockId) ??
    checkOrder(task.order) ??
    checkTaskFields(task);
  if (problem) return problem;

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
  draft.putTask(created);
  return null;
}

/** Изменение полей задачи. Предупреждения при выходе из выполненного состояния ставит settle. */
function updateTask(
  draft: GraphDraft,
  id: TaskId,
  patch: TaskPatch,
  ctx: ApplyContext,
): GraphError | null {
  const task = draft.task(id);
  if (!task) return { code: 'TASK_NOT_FOUND', id };
  const problem =
    (patch.status === undefined ? null : checkStatusChange(task.status, patch.status, ctx)) ??
    checkTaskFields(patch);
  if (problem) return problem;
  const changes = changedFields(task, patch, TASK_PATCH_FIELDS);
  if (changes) draft.putTask({ ...task, ...changes, ...edited(ctx) });
  return null;
}

/** Порядок в блоке или перенос в другой блок (в том числе на другой уровень). */
function moveTask(
  draft: GraphDraft,
  id: TaskId,
  blockId: NodeId,
  order: string,
): GraphError | null {
  const task = draft.task(id);
  if (!task) return { code: 'TASK_NOT_FOUND', id };
  const problem = checkBlock(draft, blockId) ?? checkOrder(order);
  if (problem) return problem;
  if (task.blockId === blockId && task.order === order) return null;

  // Стрелки задачи теперь пойдут от нового блока: петля — сразу, цикл — по итогу (applyOps).
  if (blockId !== task.blockId) {
    for (const edgeId of draft.edgesFromTask(id)) {
      if (draft.edge(edgeId)?.target.nodeId === blockId) return { code: 'SELF_LOOP', edgeId };
    }
  }
  draft.putTask({ ...task, blockId, order });
  return null;
}

/** Удаляет задачу и её стрелки. */
function deleteTask(draft: GraphDraft, id: TaskId): GraphError | null {
  if (!draft.task(id)) return { code: 'TASK_NOT_FOUND', id };
  for (const edgeId of [...draft.edgesFromTask(id)]) draft.removeEdge(edgeId);
  draft.removeTask(id);
  return null;
}

/**
 * Снимает предупреждения. 'this' — все у этой задачи. 'downstream' — у неё и у задач после неё,
 * но только от тех же источников, что у неё: чужие предупреждения дальше по цепочке остаются.
 */
function dismissWarnings(
  draft: GraphDraft,
  taskId: TaskId,
  scope: 'this' | 'downstream',
): GraphError | null {
  const task = draft.task(taskId);
  if (!task) return { code: 'TASK_NOT_FOUND', id: taskId };
  if (task.warnings.length === 0) return null;

  const touched: Task[] = [{ ...task, warnings: [] }];
  if (scope === 'downstream') {
    const sources = new Set(task.warnings.map((warning) => sourceKey(warning.source)));
    for (const downId of downstreamTasks(draft, taskId)) {
      const down = draft.task(downId);
      if (!down) continue;
      const kept = down.warnings.filter((warning) => !sources.has(sourceKey(warning.source)));
      if (kept.length !== down.warnings.length) touched.push({ ...down, warnings: kept });
    }
  }
  for (const changed of touched) draft.putTask(changed);
  return null;
}

// ---- Стрелки ----

function createEdge(draft: GraphDraft, edge: GraphEdge): GraphError | null {
  if (draft.edge(edge.id)) return { code: 'DUPLICATE_ID', id: edge.id };
  // Цикл проверяется по итогу операции или пакета (applyOps): один проход на весь пакет.
  const problem = checkEdge(draft, edge);
  if (problem) return problem;
  draft.putEdge(knownEdge(edge));
  return null;
}

function deleteEdge(draft: GraphDraft, id: EdgeId): GraphError | null {
  if (!draft.edge(id)) return { code: 'EDGE_NOT_FOUND', id };
  draft.removeEdge(id);
  return null;
}

// ---- Восстановление ----

function firstTakenId<K extends string>(
  exists: (id: K) => boolean,
  items: readonly { readonly id: K }[],
): K | null {
  const seen = new Set<K>();
  for (const item of items) {
    if (exists(item.id) || seen.has(item.id)) return item.id;
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
  draft: GraphDraft,
  nodes: readonly GraphNode[],
  tasks: readonly Task[],
  edges: readonly GraphEdge[],
): GraphError | null {
  // Записи приходят от клиента целиком: в граф попадают только известные поля.
  const cleanNodes = nodes.map(knownNode);
  const cleanTasks = tasks.map(knownTask);
  const cleanEdges = edges.map(knownEdge);
  const taken =
    firstTakenId((id: NodeId) => draft.node(id) !== undefined, cleanNodes) ??
    firstTakenId((id: TaskId) => draft.task(id) !== undefined, cleanTasks) ??
    firstTakenId((id: EdgeId) => draft.edge(id) !== undefined, cleanEdges);
  if (taken !== null) return { code: 'DUPLICATE_ID', id: taken };

  for (const node of cleanNodes) draft.putNode(node);
  for (const task of cleanTasks) draft.putTask(task);
  for (const node of cleanNodes) {
    const problem = checkNode(draft, node);
    if (problem) return problem;
  }
  for (const task of cleanTasks) {
    const problem = checkTask(draft, task);
    if (problem) return problem;
  }
  putEdgesIfValid(draft, cleanEdges);
  return null;
}
