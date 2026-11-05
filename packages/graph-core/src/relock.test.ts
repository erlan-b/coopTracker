// Выполненная нода снова становится невыполненной: предупреждения, «не блокировать» (keepDone),
// пометка «засчитано» и превью для диалога (DESIGN.md, «Когда выполненное снова не выполнено»).

import { describe, expect, it } from 'vitest';
import { previewRelock } from './apply';
import {
  LATER,
  N,
  NOW,
  T,
  apply,
  applyOk,
  block,
  build,
  ctx,
  deepFreeze,
  edge,
  errorOf,
  roadmap,
  setStatus,
  task,
} from './test-helpers';
import type { ApplyContext, Graph, Op } from './types';

const keep = (op: Op): Op => ({ ...op, keepDone: true });
const sourcesOf = (graph: Graph, id: string) =>
  graph.tasks[T(id)]?.warnings.map(({ source }) =>
    source.kind === 'task' ? `task:${source.taskId}` : `node:${source.nodeId}`,
  );
const countedOf = (graph: Graph, id: string) => graph.nodes[N(id)]?.countedDone;

/** a (a1 выполнена) → b (b1 в работе, b2 не начата). a выполнен, b доступен. */
const base = build(
  block('a'),
  block('b'),
  task('a1', 'a', { status: 'done' }),
  task('b1', 'b', { status: 'in_progress' }),
  task('b2', 'b'),
  edge('ab', 'a', 'b'),
);

/** Роадмапа r (блок in с выполненной i1) → y (y1 в работе). r выполнена. */
const withRoadmap = build(
  roadmap('r'),
  block('in', { parent: 'r' }),
  task('i1', 'in', { status: 'done' }),
  block('y'),
  task('y1', 'y', { status: 'in_progress' }),
  edge('ry', 'r', 'y'),
);

/** base и блок x с невыполненной x1, который пока ни с чем не связан. */
const withX = [block('x'), task('x1', 'x')].reduce((g, op) => applyOk(g, op), base);

describe('выполненная нода снова становится невыполненной', () => {
  it('новая невыполненная задача: последующее блокируется, начатое получает предупреждение', () => {
    const next = applyOk(base, task('a2', 'a'), ctx('member', {}, LATER));
    expect(next.tasks[T('b1')]?.warnings).toEqual([
      { source: { kind: 'node', nodeId: 'a' }, at: LATER },
    ]);
    expect(next.tasks[T('b2')]).toBe(base.tasks[T('b2')]);
    expect(countedOf(next, 'a')).toBeNull();
  });

  it('новая выполненная задача ничего не блокирует', () => {
    const next = applyOk(base, task('a2', 'a', { status: 'done' }));
    expect(next.tasks[T('b1')]).toBe(base.tasks[T('b1')]);
  });

  it('перенос невыполненной задачи в выполненный блок', () => {
    const next = applyOk(base, { kind: 'moveTask', id: T('b2'), blockId: N('a'), order: 'b0' });
    expect(sourcesOf(next, 'b1')).toEqual(['node:a']);
  });

  it('стрелка от невыполненного: блокируется то, что после блока, но не его задачи', () => {
    const next = applyOk(withX, edge('xa', 'x', 'a'));
    expect(sourcesOf(next, 'b1')).toEqual(['node:a']);
    expect(next.tasks[T('a1')]).toBe(withX.tasks[T('a1')]);
  });

  it('новый блок внутри выполненной роадмапы', () => {
    const next = applyOk(withRoadmap, block('new', { parent: 'r' }));
    expect(sourcesOf(next, 'y1')).toEqual(['node:r']);
  });

  it('удаление последней задачи: блок становится «пусто»', () => {
    const next = applyOk(base, { kind: 'deleteTask', id: T('a1') });
    expect(sourcesOf(next, 'b1')).toEqual(['node:a']);
  });

  it('источник предупреждения — первая в цепочке нода, которая перестала быть выполненной', () => {
    const next = applyOk(withRoadmap, task('i2', 'in'));
    expect(sourcesOf(next, 'y1')).toEqual(['node:in']);
  });

  it('если блок и так был заблокирован, он ничего не теряет — предупреждений нет', () => {
    const locked = applyOk(withX, edge('xa', 'x', 'a'));
    const next = applyOk(locked, { kind: 'dismissWarnings', taskId: T('b1'), scope: 'this' });
    const added = applyOk(next, task('a2', 'a'));
    expect(added.tasks[T('b1')]).toBe(next.tasks[T('b1')]);
  });
});

describe('«не блокировать» (keepDone)', () => {
  it('нода получает «засчитано», последующее не блокируется, предупреждений нет', () => {
    const next = applyOk(base, keep(task('a2', 'a')), ctx('member', {}, LATER));
    expect(countedOf(next, 'a')).toEqual({ by: 'member', at: LATER });
    expect(next.tasks[T('b1')]).toBe(base.tasks[T('b1')]);
  });

  it('пометку получает только первая в цепочке нода', () => {
    const next = applyOk(withRoadmap, keep(task('i2', 'in')));
    expect(countedOf(next, 'in')).not.toBeNull();
    expect(countedOf(next, 'r')).toBeNull();
    expect(next.tasks[T('y1')]).toBe(withRoadmap.tasks[T('y1')]);
  });

  it('работает для стрелки, нового блока в роадмапе и удаления последней задачи', () => {
    expect(countedOf(applyOk(withX, keep(edge('xa', 'x', 'a'))), 'a')).not.toBeNull();
    expect(
      countedOf(applyOk(withRoadmap, keep(block('new', { parent: 'r' }))), 'r'),
    ).not.toBeNull();
    const deleted = applyOk(base, keep({ kind: 'deleteTask', id: T('a1') }));
    expect(countedOf(deleted, 'a')).not.toBeNull();
  });

  it('если ничего не блокируется, флаг ничего не делает', () => {
    const next = applyOk(base, keep(task('a2', 'a', { status: 'done' })));
    expect(countedOf(next, 'a')).toBeNull();
    expect(next.nodes).toBe(base.nodes);
  });

  it('пометка снимается сама, когда нода снова выполнена, и следующее изменение снова блокирует', () => {
    const counted = applyOk(base, keep(task('a2', 'a')));
    const finished = applyOk(counted, setStatus('a2', 'done'));
    expect(countedOf(finished, 'a')).toBeNull();
    const again = applyOk(finished, task('a3', 'a'));
    expect(sourcesOf(again, 'b1')).toEqual(['node:a']);
  });

  it('пометку можно снять вручную — тогда последующее блокируется', () => {
    const counted = applyOk(base, keep(task('a2', 'a')));
    const op: Op = { kind: 'updateNode', id: N('a'), patch: { countedDone: null } };
    const cleared = applyOk(counted, op, ctx('member', {}, LATER));
    expect(cleared.nodes[N('a')]).toMatchObject({ countedDone: null, updatedBy: 'member' });
    expect(sourcesOf(cleared, 'b1')).toEqual(['node:a']);
  });

  it('поставить пометку правкой нельзя → INVALID_VALUE', () => {
    const op = {
      kind: 'updateNode',
      id: N('a'),
      patch: { countedDone: { by: 'master', at: NOW } },
    } as unknown as Op;
    expect(errorOf(apply(base, op))).toEqual({
      code: 'INVALID_VALUE',
      field: 'countedDone',
      reason: 'bad_format',
    });
  });

  it('переоткрытие задачи в «засчитанном» блоке не блокирует то, что после блока', () => {
    const counted = applyOk(base, keep(task('a2', 'a')));
    const next = applyOk(counted, setStatus('a1', 'todo'));
    expect(next.tasks[T('b1')]).toBe(counted.tasks[T('b1')]);
  });
});

describe('previewRelock', () => {
  const preview = (graph: Graph, op: Op, context: ApplyContext = ctx()) =>
    previewRelock(deepFreeze(graph), deepFreeze(op), context);

  it('говорит, какие ноды перестанут быть выполненными и какие задачи заблокируются', () => {
    expect(preview(base, task('a2', 'a'))).toEqual({
      ok: true,
      value: { nodes: ['a'], tasks: ['b1', 'b2'] },
    });
    expect(preview(withRoadmap, task('i2', 'in'))).toEqual({
      ok: true,
      value: { nodes: ['in'], tasks: ['y1'] },
    });
  });

  it('пусто, если спрашивать не о чем', () => {
    const empty = { ok: true, value: { nodes: [], tasks: [] } };
    expect(preview(base, task('a2', 'a', { status: 'done' }))).toEqual(empty);
    expect(preview(base, { kind: 'moveNodes', moves: [{ id: N('a'), x: 5, y: 5 }] })).toEqual(
      empty,
    );
  });

  it('ошибки — те же, что у applyOp', () => {
    expect(preview(base, task('a2', 'nope'))).toEqual({
      ok: false,
      error: { code: 'NODE_NOT_FOUND', id: 'nope' },
    });
    expect(preview(base, task('a2', 'a'), ctx('viewer'))).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', reason: 'viewer' },
    });
  });
});
