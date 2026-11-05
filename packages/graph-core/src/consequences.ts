// Последствия изменения графа: предупреждения «снова не выполнено» и пометки «засчитано».
// Считаются по разнице графа до и после изменения, поэтому одинаковы для любой операции,
// включая отмену. Правила — DESIGN.md, «Предупреждение…» и «Когда выполненное снова не выполнено».

import { doneness } from './doneness';
import type { Doneness } from './doneness';
import type { NodeId, TaskId } from './ids';
import { getOwn, putAll, valuesOf } from './records';
import { isTaskCompleted, WARNED_STATUSES } from './status';
import { spreadLoss, taskEdgeTargets } from './structure';
import type { SpreadStart } from './structure';
import type { ApplyContext, Graph, GraphNode, GraphSettings, Task, WarningSource } from './types';

/** Что изменение снова заблокирует — для диалога «блокировать / не блокировать / отмена». */
export type Relock = {
  /** Выполненные ноды, которые перестанут быть выполненными; при «не блокировать» получат «засчитано». */
  readonly nodes: readonly NodeId[];
  /** Задачи, которые окажутся заблокированы. Начатые и выполненные получат предупреждение. */
  readonly tasks: readonly TaskId[];
};

export function sourceKey(source: WarningSource): string {
  return source.kind === 'node' ? `node:${source.nodeId}` : `task:${source.taskId}`;
}

/** Одно предупреждение на источник: повтор заменяет старое и обновляет время. */
export function withWarning(task: Task, source: WarningSource, at: string): Task {
  const key = sourceKey(source);
  const others = task.warnings.filter((warning) => sourceKey(warning.source) !== key);
  return { ...task, warnings: [...others, { source, at }] };
}

/** Задачи, которые изменение вывело из выполненного состояния. */
function reopenedTasks(before: Graph, after: Graph, settings: GraphSettings): TaskId[] {
  if (before.tasks === after.tasks) return [];
  const result: TaskId[] = [];
  for (const task of valuesOf(after.tasks)) {
    const was = getOwn(before.tasks, task.id);
    if (
      was !== undefined &&
      was !== task &&
      isTaskCompleted(was.status, settings) &&
      !isTaskCompleted(task.status, settings)
    ) {
      result.push(task.id);
    }
  }
  return result;
}

/**
 * Кого затрагивает изменение и от какого источника. Переоткрытая задача — источник и для стрелок
 * от неё, и для всего после её блока, если блок из-за неё перестал быть выполненным. Остальное —
 * от первой в цепочке ноды, которая перестала быть выполненной.
 */
function lossSpread(
  before: Graph,
  after: Graph,
  settings: GraphSettings,
  was: Doneness,
  now: Doneness,
): Map<TaskId, WarningSource> {
  const lost = now.order.filter((id) => was.done.has(id) && !now.done.has(id));
  const lostSet = new Set(lost);
  const reopened = reopenedTasks(before, after, settings);
  const starts: SpreadStart<WarningSource>[] = [];
  for (const taskId of reopened) {
    const blockId = getOwn(after.tasks, taskId)?.blockId;
    starts.push({
      tag: { kind: 'task', taskId },
      locked: taskEdgeTargets(after, taskId),
      notDone: blockId !== undefined && lostSet.has(blockId) ? [blockId] : [],
    });
  }
  for (const id of lost)
    starts.push({ tag: { kind: 'node', nodeId: id }, locked: [], notDone: [id] });
  const reached = spreadLoss(after, starts);
  for (const id of reopened) reached.delete(id);
  return reached;
}

export type SettleOptions = {
  /** «Не блокировать»: ноды, переставшие быть выполненными, получают «засчитано». */
  readonly keepDone: boolean;
  /** Для отмены: предупреждение получают только задачи, изменённые после этого момента. */
  readonly warnOnlyChangedAfter: string | null;
};

/**
 * Достраивает граф после изменения: с «не блокировать» ставит «засчитано» нодам, которые
 * перестали быть выполненными; снимает пометку там, где нода снова выполнена по-настоящему;
 * ставит предупреждения начатым и выполненным задачам, которые оказались заблокированы.
 */
export function settle(
  before: Graph,
  after: Graph,
  ctx: ApplyContext,
  options: SettleOptions,
): Graph {
  const was = doneness(before, ctx.settings);
  const now = doneness(after, ctx.settings, options.keepDone ? was.done : undefined);

  const marked: GraphNode[] = [];
  for (const id of now.toCount) {
    const node = getOwn(after.nodes, id);
    if (node) marked.push({ ...node, countedDone: { by: ctx.actor.id, at: ctx.now } });
  }
  for (const id of now.countedNoLongerNeeded) {
    const node = getOwn(after.nodes, id);
    if (node) marked.push({ ...node, countedDone: null });
  }

  const since = options.warnOnlyChangedAfter;
  const warned: Task[] = [];
  for (const [taskId, source] of lossSpread(before, after, ctx.settings, was, now)) {
    const task = getOwn(after.tasks, taskId);
    if (!task || !WARNED_STATUSES.has(task.status)) continue;
    if (since !== null && !(task.updatedAt > since)) continue;
    warned.push(withWarning(task, source, ctx.now));
  }

  if (marked.length === 0 && warned.length === 0) return after;
  return { ...after, nodes: putAll(after.nodes, marked), tasks: putAll(after.tasks, warned) };
}

/** Что изменение заблокирует, без самих предупреждений и пометок. */
export function relockOf(before: Graph, after: Graph, settings: GraphSettings): Relock {
  const was = doneness(before, settings);
  const reached = lossSpread(before, after, settings, was, doneness(after, settings));
  return { nodes: doneness(after, settings, was.done).toCount, tasks: [...reached.keys()] };
}
