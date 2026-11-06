// Случайные последовательности операций (fast-check). После каждой операции applyFull проверяет:
// граф корректен целиком, изменения точны, запомненное для графа совпадает с посчитанным заново.
// Плюс отмена сразу после операции возвращает исходный граф. Полный набор свойств — подшаг 1f.

import fc from 'fast-check';
import type { Arbitrary } from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  E,
  N,
  T,
  applyFull,
  block,
  build,
  ctx,
  edge,
  milestone,
  roadmap,
  task,
  taskEdge,
} from './test-helpers';
import type { Graph, Op, TaskStatus } from './types';

/**
 * r1 (i1: t4 ✓ → i2: t5) → m;  a (t1 ✓, t2) → b (t3 в работе);  t3 → c (t6 ✓);  пустая r2.
 * ✓ — выполнена.
 */
const start = build(
  roadmap('r1'),
  block('i1', { parent: 'r1' }),
  block('i2', { parent: 'r1' }),
  roadmap('r2'),
  block('a'),
  block('b'),
  block('c'),
  milestone('m'),
  task('t1', 'a', { status: 'done' }),
  task('t2', 'a'),
  task('t3', 'b', { status: 'in_progress' }),
  task('t4', 'i1', { status: 'done' }),
  task('t5', 'i2', { status: 'in_review' }),
  task('t6', 'c', { status: 'done' }),
  edge('e1', 'a', 'b'),
  taskEdge('e2', 't3', 'c'),
  edge('e3', 'r1', 'm'),
  edge('e4', 'i1', 'i2'),
);

// Существующие id и несколько новых: чтобы операции и проходили, и отклонялись.
const nodeId = fc.constantFrom('a', 'b', 'c', 'm', 'r1', 'r2', 'i1', 'i2', 'n1', 'n2');
const taskId = fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 'n-t1', 'n-t2');
const edgeId = fc.constantFrom('e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7');
const status = fc.constantFrom<TaskStatus>('todo', 'in_progress', 'in_review', 'done');

const createNode: Arbitrary<Op> = fc
  .record({
    id: fc.constantFrom('n1', 'n2', 'n3'),
    type: fc.constantFrom('block', 'roadmap', 'milestone'),
    parent: fc.constantFrom(null, 'r1', 'r2'),
  })
  .map(({ id, type, parent }) => {
    const options = parent === null ? {} : { parent };
    if (type === 'roadmap') return roadmap(id, options);
    return type === 'block' ? block(id, options) : milestone(id, options);
  });

const op: Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(taskId, status)
      .map(([id, to]): Op => ({ kind: 'updateTask', id: T(id), patch: { status: to } })),
  },
  {
    weight: 2,
    arbitrary: fc.tuple(taskId, nodeId, status).map(([id, at, to]) => task(id, at, { status: to })),
  },
  {
    weight: 2,
    arbitrary: fc.tuple(edgeId, nodeId, nodeId).map(([id, from, to]) => edge(id, from, to)),
  },
  {
    weight: 2,
    arbitrary: fc.tuple(edgeId, taskId, nodeId).map(([id, from, to]) => taskEdge(id, from, to)),
  },
  { weight: 2, arbitrary: createNode },
  {
    weight: 1,
    arbitrary: fc
      .tuple(taskId, nodeId)
      .map(([id, at]): Op => ({ kind: 'moveTask', id: T(id), blockId: N(at), order: 'b1' })),
  },
  { weight: 1, arbitrary: taskId.map((id): Op => ({ kind: 'deleteTask', id: T(id) })) },
  { weight: 1, arbitrary: edgeId.map((id): Op => ({ kind: 'deleteEdge', id: E(id) })) },
  { weight: 1, arbitrary: nodeId.map((id): Op => ({ kind: 'deleteNode', id: N(id) })) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(nodeId, fc.constantFrom('n1', 'n2', 'n3'))
      .map(([id, inner]): Op => ({ kind: 'blockToRoadmap', id: N(id), innerBlockId: N(inner) })),
  },
  { weight: 1, arbitrary: nodeId.map((id): Op => ({ kind: 'roadmapToBlock', id: N(id) })) },
  {
    weight: 1,
    arbitrary: nodeId.map((id): Op => ({
      kind: 'updateNode',
      id: N(id),
      patch: { countedDone: null },
    })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(taskId, fc.constantFrom<'this' | 'downstream'>('this', 'downstream'))
      .map(([id, scope]): Op => ({ kind: 'dismissWarnings', taskId: T(id), scope })),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.tuple(nodeId, fc.integer({ min: -2, max: 2 })), { maxLength: 3 })
      .map(([...moves]): Op => ({
        kind: 'moveNodes',
        moves: [...new Map(moves).entries()].map(([id, x]) => ({ id: N(id), x, y: 0 })),
      })),
  },
);

const withKeepDone: Arbitrary<Op> = fc
  .tuple(op, fc.boolean())
  .map(([body, keepDone]) => (keepDone ? { ...body, keepDone } : body));

describe('случайные последовательности операций', () => {
  it('всё запомненное сходится с пересчётом, а отмена возвращает граф', () => {
    fc.assert(
      fc.property(fc.array(withKeepDone, { maxLength: 30 }), fc.boolean(), (ops, unlocks) => {
        const context = ctx('master', { statusMode: 'review', reviewUnlocks: unlocks });
        let graph: Graph = start;
        for (const next of ops) {
          const result = applyFull(graph, next, context);
          if (!result.ok) continue;
          const { graph: after, changes } = result.value;
          const undone = applyFull(after, { kind: 'revert', changes }, context);
          expect(undone.ok && undone.value.graph).toEqual(graph);
          graph = after;
        }
      }),
      { numRuns: 200 },
    );
  });
});
