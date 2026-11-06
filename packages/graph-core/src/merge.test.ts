// Слияние веток по полям (DESIGN.md, «Как устроено слияние»): что изменено с одной стороны —
// берётся оттуда, с обеих по-разному — конфликт, списки — как множества, позиции не конфликтуют.

import { describe, expect, it } from 'vitest';
import { asLabelId, asUserId } from './ids';
import type { MergeOptions, MergeSide, Merged } from './merge';
import { E, N, T, applyOpsOk, block, build, edge, mergeChecked, must, task } from './test-helpers';
import type { ApplyContext, Graph, GraphNode, NodePatch, Op, Task, TaskPatch } from './types';

const T1 = '2026-11-07T10:00:00.000Z';
const T2 = '2026-11-07T11:00:00.000Z';
const T3 = '2026-11-07T12:00:00.000Z';

const as = (name: string, now: string): ApplyContext => ({
  actor: { id: asUserId(name), role: 'master' },
  settings: { statusMode: 'review', reviewUnlocks: false },
  now,
});

/**
 * a (выполнен) и c (выполнен) → b (в работе). В a две задачи, в b — начатая и не начатая.
 * Если a или c перестанет быть выполненным, начатая t3 получит предупреждение.
 */
const BASE = build(
  block('a'),
  block('b'),
  block('c'),
  task('t1', 'a', { status: 'done' }),
  task('t2', 'a', { status: 'done', order: 'a1' }),
  task('t3', 'b', { status: 'in_progress' }),
  task('t5', 'b', { order: 'a1' }),
  task('t4', 'c', { status: 'done' }),
  edge('e1', 'a', 'b'),
  edge('e2', 'c', 'b'),
);

/** Ветка: правит ann в T1. Целевая ветка: правит bob в T2. */
const onBranch = (...ops: Op[]): Graph => applyOpsOk(BASE, ops, as('ann', T1));
const onTarget = (...ops: Op[]): Graph => applyOpsOk(BASE, ops, as('bob', T2));

const updateTask = (id: string, patch: TaskPatch): Op => ({ kind: 'updateTask', id: T(id), patch });
const updateNode = (id: string, patch: NodePatch): Op => ({ kind: 'updateNode', id: N(id), patch });
const moveNode = (id: string, x: number, y: number): Op => ({
  kind: 'moveNodes',
  moves: [{ id: N(id), x, y }],
});
const moveTask = (id: string, blockId: string, order: string): Op => ({
  kind: 'moveTask',
  id: T(id),
  blockId: N(blockId),
  order,
});
const users = (...names: string[]) => names.map(asUserId);

const taskOf = (graph: Graph, id: string): Task => must(graph.tasks.get(T(id)));
const nodeOf = (graph: Graph, id: string): GraphNode => must(graph.nodes.get(N(id)));

const mergeOk = (base: Graph, branch: Graph, target: Graph, options: MergeOptions = {}): Merged =>
  mergeChecked(base, branch, target, as('merger', T3), options);

const choose = (key: string, side: MergeSide): MergeOptions => ({
  resolutions: new Map([[key, side]]),
});

describe('merge: что изменено с одной стороны', () => {
  it('ничего не менялось — целевой граф тем же объектом', () => {
    const result = mergeOk(BASE, BASE, BASE);
    expect(result.graph).toBe(BASE);
    expect(result.conflicts).toEqual([]);
    expect(result.positionsKept).toEqual([]);
  });

  it('изменено только в целевой ветке — целевой граф тем же объектом', () => {
    const target = onTarget(updateTask('t3', { title: 'Y' }), { kind: 'deleteTask', id: T('t5') });
    expect(mergeOk(BASE, BASE, target).graph).toBe(target);
  });

  it('изменено только в ветке — результат как в ветке, записи ветки теми же объектами', () => {
    const branch = onBranch(
      updateTask('t3', { title: 'X', assigneeIds: users('u1') }),
      updateNode('b', { description: 'описание' }),
      moveNode('c', 40, 80),
      moveTask('t5', 'a', 'a2'),
      block('d'),
      task('t8', 'd'),
      edge('e3', 'b', 'd'),
      { kind: 'deleteEdge', id: E('e2') },
      { kind: 'deleteTask', id: T('t4') },
    );
    const { graph, conflicts } = mergeOk(BASE, branch, BASE);
    expect(graph).toEqual(branch);
    expect(conflicts).toEqual([]);
    expect(taskOf(graph, 't3')).toBe(taskOf(branch, 't3'));
    expect(nodeOf(graph, 'd')).toBe(nodeOf(branch, 'd'));
  });

  it('добавленное и удалённое с разных сторон — всё вместе', () => {
    const branch = onBranch(block('d'), task('t8', 'd'), edge('e3', 'b', 'd'));
    const target = onTarget(
      { kind: 'deleteEdge', id: E('e2') },
      { kind: 'deleteTask', id: T('t5') },
    );
    const { graph } = mergeOk(BASE, branch, target);
    expect(graph.nodes.has(N('d'))).toBe(true);
    expect(graph.tasks.has(T('t8'))).toBe(true);
    expect(graph.edges.has(E('e3'))).toBe(true);
    expect(graph.edges.has(E('e2'))).toBe(false);
    expect(graph.tasks.has(T('t5'))).toBe(false);
  });

  it('разные поля одной записи с разных сторон — оба изменения, без конфликта', () => {
    const branch = onBranch(updateTask('t3', { title: 'X' }));
    const target = onTarget(updateTask('t3', { description: 'D', priority: 'high' }));
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([]);
    expect(taskOf(graph, 't3')).toMatchObject({ title: 'X', description: 'D', priority: 'high' });
  });

  it('авторство — той стороны, где запись правили позже', () => {
    const early = onBranch(updateTask('t3', { title: 'X' }));
    const late = onTarget(updateTask('t3', { description: 'D' }));
    expect(taskOf(mergeOk(BASE, early, late).graph, 't3')).toMatchObject({
      updatedBy: 'bob',
      updatedAt: T2,
    });
    const branch = applyOpsOk(BASE, [updateTask('t3', { title: 'X' })], as('ann', T3));
    expect(taskOf(mergeOk(BASE, branch, late).graph, 't3')).toMatchObject({
      updatedBy: 'ann',
      updatedAt: T3,
    });
  });

  it('одинаковое изменение с обеих сторон — без конфликта', () => {
    const branch = onBranch(updateTask('t3', { title: 'X', status: 'done' }));
    const target = onTarget(updateTask('t3', { title: 'X', status: 'done' }));
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([]);
    expect(taskOf(graph, 't3')).toMatchObject({ title: 'X', status: 'done' });
  });
});

describe('merge: конфликты полей', () => {
  const branch = onBranch(updateTask('t3', { title: 'X' }));
  const target = onTarget(updateTask('t3', { title: 'Y' }));
  const KEY = 'field:title:task:t3';

  it('поле изменено по-разному — конфликт, пока не решён — значение целевой ветки', () => {
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([
      {
        kind: 'field',
        key: KEY,
        record: 'task',
        id: 't3',
        field: 'title',
        base: 't3',
        branch: 'X',
        target: 'Y',
        chosen: null,
      },
    ]);
    expect(taskOf(graph, 't3').title).toBe('Y');
  });

  it('решение «из ветки» берёт значение ветки, «из целевой» — целевое', () => {
    const fromBranch = mergeOk(BASE, branch, target, choose(KEY, 'branch'));
    expect(taskOf(fromBranch.graph, 't3').title).toBe('X');
    expect(fromBranch.conflicts.map((conflict) => conflict.chosen)).toEqual(['branch']);
    const fromTarget = mergeOk(BASE, branch, target, choose(KEY, 'target'));
    expect(taskOf(fromTarget.graph, 't3').title).toBe('Y');
    expect(fromTarget.conflicts.map((conflict) => conflict.chosen)).toEqual(['target']);
  });

  it('решение без конфликта не используется', () => {
    const options = choose('field:title:task:t4', 'branch');
    const { graph, conflicts } = mergeOk(BASE, branch, target, options);
    expect(taskOf(graph, 't4').title).toBe('t4');
    expect(conflicts.map((conflict) => conflict.chosen)).toEqual([null]);
  });

  it('решение по ключу действует и после того, как целевая ветка ушла вперёд', () => {
    const { conflicts } = mergeOk(BASE, branch, target);
    const later = applyOpsOk(target, [updateTask('t5', { title: 'ещё' })], as('bob', T3));
    const { graph } = mergeOk(BASE, branch, later, choose(must(conflicts[0]).key, 'branch'));
    expect(taskOf(graph, 't3').title).toBe('X');
    expect(taskOf(graph, 't5').title).toBe('ещё');
  });

  it('статус — обычное поле: изменён с обеих сторон по-разному — конфликт', () => {
    const b = onBranch(updateTask('t3', { status: 'todo' }));
    const t = onTarget(updateTask('t3', { status: 'done' }));
    const { graph, conflicts } = mergeOk(BASE, b, t);
    expect(conflicts).toEqual([
      expect.objectContaining({ field: 'status', branch: 'todo', target: 'done' }),
    ]);
    expect(taskOf(graph, 't3').status).toBe('done');
  });

  it('конфликты по записи, id и полю: сначала ноды, потом задачи', () => {
    const b = onBranch(
      updateTask('t3', { title: 'X', description: 'DX' }),
      updateTask('t1', { title: 'X' }),
      updateNode('b', { title: 'BX' }),
    );
    const t = onTarget(
      updateTask('t3', { title: 'Y', description: 'DY' }),
      updateTask('t1', { title: 'Y' }),
      updateNode('b', { title: 'BY' }),
    );
    expect(mergeOk(BASE, b, t).conflicts.map((conflict) => conflict.key)).toEqual([
      'field:title:node:b',
      'field:title:task:t1',
      'field:description:task:t3',
      'field:title:task:t3',
    ]);
  });

  it('запись, добавленная с обеих сторон с одним id: разные поля — конфликты', () => {
    const b = onBranch(block('z', { title: 'Z1' }));
    const t = onTarget(block('z', { title: 'Z2' }));
    const { graph, conflicts } = mergeOk(BASE, b, t);
    expect(conflicts).toEqual([
      expect.objectContaining({
        key: 'field:title:node:z',
        base: undefined,
        branch: 'Z1',
        target: 'Z2',
      }),
    ]);
    expect(nodeOf(graph, 'z')).toBe(nodeOf(t, 'z'));
  });
});

describe('merge: списки как множества', () => {
  it('ответственные, добавленные с обеих сторон, объединяются', () => {
    const b = onBranch(updateTask('t3', { assigneeIds: users('u1') }));
    const t = onTarget(updateTask('t3', { assigneeIds: users('u2') }));
    const { graph, conflicts } = mergeOk(BASE, b, t);
    expect(conflicts).toEqual([]);
    expect(taskOf(graph, 't3').assigneeIds).toEqual(['u2', 'u1']);
  });

  it('удалённое с одной стороны убирается, добавленное с другой остаётся', () => {
    const base = applyOpsOk(
      BASE,
      [updateTask('t3', { assigneeIds: users('u1', 'u2') })],
      as('ann', T1),
    );
    const b = applyOpsOk(base, [updateTask('t3', { assigneeIds: users('u2') })], as('ann', T2));
    const t = applyOpsOk(
      base,
      [updateTask('t3', { assigneeIds: users('u1', 'u2', 'u3') })],
      as('bob', T2),
    );
    expect(taskOf(mergeOk(base, b, t).graph, 't3').assigneeIds).toEqual(['u2', 'u3']);
  });

  it('метки ноды сливаются так же', () => {
    const b = onBranch(updateNode('b', { labelIds: [asLabelId('l1')] }));
    const t = onTarget(updateNode('b', { labelIds: [asLabelId('l2')] }));
    expect(nodeOf(mergeOk(BASE, b, t).graph, 'b')).toMatchObject({ labelIds: ['l2', 'l1'] });
  });

  it('вместе больше лимита — конфликт поля', () => {
    const b = onBranch(
      updateTask('t3', { assigneeIds: users('u1', 'u2', 'u3', 'u4', 'u5', 'u6') }),
    );
    const t = onTarget(updateTask('t3', { assigneeIds: users('v1', 'v2', 'v3', 'v4', 'v5') }));
    const { graph, conflicts } = mergeOk(BASE, b, t);
    expect(conflicts.map((conflict) => conflict.key)).toEqual(['field:assigneeIds:task:t3']);
    expect(taskOf(graph, 't3').assigneeIds).toEqual(taskOf(t, 't3').assigneeIds);
    const fromBranch = mergeOk(BASE, b, t, choose('field:assigneeIds:task:t3', 'branch'));
    expect(taskOf(fromBranch.graph, 't3').assigneeIds).toEqual(taskOf(b, 't3').assigneeIds);
  });
});

describe('merge: предупреждения', () => {
  const reopen = (id: string): Op => updateTask(id, { status: 'in_progress' });

  it('новые с обеих сторон остаются, самые новые в конце', () => {
    const { graph, conflicts } = mergeOk(BASE, onBranch(reopen('t1')), onTarget(reopen('t4')));
    expect(conflicts).toEqual([]);
    expect(taskOf(graph, 't3').warnings).toEqual([
      { source: { kind: 'task', taskId: 't1' }, at: T1 },
      { source: { kind: 'task', taskId: 't4' }, at: T2 },
    ]);
  });

  it('от одного источника остаётся одно — более позднее', () => {
    const { graph } = mergeOk(BASE, onBranch(reopen('t1')), onTarget(reopen('t1')));
    expect(taskOf(graph, 't3').warnings).toEqual([
      { source: { kind: 'task', taskId: 't1' }, at: T2 },
    ]);
  });

  it('снятое с одной стороны снимается, а новое с другой остаётся', () => {
    const warned = applyOpsOk(BASE, [reopen('t1')], as('ann', T1));
    const done = (id: string) => updateTask(id, { status: 'done' });
    const dismiss: Op = { kind: 'dismissWarnings', taskId: T('t3'), scope: 'this' };
    const b = applyOpsOk(warned, [dismiss], as('ann', T2));
    // В целевой ветке t1 закрыли и снова открыли: предупреждение от неё — с новым временем.
    const t = applyOpsOk(
      applyOpsOk(warned, [done('t1')], as('bob', T2)),
      [reopen('t1')],
      as('bob', T3),
    );
    expect(taskOf(mergeOk(warned, b, t).graph, 't3').warnings).toEqual([
      { source: { kind: 'task', taskId: 't1' }, at: T3 },
    ]);
    const quiet = applyOpsOk(warned, [updateTask('t3', { title: 'Y' })], as('bob', T2));
    expect(taskOf(mergeOk(warned, b, quiet).graph, 't3').warnings).toEqual([]);
  });
});

describe('merge: позиции нод не конфликтуют', () => {
  it('двигали с одной стороны — позиция оттуда', () => {
    const fromBranch = mergeOk(
      BASE,
      onBranch(moveNode('a', 10, 20)),
      onTarget(moveNode('b', 5, 5)),
    );
    expect(nodeOf(fromBranch.graph, 'a')).toMatchObject({ x: 10, y: 20 });
    expect(nodeOf(fromBranch.graph, 'b')).toMatchObject({ x: 5, y: 5 });
  });

  it('двигали с обеих сторон — позиция из ветки, x и y вместе', () => {
    const { graph, conflicts, positionsKept } = mergeOk(
      BASE,
      onBranch(moveNode('a', 100, 0)),
      onTarget(moveNode('a', 0, 50)),
    );
    expect(nodeOf(graph, 'a')).toMatchObject({ x: 100, y: 0 });
    expect(conflicts).toEqual([]);
    expect(positionsKept).toEqual([]);
  });

  it('сервер велел оставить целевую — позиция целевая, нода в списке «не перенесены»', () => {
    const b = onBranch(moveNode('a', 100, 0), moveNode('c', 7, 7));
    const t = onTarget(moveNode('a', 0, 50), moveNode('b', 9, 9));
    const keep = new Set([N('a'), N('c')]);
    const { graph, positionsKept } = mergeOk(BASE, b, t, { keepTargetPositions: keep });
    expect(nodeOf(graph, 'a')).toMatchObject({ x: 0, y: 50 });
    // c двигали только в ветке: оставлять нечего.
    expect(nodeOf(graph, 'c')).toMatchObject({ x: 7, y: 7 });
    expect(positionsKept).toEqual(['a']);
  });
});

describe('merge: место задачи', () => {
  it('перенесена в разные блоки — конфликт blockId; решение переносит блок вместе с порядком', () => {
    const b = onBranch(moveTask('t5', 'a', 'a5'));
    const t = onTarget(moveTask('t5', 'c', 'a7'));
    const KEY = 'field:blockId:task:t5';
    const unresolved = mergeOk(BASE, b, t);
    expect(unresolved.conflicts).toEqual([
      expect.objectContaining({ key: KEY, base: 'b', branch: 'a', target: 'c' }),
    ]);
    expect(taskOf(unresolved.graph, 't5')).toMatchObject({ blockId: 'c', order: 'a7' });
    const resolved = mergeOk(BASE, b, t, choose(KEY, 'branch'));
    expect(taskOf(resolved.graph, 't5')).toMatchObject({ blockId: 'a', order: 'a5' });
  });

  it('порядок внутри одного блока не конфликтует — берётся из ветки', () => {
    const { graph, conflicts } = mergeOk(
      BASE,
      onBranch(moveTask('t5', 'b', 'Zz')),
      onTarget(moveTask('t5', 'b', 'a0V')),
    );
    expect(conflicts).toEqual([]);
    expect(taskOf(graph, 't5')).toMatchObject({ blockId: 'b', order: 'Zz' });
  });

  it('перенос с одной стороны и порядок в старом блоке с другой — побеждает перенос', () => {
    const { graph, conflicts } = mergeOk(
      BASE,
      onBranch(moveTask('t5', 'b', 'Zz')),
      onTarget(moveTask('t5', 'a', 'a5')),
    );
    expect(conflicts).toEqual([]);
    expect(taskOf(graph, 't5')).toMatchObject({ blockId: 'a', order: 'a5' });
    const reversed = mergeOk(
      BASE,
      onBranch(moveTask('t5', 'c', 'a5')),
      onTarget(moveTask('t5', 'b', 'Zz')),
    );
    expect(reversed.conflicts).toEqual([]);
    expect(taskOf(reversed.graph, 't5')).toMatchObject({ blockId: 'c', order: 'a5' });
  });
});

describe('merge: поля, которые не конфликтуют', () => {
  it('разные пометки «засчитано» — целевая', () => {
    const b = onBranch({ ...task('t6', 'a'), keepDone: true });
    const t = onTarget({ ...task('t7', 'a'), keepDone: true });
    expect(nodeOf(b, 'a').countedDone).toEqual({ by: 'ann', at: T1 });
    const { graph, conflicts } = mergeOk(BASE, b, t);
    expect(conflicts).toEqual([]);
    expect(nodeOf(graph, 'a').countedDone).toEqual({ by: 'bob', at: T2 });
    expect(graph.tasks.has(T('t6')) && graph.tasks.has(T('t7'))).toBe(true);
  });

  it('номер задачи — тот, что есть', () => {
    const numbered = (graph: Graph, id: string, number: number): Graph => ({
      ...graph,
      tasks: new Map(graph.tasks).set(T(id), { ...taskOf(graph, id), number }),
    });
    const b = numbered(onBranch(updateTask('t5', { title: 'X' })), 't5', 7);
    const t = onTarget(updateTask('t5', { description: 'D' }));
    const { graph, conflicts } = mergeOk(BASE, b, t);
    expect(conflicts).toEqual([]);
    expect(taskOf(graph, 't5')).toMatchObject({ number: 7, title: 'X', description: 'D' });
  });
});
