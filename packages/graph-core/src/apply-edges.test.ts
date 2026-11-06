import { describe, expect, it } from 'vitest';
import type { GraphError } from './errors';
import {
  E,
  EMPTY,
  apply,
  applyOk,
  block,
  build,
  edge,
  errorOf,
  milestone,
  roadmap,
  task,
  taskEdge,
} from './test-helpers';

/** Ноды цикла без учёта порядка обхода. */
function cycleNodes(error: GraphError): string[] {
  if (error.code !== 'CYCLE') throw new Error(`ожидался CYCLE, а пришёл ${error.code}`);
  return [...error.path].sort();
}

describe('createEdge', () => {
  it('стрелка от выхода ноды и от выхода задачи', () => {
    const graph = build(block('a'), block('b'), block('c'), task('t', 'a'));
    const withNodeEdge = applyOk(graph, edge('ab', 'a', 'b'));
    const next = applyOk(withNodeEdge, taskEdge('tc', 't', 'c'));
    expect(next.edges.get(E('ab'))).toEqual({
      id: 'ab',
      source: { kind: 'node', nodeId: 'a' },
      target: { kind: 'node', nodeId: 'b' },
    });
    expect(next.edges.get(E('tc'))).toEqual({
      id: 'tc',
      source: { kind: 'task', taskId: 't' },
      target: { kind: 'node', nodeId: 'c' },
    });
    expect(next.nodes).toBe(graph.nodes);
    expect(next.tasks).toBe(graph.tasks);
    expect(next.edges.get(E('ab'))).toBe(withNodeEdge.edges.get(E('ab')));
  });

  it('конец не найден → NODE_NOT_FOUND / TASK_NOT_FOUND', () => {
    const graph = build(block('a'));
    expect(errorOf(apply(graph, edge('e', 'nope', 'a')))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'nope',
    });
    expect(errorOf(apply(graph, edge('e', 'a', 'nope')))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'nope',
    });
    expect(errorOf(apply(graph, taskEdge('e', 'nope', 'a')))).toEqual({
      code: 'TASK_NOT_FOUND',
      id: 'nope',
    });
  });

  it('петля → SELF_LOOP, в том числе от задачи к её же блоку', () => {
    const graph = build(block('a'), task('t', 'a'));
    expect(errorOf(apply(graph, edge('aa', 'a', 'a')))).toEqual({
      code: 'SELF_LOOP',
      edgeId: 'aa',
    });
    expect(errorOf(apply(graph, taskEdge('ta', 't', 'a')))).toEqual({
      code: 'SELF_LOOP',
      edgeId: 'ta',
    });
  });

  it('такая же стрелка уже есть → DUPLICATE_EDGE с id существующей', () => {
    const graph = build(
      block('a'),
      block('b'),
      task('t', 'a'),
      edge('ab', 'a', 'b'),
      taskEdge('tb', 't', 'b'),
    );
    expect(errorOf(apply(graph, edge('ab2', 'a', 'b')))).toEqual({
      code: 'DUPLICATE_EDGE',
      edgeId: 'ab',
    });
    expect(errorOf(apply(graph, taskEdge('tb2', 't', 'b')))).toEqual({
      code: 'DUPLICATE_EDGE',
      edgeId: 'tb',
    });
  });

  it('занятый id → DUPLICATE_ID', () => {
    const graph = build(block('a'), block('b'), block('c'), edge('e', 'a', 'b'));
    expect(errorOf(apply(graph, edge('e', 'b', 'c')))).toEqual({ code: 'DUPLICATE_ID', id: 'e' });
  });

  it('цикл → CYCLE с нодами цикла', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      block('d'),
      edge('ab', 'a', 'b'),
      edge('bc', 'b', 'c'),
      edge('dc', 'd', 'c'),
    );
    expect(cycleNodes(errorOf(apply(graph, edge('ca', 'c', 'a'))))).toEqual(['a', 'b', 'c']);
  });

  it('стрелка от задачи при поиске циклов считается стрелкой от её блока', () => {
    const graph = build(block('a'), block('b'), task('t', 'b'), edge('ab', 'a', 'b'));
    expect(cycleNodes(errorOf(apply(graph, taskEdge('ta', 't', 'a'))))).toEqual(['a', 'b']);
  });

  it('стрелки через границу роадмапы разрешены в обе стороны и между роадмапами', () => {
    const graph = build(
      roadmap('r1'),
      block('in1', { parent: 'r1' }),
      task('t', 'in1'),
      roadmap('r2'),
      block('in2', { parent: 'r2' }),
      block('x'),
    );
    const next = [
      edge('in1-x', 'in1', 'x'),
      edge('x-in2', 'x', 'in2'),
      edge('in1-in2', 'in1', 'in2'),
      taskEdge('t-in2', 't', 'in2'),
      edge('r1-r2', 'r1', 'r2'),
    ].reduce((current, op) => applyOk(current, op), graph);
    expect([...next.edges.keys()]).toHaveLength(5);
  });

  it('тупик: блок внутри R ждёт X, а X ждёт всю R → CYCLE', () => {
    const graph = build(
      roadmap('r'),
      block('in', { parent: 'r' }),
      block('x'),
      edge('x-in', 'x', 'in'),
    );
    expect(cycleNodes(errorOf(apply(graph, edge('r-x', 'r', 'x'))))).toEqual(['in', 'r', 'x']);
  });

  it('тупик: R ждёт X, а X ждёт блок внутри R → CYCLE', () => {
    const graph = build(
      roadmap('r'),
      block('in', { parent: 'r' }),
      block('x'),
      edge('x-r', 'x', 'r'),
    );
    expect(cycleNodes(errorOf(apply(graph, edge('in-x', 'in', 'x'))))).toEqual(['in', 'r', 'x']);
  });

  it('нода внутри роадмапы не может ждать саму роадмапу, и наоборот → CYCLE', () => {
    const graph = build(roadmap('r'), block('in', { parent: 'r' }), task('t', 'in'));
    expect(cycleNodes(errorOf(apply(graph, edge('in-r', 'in', 'r'))))).toEqual(['in', 'r']);
    expect(cycleNodes(errorOf(apply(graph, edge('r-in', 'r', 'in'))))).toEqual(['in', 'r']);
    expect(cycleNodes(errorOf(apply(graph, taskEdge('t-r', 't', 'r'))))).toEqual(['in', 'r']);
  });

  it('пустая роадмапа пропускает зависимость насквозь: X → R → Y → X — цикл', () => {
    const graph = build(
      roadmap('r'),
      block('x'),
      block('y'),
      edge('xr', 'x', 'r'),
      edge('ry', 'r', 'y'),
    );
    expect(cycleNodes(errorOf(apply(graph, edge('yx', 'y', 'x'))))).toEqual(['r', 'x', 'y']);
  });

  it('milestone: стрелки в него и из него', () => {
    const graph = build(block('a'), milestone('m'), block('b'), edge('am', 'a', 'm'));
    expect(applyOk(graph, edge('mb', 'm', 'b')).edges.get(E('mb'))).toBeDefined();
    expect(cycleNodes(errorOf(apply(graph, edge('ma', 'm', 'a'))))).toEqual(['a', 'm']);
  });
});

describe('путь цикла в ошибке', () => {
  it('один и тот же, как бы ни лежали записи в памяти', () => {
    // Два цикла через d → a: через b и через c. Выбор не зависит от порядка создания.
    const parts = [
      [block('a'), block('b'), block('c'), block('d')],
      [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('bd', 'b', 'd'), edge('cd', 'c', 'd')],
    ] as const;
    const forward = build(...parts[0], ...parts[1]);
    const backward = build(...[...parts[0]].reverse(), ...[...parts[1]].reverse());
    const closing = edge('da', 'd', 'a');
    expect(errorOf(apply(forward, closing))).toEqual(errorOf(apply(backward, closing)));
  });
});

describe('deleteEdge', () => {
  it('удаляет стрелку, остальное — те же объекты', () => {
    const graph = build(
      block('a'),
      block('b'),
      block('c'),
      edge('ab', 'a', 'b'),
      edge('bc', 'b', 'c'),
    );
    const next = applyOk(graph, { kind: 'deleteEdge', id: E('ab') });
    expect([...next.edges.keys()]).toEqual(['bc']);
    expect(next.edges.get(E('bc'))).toBe(graph.edges.get(E('bc')));
    expect(next.nodes).toBe(graph.nodes);
  });

  it('стрелка не найдена → EDGE_NOT_FOUND', () => {
    expect(errorOf(apply(EMPTY, { kind: 'deleteEdge', id: E('nope') }))).toEqual({
      code: 'EDGE_NOT_FOUND',
      id: 'nope',
    });
  });
});
