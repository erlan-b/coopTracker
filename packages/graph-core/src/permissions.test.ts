// Права и правила статусов (DESIGN.md, «Роли», «Настройки envi», инвариант 7).

import { describe, expect, it } from 'vitest';
import {
  E,
  N,
  NOW,
  T,
  apply,
  applyOk,
  block,
  build,
  ctx,
  edge,
  errorOf,
  must,
  setStatus,
  task,
} from './test-helpers';
import type { Op, OpKind } from './types';

describe('viewer', () => {
  const graph = build(block('a'), block('b'), task('t', 'a'), edge('ab', 'a', 'b'));

  // Пример каждой операции. Тип требует все виды операций: новая операция без примера
  // здесь — ошибка компиляции, и проверка прав для неё не забудется.
  const samples: { readonly [K in OpKind]: Extract<Op, { kind: K }> } = {
    createNode: block('c') as Extract<Op, { kind: 'createNode' }>,
    updateNode: { kind: 'updateNode', id: N('a'), patch: { title: 'x' } },
    moveNodes: { kind: 'moveNodes', moves: [{ id: N('a'), x: 1, y: 1 }] },
    deleteNode: { kind: 'deleteNode', id: N('a') },
    blockToRoadmap: { kind: 'blockToRoadmap', id: N('a'), innerBlockId: N('i') },
    roadmapToBlock: { kind: 'roadmapToBlock', id: N('a') },
    createTask: task('t2', 'a') as Extract<Op, { kind: 'createTask' }>,
    updateTask: { kind: 'updateTask', id: T('t'), patch: { title: 'x' } },
    moveTask: { kind: 'moveTask', id: T('t'), blockId: N('b'), order: 'a0' },
    deleteTask: { kind: 'deleteTask', id: T('t') },
    createEdge: edge('ba', 'b', 'a') as Extract<Op, { kind: 'createEdge' }>,
    deleteEdge: { kind: 'deleteEdge', id: E('ab') },
    dismissWarnings: { kind: 'dismissWarnings', taskId: T('t'), scope: 'this' },
    restore: { kind: 'restore', nodes: [], tasks: [], edges: [] },
    revert: { kind: 'revert', changes: { at: NOW, nodes: [], tasks: [], edges: [] } },
  };

  it.each(Object.values(samples))('не может $kind → FORBIDDEN', (op) => {
    expect(errorOf(apply(graph, op, ctx('viewer')))).toEqual({
      code: 'FORBIDDEN',
      reason: 'viewer',
    });
  });
});

describe('статусы в режиме free', () => {
  const graph = build(block('a'), task('t', 'a'));

  it('member сразу ставит done', () => {
    expect(applyOk(graph, setStatus('t', 'done'), ctx('member')).tasks[T('t')]?.status).toBe(
      'done',
    );
  });

  it('статуса in_review нет → STATUS_NOT_ALLOWED, и при правке, и при создании', () => {
    expect(errorOf(apply(graph, setStatus('t', 'in_review'), ctx('master')))).toEqual({
      code: 'STATUS_NOT_ALLOWED',
      status: 'in_review',
    });
    expect(errorOf(apply(graph, task('t2', 'a', { status: 'in_review' }), ctx('master')))).toEqual({
      code: 'STATUS_NOT_ALLOWED',
      status: 'in_review',
    });
  });
});

describe('статусы в режиме review', () => {
  const member = ctx('member', { statusMode: 'review' });
  const master = ctx('master', { statusMode: 'review' });
  const forbidden = { code: 'FORBIDDEN', reason: 'review_requires_master' };
  const graph = build(
    block('a'),
    task('todo', 'a'),
    task('review', 'a', { status: 'in_review' }),
    task('done', 'a', { status: 'done' }),
  );
  const statusOf = (op: Op, context: typeof member, id: string) =>
    must(applyOk(graph, op, context).tasks[T(id)]).status;

  it('member отправляет на проверку, но не ставит done → FORBIDDEN', () => {
    expect(statusOf(setStatus('todo', 'in_review'), member, 'todo')).toBe('in_review');
    expect(errorOf(apply(graph, setStatus('review', 'done'), member))).toEqual(forbidden);
    expect(errorOf(apply(graph, setStatus('todo', 'done'), member))).toEqual(forbidden);
    expect(errorOf(apply(graph, task('new', 'a', { status: 'done' }), member))).toEqual(forbidden);
  });

  it('master подтверждает, отклоняет и может ставить done сразу', () => {
    expect(statusOf(setStatus('review', 'done'), master, 'review')).toBe('done');
    expect(statusOf(setStatus('review', 'in_progress'), master, 'review')).toBe('in_progress');
    expect(statusOf(setStatus('todo', 'done'), master, 'todo')).toBe('done');
  });

  it('member может вернуть задачу в работу и править выполненную, не меняя статус', () => {
    expect(statusOf(setStatus('done', 'in_progress'), member, 'done')).toBe('in_progress');
    expect(statusOf(setStatus('review', 'todo'), member, 'review')).toBe('todo');
    const edit: Op = { kind: 'updateTask', id: T('done'), patch: { status: 'done', title: 'X' } };
    expect(applyOk(graph, edit, member).tasks[T('done')]).toMatchObject({
      status: 'done',
      title: 'X',
    });
  });
});
