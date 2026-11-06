// Операция restore: возврат удалённого (undo удаления, корзина).

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
  roadmap,
  task,
  taskEdge,
} from './test-helpers';
import { LIMITS } from './types';
import type { Graph, GraphEdge, GraphNode, Op, Task } from './types';

const restoreOp = (
  nodes: readonly GraphNode[],
  tasks: readonly Task[] = [],
  edges: readonly GraphEdge[] = [],
): Op => ({ kind: 'restore', nodes, tasks, edges });

const nodeOf = (graph: Graph, id: string) => must(graph.nodes.get(N(id)));
const taskOf = (graph: Graph, id: string) => must(graph.tasks.get(T(id)));
const edgeOf = (graph: Graph, id: string) => must(graph.edges.get(E(id)));

describe('restore', () => {
  it('возвращает удалённый блок с задачами и стрелками как был', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      task('t', 'b', { status: 'done' }),
      edge('ab', 'a', 'b'),
      taskEdge('tc', 't', 'c'),
    );
    const deleted = applyOk(graph, { kind: 'deleteNode', id: N('b') });
    const restored = applyOk(
      deleted,
      restoreOp(
        [nodeOf(graph, 'b')],
        [taskOf(graph, 't')],
        [edgeOf(graph, 'ab'), edgeOf(graph, 'tc')],
      ),
    );
    expect(restored).toEqual(graph);
  });

  it('возвращает роадмапу вместе с содержимым', () => {
    const graph = build(roadmap('r'), block('in', { parent: 'r' }), task('t', 'in'));
    const deleted = applyOk(graph, { kind: 'deleteNode', id: N('r') });
    const restored = applyOk(
      deleted,
      restoreOp([nodeOf(graph, 'in'), nodeOf(graph, 'r')], [taskOf(graph, 't')]),
    );
    expect(restored).toEqual(graph);
  });

  it('права на статусы не проверяет: возвращается ровно то, что было', () => {
    const graph = build(
      block('a'),
      task('done', 'a', { status: 'done' }),
      task('rev', 'a', { status: 'in_review' }),
    );
    const deleted = applyOk(graph, { kind: 'deleteNode', id: N('a') });
    const op = restoreOp([nodeOf(graph, 'a')], [taskOf(graph, 'done'), taskOf(graph, 'rev')]);
    // member в режиме review (done ставит только master) и envi в режиме free (in_review нет).
    expect(applyOk(deleted, op, ctx('member', { statusMode: 'review' }))).toEqual(graph);
    expect(applyOk(deleted, op, ctx('member', { statusMode: 'free' }))).toEqual(graph);
  });

  it('занятый id → DUPLICATE_ID, в том числе повтор внутри операции', () => {
    const graph = build(block('a'));
    expect(errorOf(apply(graph, restoreOp([nodeOf(graph, 'a')])))).toEqual({
      code: 'DUPLICATE_ID',
      id: 'a',
    });
    const other = build(block('b'));
    const twice = restoreOp([nodeOf(other, 'b'), nodeOf(other, 'b')]);
    expect(errorOf(apply(graph, twice))).toEqual({ code: 'DUPLICATE_ID', id: 'b' });
  });

  it('блока задачи или родителя ноды больше нет → ошибка', () => {
    const source = build(roadmap('r'), block('in', { parent: 'r' }), task('t', 'in'));
    const empty = build();
    expect(errorOf(apply(empty, restoreOp([], [taskOf(source, 't')])))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'in',
    });
    expect(errorOf(apply(empty, restoreOp([nodeOf(source, 'in')])))).toEqual({
      code: 'INVALID_PARENT',
      parentId: 'r',
    });
  });

  it('стрелки к нодам, которых больше нет, пропускаются', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      edge('ab', 'a', 'b'),
      edge('bc', 'b', 'c'),
    );
    const withoutB = applyOk(graph, { kind: 'deleteNode', id: N('b') });
    const withoutC = applyOk(withoutB, { kind: 'deleteNode', id: N('c') });
    const restored = applyOk(
      withoutC,
      restoreOp([nodeOf(graph, 'b')], [], [edgeOf(graph, 'ab'), edgeOf(graph, 'bc')]),
    );
    expect([...restored.edges.keys()]).toEqual(['ab']);
  });

  it('стрелка, которая теперь замкнула бы цикл или повторила бы существующую, пропускается', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      edge('ab', 'a', 'b'),
      edge('ca', 'c', 'a'),
    );
    const changed: Op[] = [
      { kind: 'deleteEdge', id: E('ab') },
      { kind: 'deleteEdge', id: E('ca') },
      edge('ba', 'b', 'a'),
      edge('ca2', 'c', 'a'),
    ];
    const current = changed.reduce((g, op) => applyOk(g, op), graph);
    const restored = applyOk(
      current,
      restoreOp([], [], [edgeOf(graph, 'ab'), edgeOf(graph, 'ca')]),
    );
    // ab замкнула бы a → b → a, ca повторила бы ca2.
    expect(restored).toBe(current);
  });

  it('пропускает только проблемные стрелки, остальные возвращает', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      edge('ab', 'a', 'b'),
      edge('cb', 'c', 'b'),
    );
    const changes: Op[] = [
      { kind: 'deleteEdge', id: E('ab') },
      { kind: 'deleteEdge', id: E('cb') },
      edge('ba', 'b', 'a'),
    ];
    const current = changes.reduce((g, op) => applyOk(g, op), graph);
    const restored = applyOk(
      current,
      restoreOp([], [], [edgeOf(graph, 'ab'), edgeOf(graph, 'cb')]),
    );
    expect([...restored.edges.keys()].sort()).toEqual(['ba', 'cb']);
  });
});

describe('restore принимает только знакомое', () => {
  it('лишние поля, в том числе вложенные, в граф не попадают', () => {
    const graph = build(block('a'), block('b'), task('t', 'a'), edge('ab', 'a', 'b'));
    const deleted = applyOk(graph, { kind: 'deleteNode', id: N('a') });
    const dirtyNode = { ...nodeOf(graph, 'a'), evil: 1 };
    const dirtyTask = {
      ...taskOf(graph, 't'),
      deadline: { kind: 'date' as const, date: '2026-12-01', x: 1 },
    };
    const dirtyEdge = {
      ...edgeOf(graph, 'ab'),
      target: { kind: 'node' as const, nodeId: N('b'), x: 1 },
    };
    const restored = applyOk(deleted, restoreOp([dirtyNode], [dirtyTask], [dirtyEdge]));
    expect(restored.nodes.get(N('a'))).toEqual(nodeOf(graph, 'a'));
    expect(restored.tasks.get(T('t'))?.deadline).toEqual({ kind: 'date', date: '2026-12-01' });
    expect(restored.edges.get(E('ab'))).toEqual(edgeOf(graph, 'ab'));
  });

  it(`задача с больше чем ${LIMITS.maxWarnings} предупреждениями не возвращается`, () => {
    const graph = build(block('a'), task('t', 'a'));
    const deleted = applyOk(graph, { kind: 'deleteTask', id: T('t') });
    const warning = { source: { kind: 'node' as const, nodeId: N('a') }, at: NOW };
    const crowded = {
      ...taskOf(graph, 't'),
      warnings: Array.from({ length: LIMITS.maxWarnings + 1 }, () => warning),
    };
    expect(errorOf(apply(deleted, restoreOp([], [crowded])))).toEqual({
      code: 'INVALID_VALUE',
      field: 'warnings',
      reason: 'too_many',
    });
  });
});
