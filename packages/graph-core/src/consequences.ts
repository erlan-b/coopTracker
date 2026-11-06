// Последствия изменения графа: предупреждения «снова не выполнено» и пометки «засчитано».
// Считаются по разнице до и после шага (одной операции), поэтому одинаковы для любой операции,
// включая отмену. Правила — DESIGN.md, «Предупреждение…» и «Когда выполненное снова не выполнено».

import { donenessBeforeStep, evaluate, seedsOf, settingsKey } from './doneness';
import type { Evaluation } from './doneness';
import type { GraphDraft, Step } from './draft';
import type { NodeId, TaskId } from './ids';
import { isTaskCompleted, WARNED_STATUSES } from './status';
import { orderOf, spreadLoss, taskEdgeTargets } from './structure';
import type { SpreadStart } from './structure';
import { LIMITS } from './types';
import type { ApplyContext, GraphSettings, Task, WarningSource } from './types';

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

/**
 * Одно предупреждение на источник: повтор заменяет старое и обновляет время. Самые новые —
 * в конце; сверх LIMITS.maxWarnings уходят самые старые.
 */
export function withWarning(task: Task, source: WarningSource, at: string): Task {
  const key = sourceKey(source);
  const others = task.warnings.filter((warning) => sourceKey(warning.source) !== key);
  const warnings = [...others, { source, at }];
  return { ...task, warnings: warnings.slice(-LIMITS.maxWarnings) };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Задачи, которые шаг вывел из выполненного состояния, по id. */
function reopenedTasks(view: GraphDraft, step: Step, settings: GraphSettings): TaskId[] {
  const result: TaskId[] = [];
  for (const [id, before] of step.tasks) {
    const after = view.task(id);
    if (
      before !== undefined &&
      after !== undefined &&
      isTaskCompleted(before.status, settings) &&
      !isTaskCompleted(after.status, settings)
    ) {
      result.push(id);
    }
  }
  return result.sort(byId);
}

/**
 * Кого затрагивает шаг и от какого источника. Переоткрытая задача — источник и для стрелок
 * от неё, и для всего после её блока, если блок из-за неё перестал быть выполненным. Остальное —
 * от первой в цепочке ноды, которая перестала быть выполненной. Порядок стартов однозначен
 * (задачи по id, ноды в порядке зависимостей), поэтому источник у всех получается один и тот же.
 */
function lossSpread(
  view: GraphDraft,
  step: Step,
  settings: GraphSettings,
  evaluation: Evaluation,
): Map<TaskId, WarningSource> {
  const lostSet = new Set(evaluation.lost);
  const reopened = reopenedTasks(view, step, settings);
  const starts: SpreadStart<WarningSource>[] = [];
  for (const taskId of reopened) {
    const blockId = view.task(taskId)?.blockId;
    starts.push({
      tag: { kind: 'task', taskId },
      locked: taskEdgeTargets(view, taskId),
      notDone: blockId !== undefined && lostSet.has(blockId) ? [blockId] : [],
    });
  }
  for (const id of evaluation.lost) {
    starts.push({ tag: { kind: 'node', nodeId: id }, locked: [], notDone: [id] });
  }
  if (starts.length === 0) return new Map();
  const reached = spreadLoss(view, starts, (id) => evaluation.state.done.has(id));
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
 * Завершает шаг (одну операцию): с «не блокировать» ставит «засчитано» нодам, которые
 * перестали быть выполненными; снимает пометку там, где нода снова выполнена по-настоящему;
 * ставит предупреждения начатым и выполненным задачам, которые оказались заблокированы.
 * Если шаг не мог изменить выполненность (перемещение, текст, «не начата» → «в работе»),
 * ничего не пересчитывается.
 */
export function settle(draft: GraphDraft, ctx: ApplyContext, options: SettleOptions): void {
  const step = draft.takeStep();
  const key = settingsKey(ctx.settings);
  const seeds = seedsOf(draft, step, ctx.settings);
  if (!seeds) {
    draft.settled(key, draft.donenessAtStep(key));
    return;
  }
  const was = donenessBeforeStep(draft, ctx.settings);
  const evaluation = evaluate(draft, ctx.settings, orderOf(draft), was, seeds, options.keepDone);

  for (const id of evaluation.toCount) {
    const node = draft.node(id);
    if (node) draft.putNode({ ...node, countedDone: { by: ctx.actor.id, at: ctx.now } });
  }
  for (const id of evaluation.countedNoLongerNeeded) {
    const node = draft.node(id);
    if (node) draft.putNode({ ...node, countedDone: null });
  }

  const since = options.warnOnlyChangedAfter;
  for (const [taskId, source] of lossSpread(draft, step, ctx.settings, evaluation)) {
    const task = draft.task(taskId);
    if (!task || !WARNED_STATUSES.has(task.status)) continue;
    if (since !== null && !(task.updatedAt > since)) continue;
    draft.putTask(withWarning(task, source, ctx.now));
  }

  // Пометки и предупреждения выполненность не меняют: она уже посчитана с их учётом.
  draft.takeStep();
  draft.settled(key, evaluation.state);
}

/** Что шаг заблокирует, без самих предупреждений и пометок. Шаг не завершается. */
export function relockOf(draft: GraphDraft, settings: GraphSettings): Relock {
  const step = draft.peekStep();
  const seeds = seedsOf(draft, step, settings);
  if (!seeds) return { nodes: [], tasks: [] };
  const was = donenessBeforeStep(draft, settings);
  const order = orderOf(draft);
  const blocking = evaluate(draft, settings, order, was, seeds, false);
  const reached = lossSpread(draft, step, settings, blocking);
  const keeping = evaluate(draft, settings, order, was, seeds, true);
  return { nodes: [...keeping.toCount].sort(byId), tasks: [...reached.keys()].sort(byId) };
}
