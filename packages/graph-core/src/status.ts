// Правила статусов задач: что считается выполненным и кто какой статус может поставить.

import type { GraphError } from './errors';
import type { ApplyContext, GraphSettings, TaskStatus } from './types';

/**
 * Выполнена ли задача для стрелок и готовности блока: done, а in_review — если в envi
 * включено reviewUnlocks (только в режиме review).
 */
export function isTaskCompleted(status: TaskStatus, settings: GraphSettings): boolean {
  return (
    status === 'done' ||
    (status === 'in_review' && settings.statusMode === 'review' && settings.reviewUnlocks)
  );
}

/** Задачи с этими статусами получают предупреждение «предыдущая задача изменена». */
export const WARNED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'in_progress',
  'in_review',
  'done',
]);

/** Может ли участник поставить задаче этот статус. from = null — задача создаётся. */
export function checkStatusChange(
  from: TaskStatus | null,
  to: TaskStatus,
  ctx: ApplyContext,
): GraphError | null {
  if (from === to) return null;
  if (to === 'in_review' && ctx.settings.statusMode !== 'review') {
    return { code: 'STATUS_NOT_ALLOWED', status: to };
  }
  if (to === 'done' && ctx.settings.statusMode === 'review' && ctx.actor.role !== 'master') {
    return { code: 'FORBIDDEN', reason: 'review_requires_master' };
  }
  return null;
}
