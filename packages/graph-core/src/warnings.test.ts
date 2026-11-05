// Предупреждение при выходе задачи из выполненного состояния (DESIGN.md) и его снятие.
// Другие причины потери выполненности (новая задача, стрелка и т. п.) — в relock.test.ts.

import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  LATER,
  NOW,
  T,
  apply,
  applyOk,
  block,
  build,
  ctx,
  edge,
  errorOf,
  roadmap,
  setStatus,
  task,
  taskEdge,
} from './test-helpers';
import type { Graph, Op, WarningSource } from './types';

const warningsOf = (graph: Graph, id: string) => graph.tasks[T(id)]?.warnings;
const sourcesOf = (graph: Graph, id: string) =>
  warningsOf(graph, id)?.map(({ source }) =>
    source.kind === 'task' ? `task:${source.taskId}` : `node:${source.nodeId}`,
  );
const fromTask = (id: string): WarningSource => ({ kind: 'task', taskId: T(id) });
const review = (role: 'master' | 'member', reviewUnlocks = false, now = LATER) =>
  ctx(role, { statusMode: 'review', reviewUnlocks }, now);

describe('предупреждение при выходе задачи из выполненного состояния', () => {
  it('ставится задачам после неё по её стрелке — только начатым и выполненным', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t', 'a', { status: 'done' }),
      task('b-progress', 'b', { status: 'in_progress' }),
      task('b-review', 'b', { status: 'in_review' }),
      task('b-done', 'b', { status: 'done' }),
      task('b-todo', 'b'),
      taskEdge('tb', 't', 'b'),
    );
    const next = applyOk(graph, setStatus('t', 'todo'), review('member'));
    const warning = [{ source: fromTask('t'), at: LATER }];
    expect(warningsOf(next, 'b-progress')).toEqual(warning);
    expect(warningsOf(next, 'b-review')).toEqual(warning);
    expect(warningsOf(next, 'b-done')).toEqual(warning);
    expect(next.tasks[T('b-todo')]).toBe(graph.tasks[T('b-todo')]);
    // Статус и авторство задач с предупреждением не меняются.
    expect(next.tasks[T('b-done')]).toMatchObject({
      status: 'done',
      updatedBy: 'master',
      updatedAt: NOW,
    });
  });

  it('ставится по стрелке от блока, если блок был выполнен', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t', 'a', { status: 'done' }),
      task('b1', 'b', { status: 'in_progress' }),
      edge('ab', 'a', 'b'),
    );
    const next = applyOk(graph, setStatus('t', 'in_progress'));
    expect(warningsOf(next, 'b1')).toEqual([{ source: fromTask('t'), at: NOW }]);
  });

  it('по стрелке от блока не ставится, если блок и так не был выполнен', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t', 'a', { status: 'done' }),
      task('other', 'a'),
      task('b1', 'b', { status: 'in_progress' }),
      edge('ab', 'a', 'b'),
    );
    const next = applyOk(graph, setStatus('t', 'todo'));
    expect(next.tasks[T('b1')]).toBe(graph.tasks[T('b1')]);
  });

  it('идёт дальше по цепочке нод', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      task('t', 'a', { status: 'done' }),
      task('c1', 'c', { status: 'in_progress' }),
      taskEdge('tb', 't', 'b'),
      edge('bc', 'b', 'c'),
    );
    const next = applyOk(graph, setStatus('t', 'todo'));
    expect(sourcesOf(next, 'c1')).toEqual(['task:t']);
  });

  it('не идёт по стрелкам других задач заблокированного блока: они остаются выполненными', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      task('t', 'a', { status: 'done' }),
      task('b1', 'b', { status: 'done' }),
      task('c1', 'c', { status: 'in_progress' }),
      taskEdge('tb', 't', 'b'),
      taskEdge('b1c', 'b1', 'c'),
    );
    const next = applyOk(graph, setStatus('t', 'todo'));
    expect(warningsOf(next, 'b1')).toHaveLength(1);
    expect(next.tasks[T('c1')]).toBe(graph.tasks[T('c1')]);
  });

  it('соседние задачи того же блока не получают предупреждение', () => {
    const graph = build(
      block('a'),
      task('t', 'a', { status: 'done' }),
      task('s', 'a', { status: 'in_progress' }),
    );
    const next = applyOk(graph, setStatus('t', 'todo'));
    expect(next.tasks[T('s')]).toBe(graph.tasks[T('s')]);
  });

  it('стрелка в роадмапу — предупреждение получает всё внутри', () => {
    const graph = build(
      block('a'),
      roadmap('r'),
      block('in', { parent: 'r' }),
      task('t', 'a', { status: 'done' }),
      task('i1', 'in', { status: 'in_progress' }),
      taskEdge('tr', 't', 'r'),
    );
    const next = applyOk(graph, setStatus('t', 'todo'));
    expect(warningsOf(next, 'i1')).toHaveLength(1);
  });

  it('блок внутри роадмапы перестал быть выполненным — идёт и по стрелкам от роадмапы', () => {
    const graph = build(
      roadmap('r'),
      block('in', { parent: 'r' }),
      block('x'),
      task('t', 'in', { status: 'done' }),
      task('x1', 'x', { status: 'in_progress' }),
      edge('rx', 'r', 'x'),
    );
    const next = applyOk(graph, setStatus('t', 'todo'));
    expect(sourcesOf(next, 'x1')).toEqual(['task:t']);
  });

  it('master отклонил in_review: предупреждение — только если in_review разблокировал следующие', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t', 'a', { status: 'in_review' }),
      task('b1', 'b', { status: 'in_progress' }),
      taskEdge('tb', 't', 'b'),
    );
    const unlocking = applyOk(graph, setStatus('t', 'in_progress'), review('master', true));
    expect(warningsOf(unlocking, 'b1')).toHaveLength(1);
    const notUnlocking = applyOk(graph, setStatus('t', 'in_progress'), review('master', false));
    expect(notUnlocking.tasks[T('b1')]).toBe(graph.tasks[T('b1')]);
  });

  it('done → in_review при reviewUnlocks: задача остаётся выполненной, предупреждений нет', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t', 'a', { status: 'done' }),
      task('b1', 'b', { status: 'in_progress' }),
      taskEdge('tb', 't', 'b'),
    );
    const next = applyOk(graph, setStatus('t', 'in_review'), review('master', true));
    expect(next.tasks[T('b1')]).toBe(graph.tasks[T('b1')]);
  });

  it('правка названия или описания предупреждений не даёт', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t', 'a', { status: 'done' }),
      task('b1', 'b', { status: 'in_progress' }),
      taskEdge('tb', 't', 'b'),
    );
    const op: Op = { kind: 'updateTask', id: T('t'), patch: { title: 'Новое', description: '…' } };
    expect(applyOk(graph, op).tasks[T('b1')]).toBe(graph.tasks[T('b1')]);
  });

  it('повторное переоткрытие той же задачи не дублирует предупреждение, а обновляет время', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t', 'a', { status: 'done' }),
      task('b1', 'b', { status: 'in_progress' }),
      taskEdge('tb', 't', 'b'),
    );
    const reopened = applyOk(graph, setStatus('t', 'todo'), ctx('master', {}, NOW));
    const doneAgain = applyOk(reopened, setStatus('t', 'done'));
    const reopenedAgain = applyOk(doneAgain, setStatus('t', 'todo'), ctx('master', {}, LATER));
    expect(warningsOf(reopenedAgain, 'b1')).toEqual([{ source: fromTask('t'), at: LATER }]);
  });
});

describe('dismissWarnings', () => {
  // a(t) → b(b1) → c(c1); d(v) → c. Переоткрыты t и v: у b1 предупреждение от t, у c1 — от t и v.
  const graph = [setStatus('t', 'todo'), setStatus('v', 'todo')].reduce(
    (current, op) => applyOk(current, op),
    build(
      block('a'),
      block('b'),
      block('c'),
      block('d'),
      task('t', 'a', { status: 'done' }),
      task('b1', 'b', { status: 'in_progress' }),
      task('c1', 'c', { status: 'in_progress' }),
      task('v', 'd', { status: 'done' }),
      edge('ab', 'a', 'b'),
      edge('bc', 'b', 'c'),
      taskEdge('vc', 'v', 'c'),
    ),
  );
  const dismiss = (id: string, scope: 'this' | 'downstream'): Op => ({
    kind: 'dismissWarnings',
    taskId: T(id),
    scope,
  });

  it('исходное состояние: предупреждения расставлены', () => {
    expect(sourcesOf(graph, 'b1')).toEqual(['task:t']);
    expect(sourcesOf(graph, 'c1')).toEqual(['task:t', 'task:v']);
  });

  it("'this' снимает все предупреждения только у этой задачи", () => {
    const next = applyOk(graph, dismiss('c1', 'this'), ctx('member'));
    expect(warningsOf(next, 'c1')).toEqual([]);
    expect(next.tasks[T('b1')]).toBe(graph.tasks[T('b1')]);
  });

  it("'downstream' снимает у неё и у следующих задач, но только от тех же источников", () => {
    const next = applyOk(graph, dismiss('b1', 'downstream'), ctx('member'));
    expect(warningsOf(next, 'b1')).toEqual([]);
    expect(sourcesOf(next, 'c1')).toEqual(['task:v']);
  });

  it('без предупреждений — тот же граф; задача не найдена → TASK_NOT_FOUND', () => {
    expect(applyOk(graph, dismiss('t', 'downstream'))).toBe(graph);
    expect(errorOf(apply(EMPTY, dismiss('nope', 'this')))).toEqual({
      code: 'TASK_NOT_FOUND',
      id: 'nope',
    });
  });
});
