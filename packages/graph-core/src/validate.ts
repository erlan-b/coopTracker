// Проверка значений полей: длина текста, размер списков, формат сроков, целые координаты.
// Форму данных (типы полей, допустимые значения статуса и приоритета) проверяет схема
// на входе сервера; здесь — правила графа, одинаковые для клиента и сервера.

import type { GraphError, InvalidReason } from './errors';
import { LIMITS } from './types';
import type { Deadline, NodePatch, TaskPatch } from './types';

export function invalidValue(field: string, reason: InvalidReason): GraphError {
  return { code: 'INVALID_VALUE', field, reason };
}

function firstError(checks: readonly (GraphError | null)[]): GraphError | null {
  return checks.find((check) => check !== null) ?? null;
}

function checkText(field: string, value: string | undefined, maxLength: number): GraphError | null {
  return value !== undefined && value.length > maxLength ? invalidValue(field, 'too_long') : null;
}

function checkList(
  field: string,
  list: readonly string[] | undefined,
  max: number,
): GraphError | null {
  if (list === undefined) return null;
  if (list.length > max) return invalidValue(field, 'too_many');
  if (new Set(list).size !== list.length) return invalidValue(field, 'duplicate');
  return null;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD', и такая дата существует (не 2026-02-30). */
function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * Момент в UTC ровно в виде toISOString(): 'YYYY-MM-DDTHH:mm:ss.sssZ'. У каждого момента одна
 * запись, поэтому сроки можно сравнивать как строки (это нужно слиянию веток).
 */
function isUtcInstant(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function checkDeadline(deadline: Deadline | null | undefined): GraphError | null {
  if (deadline === undefined || deadline === null) return null;
  const valid =
    deadline.kind === 'date' ? isCalendarDate(deadline.date) : isUtcInstant(deadline.at);
  return valid ? null : invalidValue('deadline', 'bad_format');
}

function checkEstimate(estimate: number | null | undefined): GraphError | null {
  if (estimate === undefined || estimate === null) return null;
  if (!Number.isFinite(estimate)) return invalidValue('estimate', 'bad_format');
  return estimate < 0 ? invalidValue('estimate', 'negative') : null;
}

/** Поля ноды: и при создании, и в изменении (пропущенные поля не проверяются). */
export function checkNodeFields(fields: Omit<NodePatch, 'countedDone'>): GraphError | null {
  return firstError([
    checkText('title', fields.title, LIMITS.titleMaxLength),
    checkText('description', fields.description, LIMITS.descriptionMaxLength),
    checkDeadline(fields.deadline),
    checkList('labelIds', fields.labelIds, LIMITS.maxLabels),
  ]);
}

/** Поля задачи, кроме статуса: правила статуса зависят от роли и режима envi (status.ts). */
export function checkTaskFields(fields: TaskPatch): GraphError | null {
  return firstError([
    checkText('title', fields.title, LIMITS.titleMaxLength),
    checkText('description', fields.description, LIMITS.descriptionMaxLength),
    checkList('assigneeIds', fields.assigneeIds, LIMITS.maxAssignees),
    checkList('labelIds', fields.labelIds, LIMITS.maxLabels),
    checkDeadline(fields.deadline),
    checkEstimate(fields.estimate),
  ]);
}

export function checkCoordinates(x: number, y: number): GraphError | null {
  if (!Number.isSafeInteger(x)) return invalidValue('x', 'not_integer');
  if (!Number.isSafeInteger(y)) return invalidValue('y', 'not_integer');
  return null;
}

export function checkOrder(order: string): GraphError | null {
  if (order.length === 0) return invalidValue('order', 'bad_format');
  return order.length > LIMITS.orderMaxLength ? invalidValue('order', 'too_long') : null;
}
