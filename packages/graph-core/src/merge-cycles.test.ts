// Слияние веток: циклы после слияния и последствия — предупреждения, «засчитано», «не
// блокировать» на всё слияние (DESIGN.md, «Как устроено слияние», подшаг 2c).

import { describe, expect, it } from 'vitest';
import { asUserId } from './ids';
import { merge } from './merge';
import type { MergeOptions, Merged } from './merge';
import {
  E,
  N,
  T,
  applyOpsOk,
  block,
  build,
  edge,
  mergeChecked,
  must,
  task,
  taskEdge,
} from './test-helpers';
import type { ApplyContext, Graph, Op } from './types';

const T1 = '2026-11-07T10:00:00.000Z';
const T2 = '2026-11-07T11:00:00.000Z';
const T3 = '2026-11-07T12:00:00.000Z';

const as = (name: string, now: string): ApplyContext => ({
  actor: { id: asUserId(name), role: 'master' },
  settings: { statusMode: 'review', reviewUnlocks: false },
  now,
});

/** Блоки a, b, c, d, f по задаче; задача t в a со стрелкой в c; блок p между b и d. */
const BASE = build(
  block('a'),
  block('b'),
  block('c'),
  block('d'),
  block('f'),
  block('p'),
  task('ta', 'a'),
  task('t', 'a', { order: 'a1' }),
  task('tb', 'b'),
  task('tc', 'c'),
  task('td', 'd'),
  task('tf', 'f'),
  task('tp', 'p'),
  taskEdge('e', 't', 'c'),
  edge('e1', 'b', 'p'),
  edge('e2', 'p', 'd'),
);

const onBranch = (...ops: Op[]): Graph => applyOpsOk(BASE, ops, as('ann', T1));
const onTarget = (...ops: Op[]): Graph => applyOpsOk(BASE, ops, as('bob', T2));

const moveTask = (id: string, blockId: string, order: string): Op => ({
  kind: 'moveTask',
  id: T(id),
  blockId: N(blockId),
  order,
});
const deleteNode = (id: string): Op => ({ kind: 'deleteNode', id: N(id) });

const mergeOk = (base: Graph, branch: Graph, target: Graph, options: MergeOptions = {}): Merged =>
  mergeChecked(base, branch, target, as('merger', T3), options);

const resolve = (...pairs: [string, 'branch' | 'target'][]): MergeOptions => ({
  resolutions: new Map(pairs),
});

const blockOf = (graph: Graph, id: string) => must(graph.tasks.get(T(id))).blockId;

describe('merge: цикл после слияния', () => {
  it('стрелка ветки замыкает цикл со стрелкой целевой — не переносится, конфликт', () => {
    const branch = onBranch(edge('x', 'a', 'b'));
    const target = onTarget(edge('y', 'b', 'a'));
    const { graph, conflicts, relock } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([
      {
        kind: 'cycle',
        key: 'cycle:edge:x',
        record: 'edge',
        id: 'x',
        chosen: null,
        cycle: ['b', 'a'],
        instead: [],
      },
    ]);
    expect(graph.edges.has(E('y')) && !graph.edges.has(E('x'))).toBe(true);
    expect(relock).toEqual({ nodes: [], tasks: [] });
    // «Не переносить» решает конфликт; «перенести» исполнить нельзя — на цикле нет других
    // изменений ветки, и конфликт снова не решён.
    const kept = mergeOk(BASE, branch, target, resolve(['cycle:edge:x', 'target']));
    expect(kept.conflicts).toEqual([expect.objectContaining({ chosen: 'target' })]);
    const forced = mergeOk(BASE, branch, target, resolve(['cycle:edge:x', 'branch']));
    expect(forced.conflicts).toEqual([expect.objectContaining({ chosen: null })]);
    expect(forced.graph.edges.has(E('x'))).toBe(false);
  });

  it('две стрелки ветки на цикле — не переносится последняя; можно не переносить другую', () => {
    // Ветка: c → d и f → c. Целевая: d → f. Вместе — цикл c → d → f → c.
    const branch = onBranch(edge('x1', 'c', 'd'), edge('x2', 'f', 'c'));
    const target = onTarget(edge('y', 'd', 'f'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts).toEqual([
      expect.objectContaining({
        key: 'cycle:edge:x2',
        cycle: ['c', 'd', 'f'],
        instead: ['cycle:edge:x1'],
        chosen: null,
      }),
    ]);
    expect(unresolved.graph.edges.has(E('x1')) && !unresolved.graph.edges.has(E('x2'))).toBe(true);

    // «Перенести x2, а не переносить x1» — конфликт переезжает на x1.
    const swapped = mergeOk(
      BASE,
      branch,
      target,
      resolve(['cycle:edge:x2', 'branch'], ['cycle:edge:x1', 'target']),
    );
    expect(swapped.conflicts).toEqual([
      expect.objectContaining({
        key: 'cycle:edge:x1',
        cycle: ['d', 'f', 'c'],
        instead: ['cycle:edge:x2'],
        chosen: 'target',
      }),
    ]);
    expect(swapped.graph.edges.has(E('x2')) && !swapped.graph.edges.has(E('x1'))).toBe(true);

    // «Не переносить x1» без пары: переносится x2, x1 — нет, конфликт решён так, как выбрали.
    const dropFirst = mergeOk(BASE, branch, target, resolve(['cycle:edge:x1', 'target']));
    expect(dropFirst.conflicts).toEqual([
      expect.objectContaining({ key: 'cycle:edge:x1', chosen: 'target' }),
    ]);
    expect(dropFirst.graph.edges.has(E('x2')) && !dropFirst.graph.edges.has(E('x1'))).toBe(true);

    // Перенести обе нельзя: вторая по порядку не переносится, её конфликт снова не решён.
    const both = mergeOk(
      BASE,
      branch,
      target,
      resolve(['cycle:edge:x1', 'branch'], ['cycle:edge:x2', 'branch']),
    );
    expect(both.conflicts).toEqual([
      expect.objectContaining({ key: 'cycle:edge:x2', chosen: null }),
    ]);
  });

  it('перенос задачи в блок, куда ведёт её стрелка, — петля; задача остаётся на месте', () => {
    const branch = onBranch(moveTask('tb', 'c', 'a5'));
    const target = onTarget(taskEdge('y', 'tb', 'c'));
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([
      {
        kind: 'cycle',
        key: 'cycle:task:tb',
        record: 'task',
        id: 'tb',
        chosen: null,
        cycle: ['c'],
        instead: [],
      },
    ]);
    expect(must(graph.tasks.get(T('tb')))).toBe(must(target.tasks.get(T('tb'))));
    expect(graph.edges.has(E('y'))).toBe(true);
  });

  it('стрелка ветки от задачи, которую целевая перенесла в блок этой стрелки, — петля', () => {
    const branch = onBranch(taskEdge('x', 'tb', 'c'));
    const target = onTarget(moveTask('tb', 'c', 'a5'));
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([
      expect.objectContaining({ key: 'cycle:edge:x', cycle: ['c'], instead: [] }),
    ]);
    expect(graph).toBe(target);
  });

  it('перенос задачи со стрелкой замыкает цикл; вместо него можно не переносить стрелку', () => {
    // Ветка: t в f (f → c по стрелке e) и c → d. Целевая: d → f.
    const branch = onBranch(moveTask('t', 'f', 'a5'), edge('x', 'c', 'd'));
    const target = onTarget(edge('y', 'd', 'f'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts).toEqual([
      expect.objectContaining({
        key: 'cycle:task:t',
        cycle: ['c', 'd', 'f'],
        instead: ['cycle:edge:x'],
      }),
    ]);
    expect(blockOf(unresolved.graph, 't')).toBe('a');
    expect(unresolved.graph.edges.has(E('x'))).toBe(true);

    const swapped = mergeOk(
      BASE,
      branch,
      target,
      resolve(['cycle:task:t', 'branch'], ['cycle:edge:x', 'target']),
    );
    expect(swapped.conflicts).toEqual([
      expect.objectContaining({
        key: 'cycle:edge:x',
        cycle: ['d', 'f', 'c'],
        instead: ['cycle:task:t'],
        chosen: 'target',
      }),
    ]);
    expect(blockOf(swapped.graph, 't')).toBe('f');
    expect(swapped.graph.edges.has(E('x'))).toBe(false);
  });

  it('удалённое, возвращённое решением, может замкнуть цикл — тогда появляется конфликт цикла', () => {
    // Целевая удалила p (b → p → d) и провела d → b. Вернуть p — вернуть и цикл b → p → d → b.
    const branch = onBranch({ kind: 'updateTask', id: T('tp'), patch: { title: 'X' } });
    const target = onTarget(deleteNode('p'), edge('y', 'd', 'b'));
    expect(mergeOk(BASE, branch, target).conflicts.map((conflict) => conflict.key)).toEqual([
      'deleted:node:p',
    ]);
    const restored = mergeOk(BASE, branch, target, resolve(['deleted:node:p', 'branch']));
    expect(restored.conflicts).toEqual([
      expect.objectContaining({
        key: 'cycle:edge:e2',
        cycle: ['d', 'b', 'p'],
        instead: ['cycle:edge:e1'],
      }),
      expect.objectContaining({ key: 'deleted:node:p', chosen: 'branch' }),
    ]);
    expect(restored.graph.edges.has(E('e1')) && !restored.graph.edges.has(E('e2'))).toBe(true);
  });

  it('«вместо» — только изменения на найденном цикле: если цикл не разорвать другим, их нет', () => {
    // Цикл b → d → c → b есть и через p: b → p → d → c → b. Не переносить x1 мало — остаётся
    // цикл через p, поэтому вместо x2 предложить нечего.
    const branch = onBranch(edge('x1', 'b', 'd'), edge('x2', 'c', 'b'));
    const target = onTarget(edge('y', 'd', 'c'));
    expect(mergeOk(BASE, branch, target).conflicts).toEqual([
      expect.objectContaining({ key: 'cycle:edge:x2', cycle: ['b', 'p', 'd', 'c'], instead: [] }),
    ]);
  });

  it('решение «из целевой» без цикла не используется — стрелка переносится', () => {
    const branch = onBranch(edge('x', 'a', 'b'));
    const { graph, conflicts } = mergeOk(BASE, branch, BASE, resolve(['cycle:edge:x', 'target']));
    expect(conflicts).toEqual([]);
    expect(graph.edges.has(E('x'))).toBe(true);
  });

  it('перенос, который некуда вернуть, не отменяется: если цикл иначе не разорвать — ошибка', () => {
    // Ветка перенесла t в b и удалила a; целевая провела c → b. Вернуть t в a нельзя.
    const branch = onBranch(moveTask('t', 'b', 'a5'), deleteNode('a'));
    const target = onTarget(edge('y', 'c', 'b'));
    expect(merge(BASE, branch, target, as('merger', T3))).toEqual({
      ok: false,
      error: { code: 'CYCLE', path: ['b', 'c'] },
    });
  });
});

describe('merge: последствия', () => {
  /** a (выполнен) → b: в b начатая задача. */
  const DONE = build(
    block('a'),
    task('t1', 'a', { status: 'done' }),
    task('t3', 'a', { status: 'done', order: 'a1' }),
    block('b'),
    task('t2', 'b'),
    block('c'),
    edge('e', 'a', 'b'),
  );
  const branchOf = (...ops: Op[]) => applyOpsOk(DONE, ops, as('ann', T1));
  const targetOf = (...ops: Op[]) => applyOpsOk(DONE, ops, as('bob', T2));
  const reopen = (id: string, keepDone = false): Op => ({
    kind: 'updateTask',
    id: T(id),
    patch: { status: 'in_progress' },
    ...(keepDone ? { keepDone } : {}),
  });

  it('слияние переоткрыло задачу — начатое дальше получает предупреждение со временем слияния', () => {
    const branch = branchOf(reopen('t1'));
    const target = targetOf(reopen('t2'));
    const { graph, relock } = mergeOk(DONE, branch, target);
    expect(relock).toEqual({ nodes: ['a'], tasks: ['t2'] });
    expect(must(graph.tasks.get(T('t2'))).warnings).toEqual([
      { source: { kind: 'task', taskId: 't1' }, at: T3 },
    ]);
    expect(must(graph.nodes.get(N('a'))).countedDone).toBeNull();
  });

  it('«не блокировать» на всё слияние — нода засчитана, предупреждений нет', () => {
    const branch = branchOf(reopen('t1'));
    const target = targetOf(reopen('t2'));
    const { graph, relock } = mergeOk(DONE, branch, target, { keepDone: true });
    expect(relock).toEqual({ nodes: ['a'], tasks: ['t2'] });
    expect(must(graph.tasks.get(T('t2'))).warnings).toEqual([]);
    expect(must(graph.nodes.get(N('a'))).countedDone).toEqual({ by: 'merger', at: T3 });
  });

  it('пометка «засчитано», ставшая лишней после слияния, снимается', () => {
    // В целевой t3 переоткрыли с «не блокировать» — a засчитан. Ветка вынесла t3 из a.
    const target = targetOf(reopen('t3', true));
    expect(must(target.nodes.get(N('a'))).countedDone).not.toBeNull();
    const branch = branchOf(moveTask('t3', 'c', 'a0'));
    const { graph } = mergeOk(DONE, branch, target);
    expect(blockOf(graph, 't3')).toBe('c');
    expect(must(graph.tasks.get(T('t3'))).status).toBe('in_progress');
    expect(must(graph.nodes.get(N('a'))).countedDone).toBeNull();
  });
});
