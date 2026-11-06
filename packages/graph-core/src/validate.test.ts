// Проверка значений полей (DESIGN.md, «Лимиты», «Поля задачи»). Через операции — так же,
// как значения попадают в граф на самом деле.

import { describe, expect, it } from 'vitest';
import { asLabelId, asUserId } from './ids';
import { N, T, apply, block, build, errorOf, task } from './test-helpers';
import { LIMITS } from './types';
import type { NodePatch, Op, TaskPatch } from './types';

const graph = build(block('a'), task('t', 'a'));
const updateNode = (patch: NodePatch): Op => ({ kind: 'updateNode', id: N('a'), patch });
const updateTask = (patch: TaskPatch): Op => ({ kind: 'updateTask', id: T('t'), patch });
const errorField = (op: Op) => {
  const result = apply(graph, op);
  return result.ok ? 'ok' : result.error;
};
const invalid = (field: string, reason: string) => ({ code: 'INVALID_VALUE', field, reason });

describe('текст', () => {
  it('название до 200 символов, пустое допустимо', () => {
    const max = 'я'.repeat(LIMITS.titleMaxLength);
    expect(errorField(updateNode({ title: max }))).toBe('ok');
    expect(errorField(updateTask({ title: '' }))).toBe('ok');
    expect(errorField(updateNode({ title: `${max}!` }))).toEqual(invalid('title', 'too_long'));
    expect(errorField(updateTask({ title: `${max}!` }))).toEqual(invalid('title', 'too_long'));
  });

  it('описание до 20 000 символов', () => {
    const tooLong = 'x'.repeat(LIMITS.descriptionMaxLength + 1);
    expect(errorField(updateNode({ description: tooLong }))).toEqual(
      invalid('description', 'too_long'),
    );
    expect(errorField(updateTask({ description: tooLong }))).toEqual(
      invalid('description', 'too_long'),
    );
  });
});

describe('списки', () => {
  const labels = (n: number) => Array.from({ length: n }, (_, i) => asLabelId(`l${i}`));
  const users = (n: number) => Array.from({ length: n }, (_, i) => asUserId(`u${i}`));

  it('метки: до 20, без повторов', () => {
    expect(errorField(updateNode({ labelIds: labels(LIMITS.maxLabels) }))).toBe('ok');
    expect(errorField(updateNode({ labelIds: labels(LIMITS.maxLabels + 1) }))).toEqual(
      invalid('labelIds', 'too_many'),
    );
    expect(errorField(updateTask({ labelIds: [asLabelId('x'), asLabelId('x')] }))).toEqual(
      invalid('labelIds', 'duplicate'),
    );
  });

  it('ответственные: до 10, без повторов', () => {
    expect(errorField(updateTask({ assigneeIds: users(LIMITS.maxAssignees) }))).toBe('ok');
    expect(errorField(updateTask({ assigneeIds: users(LIMITS.maxAssignees + 1) }))).toEqual(
      invalid('assigneeIds', 'too_many'),
    );
    expect(errorField(updateTask({ assigneeIds: [asUserId('u'), asUserId('u')] }))).toEqual(
      invalid('assigneeIds', 'duplicate'),
    );
  });
});

describe('срок', () => {
  const date = (value: string) => updateTask({ deadline: { kind: 'date', date: value } });
  const at = (value: string) => updateNode({ deadline: { kind: 'datetime', at: value } });

  it('дата — существующая календарная дата YYYY-MM-DD', () => {
    expect(errorField(date('2028-02-29'))).toBe('ok');
    for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-2-3', '05.11.2026', '']) {
      expect(errorField(date(bad)), bad).toEqual(invalid('deadline', 'bad_format'));
    }
  });

  it('дата со временем — момент в UTC ровно в виде toISOString()', () => {
    expect(errorField(at('2026-11-05T10:00:00.000Z'))).toBe('ok');
    for (const bad of [
      '2026-11-05T10:00Z',
      '2026-11-05T10:00:00Z',
      '2026-11-05T13:00:00.000+03:00',
      '2026-11-05',
      'завтра',
    ]) {
      expect(errorField(at(bad)), bad).toEqual(invalid('deadline', 'bad_format'));
    }
  });
});

describe('оценка', () => {
  it('неотрицательное конечное число, дробное допустимо', () => {
    expect(errorField(updateTask({ estimate: 0 }))).toBe('ok');
    expect(errorField(updateTask({ estimate: 1.5 }))).toBe('ok');
    expect(errorField(updateTask({ estimate: null }))).toBe('ok');
    expect(errorField(updateTask({ estimate: -1 }))).toEqual(invalid('estimate', 'negative'));
    expect(errorField(updateTask({ estimate: Number.NaN }))).toEqual(
      invalid('estimate', 'bad_format'),
    );
    expect(errorField(updateTask({ estimate: Number.POSITIVE_INFINITY }))).toEqual(
      invalid('estimate', 'bad_format'),
    );
  });

  it('не больше двух знаков после запятой', () => {
    for (const ok of [0.25, 0.07, 1.13, 0.1, 0.29, 12345.67]) {
      expect(errorField(updateTask({ estimate: ok }))).toBe('ok');
    }
    for (const tooPrecise of [0.333, 1.005, 0.001]) {
      expect(errorField(updateTask({ estimate: tooPrecise }))).toEqual(
        invalid('estimate', 'too_precise'),
      );
    }
  });
});

describe('ошибка не меняет граф', () => {
  it('операция с ошибкой ничего не возвращает, а входной граф заморожен и цел', () => {
    const before = JSON.stringify(graph);
    expect(errorOf(apply(graph, updateTask({ estimate: -1 }))).code).toBe('INVALID_VALUE');
    expect(JSON.stringify(graph)).toBe(before);
  });
});
