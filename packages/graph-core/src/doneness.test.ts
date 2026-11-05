// Выполненность нод (DESIGN.md, «Вычисляемые состояния»): основа для стрелок и «засчитано».

import { describe, expect, it } from 'vitest';
import { doneness } from './doneness';
import {
  applyOk,
  block,
  build,
  ctx,
  edge,
  milestone,
  roadmap,
  setStatus,
  task,
  taskEdge,
} from './test-helpers';
import type { Graph, GraphSettings } from './types';

const FREE: GraphSettings = { statusMode: 'free', reviewUnlocks: false };
const doneIds = (graph: Graph, settings: GraphSettings = FREE) =>
  [...doneness(graph, settings).done].sort();
const lockedIds = (graph: Graph) => [...doneness(graph, FREE).locked].sort();

describe('doneness', () => {
  it('блок выполнен, когда в нём есть задачи и все выполнены; пустой — не выполнен', () => {
    const graph = build(
      block('empty'),
      block('full'),
      task('f1', 'full', { status: 'done' }),
      block('partial'),
      task('p1', 'partial', { status: 'done' }),
      task('p2', 'partial', { status: 'in_progress' }),
    );
    expect(doneIds(graph)).toEqual(['full']);
  });

  it('блок с невыполненным входом заблокирован и не выполнен, даже если его задачи выполнены', () => {
    const graph = build(
      block('x'),
      task('x1', 'x'),
      block('a'),
      task('a1', 'a', { status: 'done' }),
      edge('xa', 'x', 'a'),
    );
    expect(lockedIds(graph)).toEqual(['a']);
    expect(doneIds(graph)).toEqual([]);
  });

  it('стрелка от задачи выполнена, когда выполнена сама задача, а не весь её блок', () => {
    const graph = build(
      block('a'),
      task('a1', 'a', { status: 'done' }),
      task('a2', 'a'),
      block('b'),
      task('b1', 'b', { status: 'done' }),
      taskEdge('a1b', 'a1', 'b'),
    );
    expect(doneIds(graph)).toEqual(['b']);
    expect(lockedIds(applyOk(graph, setStatus('a1', 'todo')))).toEqual(['b']);
  });

  it('in_review выполнена только при reviewUnlocks', () => {
    const graph = build(block('a'), task('a1', 'a', { status: 'in_review' }));
    expect(doneIds(graph, { statusMode: 'review', reviewUnlocks: false })).toEqual([]);
    expect(doneIds(graph, { statusMode: 'review', reviewUnlocks: true })).toEqual(['a']);
  });

  it('роадмапа выполнена, когда выполнено всё внутри; пустая — не выполнена', () => {
    const graph = build(
      roadmap('empty'),
      roadmap('r'),
      block('in1', { parent: 'r' }),
      task('i1', 'in1', { status: 'done' }),
      block('in2', { parent: 'r' }),
      task('i2', 'in2'),
    );
    expect(doneIds(graph)).toEqual(['in1']);
    expect(doneIds(applyOk(graph, setStatus('i2', 'done')))).toEqual(['in1', 'in2', 'r']);
  });

  it('у заблокированной роадмапы заблокировано всё внутри', () => {
    const graph = build(
      block('x'),
      task('x1', 'x'),
      roadmap('r'),
      block('in', { parent: 'r' }),
      task('i1', 'in', { status: 'done' }),
      edge('xr', 'x', 'r'),
    );
    expect(lockedIds(graph)).toEqual(['in', 'r']);
    expect(doneIds(graph)).toEqual([]);
  });

  it('milestone выполнен, когда выполнены все входы; без входов — не выполнен', () => {
    const graph = build(
      milestone('lonely'),
      block('a'),
      task('a1', 'a', { status: 'done' }),
      milestone('m'),
      edge('am', 'a', 'm'),
    );
    expect(doneIds(graph)).toEqual(['a', 'm']);
    expect(doneIds(applyOk(graph, setStatus('a1', 'todo')))).toEqual([]);
  });

  it('«засчитано» делает ноду выполненной для всего после неё', () => {
    const graph = build(
      block('a'),
      task('a1', 'a', { status: 'done' }),
      block('b'),
      task('b1', 'b', { status: 'done' }),
      edge('ab', 'a', 'b'),
    );
    const counted = applyOk(graph, { ...task('a2', 'a'), keepDone: true });
    expect(doneIds(counted)).toEqual(['a', 'b']);
    expect(lockedIds(counted)).toEqual([]);
  });

  it('порядок обхода — по зависимостям', () => {
    const graph = build(
      block('c'),
      block('b'),
      block('a'),
      edge('ab', 'a', 'b'),
      edge('bc', 'b', 'c'),
    );
    expect(doneness(graph, ctx().settings).order).toEqual(['a', 'b', 'c']);
  });
});
