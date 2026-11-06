import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  LATER,
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
  milestone,
  must,
  roadmap,
  task,
  taskEdge,
} from './test-helpers';
import { asUserId } from './ids';
import type { Op, TaskPatch } from './types';

describe('createTask', () => {
  it('создаёт задачу без номера и предупреждений, с авторством', () => {
    const graph = build(block('a'));
    const next = applyOk(graph, task('t', 'a', { status: 'in_progress' }), ctx('member'));
    expect(next.tasks.get(T('t'))).toEqual({
      id: 't',
      blockId: 'a',
      order: 'a0',
      number: null,
      title: 't',
      description: '',
      status: 'in_progress',
      assigneeIds: [],
      deadline: null,
      priority: 'none',
      labelIds: [],
      estimate: null,
      warnings: [],
      createdBy: 'member',
      createdAt: NOW,
      updatedBy: 'member',
      updatedAt: NOW,
    });
    expect(next.nodes).toBe(graph.nodes);
    expect(next.edges).toBe(graph.edges);
  });

  it('задачи лежат только в блоках → WRONG_NODE_TYPE', () => {
    const graph = build(roadmap('r'), milestone('m'));
    expect(errorOf(apply(graph, task('t', 'r')))).toEqual({
      code: 'WRONG_NODE_TYPE',
      id: 'r',
      expected: 'block',
    });
    expect(errorOf(apply(graph, task('t', 'm')))).toEqual({
      code: 'WRONG_NODE_TYPE',
      id: 'm',
      expected: 'block',
    });
  });

  it('блок не найден → NODE_NOT_FOUND', () => {
    expect(errorOf(apply(EMPTY, task('t', 'nope')))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'nope',
    });
  });

  it('занятый id → DUPLICATE_ID', () => {
    const graph = build(block('a'), task('t', 'a'));
    expect(errorOf(apply(graph, task('t', 'a')))).toEqual({ code: 'DUPLICATE_ID', id: 't' });
  });

  it('порядок: пустой или слишком длинный → INVALID_VALUE', () => {
    const graph = build(block('a'));
    expect(errorOf(apply(graph, task('t', 'a', { order: '' })))).toEqual({
      code: 'INVALID_VALUE',
      field: 'order',
      reason: 'bad_format',
    });
    expect(errorOf(apply(graph, task('t', 'a', { order: 'a'.repeat(129) })))).toEqual({
      code: 'INVALID_VALUE',
      field: 'order',
      reason: 'too_long',
    });
  });

  it('лишнее из сообщения (номер, предупреждения, авторство) в задачу не попадает', () => {
    const graph = build(block('a'));
    const op = {
      kind: 'createTask',
      task: {
        ...(task('t', 'a') as Extract<Op, { kind: 'createTask' }>).task,
        number: 999,
        warnings: [{ sourceTaskId: 'x', at: NOW }],
        createdBy: 'someone-else',
      },
    } as unknown as Op;
    expect(applyOk(graph, op).tasks.get(T('t'))).toMatchObject({
      number: null,
      warnings: [],
      createdBy: 'master',
    });
  });
});

describe('updateTask', () => {
  it('меняет поля и отмечает автора; остальные задачи — те же объекты', () => {
    const graph = build(block('a'), task('t1', 'a'), task('t2', 'a'));
    const patch: TaskPatch = {
      title: 'Логин',
      assigneeIds: [asUserId('u1'), asUserId('u2')],
      priority: 'high',
      estimate: 3,
    };
    const next = applyOk(
      graph,
      { kind: 'updateTask', id: T('t1'), patch },
      ctx('member', {}, LATER),
    );
    expect(next.tasks.get(T('t1'))).toMatchObject({
      ...patch,
      createdBy: 'master',
      createdAt: NOW,
      updatedBy: 'member',
      updatedAt: LATER,
    });
    expect(next.tasks.get(T('t2'))).toBe(graph.tasks.get(T('t2')));
    expect(next.nodes).toBe(graph.nodes);
    expect(next.edges).toBe(graph.edges);
  });

  it('без новых значений — тот же граф', () => {
    const graph = build(block('a'), task('t', 'a'));
    const op: Op = { kind: 'updateTask', id: T('t'), patch: { title: 't', status: 'todo' } };
    expect(applyOk(graph, op, ctx('member', {}, LATER))).toBe(graph);
  });

  it('задача не найдена → TASK_NOT_FOUND', () => {
    const op: Op = { kind: 'updateTask', id: T('nope'), patch: { title: 'x' } };
    expect(errorOf(apply(EMPTY, op))).toEqual({ code: 'TASK_NOT_FOUND', id: 'nope' });
  });

  it('поля вне изменения (блок, номер, предупреждения) не меняются', () => {
    const graph = build(block('a'), block('b'), task('t', 'a'));
    const patch = { title: 'X', blockId: 'b', number: 5, warnings: [] } as unknown as TaskPatch;
    const next = applyOk(graph, { kind: 'updateTask', id: T('t'), patch });
    expect(next.tasks.get(T('t'))).toMatchObject({ title: 'X', blockId: 'a', number: null });
  });
});

describe('moveTask', () => {
  const move = (id: string, blockId: string, order: string): Op => ({
    kind: 'moveTask',
    id: T(id),
    blockId: N(blockId),
    order,
  });

  it('меняет порядок внутри блока, авторство не трогает', () => {
    const graph = build(block('a'), task('t', 'a', { order: 'a0' }));
    const next = applyOk(graph, move('t', 'a', 'a5'), ctx('member', {}, LATER));
    expect(next.tasks.get(T('t'))).toMatchObject({ order: 'a5', updatedAt: NOW });
  });

  it('переносит в другой блок, в том числе на другой уровень, с полями и стрелками', () => {
    const graph = build(
      block('a'),
      block('c'),
      roadmap('r'),
      block('in', { parent: 'r' }),
      task('t', 'a', { status: 'done' }),
      taskEdge('tc', 't', 'c'),
    );
    const next = applyOk(graph, move('t', 'in', 'b0'));
    expect(next.tasks.get(T('t'))).toEqual({
      ...must(graph.tasks.get(T('t'))),
      blockId: 'in',
      order: 'b0',
    });
    expect(next.edges).toBe(graph.edges);
  });

  it('стрелка задачи в новый блок стала бы петлёй → SELF_LOOP', () => {
    const graph = build(block('a'), block('b'), task('t', 'a'), taskEdge('tb', 't', 'b'));
    expect(errorOf(apply(graph, move('t', 'b', 'a0')))).toEqual({
      code: 'SELF_LOOP',
      edgeId: 'tb',
    });
  });

  it('стрелка задачи из нового блока замкнула бы цикл → CYCLE', () => {
    // a → b (стрелка от задачи t), b → c. Перенос t в c даёт c → b → c.
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      task('t', 'a'),
      taskEdge('tb', 't', 'b'),
      edge('bc', 'b', 'c'),
    );
    const error = errorOf(apply(graph, move('t', 'c', 'a0')));
    expect(error.code).toBe('CYCLE');
    expect(error.code === 'CYCLE' && [...error.path].sort()).toEqual(['b', 'c']);
  });

  it('не в блок → WRONG_NODE_TYPE; задача не найдена → TASK_NOT_FOUND', () => {
    const graph = build(block('a'), milestone('m'), task('t', 'a'));
    expect(errorOf(apply(graph, move('t', 'm', 'a0')))).toEqual({
      code: 'WRONG_NODE_TYPE',
      id: 'm',
      expected: 'block',
    });
    expect(errorOf(apply(graph, move('nope', 'a', 'a0')))).toEqual({
      code: 'TASK_NOT_FOUND',
      id: 'nope',
    });
  });

  it('то же место — тот же граф', () => {
    const graph = build(block('a'), task('t', 'a', { order: 'a0' }));
    expect(applyOk(graph, move('t', 'a', 'a0'))).toBe(graph);
  });
});

describe('deleteTask', () => {
  it('удаляет задачу и её стрелки, остальное не трогает', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t1', 'a'),
      task('t2', 'a'),
      taskEdge('t1b', 't1', 'b'),
      taskEdge('t2b', 't2', 'b'),
      edge('ab', 'a', 'b'),
    );
    const next = applyOk(graph, { kind: 'deleteTask', id: T('t1') });
    expect([...next.tasks.keys()]).toEqual(['t2']);
    expect([...next.edges.keys()].sort()).toEqual(['ab', 't2b']);
    expect(next.nodes).toBe(graph.nodes);
    expect(next.tasks.get(T('t2'))).toBe(graph.tasks.get(T('t2')));
  });

  it('задача не найдена → TASK_NOT_FOUND', () => {
    expect(errorOf(apply(EMPTY, { kind: 'deleteTask', id: T('nope') }))).toEqual({
      code: 'TASK_NOT_FOUND',
      id: 'nope',
    });
  });
});
