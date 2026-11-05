// Отмена (DESIGN.md, «Undo»): операция + отмена = исходный граф, чужие правки не затираются.

import { describe, expect, it } from 'vitest';
import { previewRelock } from './apply';
import { changesBetween, combineChanges, isEmptyChanges } from './changes';
import { asLabelId, asUserId } from './ids';
import { planRevert } from './revert';
import {
  E,
  N,
  T,
  apply,
  applyOk,
  block,
  build,
  ctx,
  deepFreeze,
  edge,
  milestone,
  roadmap,
  setStatus,
  task,
  taskEdge,
} from './test-helpers';
import type { ApplyContext, Changes, Graph, Op } from './types';

const T1 = '2026-11-05T11:00:00.000Z';
const T2 = '2026-11-05T12:00:00.000Z';
const T3 = '2026-11-05T13:00:00.000Z';

/** Участник с именем: чтобы видеть, чья правка где осталась. */
const as = (name: string, now: string): ApplyContext => ({
  actor: { id: asUserId(name), role: 'member' },
  settings: { statusMode: 'review', reviewUnlocks: false },
  now,
});
const master = (now: string) => ctx('master', { statusMode: 'review' }, now);

/** Применяет операцию и запоминает, что она изменила. */
function act(graph: Graph, op: Op, context: ApplyContext) {
  const after = applyOk(graph, op, context);
  return { after, changes: changesBetween(graph, after, context.now) };
}

const revert = (changes: Changes): Op => ({ kind: 'revert', changes });

function undo(graph: Graph, changes: Changes, context: ApplyContext) {
  const result = planRevert(deepFreeze(graph), deepFreeze(changes), context);
  if (!result.ok) throw new Error(`отмена отклонена: ${JSON.stringify(result.error)}`);
  return result.value;
}

/**
 * r (in: i1 ✓) → b;  a (a1 ✓, a2) → b (b1 в работе);  a1 → m;  пустая роадмапа empty.
 * ✓ — выполнена.
 */
const base = build(
  roadmap('r'),
  block('in', { parent: 'r' }),
  task('i1', 'in', { status: 'done' }),
  block('a', { title: 'A' }),
  task('a1', 'a', { status: 'done' }),
  task('a2', 'a'),
  block('b'),
  task('b1', 'b', { status: 'in_progress' }),
  milestone('m'),
  roadmap('empty'),
  edge('ab', 'a', 'b'),
  taskEdge('a1m', 'a1', 'm'),
  edge('rb', 'r', 'b'),
);

const reopened = applyOk(base, setStatus('i1', 'todo'), master(T1));
const counted = applyOk(base, { ...task('i2', 'in'), keepDone: true }, master(T1));

const roundTrips: readonly (readonly [string, Graph, Op])[] = [
  ['createNode', base, block('c')],
  [
    'updateNode',
    base,
    {
      kind: 'updateNode',
      id: N('a'),
      patch: {
        title: 'Авторизация',
        deadline: { kind: 'date', date: '2026-12-01' },
        labelIds: [asLabelId('l')],
      },
    },
  ],
  [
    'moveNodes',
    base,
    {
      kind: 'moveNodes',
      moves: [
        { id: N('a'), x: 100, y: 0 },
        { id: N('b'), x: 0, y: 100 },
      ],
    },
  ],
  ['deleteNode: блок со всем', base, { kind: 'deleteNode', id: N('a') }],
  ['deleteNode: роадмапа со всем', base, { kind: 'deleteNode', id: N('r') }],
  ['blockToRoadmap', base, { kind: 'blockToRoadmap', id: N('a'), innerBlockId: N('a-in') }],
  ['roadmapToBlock', base, { kind: 'roadmapToBlock', id: N('empty') }],
  ['createTask', base, task('b2', 'b')],
  [
    'updateTask',
    base,
    {
      kind: 'updateTask',
      id: T('a2'),
      patch: { title: 'X', assigneeIds: [asUserId('u')], estimate: 3, priority: 'high' },
    },
  ],
  ['updateTask: переоткрытие с предупреждениями', base, setStatus('i1', 'todo')],
  ['moveTask', base, { kind: 'moveTask', id: T('a2'), blockId: N('b'), order: 'b0' }],
  ['deleteTask со стрелкой', base, { kind: 'deleteTask', id: T('a1') }],
  ['createEdge', base, edge('bm', 'b', 'm')],
  ['deleteEdge', base, { kind: 'deleteEdge', id: E('ab') }],
  ['dismissWarnings', reopened, { kind: 'dismissWarnings', taskId: T('b1'), scope: 'this' }],
  ['createTask с «не блокировать»', base, { ...task('i2', 'in'), keepDone: true }],
  [
    'снятие «засчитано»',
    counted,
    { kind: 'updateNode', id: N('in'), patch: { countedDone: null } },
  ],
  ['пометка снимается сама', counted, setStatus('i2', 'done')],
];

describe('операция + отмена = исходный граф', () => {
  it.each(roundTrips)('%s', (_name, before, op) => {
    const { after, changes } = act(before, op, master(T1));
    expect(isEmptyChanges(changes)).toBe(false);
    const back = applyOk(after, revert(changes), master(T2));
    expect(back).toEqual(before);
    // Нетронутые записи — те же объекты.
    for (const node of Object.values(before.nodes)) {
      if (!changes.nodes.some((c) => (c.before ?? c.after)?.id === node.id)) {
        expect(back.nodes[node.id]).toBe(node);
      }
    }
    // Повтор (отмена отмены) возвращает граф после операции.
    const redo = changesBetween(after, back, T2);
    expect(applyOk(back, revert(redo), master(T3))).toEqual(after);
  });

  it('restore + отмена', () => {
    const deleted = applyOk(base, { kind: 'deleteNode', id: N('a') }, master(T1));
    const op: Op = {
      kind: 'restore',
      nodes: [base.nodes[N('a')]!],
      tasks: [base.tasks[T('a1')]!, base.tasks[T('a2')]!],
      edges: [base.edges[E('ab')]!, base.edges[E('a1m')]!],
    };
    const { after, changes } = act(deleted, op, master(T2));
    expect(applyOk(after, revert(changes), master(T3))).toEqual(deleted);
  });

  it('действие из нескольких операций отменяется одним шагом', () => {
    const first = act(
      base,
      { kind: 'moveNodes', moves: [{ id: N('a'), x: 10, y: 0 }] },
      master(T1),
    );
    const second = act(
      first.after,
      { kind: 'moveNodes', moves: [{ id: N('a'), x: 20, y: 5 }] },
      master(T1),
    );
    const third = act(second.after, task('a3', 'a'), master(T1));
    const all = combineChanges(combineChanges(first.changes, second.changes), third.changes);
    expect(applyOk(third.after, revert(all), master(T2))).toEqual(base);
  });

  it('созданное и удалённое внутри одного действия взаимно сокращается', () => {
    const created = act(base, block('c'), master(T1));
    const deleted = act(created.after, { kind: 'deleteNode', id: N('c') }, master(T1));
    expect(isEmptyChanges(combineChanges(created.changes, deleted.changes))).toBe(true);
  });

  it('member в режиме review отменяет своё переоткрытие выполненной задачи', () => {
    const { after, changes } = act(base, setStatus('a1', 'todo'), as('ann', T1));
    expect(applyOk(after, revert(changes), as('ann', T2))).toEqual(base);
  });
});

describe('чужая работа не затирается', () => {
  const rename = (id: string, title: string): Op => ({
    kind: 'updateNode',
    id: N(id),
    patch: { title },
  });

  it('поле, которое потом поменял другой, остаётся его и попадает в пропущенное', () => {
    const mine = act(base, rename('a', 'Моё'), as('ann', T1));
    const theirs = applyOk(mine.after, rename('a', 'Чужое'), as('bob', T2));
    const { graph, skipped } = undo(theirs, mine.changes, as('ann', T3));
    expect(graph.nodes[N('a')]?.title).toBe('Чужое');
    expect(skipped).toEqual([
      { record: 'node', id: 'a', field: 'title', reason: 'changed', by: 'bob' },
    ]);
  });

  it('другие поля той же записи возвращаются, чужие остаются', () => {
    const mine = act(base, rename('a', 'Моё'), as('ann', T1));
    const theirs = applyOk(
      mine.after,
      { kind: 'updateNode', id: N('a'), patch: { description: 'чужое описание' } },
      as('bob', T2),
    );
    const { graph, skipped } = undo(theirs, mine.changes, as('ann', T3));
    expect(graph.nodes[N('a')]).toMatchObject({
      title: 'A',
      description: 'чужое описание',
      updatedBy: 'bob',
    });
    expect(skipped).toEqual([]);
  });

  it('позиция, которую потом поменял другой, остаётся', () => {
    const move = (x: number): Op => ({ kind: 'moveNodes', moves: [{ id: N('a'), x, y: 0 }] });
    const mine = act(base, move(100), as('ann', T1));
    const theirs = applyOk(mine.after, move(200), as('bob', T2));
    const { graph, skipped } = undo(theirs, mine.changes, as('ann', T3));
    expect(graph.nodes[N('a')]?.x).toBe(200);
    expect(skipped.map((s) => s.field)).toEqual(['x']);
  });

  it('списки — как множества: убирается только ваше добавление', () => {
    const labels = (...ids: string[]): Op => ({
      kind: 'updateNode',
      id: N('a'),
      patch: { labelIds: ids.map(asLabelId) },
    });
    const mine = act(base, labels('mine'), as('ann', T1));
    const theirs = applyOk(mine.after, labels('mine', 'theirs'), as('bob', T2));
    const { graph, skipped } = undo(theirs, mine.changes, as('ann', T3));
    expect(graph.nodes[N('a')]).toHaveProperty('labelIds', ['theirs']);
    expect(skipped).toEqual([]);
  });

  it('созданное вами, но потом изменённое другим, не удаляется', () => {
    const mine = act(base, block('c'), as('ann', T1));
    const theirs = applyOk(mine.after, rename('c', 'Чужое'), as('bob', T2));
    const { graph, skipped } = undo(theirs, mine.changes, as('ann', T3));
    expect(graph.nodes[N('c')]?.title).toBe('Чужое');
    expect(skipped).toEqual([
      { record: 'node', id: 'c', field: null, reason: 'changed', by: 'bob' },
    ]);
  });

  it('созданное вами, в котором уже чужое, не удаляется', () => {
    const mine = act(base, block('c'), as('ann', T1));
    const theirs = applyOk(mine.after, task('c1', 'c'), as('bob', T2));
    const { graph, skipped } = undo(theirs, mine.changes, as('ann', T3));
    expect(graph).toBe(theirs);
    expect(skipped).toEqual([{ record: 'node', id: 'c', field: null, reason: 'in_use', by: null }]);
  });

  it('из удалённого возвращается то, что можно: стрелка к удалённой другим ноде — нет', () => {
    const mine = act(base, { kind: 'deleteTask', id: T('a1') }, as('ann', T1));
    const theirs = applyOk(mine.after, { kind: 'deleteNode', id: N('m') }, as('bob', T2));
    const { graph, skipped } = undo(theirs, mine.changes, as('ann', T3));
    expect(graph.tasks[T('a1')]).toBe(base.tasks[T('a1')]);
    expect(graph.edges[E('a1m')]).toBeUndefined();
    expect(skipped).toEqual([
      { record: 'edge', id: 'a1m', field: null, reason: 'unrestorable', by: null },
    ]);
  });

  it('изменённое вами, но удалённое другим, остаётся удалённым', () => {
    const mine = act(
      base,
      { kind: 'updateTask', id: T('a2'), patch: { title: 'Моё' } },
      as('ann', T1),
    );
    const theirs = applyOk(mine.after, { kind: 'deleteTask', id: T('a2') }, as('bob', T2));
    const { graph, skipped } = undo(theirs, mine.changes, as('ann', T3));
    expect(graph).toBe(theirs);
    expect(skipped).toEqual([
      { record: 'task', id: 'a2', field: null, reason: 'deleted', by: null },
    ]);
  });

  it('если после отмены граф нарушил бы инвариант, отмена отклоняется целиком', () => {
    // Вы перенесли задачу из a в b, другой удалил a: вернуть задачу некуда.
    const mine = act(
      base,
      { kind: 'moveTask', id: T('a2'), blockId: N('b'), order: 'b0' },
      as('ann', T1),
    );
    const theirs = applyOk(mine.after, { kind: 'deleteNode', id: N('a') }, as('bob', T2));
    const result = apply(theirs, revert(mine.changes), as('ann', T3));
    expect(result).toEqual({ ok: false, error: { code: 'NODE_NOT_FOUND', id: 'a' } });
  });
});

describe('предупреждения при отмене', () => {
  // Режим free: member сам ставит done.
  const as = (name: string, now: string): ApplyContext => ({
    actor: { id: asUserId(name), role: 'member' },
    settings: { statusMode: 'free', reviewUnlocks: false },
    now,
  });
  // a (a1) → b (b1 в работе досрочно, b2 не начата).
  const graph = build(
    block('a'),
    task('a1', 'a'),
    block('b'),
    task('b1', 'b', { status: 'in_progress' }),
    task('b2', 'b'),
    edge('ab', 'a', 'b'),
  );

  it('быстрая отмена ошибки никого не дёргает', () => {
    const mine = act(graph, setStatus('a1', 'done'), as('ann', T1));
    expect(applyOk(mine.after, revert(mine.changes), as('ann', T2))).toEqual(graph);
  });

  it('получает тот, кто успел взять задачу, пока она была разблокирована', () => {
    const mine = act(graph, setStatus('a1', 'done'), as('ann', T1));
    const theirs = applyOk(mine.after, setStatus('b2', 'in_progress'), as('bob', T2));
    const back = applyOk(theirs, revert(mine.changes), as('ann', T3));
    expect(back.tasks[T('b2')]?.warnings).toEqual([
      { source: { kind: 'task', taskId: 'a1' }, at: T3 },
    ]);
    expect(back.tasks[T('b1')]).toBe(theirs.tasks[T('b1')]);
  });

  it('previewRelock показывает, что отмена снова заблокирует', () => {
    const mine = act(graph, setStatus('a1', 'done'), as('ann', T1));
    const result = previewRelock(mine.after, revert(mine.changes), as('ann', T2));
    expect(result).toEqual({ ok: true, value: { nodes: ['a'], tasks: ['b1', 'b2'] } });
  });
});
