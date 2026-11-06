// Пакет операций (applyOps) и лимиты размера (LIMITS).

import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from './apply';
import { combineChanges } from './changes';
import type { Result } from './errors';
import {
  N,
  T,
  applyFull,
  applyOpsFull,
  applyOk,
  block,
  build,
  buildLarge,
  ctx,
  deepFreeze,
  edge,
  expectDerivedConsistent,
  setStatus,
  task,
  taskEdge,
} from './test-helpers';
import { LIMITS } from './types';
import type { Graph, Op } from './types';

const base = build(
  block('a'),
  task('a1', 'a', { status: 'done' }),
  block('b'),
  edge('ab', 'a', 'b'),
);

function okValue<V>(result: Result<V>): V {
  if (!result.ok) throw new Error(`отклонено: ${JSON.stringify(result.error)}`);
  return result.value;
}

const batch = (graph: Graph, ops: readonly Op[]) =>
  okValue(applyOps(deepFreeze(graph), deepFreeze(ops), ctx()));

describe('applyOps', () => {
  const ops: readonly Op[] = [
    task('b1', 'b', { status: 'in_progress' }),
    block('c'),
    taskEdge('b1c', 'b1', 'c'),
    setStatus('a1', 'todo'),
  ];

  it('без лишнего — то же, что по очереди, а изменения — одним шагом отмены', () => {
    const together = batch(base, ops);
    let graph = base;
    let changes = null;
    for (const op of ops) {
      const step = okValue(applyFull(graph, op));
      graph = step.graph;
      changes = changes === null ? step.changes : combineChanges(changes, step.changes);
    }
    expect(together.graph).toEqual(graph);
    expect(together.changes).toEqual(changes);
    expect(together.graph.tasks.get(T('b1'))?.warnings).toEqual([
      { source: { kind: 'task', taskId: 'a1' }, at: ctx().now },
    ]);
    expectDerivedConsistent(together.graph);
    const undone = okValue(
      applyFull(together.graph, { kind: 'revert', changes: together.changes }),
    );
    expect(undone.graph).toEqual(base);
  });

  it('всё или ничего: ошибка любой операции отменяет весь пакет', () => {
    const result = applyOps(base, [block('c'), task('x', 'nope')], ctx());
    expect(result).toEqual({ ok: false, error: { code: 'NODE_NOT_FOUND', id: 'nope' } });
  });

  it('туда и обратно в одном пакете — тот же граф и те же объекты', () => {
    const move = (x: number): Op => ({ kind: 'moveNodes', moves: [{ id: N('a'), x, y: 0 }] });
    const result = batch(base, [move(50), move(0)]);
    expect(result.graph).toBe(base);
    expect(result.changes).toEqual({ at: ctx().now, nodes: [], tasks: [], edges: [] });
  });

  it('пустой пакет — тот же граф', () => {
    expect(batch(base, []).graph).toBe(base);
  });

  it('последствия — по итогу пакета: переоткрыли и снова закрыли — предупреждений нет', () => {
    const graph = build(
      block('a'),
      task('a1', 'a', { status: 'done' }),
      block('b'),
      task('b1', 'b', { status: 'in_progress' }),
      edge('ab', 'a', 'b'),
    );
    const result = okValue(applyOpsFull(graph, [setStatus('a1', 'todo'), setStatus('a1', 'done')]));
    expect(result.graph.tasks.get(T('b1'))).toBe(graph.tasks.get(T('b1')));
  });

  it('«не блокировать» у одной операции действует на весь пакет', () => {
    const result = okValue(
      applyOpsFull(base, [block('c'), { ...task('a2', 'a'), keepDone: true }]),
    );
    expect(result.graph.nodes.get(N('a'))?.countedDone).toEqual({ by: 'master', at: ctx().now });
  });

  it('цикл проверяется по итогу пакета: CYCLE, и ничего не применено', () => {
    const result = applyOps(base, [block('c'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a')], ctx());
    expect(result.ok || result.error.code).toBe('CYCLE');
    expect(
      result.ok || [...(result.error.code === 'CYCLE' ? result.error.path : [])].sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it(`не больше ${LIMITS.maxOpsPerBatch} операций в пакете`, () => {
    const ops = Array.from({ length: LIMITS.maxOpsPerBatch + 1 }, (_, i) => block(`n${i}`));
    expect(applyOps(base, ops, ctx())).toEqual({
      ok: false,
      error: { code: 'LIMIT_EXCEEDED', records: 'ops', limit: LIMITS.maxOpsPerBatch },
    });
  });
});

describe('лимиты', () => {
  it('нод в ветке не больше LIMITS.maxNodes', () => {
    const fill = Array.from({ length: LIMITS.maxNodes }, (_, i) => block(`n${i}`));
    const full = buildLarge(fill);
    expect(applyOp(full, block('one-more'), ctx())).toEqual({
      ok: false,
      error: { code: 'LIMIT_EXCEEDED', records: 'nodes', limit: LIMITS.maxNodes },
    });
    // Удалить и создать другую — можно: граф не растёт.
    const removed = applyOk(full, { kind: 'deleteNode', id: N('n0') });
    expect(applyOk(removed, block('one-more')).nodes.size).toBe(LIMITS.maxNodes);
  });

  it(`у задачи не больше ${LIMITS.maxWarnings} предупреждений: уходят самые старые`, () => {
    const count = LIMITS.maxWarnings + 1;
    const sources = Array.from({ length: count }, (_, i) => `s${i}`);
    let graph = batch(build(), [
      block('src'),
      block('dst'),
      task('x', 'dst', { status: 'in_progress' }),
      ...sources.map((id) => task(id, 'src', { status: 'done' })),
      ...sources.map((id) => taskEdge(`${id}-dst`, id, 'dst')),
    ]).graph;
    for (const id of sources) graph = applyOk(graph, setStatus(id, 'todo'));
    const warnings = graph.tasks.get(T('x'))?.warnings ?? [];
    expect(warnings).toHaveLength(LIMITS.maxWarnings);
    expect(warnings.map(({ source }) => source.kind === 'task' && source.taskId)).toEqual(
      sources.slice(1),
    );
  });
});
