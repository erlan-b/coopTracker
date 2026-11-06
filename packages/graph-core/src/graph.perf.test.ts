// Бюджет скорости (DESIGN.md, «Скорость graph-core») на графе в 1 000 нод и 10 000 задач.
// Запускается отдельно от остальных тестов: npm run test:perf. Частые операции укладываются в 5 мс, редкие тяжёлые — в 10 мс (медиана по повторам).
// На обычном компьютере выходит в 2–3 раза меньше: запас на медленную машину CI. Если тест
// упал — скорее всего, где-то снова перебирается весь граф на каждую операцию.

import { describe, expect, it } from 'vitest';
import { applyOp, applyOps, previewRelock } from './apply';
import type { Result } from './errors';
import { graphFromSnapshot, toSnapshot } from './snapshot';
import { graphStates, statesFromScratch } from './states';
import type { Now } from './states';
import {
  N,
  T,
  block,
  buildLarge,
  ctx,
  edge,
  roadmap,
  setStatus,
  task,
  taskEdge,
} from './test-helpers';
import type { Graph, Op } from './types';

/** Частые операции: правка, статус, новая задача или стрелка, перетаскивание. */
const FREQUENT_MS = 5;
/** Редкие тяжёлые: удаление роадмапы со всем содержимым и его отмена, пакеты операций. */
const HEAVY_MS = 10;
/** Открыть envi: снимок → граф с проверкой → первая операция. Один раз на загрузку. */
const LOAD_MS = 30;
const REPEATS = 25;

declare const performance: { now(): number };

/** Повторяемые «случайные» числа: граф одинаковый при каждом запуске. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const context = ctx('master', { statusMode: 'review', reviewUnlocks: false });
const NOW: Now = { at: '2026-11-15T12:00:00.000Z', today: '2026-11-15' };

function ok<V>(result: Result<V>): V {
  if (!result.ok) throw new Error(`отклонено: ${JSON.stringify(result.error)}`);
  return result.value;
}

/**
 * 50 роадмап по 10 блоков внутри и 450 блоков на корневом уровне: 1 000 нод, 950 блоков,
 * 10 000 задач (две трети выполнены), 2 000 стрелок от нод и от задач — без циклов: от блока
 * к блоку с большим номером.
 */
function bigGraph(): Graph {
  const next = random(42);
  const ops: Op[] = [];
  const blocks: string[] = [];
  for (let r = 0; r < 50; r++) {
    ops.push(roadmap(`r${r}`));
    for (let b = 0; b < 10; b++) {
      ops.push(block(`r${r}-b${b}`, { parent: `r${r}` }));
      blocks.push(`r${r}-b${b}`);
    }
  }
  for (let b = 0; b < 450; b++) {
    ops.push(block(`b${b}`));
    blocks.push(`b${b}`);
  }
  blocks.forEach((id, k) => {
    // 950 блоков по 10 задач и ещё по одной в первых 500: ровно 10 000.
    for (let t = 0; t < 10 + (k < 500 ? 1 : 0); t++) {
      ops.push(task(`${id}-t${t}`, id, { status: next() < 0.66 ? 'done' : 'todo' }));
    }
  });
  const pairs = new Set<string>();
  for (let e = 0; pairs.size < 2_000; e++) {
    const from = Math.floor(next() * (blocks.length - 1));
    const to = from + 1 + Math.floor(next() * Math.min(30, blocks.length - from - 1));
    const fromTask = e % 2 === 1;
    const key = `${fromTask ? 't' : 'n'}${from}>${to}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    const source = blocks[from]!;
    const target = blocks[to]!;
    ops.push(fromTask ? taskEdge(`e${e}`, `${source}-t0`, target) : edge(`e${e}`, source, target));
  }
  return buildLarge(ops, context);
}

/** Медиана времени в мс по REPEATS повторам после прогрева; run получает номер повтора. */
function median(run: (i: number) => void): number {
  for (let i = 0; i < 5; i++) run(-1 - i);
  const times: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const startedAt = performance.now();
    run(i);
    times.push(performance.now() - startedAt);
  }
  return times.sort((a, b) => a - b)[REPEATS >> 1]!;
}

describe('скорость на 1 000 нод и 10 000 задач', () => {
  const graph = bigGraph();
  // Запомненное (указатели, порядок, выполненность) — как у живого графа после операций.
  ok(applyOp(graph, setStatus('b0-t1', 'in_progress'), context));

  // Выполненная задача, от которой что-то зависит: её переоткрытие ставит предупреждения.
  const doneWithEdges = [...graph.edges.values()]
    .flatMap((e) => (e.source.kind === 'task' ? [graph.tasks.get(e.source.taskId)!] : []))
    .find((t) => t.status === 'done')!;
  const reopen = setStatus(doneWithEdges.id, 'todo');

  it('граф нужного размера', () => {
    expect([graph.nodes.size, graph.tasks.size, graph.edges.size]).toEqual([1_000, 10_000, 2_000]);
  });

  const frequent: readonly (readonly [string, (i: number) => Result<unknown>])[] = [
    [
      'название задачи',
      (i) =>
        applyOp(graph, { kind: 'updateTask', id: T('b0-t1'), patch: { title: `${i}` } }, context),
    ],
    [
      'статус без смены выполненности',
      () => applyOp(graph, setStatus('b100-t2', 'in_progress'), context),
    ],
    ['переоткрытие с предупреждениями', () => applyOp(graph, reopen, context)],
    ['вопрос «блокировать?» (previewRelock)', () => previewRelock(graph, reopen, context)],
    ['новая задача', (i) => applyOp(graph, task(`new${i}`, 'b200'), context)],
    [
      'новая стрелка',
      (i) => applyOp(graph, edge(`new-e${i}`, 'b10', `b${400 + ((i + 10) % 40)}`), context),
    ],
    [
      'перетаскивание 20 нод',
      (i) => {
        const moves = Array.from({ length: 20 }, (_, n) => ({ id: N(`b${n}`), x: i, y: n }));
        return applyOp(graph, { kind: 'moveNodes', moves }, context);
      },
    ],
  ];

  it.each(frequent)(`%s — до ${FREQUENT_MS} мс`, (_name, run) => {
    expect(median((i) => ok(run(i)))).toBeLessThan(FREQUENT_MS);
  });

  it(`удаление роадмапы со 110 задачами и его отмена — до ${HEAVY_MS} мс`, () => {
    const remove: Op = { kind: 'deleteNode', id: N('r25') };
    expect(median(() => ok(applyOp(graph, remove, context)))).toBeLessThan(HEAVY_MS);
    const deleted = ok(applyOp(graph, remove, context));
    const revert: Op = { kind: 'revert', changes: deleted.changes };
    expect(median(() => ok(applyOp(deleted.graph, revert, context)))).toBeLessThan(HEAVY_MS);
  });

  it(`пакет из 100 новых задач — до ${HEAVY_MS} мс`, () => {
    const ops = (i: number) =>
      Array.from({ length: 100 }, (_, n) => task(`batch${i}-${n}`, `b${n}`));
    expect(median((i) => ok(applyOps(graph, ops(i), context)))).toBeLessThan(HEAVY_MS);
  });

  it(`пакет из 200 новых нод и ~400 стрелок — до ${HEAVY_MS} мс`, () => {
    const ops = (i: number): Op[] => {
      const id = (n: number) => `imp${i}-${n}`;
      const nodes = Array.from({ length: 200 }, (_, n) => block(id(n)));
      const next = Array.from({ length: 199 }, (_, n) => edge(`${id(n)}>1`, id(n), id(n + 1)));
      const skip = Array.from({ length: 198 }, (_, n) => edge(`${id(n)}>2`, id(n), id(n + 2)));
      return [...nodes, ...next, ...skip];
    };
    expect(median((i) => ok(applyOps(graph, ops(i), context)))).toBeLessThan(HEAVY_MS);
  });

  it(`состояния для интерфейса после смены статуса — до ${FREQUENT_MS} мс`, () => {
    // Как в интерфейсе: прошлые состояния есть, после операции считается только задетое.
    const before = graphStates(graph, context.settings, NOW);
    const after = ok(applyOp(graph, reopen, context)).graph;
    expect(median(() => graphStates(after, context.settings, NOW, before))).toBeLessThan(
      FREQUENT_MS,
    );
  });

  it(`состояния для интерфейса с нуля — до ${HEAVY_MS} мс`, () => {
    // Первый показ и смена минуты (просрочка); дальше — только задетое.
    expect(
      median((i) => statesFromScratch(graph, context.settings, { ...NOW, at: `${NOW.at}#${i}` })),
    ).toBeLessThan(HEAVY_MS);
  });

  it(`загрузка снимка и первая операция — до ${LOAD_MS} мс`, () => {
    const snapshot = toSnapshot(graph);
    const load = () => ok(applyOp(ok(graphFromSnapshot(snapshot)), reopen, context));
    expect(median(load)).toBeLessThan(LOAD_MS);
  });
});
