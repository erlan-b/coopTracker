// Состояния для интерфейса (DESIGN.md, «Вычисляемые состояния», «Задачи не по порядку»,
// «Просрочка», «Сводка блока»).

import { describe, expect, it } from 'vitest';
import { asUserId } from './ids';
import { graphStates } from './states';
import type { GraphStates, Now } from './states';
import {
  N,
  T,
  applyOk,
  block,
  build,
  ctx,
  edge,
  milestone,
  must,
  roadmap,
  setStatus,
  task,
} from './test-helpers';
import type { Deadline, Graph, GraphSettings, Op } from './types';

const REVIEW: GraphSettings = { statusMode: 'review', reviewUnlocks: false };
const NOW: Now = { at: '2026-11-15T12:00:00.000Z', today: '2026-11-15' };

const states = (graph: Graph, settings: GraphSettings = REVIEW, now: Now = NOW) =>
  graphStates(graph, settings, now);
const taskOf = (s: GraphStates, id: string) => must(s.tasks.get(T(id)));
const nodeOf = (s: GraphStates, id: string) => must(s.nodes.get(N(id)));

const taskDeadline = (id: string, deadline: Deadline): Op => ({
  kind: 'updateTask',
  id: T(id),
  patch: { deadline },
});
const nodeDeadline = (id: string, deadline: Deadline): Op => ({
  kind: 'updateNode',
  id: N(id),
  patch: { deadline },
});
const keep = (op: Op): Op => ({ ...op, keepDone: true });
const master = ctx('master', REVIEW);

/** a (a1 ✓, a2) → b (b1, b2 в работе, b3 ✓, b4 на проверке). a не выполнен, b заблокирован. */
const chain = build(
  block('a'),
  task('a1', 'a', { status: 'done' }),
  task('a2', 'a'),
  block('b'),
  task('b1', 'b'),
  task('b2', 'b', { status: 'in_progress' }),
  task('b3', 'b', { status: 'done' }),
  task('b4', 'b', { status: 'in_review' }),
  edge('ab', 'a', 'b'),
);

describe('состояния задач', () => {
  it('по статусу; не начатая — по своему блоку', () => {
    const s = states(chain);
    expect(taskOf(s, 'a1').state).toBe('done');
    expect(taskOf(s, 'a2').state).toBe('available');
    expect(taskOf(s, 'b1').state).toBe('locked');
    expect(taskOf(s, 'b2').state).toBe('in_progress');
    expect(taskOf(s, 'b3').state).toBe('done');
    expect(taskOf(s, 'b4').state).toBe('in_review');
  });

  it('«Досрочно» — начатая или выполненная в заблокированном блоке', () => {
    const s = states(chain);
    expect(['b1', 'b2', 'b3', 'b4'].map((id) => taskOf(s, id).early)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(taskOf(s, 'a1').early).toBe(false);
  });

  it('«на проверке» остаётся на проверке, а разблокирует дальше только при reviewUnlocks', () => {
    expect(taskOf(states(chain), 'b4')).toMatchObject({ state: 'in_review', unblocks: false });
    const unlocks = states(chain, { statusMode: 'review', reviewUnlocks: true });
    expect(taskOf(unlocks, 'b4')).toMatchObject({ state: 'in_review', unblocks: true });
    expect(taskOf(unlocks, 'b3').unblocks).toBe(true);
  });
});

describe('состояния нод', () => {
  it('блок: заблокирован → выполнен → пусто → в работе → доступен', () => {
    const graph = build(
      block('started'),
      task('s1', 'started', { status: 'done' }),
      task('s2', 'started'),
      block('fresh'),
      task('f1', 'fresh'),
      block('finished'),
      task('x1', 'finished', { status: 'done' }),
      block('empty'),
      block('waits'),
      edge('sw', 'started', 'waits'),
    );
    const s = states(graph);
    expect(nodeOf(s, 'started').state).toBe('in_progress');
    expect(nodeOf(s, 'fresh').state).toBe('available');
    expect(nodeOf(s, 'finished')).toMatchObject({ state: 'done', unblocks: true });
    expect(nodeOf(s, 'empty')).toMatchObject({ state: 'empty', unblocks: false });
    // Пустой, но заблокированный — заблокирован.
    expect(nodeOf(s, 'waits').state).toBe('locked');
  });

  it('роадмапа: по нодам внутри и своим входам', () => {
    const graph = build(
      roadmap('done-r'),
      block('d', { parent: 'done-r' }),
      task('d1', 'd', { status: 'done' }),
      roadmap('busy'),
      block('w', { parent: 'busy' }),
      task('w1', 'w', { status: 'in_progress' }),
      roadmap('idle'),
      block('i', { parent: 'idle' }),
      task('i1', 'i'),
      roadmap('empty-r'),
      edge('busy-idle', 'busy', 'idle'),
    );
    const s = states(graph);
    expect(nodeOf(s, 'done-r').state).toBe('done');
    expect(nodeOf(s, 'busy').state).toBe('in_progress');
    expect(nodeOf(s, 'idle').state).toBe('locked');
    expect(nodeOf(s, 'i').state).toBe('locked');
    expect(nodeOf(s, 'empty-r').state).toBe('empty');
  });

  it('milestone: без входов — пусто; входы выполнены — выполнен; иначе заблокирован', () => {
    const graph = build(
      block('a'),
      task('a1', 'a', { status: 'done' }),
      block('b'),
      task('b1', 'b'),
      milestone('lonely'),
      milestone('reached'),
      milestone('waiting'),
      edge('a-reached', 'a', 'reached'),
      edge('b-waiting', 'b', 'waiting'),
    );
    const s = states(graph);
    expect(nodeOf(s, 'lonely').state).toBe('empty');
    expect(nodeOf(s, 'reached').state).toBe('done');
    expect(nodeOf(s, 'waiting').state).toBe('locked');
    expect(nodeOf(s, 'reached').summary).toBeNull();
  });

  it('«засчитанная» нода показывает настоящее состояние, а дальше пропускает', () => {
    const base = build(
      block('t'),
      task('t1', 't', { status: 'done' }),
      block('u'),
      task('u1', 'u'),
      edge('tu', 't', 'u'),
    );
    const counted = applyOk(base, keep(task('t2', 't')), master);
    const s = states(counted);
    expect(nodeOf(s, 't')).toMatchObject({ state: 'in_progress', unblocks: true });
    expect(nodeOf(s, 'u').state).toBe('available');
    // Последнюю задачу удалили с «не блокировать»: блок пуст, но всё ещё пропускает дальше.
    const emptied = applyOk(base, keep({ kind: 'deleteTask', id: T('t1') }), master);
    expect(nodeOf(states(emptied), 't')).toMatchObject({ state: 'empty', unblocks: true });
  });
});

describe('просрочка', () => {
  const date: Deadline = { kind: 'date', date: '2026-11-15' };
  const moment: Deadline = { kind: 'datetime', at: '2026-11-15T12:00:00.000Z' };
  const graph = [
    taskDeadline('a2', date),
    taskDeadline('b4', date),
    taskDeadline('a1', date),
    taskDeadline('b2', moment),
    nodeDeadline('a', date),
    nodeDeadline('b', moment),
  ].reduce((g, op) => applyOk(g, op, master), chain);
  const later = (patch: Partial<Now>): Now => ({ ...NOW, ...patch });

  it('срок-дата: весь день в срок, просрочено со следующего дня по поясу смотрящего', () => {
    expect(taskOf(states(graph), 'a2').overdue).toBe(false);
    expect(taskOf(states(graph, REVIEW, later({ today: '2026-11-16' })), 'a2').overdue).toBe(true);
  });

  it('срок со временем: просрочено сразу после этого момента', () => {
    expect(taskOf(states(graph), 'b2').overdue).toBe(false);
    const after = later({ at: '2026-11-15T12:00:00.001Z' });
    expect(taskOf(states(graph, REVIEW, after), 'b2').overdue).toBe(true);
  });

  it('выполненная задача не просрочена, «на проверке» — просрочена', () => {
    const s = states(graph, REVIEW, later({ today: '2026-11-16' }));
    expect(taskOf(s, 'a1').overdue).toBe(false);
    expect(taskOf(s, 'b4').overdue).toBe(true);
  });

  it('нода просрочена, если прошёл её срок, а она не выполнена', () => {
    const next = later({ today: '2026-11-16', at: '2026-11-16T00:00:00.000Z' });
    expect(nodeOf(states(graph, REVIEW, next), 'a').overdue).toBe(true);
    expect(nodeOf(states(graph, REVIEW, next), 'b').overdue).toBe(true);
    const done = applyOk(graph, setStatus('a2', 'done'), master);
    expect(nodeOf(states(done, REVIEW, next), 'a').overdue).toBe(false);
  });
});

describe('сводка', () => {
  const u = asUserId;
  const graph = [
    { kind: 'updateTask', id: T('b1'), patch: { estimate: 3, assigneeIds: [u('u2'), u('u1')] } },
    { kind: 'updateTask', id: T('b3'), patch: { estimate: 2, assigneeIds: [u('u1')] } },
    { kind: 'updateTask', id: T('b4'), patch: { estimate: 0.5 } },
  ].reduce<Graph>((g, op) => applyOk(g, op as Op, master), chain);

  it('блок: по статусам, оценки и сколько осталось, ответственные без повторов', () => {
    expect(nodeOf(states(graph), 'b').summary).toEqual({
      total: 4,
      byStatus: { todo: 1, in_progress: 1, in_review: 1, done: 1 },
      estimate: 5.5,
      estimateLeft: 3.5,
      unestimated: 1,
      assigneeIds: ['u1', 'u2'],
    });
  });

  it('роадмапа: по всем блокам внутри', () => {
    const withRoadmap = [
      roadmap('r'),
      block('in1', { parent: 'r' }),
      task('i1', 'in1', { status: 'done' }),
      block('in2', { parent: 'r' }),
      task('i2', 'in2'),
      task('i3', 'in2', { status: 'in_progress' }),
      milestone('m', { parent: 'r' }),
    ].reduce((g, op) => applyOk(g, op, master), build());
    expect(nodeOf(states(withRoadmap), 'r').summary).toMatchObject({
      total: 3,
      byStatus: { todo: 1, in_progress: 1, in_review: 0, done: 1 },
    });
  });
});

describe('без лишних перерисовок', () => {
  it('тот же граф и тот же момент — тот же результат', () => {
    expect(states(chain)).toBe(states(chain));
  });

  it('правка, которая состояний не меняет, возвращает прошлый результат целиком', () => {
    const before = states(chain);
    const renamed = applyOk(chain, {
      kind: 'updateTask',
      id: T('b1'),
      patch: { title: 'Новое' },
    });
    expect(graphStates(renamed, REVIEW, NOW, before)).toBe(before);
  });

  it('смена статуса пересоздаёт только задетое', () => {
    const graph = applyOk(chain, block('c'));
    const before = states(graph);
    const after = graphStates(
      applyOk(graph, setStatus('b1', 'in_progress'), master),
      REVIEW,
      NOW,
      before,
    );
    expect(after).not.toBe(before);
    expect(taskOf(after, 'b1')).not.toBe(taskOf(before, 'b1'));
    expect(nodeOf(after, 'b')).not.toBe(nodeOf(before, 'b')); // сводка изменилась
    for (const id of ['a1', 'a2', 'b2', 'b3', 'b4'])
      expect(taskOf(after, id)).toBe(taskOf(before, id));
    expect(nodeOf(after, 'a')).toBe(nodeOf(before, 'a'));
    expect(nodeOf(after, 'c')).toBe(nodeOf(before, 'c'));
  });

  it('новый момент пересоздаёт только то, что стало просроченным', () => {
    const graph = applyOk(chain, taskDeadline('a2', { kind: 'date', date: '2026-11-15' }), master);
    const before = states(graph);
    const after = graphStates(graph, REVIEW, { ...NOW, today: '2026-11-16' }, before);
    expect(taskOf(after, 'a2')).not.toBe(taskOf(before, 'a2'));
    expect(taskOf(after, 'a1')).toBe(taskOf(before, 'a1'));
    expect(nodeOf(after, 'a')).toBe(nodeOf(before, 'a'));
  });
});
