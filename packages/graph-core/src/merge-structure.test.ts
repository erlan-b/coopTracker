// Слияние веток: удалённое с одной стороны против изменённого с другой, стрелки, превращение
// блока в роадмапу и обратно, лимиты (DESIGN.md, «Как устроено слияние», подшаг 2b).

import { describe, expect, it } from 'vitest';
import { asUserId } from './ids';
import { merge } from './merge';
import type { MergeOptions, MergeSide, Merged } from './merge';
import {
  E,
  N,
  T,
  applyOpsOk,
  block,
  build,
  buildLarge,
  edge,
  mergeChecked,
  milestone,
  must,
  roadmap,
  task,
  taskEdge,
  withTask,
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

/**
 * Роадмапа r (внутри блок a с t1, t2) → b (t3) → milestone m; от t3 стрелка в c (t4).
 * Пустая роадмапа q — для превращения обратно в блок.
 */
const BASE = build(
  roadmap('r'),
  block('a', { parent: 'r' }),
  task('t1', 'a'),
  task('t2', 'a', { order: 'a1' }),
  block('b'),
  task('t3', 'b'),
  block('c'),
  task('t4', 'c'),
  milestone('m'),
  roadmap('q'),
  edge('e1', 'a', 'b'),
  edge('e2', 'b', 'm'),
  taskEdge('e3', 't3', 'c'),
);

const onBranch = (...ops: Op[]): Graph => applyOpsOk(BASE, ops, as('ann', T1));
const onTarget = (...ops: Op[]): Graph => applyOpsOk(BASE, ops, as('bob', T2));

const deleteNode = (id: string): Op => ({ kind: 'deleteNode', id: N(id) });
const deleteTask = (id: string): Op => ({ kind: 'deleteTask', id: T(id) });
const rename = (id: string, title: string): Op => ({
  kind: 'updateTask',
  id: T(id),
  patch: { title },
});
const moveTask = (id: string, blockId: string, order: string): Op => ({
  kind: 'moveTask',
  id: T(id),
  blockId: N(blockId),
  order,
});

const mergeOk = (base: Graph, branch: Graph, target: Graph, options: MergeOptions = {}): Merged =>
  mergeChecked(base, branch, target, as('merger', T3), options);

const choose = (key: string, side: MergeSide): MergeOptions => ({
  resolutions: new Map([[key, side]]),
});

/** Какие записи есть в графе — для коротких проверок. */
const has = (graph: Graph) => ({
  nodes: (...ids: string[]) => ids.every((id) => graph.nodes.has(N(id))),
  tasks: (...ids: string[]) => ids.every((id) => graph.tasks.has(T(id))),
  edges: (...ids: string[]) => ids.every((id) => graph.edges.has(E(id))),
  noNodes: (...ids: string[]) => ids.every((id) => !graph.nodes.has(N(id))),
  noTasks: (...ids: string[]) => ids.every((id) => !graph.tasks.has(T(id))),
  noEdges: (...ids: string[]) => ids.every((id) => !graph.edges.has(E(id))),
});

describe('merge: удалено в целевой ветке', () => {
  it('в ветке не трогали или только сдвинули — удалено, без конфликта', () => {
    const target = onTarget(deleteNode('b'));
    expect(mergeOk(BASE, BASE, target).graph).toBe(target);
    const moved = onBranch({ kind: 'moveNodes', moves: [{ id: N('b'), x: 50, y: 50 }] });
    const { graph, conflicts } = mergeOk(BASE, moved, target);
    expect(conflicts).toEqual([]);
    expect(has(graph).noNodes('b')).toBe(true);
  });

  it('в ветке задачу только переставили или она получила предупреждение — удалено без конфликта', () => {
    const target = onTarget(deleteNode('a'));
    const reordered = onBranch(moveTask('t1', 'a', 'a9'));
    const warned = withTask(BASE, 't1', {
      warnings: [{ source: { kind: 'node', nodeId: N('m') }, at: T1 }],
    });
    for (const branch of [reordered, warned]) {
      const { graph, conflicts } = mergeOk(BASE, branch, target);
      expect(conflicts).toEqual([]);
      expect(has(graph).noNodes('a') && has(graph).noTasks('t1', 't2')).toBe(true);
    }
  });

  it('стрелка ветки от задачи, которую целевая вынесла из удалённого блока, — без конфликта', () => {
    const target = onTarget(moveTask('t3', 'a', 'a5'), deleteNode('b'));
    const branch = onBranch(taskEdge('x1', 't3', 'm'));
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([]);
    expect(must(graph.tasks.get(T('t3'))).blockId).toBe('a');
    expect(has(graph).noNodes('b') && has(graph).edges('e3', 'x1')).toBe(true);
  });

  it('в ветке изменили задачу внутри — конфликт на блок; по умолчанию удалено', () => {
    const branch = onBranch(rename('t3', 'X'));
    const target = onTarget(deleteNode('b'));
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([
      {
        kind: 'deleted',
        key: 'deleted:node:b',
        record: 'node',
        id: 'b',
        deletedIn: 'target',
        chosen: null,
        inside: { nodes: ['b'], tasks: ['t3'] },
        orphans: [],
      },
    ]);
    expect(has(graph).noNodes('b')).toBe(true);
    expect(has(graph).noTasks('t3')).toBe(true);
  });

  it('«как в ветке» возвращает блок с задачами и стрелками', () => {
    const branch = onBranch(rename('t3', 'X'));
    const target = onTarget(deleteNode('b'));
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:b', 'branch'));
    expect(has(graph).nodes('b') && has(graph).edges('e1', 'e2', 'e3')).toBe(true);
    expect(must(graph.tasks.get(T('t3'))).title).toBe('X');
  });

  it('стрелка к тому, что удалено в целевой без конфликта, не возвращается', () => {
    const branch = onBranch(rename('t3', 'X'));
    const target = onTarget(deleteNode('b'), deleteNode('m'));
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:b', 'branch'));
    expect(has(graph).nodes('b') && has(graph).edges('e1', 'e3')).toBe(true);
    expect(has(graph).noNodes('m') && has(graph).noEdges('e2')).toBe(true);
  });

  it('удалённая задача, изменённая в ветке, — конфликт на задачу', () => {
    const branch = onBranch(rename('t3', 'X'));
    const target = onTarget(deleteTask('t3'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts.map((conflict) => conflict.key)).toEqual(['deleted:task:t3']);
    expect(has(unresolved.graph).noTasks('t3')).toBe(true);
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:task:t3', 'branch'));
    expect(has(graph).tasks('t3') && has(graph).edges('e3')).toBe(true);
  });

  it('новое в удалённой роадмапе — один конфликт на роадмапу, возвращается всё вместе', () => {
    const branch = onBranch(block('n', { parent: 'r' }), task('t9', 'n'), edge('x1', 'n', 'b'));
    const target = onTarget(deleteNode('r'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts.map((conflict) => conflict.key)).toEqual(['deleted:node:r']);
    expect(has(unresolved.graph).noNodes('r', 'a', 'n')).toBe(true);
    expect(has(unresolved.graph).noTasks('t1', 't9') && has(unresolved.graph).noEdges('x1')).toBe(
      true,
    );
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:r', 'branch'));
    expect(has(graph).nodes('r', 'a', 'n') && has(graph).tasks('t1', 't2', 't9')).toBe(true);
    expect(has(graph).edges('e1', 'x1')).toBe(true);
  });

  it('новая стрелка в ветке к удалённой ноде — конфликт', () => {
    const branch = onBranch(edge('x1', 'c', 'm'));
    const target = onTarget(deleteNode('m'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts.map((conflict) => conflict.key)).toEqual(['deleted:node:m']);
    expect(has(unresolved.graph).noEdges('x1')).toBe(true);
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:m', 'branch'));
    expect(has(graph).nodes('m') && has(graph).edges('e2', 'x1')).toBe(true);
  });

  it('задача, перенесённая веткой в удалённый блок: по умолчанию остаётся на месте', () => {
    const branch = onBranch(moveTask('t1', 'c', 'a5'));
    const target = onTarget(deleteNode('c'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts.map((conflict) => conflict.key)).toEqual(['deleted:node:c']);
    expect(must(unresolved.graph.tasks.get(T('t1')))).toMatchObject({ blockId: 'a', order: 'a0' });
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:c', 'branch'));
    expect(must(graph.tasks.get(T('t1')))).toMatchObject({ blockId: 'c', order: 'a5' });
    expect(has(graph).tasks('t4') && has(graph).edges('e3')).toBe(true);
  });

  it('перенос в удалённый блок даёт конфликт удаления при любом решении о месте задачи', () => {
    const branch = onBranch(moveTask('t1', 'c', 'a5'));
    const target = onTarget(moveTask('t1', 'b', 'a5'), deleteNode('c'));
    for (const side of [undefined, 'branch', 'target'] as const) {
      const options = side === undefined ? {} : choose('field:blockId:task:t1', side);
      const { graph, conflicts } = mergeOk(BASE, branch, target, options);
      expect(conflicts.map((conflict) => conflict.key)).toEqual([
        'deleted:node:c',
        'field:blockId:task:t1',
      ]);
      expect(must(graph.tasks.get(T('t1'))).blockId).toBe('b');
    }
    const both: MergeOptions = {
      resolutions: new Map([
        ['deleted:node:c', 'branch'],
        ['field:blockId:task:t1', 'branch'],
      ]),
    };
    expect(must(mergeOk(BASE, branch, target, both).graph.tasks.get(T('t1'))).blockId).toBe('c');
  });

  it('задача, которой при удалении негде остаться, названа в конфликте и уходит с удалённым', () => {
    // Ветка перенесла t1 в c и удалила её прежний блок a; целевая удалила c.
    const branch = onBranch(moveTask('t1', 'c', 'a5'), deleteNode('a'));
    const target = onTarget(deleteNode('c'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts).toEqual([
      expect.objectContaining({
        key: 'deleted:node:c',
        inside: { nodes: ['c'], tasks: ['t4'] },
        orphans: ['t1'],
      }),
    ]);
    expect(has(unresolved.graph).noNodes('a', 'c') && has(unresolved.graph).noTasks('t1')).toBe(
      true,
    );
    const kept = mergeOk(BASE, branch, target, choose('deleted:node:c', 'branch'));
    expect(kept.conflicts).toEqual([expect.objectContaining({ orphans: ['t1'] })]);
    expect(must(kept.graph.tasks.get(T('t1'))).blockId).toBe('c');
  });
});

describe('merge: удалено в ветке', () => {
  it('в целевой не трогали или только сдвинули — удаляется вместе со стрелками', () => {
    const branch = onBranch(deleteNode('b'));
    const moved = onTarget({ kind: 'moveNodes', moves: [{ id: N('b'), x: 50, y: 50 }] });
    for (const target of [BASE, moved]) {
      const { graph, conflicts } = mergeOk(BASE, branch, target);
      expect(conflicts).toEqual([]);
      expect(has(graph).noNodes('b') && has(graph).noTasks('t3')).toBe(true);
      expect(has(graph).noEdges('e1', 'e2', 'e3')).toBe(true);
    }
  });

  it('в целевой изменили — конфликт; по умолчанию остаётся со стрелками', () => {
    const branch = onBranch(deleteNode('b'));
    const target = onTarget(rename('t3', 'Y'), task('t8', 'b', { order: 'a5' }));
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([
      expect.objectContaining({ key: 'deleted:node:b', deletedIn: 'branch', chosen: null }),
    ]);
    expect(has(graph).nodes('b') && has(graph).tasks('t3', 't8')).toBe(true);
    expect(has(graph).edges('e1', 'e2', 'e3')).toBe(true);
    expect(graph).toBe(target);
  });

  it('«как в ветке» удаляет вместе с новым из целевой', () => {
    const branch = onBranch(deleteNode('b'));
    const target = onTarget(rename('t3', 'Y'), task('t8', 'b', { order: 'a5' }));
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:b', 'branch'));
    expect(has(graph).noNodes('b') && has(graph).noTasks('t3', 't8')).toBe(true);
    expect(has(graph).noEdges('e1', 'e2', 'e3')).toBe(true);
  });

  it('удалённая задача, изменённая в целевой, — конфликт на задачу; по умолчанию остаётся', () => {
    const branch = onBranch(deleteTask('t3'));
    const target = onTarget(rename('t3', 'Y'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts).toEqual([
      expect.objectContaining({
        key: 'deleted:task:t3',
        deletedIn: 'branch',
        inside: { nodes: [], tasks: ['t3'] },
        orphans: [],
      }),
    ]);
    expect(unresolved.graph).toBe(target);
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:task:t3', 'branch'));
    expect(has(graph).noTasks('t3') && has(graph).noEdges('e3')).toBe(true);
  });

  it('новая стрелка в целевой к удалённой ноде — конфликт', () => {
    const branch = onBranch(deleteNode('m'));
    const target = onTarget(edge('x1', 'c', 'm'));
    expect(mergeOk(BASE, branch, target).graph).toBe(target);
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:m', 'branch'));
    expect(has(graph).noNodes('m') && has(graph).noEdges('e2', 'x1')).toBe(true);
  });

  it('задача, перенесённая целевой в удалённый блок: «как в ветке» — на место из ветки', () => {
    const branch = onBranch(deleteNode('c'));
    const target = onTarget(moveTask('t1', 'c', 'a5'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts.map((conflict) => conflict.key)).toEqual(['deleted:node:c']);
    expect(unresolved.graph).toBe(target);
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:c', 'branch'));
    expect(has(graph).noNodes('c') && has(graph).noTasks('t4')).toBe(true);
    expect(must(graph.tasks.get(T('t1')))).toMatchObject({ blockId: 'a', order: 'a0' });
  });

  it('если и на месте из ветки блока нет — задача уходит вместе с удалённым', () => {
    const branch = onBranch(deleteNode('c'));
    const target = onTarget(moveTask('t1', 'c', 'a5'), deleteNode('a'));
    const { graph } = mergeOk(BASE, branch, target, choose('deleted:node:c', 'branch'));
    expect(has(graph).noNodes('a', 'c') && has(graph).noTasks('t1', 't2', 't4')).toBe(true);
  });
});

describe('merge: стрелки', () => {
  it('одинаковая стрелка с обеих сторон с разными id — остаётся целевая', () => {
    const { graph, conflicts } = mergeOk(
      BASE,
      onBranch(edge('x1', 'c', 'm')),
      onTarget(edge('x2', 'c', 'm')),
    );
    expect(conflicts).toEqual([]);
    expect(has(graph).edges('x2') && has(graph).noEdges('x1')).toBe(true);
  });

  it('удалённая с любой стороны стрелка удаляется', () => {
    const branch = onBranch({ kind: 'deleteEdge', id: E('e2') });
    const target = onTarget({ kind: 'deleteEdge', id: E('e3') });
    const { graph } = mergeOk(BASE, branch, target);
    expect(has(graph).noEdges('e2', 'e3') && has(graph).edges('e1')).toBe(true);
  });
});

describe('merge: блок ↔ роадмапа против содержимого', () => {
  const toRoadmap: Op = { kind: 'blockToRoadmap', id: N('b'), innerBlockId: N('bi') };

  it('блок стал роадмапой с одной стороны, задача добавлена с другой — во внутренний блок', () => {
    for (const [branch, target] of [
      [onBranch(toRoadmap), onTarget(task('t8', 'b', { order: 'a5' }))],
      [onBranch(task('t8', 'b', { order: 'a5' })), onTarget(toRoadmap)],
    ] as const) {
      const { graph, conflicts } = mergeOk(BASE, branch, target);
      expect(conflicts).toEqual([]);
      expect(must(graph.nodes.get(N('b'))).type).toBe('roadmap');
      expect(must(graph.tasks.get(T('t8')))).toMatchObject({ blockId: 'bi', order: 'a5' });
      expect(must(graph.tasks.get(T('t3'))).blockId).toBe('bi');
    }
  });

  it('из новых блоков внутри роадмапы берётся самый ранний', () => {
    const converted = applyOpsOk(BASE, [toRoadmap], as('ann', T1));
    const later = as('ann', '2026-11-07T10:30:00.000Z');
    const branch = applyOpsOk(converted, [block('a0', { parent: 'b' })], later);
    const target = onTarget(task('t8', 'b', { order: 'a5' }));
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([]);
    expect(must(graph.tasks.get(T('t8'))).blockId).toBe('bi');
  });

  it('блок стал роадмапой с обеих сторон — внутренний блок целевой, содержимое ветки в нём', () => {
    const branch = onBranch(
      toRoadmap,
      task('t9', 'bi', { order: 'a5' }),
      edge('x1', 'bi', 'm'),
      taskEdge('x2', 't1', 'bi'),
    );
    const target = onTarget({ kind: 'blockToRoadmap', id: N('b'), innerBlockId: N('bj') });
    const { graph, conflicts } = mergeOk(BASE, branch, target);
    expect(conflicts).toEqual([]);
    expect(has(graph).nodes('bj') && has(graph).noNodes('bi')).toBe(true);
    expect(must(graph.tasks.get(T('t3'))).blockId).toBe('bj');
    expect(must(graph.tasks.get(T('t9'))).blockId).toBe('bj');
    expect(must(graph.edges.get(E('x1')))).toMatchObject({
      source: { kind: 'node', nodeId: 'bj' },
      target: { kind: 'node', nodeId: 'm' },
    });
    expect(must(graph.edges.get(E('x2')))).toMatchObject({
      source: { kind: 'task', taskId: 't1' },
      target: { kind: 'node', nodeId: 'bj' },
    });
  });

  it('внутреннего блока нет — конфликт типа; выбранный тип остаётся', () => {
    const branch = onBranch(toRoadmap, deleteNode('bi'));
    const target = onTarget(task('t8', 'b', { order: 'a5' }));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts).toEqual([
      {
        kind: 'type',
        key: 'type:node:b',
        record: 'node',
        id: 'b',
        branch: 'roadmap',
        target: 'block',
        chosen: null,
      },
    ]);
    expect(must(unresolved.graph.nodes.get(N('b'))).type).toBe('block');
    expect(has(unresolved.graph).tasks('t8')).toBe(true);
    const { graph } = mergeOk(BASE, branch, target, choose('type:node:b', 'branch'));
    expect(must(graph.nodes.get(N('b'))).type).toBe('roadmap');
    expect(has(graph).noTasks('t8')).toBe(true);
  });

  it('роадмапа стала блоком с одной стороны, нода добавлена в неё с другой — конфликт типа', () => {
    const branch = onBranch({ kind: 'roadmapToBlock', id: N('q') }, task('t9', 'q'));
    const target = onTarget(block('qa', { parent: 'q' }), task('t10', 'qa'));
    const unresolved = mergeOk(BASE, branch, target);
    expect(unresolved.conflicts.map((conflict) => conflict.key)).toEqual(['type:node:q']);
    // Тип остался целевым — и нода целевая целиком, с подписью: в ней ничего не поменялось.
    expect(must(unresolved.graph.nodes.get(N('q')))).toBe(must(target.nodes.get(N('q'))));
    expect(has(unresolved.graph).nodes('qa') && has(unresolved.graph).tasks('t10')).toBe(true);
    expect(has(unresolved.graph).noTasks('t9')).toBe(true);
    const { graph } = mergeOk(BASE, branch, target, choose('type:node:q', 'branch'));
    expect(must(graph.nodes.get(N('q'))).type).toBe('block');
    expect(has(graph).tasks('t9') && has(graph).noNodes('qa')).toBe(true);
    expect(has(graph).noTasks('t10')).toBe(true);
  });
});

describe('merge: конфликты разных видов вместе', () => {
  it('по записи и id; у одной записи — удаление, тип, потом поля', () => {
    const branch = onBranch(rename('t3', 'X'), rename('t4', 'X'), deleteNode('m'));
    const target = onTarget(deleteNode('b'), rename('t4', 'Y'), edge('x1', 'c', 'm'));
    expect(mergeOk(BASE, branch, target).conflicts.map((conflict) => conflict.key)).toEqual([
      'deleted:node:b',
      'deleted:node:m',
      'field:title:task:t4',
    ]);
  });
});

describe('merge: повторный id', () => {
  it('одна запись — milestone с одной стороны и блок с другой — ошибка DUPLICATE_ID', () => {
    const branch = onBranch(milestone('z'));
    const target = onTarget(block('z'));
    const error = { ok: false, error: { code: 'DUPLICATE_ID', id: 'z' } };
    expect(merge(BASE, branch, target, as('merger', T3))).toEqual(error);
    expect(merge(BASE, target, branch, as('merger', T3))).toEqual(error);
  });
});

describe('merge: лимиты', () => {
  it('результат больше лимита нод — ошибка', () => {
    const ops: Op[] = [];
    for (let i = 0; i < 1_999; i++) ops.push(block(`n${i}`));
    const base = buildLarge(ops);
    const branch = applyOpsOk(base, [block('extra1')], as('ann', T1));
    const target = applyOpsOk(base, [block('extra2')], as('bob', T2));
    expect(merge(base, branch, target, as('merger', T3))).toEqual({
      ok: false,
      error: { code: 'LIMIT_EXCEEDED', records: 'nodes', limit: 2_000 },
    });
  });
});
