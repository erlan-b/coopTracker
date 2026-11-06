// Property-based тесты против эталона (reference-model.ts). Эталон заново и в лоб считает
// выполненность, пометки «засчитано» и предупреждения; graph-core считает их только для задетого
// и с запомненным. Графы случайные; настройки envi, роль, время и «не блокировать» меняются от
// шага к шагу; в последовательностях есть отмена старых действий и восстановление удалённого.
// Заодно: отмена сразу после действия возвращает граф как был.
//
// Операции выбирают записи из текущего графа (по номеру в списке), поэтому большая часть
// проходит. Отклонённые тоже сверяются: ошибка та же, что без последствий.

import fc from 'fast-check';
import type { Arbitrary } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyOp, applyWithoutConsequences, previewRelock } from './apply';
import { donenessOf } from './doneness';
import { GraphDraft } from './draft';
import type { Result } from './errors';
import { asUserId } from './ids';
import { modelDoneness, modelRelock, modelSettle } from './reference-model';
import {
  EMPTY,
  N,
  applyFull,
  applyOpsFull,
  block,
  ctx,
  edge,
  milestone,
  roadmap,
  task,
  taskEdge,
} from './test-helpers';
import type {
  ApplyContext,
  Changes,
  EnviRole,
  Graph,
  GraphSettings,
  NodeType,
  Op,
  RecordChange,
  TaskStatus,
} from './types';

const SETTINGS: readonly GraphSettings[] = [
  { statusMode: 'free', reviewUnlocks: false },
  { statusMode: 'free', reviewUnlocks: true },
  { statusMode: 'review', reviewUnlocks: false },
  { statusMode: 'review', reviewUnlocks: true },
];

const status = fc.constantFrom<TaskStatus>('todo', 'in_progress', 'in_review', 'done');
/** В случайном графе выполненного больше: так чаще есть что переоткрыть и что заблокировать. */
const startStatus = fc.constantFrom<TaskStatus>(
  'done',
  'done',
  'done',
  'in_progress',
  'in_review',
  'todo',
);
const nodeType = fc.constantFrom<NodeType>('block', 'block', 'block', 'roadmap', 'milestone');
/** «Не блокировать» — примерно на каждом четвёртом шаге, иначе предупреждений почти не будет. */
const keepDone = fc.boolean().chain((rare) => (rare ? fc.boolean() : fc.constant(false)));
/** Номер записи в списке; берётся по кругу. */
const pick = fc.nat({ max: 50 });

const at = <V>(list: readonly V[], index: number): V | undefined =>
  list.length === 0 ? undefined : list[index % list.length];

function nodeOp(id: string, type: NodeType, parent: string | undefined): Op {
  const options = parent === undefined ? {} : { parent };
  if (type === 'roadmap') return roadmap(id, options);
  return type === 'block' ? block(id, options) : milestone(id, options);
}

/** Граф из операций; отклонённые (цикл, вложенность и т. п.) пропускаются. */
function buildTolerant(ops: readonly Op[]): Graph {
  const context = ctx('master', { statusMode: 'review' });
  let graph = EMPTY;
  for (const op of ops) {
    const result = applyOp(graph, op, context);
    if (result.ok) graph = result.value.graph;
  }
  return graph;
}

/**
 * Случайный граф, похожий на роадмапу: 2–8 нод (часть — внутри роадмап), многие связаны
 * цепочкой n0 → n1 → …; в каждом блоке 1–3 задачи, в начале цепочки (до ноды doneBefore) они
 * выполнены, дальше статусы случайные; ещё несколько стрелок от нод и задач к нодам с большим
 * номером. Стрелки, замыкающие цикл, и прочее недопустимое отклоняется.
 */
const randomGraph: Arbitrary<Graph> = fc
  .record({
    nodes: fc.array(
      fc.record({
        type: nodeType,
        parent: fc.option(pick, { nil: null }),
        linked: fc.boolean(),
        tasks: fc.array(startStatus, { minLength: 1, maxLength: 3 }),
      }),
      { minLength: 2, maxLength: 8 },
    ),
    doneBefore: fc.nat({ max: 8 }),
    edges: fc.array(fc.tuple(fc.boolean(), pick, pick), { maxLength: 6 }),
  })
  .map(({ nodes, doneBefore, edges }) => {
    const ids = nodes.map((_, i) => `n${i}`);
    const roadmaps = ids.filter((_, i) => nodes[i]!.type === 'roadmap');
    const tasks = nodes.flatMap((node, i) =>
      node.type !== 'block'
        ? []
        : node.tasks.map((to, k) =>
            task(`t${i}-${k}`, ids[i]!, { status: i < doneBefore ? 'done' : to }),
          ),
    );
    const taskIds = tasks.flatMap((op) => (op.kind === 'createTask' ? [op.task.id] : []));
    return buildTolerant([
      ...nodes.map((node, i) =>
        nodeOp(
          ids[i]!,
          node.type,
          node.parent === null || node.type === 'roadmap' ? undefined : at(roadmaps, node.parent),
        ),
      ),
      ...tasks,
      ...nodes.flatMap((node, i) =>
        node.linked && i > 0 ? [edge(`c${i}`, ids[i - 1]!, ids[i]!)] : [],
      ),
      ...edges.flatMap(([fromTask, from, to], i) => {
        const target = ids[to % ids.length]!;
        const source = fromTask ? at(taskIds, from) : ids[from % ((to % ids.length) + 1)];
        if (source === undefined) return [];
        return [fromTask ? taskEdge(`e${i}`, source, target) : edge(`e${i}`, source, target)];
      }),
    ]);
  });

/** Что сделать на шаге: операция над записями текущего графа, выбранными по номеру. */
type Intent =
  | { readonly kind: 'status'; readonly task: number; readonly status: TaskStatus }
  | { readonly kind: 'reopen'; readonly task: number; readonly status: TaskStatus }
  | { readonly kind: 'createTask'; readonly block: number; readonly status: TaskStatus }
  | { readonly kind: 'moveTask'; readonly task: number; readonly block: number }
  | { readonly kind: 'deleteTask'; readonly task: number }
  | {
      readonly kind: 'edge';
      readonly fromTask: boolean;
      readonly from: number;
      readonly to: number;
    }
  | { readonly kind: 'deleteEdge'; readonly edge: number }
  | { readonly kind: 'createNode'; readonly type: NodeType; readonly parent: number | null }
  | { readonly kind: 'deleteNode'; readonly node: number }
  | { readonly kind: 'blockToRoadmap'; readonly node: number }
  | { readonly kind: 'roadmapToBlock'; readonly node: number }
  | { readonly kind: 'uncount'; readonly node: number }
  | { readonly kind: 'dismiss'; readonly task: number; readonly downstream: boolean }
  | { readonly kind: 'revert'; readonly of: number }
  | { readonly kind: 'restore'; readonly of: number };

const intent: Arbitrary<Intent> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ kind: fc.constant('status'), task: pick, status }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('reopen'),
      task: pick,
      status: fc.constantFrom<TaskStatus>('todo', 'in_progress', 'in_review'),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('createTask'), block: pick, status }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('moveTask'), task: pick, block: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteTask'), task: pick }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('edge'),
      fromTask: fc.boolean(),
      from: pick,
      to: pick,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteEdge'), edge: pick }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('createNode'),
      type: nodeType,
      parent: fc.option(pick, { nil: null }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('deleteNode'), node: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('blockToRoadmap'), node: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('roadmapToBlock'), node: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('uncount'), node: pick }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('dismiss'), task: pick, downstream: fc.boolean() }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('revert'), of: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('restore'), of: pick }) },
);

/** Удалённое действием — как из корзины. */
const removed = <V>(records: readonly RecordChange<V>[]): V[] =>
  records.flatMap((change) =>
    change.after === null && change.before !== null ? [change.before] : [],
  );

/** Новые id в пределах одного прогона. */
function freshIds(): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}-new${next++}`;
}

/** Операция по намерению на текущем графе; null — не над чем (например, задач нет). */
function resolve(
  wish: Intent,
  graph: Graph,
  history: readonly Changes[],
  fresh: (prefix: string) => string,
): Op | null {
  const nodes = [...graph.nodes.values()];
  const tasks = [...graph.tasks.keys()];
  const blocks = nodes.filter((node) => node.type === 'block').map((node) => node.id);
  const ofType = (type: NodeType) =>
    nodes.filter((node) => node.type === type).map((node) => node.id);
  switch (wish.kind) {
    case 'status':
    case 'reopen': {
      // Переоткрывают выполненную или «на проверке», если такая есть.
      const finished = [...graph.tasks.values()]
        .filter((t) => t.status === 'done' || t.status === 'in_review')
        .map((t) => t.id);
      const id = at(wish.kind === 'reopen' && finished.length > 0 ? finished : tasks, wish.task);
      return id === undefined ? null : { kind: 'updateTask', id, patch: { status: wish.status } };
    }
    case 'createTask': {
      const blockId = at(blocks, wish.block);
      return blockId === undefined ? null : task(fresh('t'), blockId, { status: wish.status });
    }
    case 'moveTask': {
      const id = at(tasks, wish.task);
      const blockId = at(blocks, wish.block);
      if (id === undefined || blockId === undefined) return null;
      return { kind: 'moveTask', id, blockId, order: 'b1' };
    }
    case 'deleteTask': {
      const id = at(tasks, wish.task);
      return id === undefined ? null : { kind: 'deleteTask', id };
    }
    case 'edge': {
      const target = at(nodes, wish.to)?.id;
      const source = wish.fromTask ? at(tasks, wish.from) : at(nodes, wish.from)?.id;
      if (target === undefined || source === undefined) return null;
      return wish.fromTask
        ? taskEdge(fresh('e'), source, target)
        : edge(fresh('e'), source, target);
    }
    case 'deleteEdge': {
      const id = at([...graph.edges.keys()], wish.edge);
      return id === undefined ? null : { kind: 'deleteEdge', id };
    }
    case 'createNode': {
      const parent = wish.parent === null ? undefined : at(ofType('roadmap'), wish.parent);
      return nodeOp(fresh('n'), wish.type, wish.type === 'roadmap' ? undefined : parent);
    }
    case 'deleteNode':
    case 'blockToRoadmap':
    case 'roadmapToBlock':
    case 'uncount': {
      // Пометку снимают с помеченной ноды, если такая есть.
      const counted = nodes.filter((node) => node.countedDone !== null);
      const node = at(wish.kind === 'uncount' && counted.length > 0 ? counted : nodes, wish.node);
      if (node === undefined) return null;
      if (wish.kind === 'deleteNode') return { kind: 'deleteNode', id: node.id };
      if (wish.kind === 'roadmapToBlock') return { kind: 'roadmapToBlock', id: node.id };
      if (wish.kind === 'uncount') {
        return { kind: 'updateNode', id: node.id, patch: { countedDone: null } };
      }
      return { kind: 'blockToRoadmap', id: node.id, innerBlockId: N(fresh('n')) };
    }
    case 'dismiss': {
      // Предупреждения снимают у задачи с предупреждениями, если такая есть.
      const warned = [...graph.tasks.values()]
        .filter((t) => t.warnings.length > 0)
        .map((t) => t.id);
      const id = at(warned.length > 0 ? warned : tasks, wish.task);
      if (id === undefined) return null;
      return {
        kind: 'dismissWarnings',
        taskId: id,
        scope: wish.downstream ? 'downstream' : 'this',
      };
    }
    case 'revert':
    case 'restore': {
      const changes = at(history, wish.of);
      if (changes === undefined) return null;
      if (wish.kind === 'revert') return { kind: 'revert', changes };
      const restore: Op = {
        kind: 'restore',
        nodes: removed(changes.nodes),
        tasks: removed(changes.tasks),
        edges: removed(changes.edges),
      };
      return restore.nodes.length + restore.tasks.length + restore.edges.length > 0
        ? restore
        : null;
    }
  }
}

type StepContext = {
  readonly settings: number;
  readonly role: EnviRole;
  readonly keepDone: boolean;
  /** Время сдвинулось с прошлого шага. */
  readonly later: boolean;
};

const stepContext: Arbitrary<StepContext> = fc.record({
  settings: fc.integer({ min: 0, max: SETTINGS.length - 1 }),
  role: fc.constantFrom<EnviRole>('master', 'master', 'master', 'master', 'member', 'viewer'),
  keepDone,
  later: fc.constantFrom(true, true, false),
});

/**
 * Часы прогона: время шага обычно на минуту позже прошлого, но иногда то же самое — два
 * действия в один момент бывают и на сервере, а отмена сравнивает время изменений.
 */
function clock(): (step: StepContext) => ApplyContext {
  let minutes = 0;
  return (step) => {
    if (step.later) minutes++;
    const minute = String(minutes % 60).padStart(2, '0');
    const hour = String(10 + Math.floor(minutes / 60)).padStart(2, '0');
    return {
      actor: { id: asUserId(step.role), role: step.role },
      settings: SETTINGS[step.settings]!,
      now: `2026-11-06T${hour}:${minute}:00.000Z`,
    };
  };
}

const withKeepDone = (op: Op, keepDone: boolean): Op => (keepDone ? { ...op, keepDone } : op);

/** Операции без последствий — то, по чему эталон считает последствия заново. */
function withoutConsequences(
  graph: Graph,
  ops: readonly Op[],
  context: ApplyContext,
): Result<Graph> {
  const draft = new GraphDraft(graph);
  const problem = applyWithoutConsequences(draft, ops, context, []);
  return problem ? { ok: false, error: problem } : { ok: true, value: draft.finish() };
}

/** Выполненность, запомненная graph-core, совпадает с эталоном для всех настроек envi. */
function expectDonenessLikeModel(graph: Graph): void {
  for (const settings of SETTINGS) {
    const model = modelDoneness(graph, settings);
    expect(donenessOf(graph, settings)).toEqual({ done: model.done, locked: model.locked });
  }
}

/** Пакет так, как его применяет graph-core: по эталону, последствия по итогу или по шагам. */
function modelBatch(graph: Graph, ops: readonly Op[], context: ApplyContext): Result<Graph> {
  if (!ops.some((op) => op.kind === 'revert')) {
    const raw = withoutConsequences(graph, ops, context);
    if (!raw.ok) return raw;
    return {
      ok: true,
      value: modelSettle(graph, raw.value, context, {
        keepDone: ops.some((op) => op.keepDone === true),
        warnOnlyChangedAfter: null,
      }),
    };
  }
  let current = graph;
  for (const op of ops) {
    const raw = withoutConsequences(current, [op], context);
    if (!raw.ok) return raw;
    current = modelSettle(current, raw.value, context, {
      keepDone: op.keepDone === true,
      warnOnlyChangedAfter: op.kind === 'revert' ? op.changes.at : null,
    });
  }
  return { ok: true, value: current };
}

describe('сверка с эталоном', () => {
  it('случайный граф: выполненность совпадает с определением', () => {
    fc.assert(
      fc.property(randomGraph, (graph) => {
        expectDonenessLikeModel(graph);
      }),
      { numRuns: 300 },
    );
  });

  it('операции по одной: последствия и previewRelock совпадают с эталоном', () => {
    fc.assert(
      fc.property(
        randomGraph,
        fc.array(fc.tuple(intent, stepContext, fc.boolean()), { minLength: 5, maxLength: 25 }),
        (start, steps) => {
          const fresh = freshIds();
          const contextOf = clock();
          let graph = start;
          const history: Changes[] = [];
          for (const [wish, step, checkAll] of steps) {
            const context = contextOf(step);
            const resolved = resolve(wish, graph, history, fresh);
            if (resolved === null) continue;
            const op = withKeepDone(resolved, step.keepDone);

            const result = applyFull(graph, op, context);
            const raw = withoutConsequences(graph, [op], context);
            if (!result.ok || !raw.ok) {
              expect(result).toEqual(raw);
              continue;
            }
            const expected = modelSettle(graph, raw.value, context, {
              keepDone: step.keepDone,
              warnOnlyChangedAfter: op.kind === 'revert' ? op.changes.at : null,
            });
            expect(result.value.graph).toEqual(expected);
            expect(previewRelock(graph, op, context)).toEqual({
              ok: true,
              value: modelRelock(graph, raw.value, context.settings),
            });
            // Отмена сразу после действия возвращает граф как был — если он уже учёл текущие
            // настройки envi. Иначе пометка «засчитано», ставшая лишней после смены настроек,
            // снимается любой операцией, и отмена возвращает её только на миг: она снова лишняя.
            const settled = modelSettle(graph, graph, context, {
              keepDone: false,
              warnOnlyChangedAfter: null,
            }).nodes;
            const upToDate = [...graph.nodes].every(([id, node]) => settled.get(id) === node);
            if (op.kind !== 'revert' && upToDate) {
              const undone = applyFull(
                result.value.graph,
                { kind: 'revert', changes: result.value.changes },
                context,
              );
              expect(undone.ok && undone.value.graph).toEqual(graph);
            }

            graph = result.value.graph;
            history.push(result.value.changes);
            // Иногда — выполненность и для других настроек: тогда следующая операция с другими
            // настройками возьмёт её запомненной, а не посчитает по исходному графу.
            if (checkAll) expectDonenessLikeModel(graph);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('пакеты: последствия один раз по итогу пакета, с отменой — после каждой операции', () => {
    fc.assert(
      fc.property(
        randomGraph,
        fc.array(
          fc.tuple(
            fc.array(fc.tuple(intent, keepDone), { minLength: 2, maxLength: 6 }),
            stepContext,
          ),
          { minLength: 2, maxLength: 6 },
        ),
        (start, batches) => {
          const fresh = freshIds();
          const contextOf = clock();
          let graph = start;
          const history: Changes[] = [];
          for (const [wishes, step] of batches) {
            const context = contextOf(step);
            // Каждая операция выбирает записи из графа после предыдущих операций пакета.
            const ops: Op[] = [];
            let reached = graph;
            for (const [wish, keepDone] of wishes) {
              const resolved = resolve(wish, reached, history, fresh);
              if (resolved === null) continue;
              const op = withKeepDone(resolved, keepDone);
              const next = withoutConsequences(reached, [op], context);
              if (next.ok || ops.length === 0) ops.push(op);
              if (next.ok) reached = next.value;
            }
            if (ops.length === 0) continue;

            const result = applyOpsFull(graph, ops, context);
            const expected = modelBatch(graph, ops, context);
            if (!result.ok || !expected.ok) {
              expect(result.ok ? result.value.graph : result.error).toEqual(
                expected.ok ? expected.value : expected.error,
              );
              continue;
            }
            expect(result.value.graph).toEqual(expected.value);
            graph = result.value.graph;
            history.push(result.value.changes);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
