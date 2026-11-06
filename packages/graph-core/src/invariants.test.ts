// Проверка графа целиком (DESIGN.md, «Инварианты»): нужна там, где граф собирается не одной
// операцией — отмена, а позже слияние веток и импорт.

import { describe, expect, it } from 'vitest';
import { GraphDraft } from './draft';
import { checkGraph, checkStep } from './invariants';
import {
  E,
  N,
  T,
  block,
  build,
  edge,
  milestone,
  must,
  roadmap,
  task,
  taskEdge,
} from './test-helpers';
import type { Graph, GraphEdge, GraphNode, Task } from './types';

const valid = build(
  roadmap('r'),
  block('in', { parent: 'r' }),
  task('t', 'in'),
  block('a'),
  milestone('m'),
  edge('am', 'a', 'm'),
  taskEdge('ta', 't', 'a'),
);

const withNode = (graph: Graph, node: GraphNode): Graph => ({
  ...graph,
  nodes: new Map(graph.nodes).set(node.id, node),
});
const withTask = (graph: Graph, t: Task): Graph => ({
  ...graph,
  tasks: new Map(graph.tasks).set(t.id, t),
});
const withEdge = (graph: Graph, e: GraphEdge): Graph => ({
  ...graph,
  edges: new Map(graph.edges).set(e.id, e),
});

const nodeA = must(valid.nodes.get(N('a')));
const taskT = must(valid.tasks.get(T('t')));
const edgeAm = must(valid.edges.get(E('am')));

describe('checkGraph', () => {
  it('граф, собранный операциями, всегда корректен', () => {
    expect(checkGraph(valid)).toBeNull();
  });

  it('находит нарушение структуры', () => {
    expect(checkGraph(withTask(valid, { ...taskT, blockId: N('nope') }))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'nope',
    });
    expect(checkGraph(withTask(valid, { ...taskT, blockId: N('r') }))).toEqual({
      code: 'WRONG_NODE_TYPE',
      id: 'r',
      expected: 'block',
    });
    expect(checkGraph(withNode(valid, { ...nodeA, parentId: N('m') }))).toEqual({
      code: 'INVALID_PARENT',
      parentId: 'm',
    });
    const nested = { ...must(valid.nodes.get(N('r'))), id: N('r2'), parentId: N('r') };
    expect(checkGraph(withNode(valid, nested))).toEqual({ code: 'NESTING_TOO_DEEP', id: 'r2' });
    expect(checkGraph(withNode(valid, { ...nodeA, x: 0.5 }))).toEqual({
      code: 'INVALID_VALUE',
      field: 'x',
      reason: 'not_integer',
    });
  });

  it('находит нарушение стрелок', () => {
    const to = (nodeId: string): GraphEdge => ({
      ...edgeAm,
      id: E('bad'),
      target: { kind: 'node', nodeId: N(nodeId) },
    });
    expect(checkGraph(withEdge(valid, to('nope')))).toEqual({ code: 'NODE_NOT_FOUND', id: 'nope' });
    expect(checkGraph(withEdge(valid, to('a')))).toEqual({ code: 'SELF_LOOP', edgeId: 'bad' });
    expect(checkGraph(withEdge(valid, to('m')))).toEqual({ code: 'DUPLICATE_EDGE', edgeId: 'am' });
    const back: GraphEdge = {
      id: E('ma'),
      source: { kind: 'node', nodeId: N('m') },
      target: { kind: 'node', nodeId: N('a') },
    };
    expect(checkGraph(withEdge(valid, back))?.code).toBe('CYCLE');
  });
});

describe('checkStep: инварианты только для изменённого', () => {
  const afterStep = (change: (draft: GraphDraft) => void) => {
    const draft = new GraphDraft(valid);
    change(draft);
    return checkStep(draft, draft.peekStep());
  };

  it('без нарушений — null', () => {
    expect(afterStep((draft) => draft.putNode({ ...nodeA, title: 'Новое' }))).toBeNull();
  });

  it('находит висячие ссылки на удалённое', () => {
    // m: входящая стрелка am; a: исходящая am и входящая ta; r: нода in внутри; in: задача t.
    expect(afterStep((draft) => draft.removeNode(N('m')))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'm',
    });
    expect(afterStep((draft) => draft.removeNode(N('a')))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'a',
    });
    expect(afterStep((draft) => draft.removeNode(N('r')))).toEqual({
      code: 'INVALID_PARENT',
      parentId: 'r',
    });
    expect(afterStep((draft) => draft.removeNode(N('in')))).toEqual({
      code: 'NODE_NOT_FOUND',
      id: 'in',
    });
    expect(afterStep((draft) => draft.removeTask(T('t')))).toEqual({
      code: 'TASK_NOT_FOUND',
      id: 't',
    });
  });

  it('находит петлю, дубликат и цикл', () => {
    const intoA = must(valid.nodes.get(N('a')));
    expect(
      afterStep((draft) => {
        draft.putNode({ ...intoA, id: N('b2') });
        draft.putTask({ ...taskT, blockId: N('a') });
      }),
    ).toEqual({ code: 'SELF_LOOP', edgeId: 'ta' });
    expect(afterStep((draft) => draft.putEdge({ ...edgeAm, id: E('am2') }))).toEqual({
      code: 'DUPLICATE_EDGE',
      edgeId: 'am',
    });
    const back: GraphEdge = {
      id: E('ma'),
      source: { kind: 'node', nodeId: N('m') },
      target: { kind: 'node', nodeId: N('a') },
    };
    expect(afterStep((draft) => draft.putEdge(back))?.code).toBe('CYCLE');
  });
});
