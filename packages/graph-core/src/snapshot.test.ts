// Снимок графа для JSON и обратно: проверки на границе (сеть, файл, БД).

import { describe, expect, it } from 'vitest';
import { graphFromSnapshot, toSnapshot } from './snapshot';
import { N, T, block, build, edge, must, roadmap, task, taskEdge } from './test-helpers';
import { LIMITS } from './types';
import type { GraphNode, GraphSnapshot } from './types';

const graph = build(
  roadmap('r'),
  block('in', { parent: 'r' }),
  task('t', 'in', { status: 'done' }),
  block('a'),
  edge('ra', 'r', 'a'),
  taskEdge('ta', 't', 'a'),
);

describe('снимок', () => {
  it('туда и обратно — тот же граф, записи те же объекты', () => {
    const back = graphFromSnapshot(JSON.parse(JSON.stringify(toSnapshot(graph))) as GraphSnapshot);
    expect(back).toEqual({ ok: true, value: graph });
    const same = graphFromSnapshot(toSnapshot(graph));
    expect(same.ok && same.value.nodes.get(N('a'))).toBe(graph.nodes.get(N('a')));
  });

  it('повтор id → DUPLICATE_ID', () => {
    const snapshot = toSnapshot(graph);
    const twice = { ...snapshot, tasks: [...snapshot.tasks, ...snapshot.tasks] };
    expect(graphFromSnapshot(twice)).toEqual({
      ok: false,
      error: { code: 'DUPLICATE_ID', id: 't' },
    });
  });

  it('нарушение инварианта → его код', () => {
    const snapshot = toSnapshot(graph);
    const orphan = { ...snapshot, nodes: snapshot.nodes.filter((node) => node.id !== 'r') };
    expect(graphFromSnapshot(orphan)).toEqual({
      ok: false,
      error: { code: 'INVALID_PARENT', parentId: 'r' },
    });
  });

  it('сверх лимита → LIMIT_EXCEEDED, до разбора записей', () => {
    const one = must(graph.nodes.get(N('a')));
    const nodes: GraphNode[] = Array.from({ length: LIMITS.maxNodes + 1 }, (_, i) => ({
      ...one,
      id: N(`n${i}`),
    }));
    expect(graphFromSnapshot({ nodes, tasks: [], edges: [] })).toEqual({
      ok: false,
      error: { code: 'LIMIT_EXCEEDED', records: 'nodes', limit: LIMITS.maxNodes },
    });
  });

  it('лишние поля, в том числе вложенные, в граф не попадают', () => {
    const snapshot = toSnapshot(graph);
    const dirty = {
      ...snapshot,
      tasks: snapshot.tasks.map((t) => ({ ...t, secret: 1, deadline: null })),
      edges: snapshot.edges.map((e) => ({ ...e, source: { ...e.source, extra: true } })),
    };
    const result = graphFromSnapshot(dirty);
    expect(result.ok && result.value.tasks.get(T('t'))).not.toHaveProperty('secret');
    expect(result.ok && [...result.value.edges.values()].map((e) => e.source)).toEqual([
      { kind: 'node', nodeId: 'r' },
      { kind: 'task', taskId: 't' },
    ]);
  });
});
