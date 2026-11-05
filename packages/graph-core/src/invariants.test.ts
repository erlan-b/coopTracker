// Проверка графа целиком (DESIGN.md, «Инварианты»): нужна там, где граф собирается не одной
// операцией — отмена, а позже слияние веток и импорт.

import { describe, expect, it } from 'vitest';
import { checkGraph } from './invariants';
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
  nodes: { ...graph.nodes, [node.id]: node },
});
const withTask = (graph: Graph, t: Task): Graph => ({
  ...graph,
  tasks: { ...graph.tasks, [t.id]: t },
});
const withEdge = (graph: Graph, e: GraphEdge): Graph => ({
  ...graph,
  edges: { ...graph.edges, [e.id]: e },
});

const nodeA = must(valid.nodes[N('a')]);
const taskT = must(valid.tasks[T('t')]);
const edgeAm = must(valid.edges[E('am')]);

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
    const nested = { ...must(valid.nodes[N('r')]), id: N('r2'), parentId: N('r') };
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
