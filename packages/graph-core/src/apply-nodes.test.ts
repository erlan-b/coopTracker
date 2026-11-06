import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  LATER,
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
  milestone,
  must,
  roadmap,
  task,
  taskEdge,
} from './test-helpers';
import type { NodePatch, Op } from './types';

describe('createNode', () => {
  it('создаёт блок и проставляет авторство', () => {
    const graph = applyOk(EMPTY, block('a', { x: 10, y: -20 }), ctx('member'));
    expect(graph.nodes.get(N('a'))).toEqual({
      id: 'a',
      type: 'block',
      parentId: null,
      title: 'a',
      description: '',
      x: 10,
      y: -20,
      deadline: null,
      labelIds: [],
      countedDone: null,
      createdBy: 'member',
      createdAt: NOW,
      updatedBy: 'member',
      updatedAt: NOW,
    });
  });

  it('занятый id → DUPLICATE_ID', () => {
    const graph = build(block('a'));
    expect(errorOf(apply(graph, milestone('a')))).toEqual({ code: 'DUPLICATE_ID', id: 'a' });
  });

  it('кладёт блок и milestone внутрь роадмапы', () => {
    const graph = build(roadmap('r'), block('b', { parent: 'r' }), milestone('m', { parent: 'r' }));
    expect(graph.nodes.get(N('b'))?.parentId).toBe('r');
    expect(graph.nodes.get(N('m'))?.parentId).toBe('r');
  });

  it('родитель не найден или не роадмапа → INVALID_PARENT', () => {
    const graph = build(block('a'));
    expect(errorOf(apply(graph, block('b', { parent: 'nope' })))).toEqual({
      code: 'INVALID_PARENT',
      parentId: 'nope',
    });
    expect(errorOf(apply(graph, block('b', { parent: 'a' })))).toEqual({
      code: 'INVALID_PARENT',
      parentId: 'a',
    });
  });

  it('роадмапа только на корневом уровне → NESTING_TOO_DEEP', () => {
    const graph = build(roadmap('r'));
    expect(errorOf(apply(graph, roadmap('inner', { parent: 'r' })))).toEqual({
      code: 'NESTING_TOO_DEEP',
      id: 'inner',
    });
  });

  it('координаты только целые → INVALID_VALUE', () => {
    expect(errorOf(apply(EMPTY, block('a', { x: 1.5 })))).toEqual({
      code: 'INVALID_VALUE',
      field: 'x',
      reason: 'not_integer',
    });
    expect(errorOf(apply(EMPTY, block('a', { y: Number.NaN })))).toEqual({
      code: 'INVALID_VALUE',
      field: 'y',
      reason: 'not_integer',
    });
  });

  it('берёт только поля своего типа: лишнее из сообщения в граф не попадает', () => {
    const op = {
      kind: 'createNode',
      node: {
        id: N('m'),
        type: 'milestone',
        parentId: null,
        title: '',
        description: '',
        x: 0,
        y: 0,
        deadline: null,
        labelIds: [],
        createdBy: 'someone-else',
        countedDone: { by: 'someone-else', at: NOW },
      },
    } as unknown as Op;
    const node = applyOk(EMPTY, op).nodes.get(N('m'));
    expect(node).not.toHaveProperty('labelIds');
    expect(node).toHaveProperty('createdBy', 'master');
    expect(node).toHaveProperty('countedDone', null);
  });

  it('не трогает задачи и стрелки', () => {
    const graph = build(block('a'), block('b'), task('t', 'a'), edge('ab', 'a', 'b'));
    const next = applyOk(graph, block('c'));
    expect(next.tasks).toBe(graph.tasks);
    expect(next.edges).toBe(graph.edges);
    expect(next.nodes.get(N('a'))).toBe(graph.nodes.get(N('a')));
  });
});

describe('updateNode', () => {
  it('меняет поля и отмечает, кто и когда', () => {
    const graph = build(block('a'));
    const next = applyOk(
      graph,
      {
        kind: 'updateNode',
        id: N('a'),
        patch: { title: 'Авторизация', deadline: { kind: 'date', date: '2026-12-01' } },
      },
      ctx('member', {}, LATER),
    );
    expect(next.nodes.get(N('a'))).toMatchObject({
      title: 'Авторизация',
      deadline: { kind: 'date', date: '2026-12-01' },
      createdBy: 'master',
      createdAt: NOW,
      updatedBy: 'member',
      updatedAt: LATER,
    });
  });

  it('null очищает поле', () => {
    const graph = build(block('a'), {
      kind: 'updateNode',
      id: N('a'),
      patch: { deadline: { kind: 'date', date: '2026-12-01' } },
    });
    const next = applyOk(graph, { kind: 'updateNode', id: N('a'), patch: { deadline: null } });
    expect(next.nodes.get(N('a'))).toHaveProperty('deadline', null);
  });

  it('поле не этого типа ноды → FIELD_NOT_APPLICABLE', () => {
    const graph = build(milestone('m'));
    const op: Op = { kind: 'updateNode', id: N('m'), patch: { labelIds: [] } };
    expect(errorOf(apply(graph, op))).toEqual({
      code: 'FIELD_NOT_APPLICABLE',
      field: 'labelIds',
      nodeType: 'milestone',
    });
  });

  it('нода не найдена → NODE_NOT_FOUND', () => {
    const op: Op = { kind: 'updateNode', id: N('nope'), patch: { title: 'x' } };
    expect(errorOf(apply(EMPTY, op))).toEqual({ code: 'NODE_NOT_FOUND', id: 'nope' });
  });

  it('без новых значений возвращает тот же граф', () => {
    const graph = build(block('a', { title: 'A' }));
    const op: Op = { kind: 'updateNode', id: N('a'), patch: { title: 'A', labelIds: [] } };
    expect(applyOk(graph, op, ctx('member', {}, LATER))).toBe(graph);
  });

  it('поля вне изменения (тип, родитель, координаты) не меняются', () => {
    const graph = build(roadmap('r'), block('a'));
    const patch = { title: 'B', type: 'milestone', parentId: 'r', x: 50 } as unknown as NodePatch;
    const node = applyOk(graph, { kind: 'updateNode', id: N('a'), patch }).nodes.get(N('a'));
    expect(node).toMatchObject({ title: 'B', type: 'block', parentId: null, x: 0 });
  });
});

describe('moveNodes', () => {
  it('двигает ноды, авторство не трогает, остальное — те же объекты', () => {
    const graph = build(block('a'), block('b'), block('c'));
    const next = applyOk(
      graph,
      {
        kind: 'moveNodes',
        moves: [
          { id: N('a'), x: 100, y: 40 },
          { id: N('b'), x: 0, y: 0 },
        ],
      },
      ctx('member', {}, LATER),
    );
    expect(next.nodes.get(N('a'))).toMatchObject({
      x: 100,
      y: 40,
      updatedBy: 'master',
      updatedAt: NOW,
    });
    expect(next.nodes.get(N('b'))).toBe(graph.nodes.get(N('b')));
    expect(next.nodes.get(N('c'))).toBe(graph.nodes.get(N('c')));
    expect(next.tasks).toBe(graph.tasks);
    expect(next.edges).toBe(graph.edges);
  });

  it('без реальных сдвигов — тот же граф', () => {
    const graph = build(block('a', { x: 5 }));
    const op: Op = { kind: 'moveNodes', moves: [{ id: N('a'), x: 5, y: 0 }] };
    expect(applyOk(graph, op)).toBe(graph);
    expect(applyOk(graph, { kind: 'moveNodes', moves: [] })).toBe(graph);
  });

  it('дробные координаты, повтор ноды и несуществующая нода — ошибки', () => {
    const graph = build(block('a'));
    const move = (x: number, y: number) => ({ id: N('a'), x, y });
    expect(errorOf(apply(graph, { kind: 'moveNodes', moves: [move(0.5, 0)] }))).toEqual({
      code: 'INVALID_VALUE',
      field: 'x',
      reason: 'not_integer',
    });
    expect(errorOf(apply(graph, { kind: 'moveNodes', moves: [move(1, 1), move(2, 2)] }))).toEqual({
      code: 'INVALID_VALUE',
      field: 'moves',
      reason: 'duplicate',
    });
    const missing: Op = { kind: 'moveNodes', moves: [{ id: N('nope'), x: 0, y: 0 }] };
    expect(errorOf(apply(graph, missing))).toEqual({ code: 'NODE_NOT_FOUND', id: 'nope' });
  });
});

describe('deleteNode', () => {
  it('удаляет блок с задачами и всеми стрелками', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      task('t1', 'b'),
      task('t2', 'a'),
      edge('ab', 'a', 'b'),
      edge('bc', 'b', 'c'),
      taskEdge('t1c', 't1', 'c'),
      taskEdge('t2c', 't2', 'c'),
    );
    const next = applyOk(graph, { kind: 'deleteNode', id: N('b') });
    expect([...next.nodes.keys()].sort()).toEqual(['a', 'c']);
    expect([...next.tasks.keys()]).toEqual(['t2']);
    expect([...next.edges.keys()]).toEqual(['t2c']);
    expect(next.nodes.get(N('a'))).toBe(graph.nodes.get(N('a')));
    expect(next.tasks.get(T('t2'))).toBe(graph.tasks.get(T('t2')));
  });

  it('удаляет роадмапу со всем содержимым, включая стрелки через границу', () => {
    const graph = build(
      roadmap('r'),
      block('in', { parent: 'r' }),
      task('t', 'in'),
      block('out'),
      block('src'),
      edge('src-in', 'src', 'in'),
      taskEdge('t-out', 't', 'out'),
      edge('r-out', 'r', 'out'),
      edge('src-out', 'src', 'out'),
    );
    const next = applyOk(graph, { kind: 'deleteNode', id: N('r') });
    expect([...next.nodes.keys()].sort()).toEqual(['out', 'src']);
    expect(next.tasks.size).toBe(0);
    expect([...next.edges.keys()]).toEqual(['src-out']);
  });

  it('нода не найдена → NODE_NOT_FOUND', () => {
    expect(errorOf(apply(EMPTY, { kind: 'deleteNode', id: N('nope') }))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'nope',
    });
  });
});

describe('blockToRoadmap', () => {
  const graph = build(
    block('a', { title: 'Авторизация' }),
    block('x'),
    block('y'),
    task('t1', 'a', { status: 'done' }),
    task('t2', 'a'),
    edge('xa', 'x', 'a'),
    edge('ay', 'a', 'y'),
    taskEdge('t1y', 't1', 'y'),
  );
  const op: Op = { kind: 'blockToRoadmap', id: N('a'), innerBlockId: N('a-inner') };

  it('задачи переезжают во внутренний блок со всеми полями, стрелки остаются как были', () => {
    const next = applyOk(graph, op, ctx('member', {}, LATER));
    expect(next.nodes.get(N('a'))).toMatchObject({
      type: 'roadmap',
      title: 'Авторизация',
      parentId: null,
      updatedBy: 'member',
      updatedAt: LATER,
    });
    expect(next.nodes.get(N('a-inner'))).toMatchObject({
      type: 'block',
      parentId: 'a',
      title: 'Авторизация',
      description: '',
      createdBy: 'member',
    });
    expect(next.tasks.get(T('t1'))).toEqual({
      ...must(graph.tasks.get(T('t1'))),
      blockId: 'a-inner',
    });
    expect(next.tasks.get(T('t2'))?.blockId).toBe('a-inner');
    expect(next.edges).toBe(graph.edges);
    expect(next.nodes.get(N('x'))).toBe(graph.nodes.get(N('x')));
  });

  it('только блок → WRONG_NODE_TYPE', () => {
    const withMilestone = build(milestone('m'));
    const toRoadmap: Op = { kind: 'blockToRoadmap', id: N('m'), innerBlockId: N('i') };
    expect(errorOf(apply(withMilestone, toRoadmap))).toEqual({
      code: 'WRONG_NODE_TYPE',
      id: 'm',
      expected: 'block',
    });
  });

  it('блок внутри роадмапы → NESTING_TOO_DEEP', () => {
    const nested = build(roadmap('r'), block('b', { parent: 'r' }));
    const toRoadmap: Op = { kind: 'blockToRoadmap', id: N('b'), innerBlockId: N('i') };
    expect(errorOf(apply(nested, toRoadmap))).toEqual({ code: 'NESTING_TOO_DEEP', id: 'b' });
  });

  it('занятый id внутреннего блока → DUPLICATE_ID', () => {
    const taken: Op = { kind: 'blockToRoadmap', id: N('a'), innerBlockId: N('x') };
    expect(errorOf(apply(graph, taken))).toEqual({ code: 'DUPLICATE_ID', id: 'x' });
  });
});

describe('roadmapToBlock', () => {
  it('пустая роадмапа становится блоком', () => {
    const graph = build(roadmap('r', { title: 'Релиз' }));
    const next = applyOk(graph, { kind: 'roadmapToBlock', id: N('r') });
    expect(next.nodes.get(N('r'))).toMatchObject({ type: 'block', title: 'Релиз' });
  });

  it('непустая → ROADMAP_NOT_EMPTY', () => {
    const graph = build(roadmap('r'), milestone('m', { parent: 'r' }));
    expect(errorOf(apply(graph, { kind: 'roadmapToBlock', id: N('r') }))).toEqual({
      code: 'ROADMAP_NOT_EMPTY',
      id: 'r',
    });
  });

  it('не роадмапа → WRONG_NODE_TYPE', () => {
    const graph = build(block('a'));
    expect(errorOf(apply(graph, { kind: 'roadmapToBlock', id: N('a') }))).toEqual({
      code: 'WRONG_NODE_TYPE',
      id: 'a',
      expected: 'roadmap',
    });
  });
});

describe('id из сообщений', () => {
  it('id вроде constructor и __proto__ — обычные id, а не поля прототипа', () => {
    expect(errorOf(apply(EMPTY, task('t', 'constructor')))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'constructor',
    });
    const graph = applyOk(EMPTY, block('__proto__'));
    expect([...graph.nodes.keys()]).toEqual(['__proto__']);
    const withTask = applyOk(graph, task('t', '__proto__'));
    expect(withTask.tasks.get(T('t'))?.blockId).toBe('__proto__');
    const removed = applyOk(withTask, { kind: 'deleteNode', id: N('__proto__') });
    expect([...removed.nodes.keys()]).toEqual([]);
    expect([...removed.tasks.keys()]).toEqual([]);
  });
});
