// Какие ноды выполнены и заблокированы — для стрелок, готовности роадмап и пометки «засчитано».
// Полные состояния для интерфейса (доступна, в работе, «пусто», «Досрочно», просрочка) — следующий
// подшаг; они строятся на этом же обходе.
//
// После операции пересчитывается только то, что она могла задеть: ноды с изменёнными задачами,
// стрелками и полями, и дальше по зависимостям, пока состояние нод меняется.

import { rememberDoneness, viewOf } from './draft';
import type { GraphDraft, Step } from './draft';
import type { NodeId, TaskId } from './ids';
import { isTaskCompleted } from './status';
import { orderOf } from './structure';
import type { DependencyOrder } from './structure';
import type { Graph, GraphNode, GraphSettings } from './types';

export type DonenessState = {
  /** Нода выполнена для всего после неё: по-настоящему или с пометкой «засчитано». */
  readonly done: ReadonlySet<NodeId>;
  /** Нода заблокирована: не выполнено что-то, что она ждёт, или заблокирована её роадмапа. */
  readonly locked: ReadonlySet<NodeId>;
};

/** Что пересчитать: вход ноды (заблокирована ли) и выход (выполнена ли). */
export type Seeds = { readonly enter: ReadonlySet<NodeId>; readonly exit: ReadonlySet<NodeId> };

export type Evaluation = {
  readonly state: DonenessState;
  /** Ноды, которые были выполнены и перестали, в порядке зависимостей. */
  readonly lost: readonly NodeId[];
  /** Ноды, которые должны получить пометку «засчитано» (см. keepDone). */
  readonly toCount: readonly NodeId[];
  /** Ноды с пометкой «засчитано», которые снова выполнены по-настоящему: пометка больше не нужна. */
  readonly countedNoLongerNeeded: readonly NodeId[];
};

export const settingsKey = (settings: GraphSettings): string =>
  `${settings.statusMode}/${String(settings.reviewUnlocks)}`;

const NOTHING: ReadonlySet<NodeId> = new Set();

/** Множество, которое копируется только при первом изменении. */
class LazySet<V> {
  private owned: Set<V> | null = null;

  constructor(private readonly source: ReadonlySet<V>) {}

  has(value: V): boolean {
    return (this.owned ?? this.source).has(value);
  }

  toggle(value: V, present: boolean): void {
    if (this.has(value) === present) return;
    this.owned ??= new Set(this.source);
    if (present) this.owned.add(value);
    else this.owned.delete(value);
  }

  get result(): ReadonlySet<V> {
    return this.owned ?? this.source;
  }
}

/**
 * Выполненность нод (DESIGN.md, «Вычисляемые состояния»):
 * - нода заблокирована, если не выполнен источник хоть одной входящей стрелки или заблокирована
 *   роадмапа, внутри которой она лежит;
 * - нода выполнена по-настоящему, если не заблокирована и: у блока есть задачи и все выполнены,
 *   у роадмапы есть ноды внутри и все выполнены, у milestone есть входящие стрелки;
 * - пометка «засчитано» делает ноду выполненной для всего после неё.
 *
 * previous — состояние до изменения; seeds — что пересчитать ('all' — всё, previous тогда не
 * нужен). Дальше пересчёт идёт по зависимостям, пока состояние нод меняется.
 *
 * keepDone — «не блокировать»: нода, которая была выполнена и перестала, получает пометку.
 * Обход идёт в порядке зависимостей и учитывает уже поставленные пометки, поэтому пометку
 * получают только первые в цепочке: всё после них остаётся выполненным само.
 */
export function evaluate(
  view: GraphDraft,
  settings: GraphSettings,
  order: DependencyOrder,
  previous: DonenessState | null,
  seeds: Seeds | 'all',
  keepDone: boolean,
): Evaluation {
  const wasDone = previous?.done ?? NOTHING;
  const done = new LazySet(previous?.done ?? NOTHING);
  const locked = new LazySet(previous?.locked ?? NOTHING);
  const { steps, enterRank, exitRank } = order;

  const dirty = new Uint8Array(steps.length);
  let from = steps.length;
  const mark = (rank: number | undefined): void => {
    if (rank === undefined) return;
    dirty[rank] = 1;
    if (rank < from) from = rank;
  };
  if (seeds === 'all') {
    dirty.fill(1);
    from = 0;
  } else {
    for (const [ids, ranks] of [
      [seeds.enter, enterRank],
      [seeds.exit, exitRank],
    ] as const) {
      for (const id of ids) {
        if (view.node(id)) {
          mark(ranks.get(id));
        } else {
          done.toggle(id, false);
          locked.toggle(id, false);
        }
      }
    }
  }

  const completed = (taskId: TaskId): boolean => {
    const task = view.task(taskId);
    return task !== undefined && isTaskCompleted(task.status, settings);
  };
  const hasUnmetInput = (id: NodeId): boolean => {
    for (const edgeId of view.edgesInto(id)) {
      const source = view.edge(edgeId)?.source;
      if (!source) continue;
      if (source.kind === 'task' ? !completed(source.taskId) : !done.has(source.nodeId))
        return true;
    }
    return false;
  };
  const ownConditionMet = (node: GraphNode): boolean => {
    switch (node.type) {
      case 'block': {
        const tasks = view.tasksIn(node.id);
        if (tasks.size === 0) return false;
        for (const taskId of tasks) if (!completed(taskId)) return false;
        return true;
      }
      case 'roadmap': {
        const inside = view.childrenOf(node.id);
        if (inside.size === 0) return false;
        for (const childId of inside) if (!done.has(childId)) return false;
        return true;
      }
      case 'milestone':
        return view.edgesInto(node.id).size > 0;
    }
  };

  const lost: NodeId[] = [];
  const toCount: NodeId[] = [];
  const countedNoLongerNeeded: NodeId[] = [];
  for (let i = from; i < steps.length; i++) {
    if (dirty[i] === 0) continue;
    const { step, id } = steps[i]!;
    const node = view.node(id);
    if (!node) continue;

    if (step === 'enter') {
      const isLocked = (node.parentId !== null && locked.has(node.parentId)) || hasUnmetInput(id);
      if (isLocked === locked.has(id)) continue;
      locked.toggle(id, isLocked);
      mark(exitRank.get(id));
      if (node.type === 'roadmap') {
        for (const childId of view.childrenOf(id)) mark(enterRank.get(childId));
      }
      continue;
    }

    const complete = !locked.has(id) && ownConditionMet(node);
    let isDone = complete;
    if (complete) {
      if (node.countedDone !== null) countedNoLongerNeeded.push(id);
    } else if (node.countedDone !== null) {
      isDone = true;
    } else if (keepDone && wasDone.has(id)) {
      isDone = true;
      toCount.push(id);
    }
    if (isDone === done.has(id)) continue;
    done.toggle(id, isDone);
    if (!isDone && wasDone.has(id)) lost.push(id);
    for (const edgeId of view.edgesOut(id)) {
      const edge = view.edge(edgeId);
      if (edge?.source.kind === 'node') mark(enterRank.get(edge.target.nodeId));
    }
    if (node.parentId !== null) mark(exitRank.get(node.parentId));
  }
  return {
    state: { done: done.result, locked: locked.result },
    lost,
    toCount,
    countedNoLongerNeeded,
  };
}

/** Выполненность нод графа (запоминается для графа). */
export function donenessOf(graph: Graph, settings: GraphSettings): DonenessState {
  const view = viewOf(graph);
  const key = settingsKey(settings);
  const known = view.donenessAtStep(key);
  if (known) return known;
  const { state } = evaluate(view, settings, orderOf(view), null, 'all', false);
  rememberDoneness(graph, key, state);
  return state;
}

/**
 * Что пересчитать после шага: ноды, у которых изменились задачи (их выполненность, состав,
 * блок), стрелки, тип, роадмапа или «засчитано». Пустой результат — выполненность не изменилась.
 *
 * Ноды с пометкой «засчитано» перепроверяются всегда: пометка должна сняться, как только нода
 * выполнена по-настоящему, в том числе после смены настроек envi (`reviewUnlocks`), которая
 * граф не меняет. Таких нод единицы, это дёшево.
 */
export function seedsOf(view: GraphDraft, step: Step, settings: GraphSettings): Seeds | null {
  const enter = new Set<NodeId>();
  const exit = new Set<NodeId>();
  for (const [id, before] of step.tasks) {
    const after = view.task(id);
    const wasCompleted = before !== undefined && isTaskCompleted(before.status, settings);
    const isCompleted = after !== undefined && isTaskCompleted(after.status, settings);
    if (before?.blockId === after?.blockId && wasCompleted === isCompleted) continue;
    if (before) exit.add(before.blockId);
    if (after) exit.add(after.blockId);
    if (wasCompleted !== isCompleted) {
      for (const edgeId of view.edgesFromTask(id)) {
        const edge = view.edge(edgeId);
        if (edge) enter.add(edge.target.nodeId);
      }
    }
  }
  for (const [id, before] of step.edges) {
    for (const edge of [before, view.edge(id)]) {
      if (!edge) continue;
      enter.add(edge.target.nodeId);
      exit.add(edge.target.nodeId);
    }
  }
  for (const [id, before] of step.nodes) {
    const after = view.node(id);
    if (
      before !== undefined &&
      after !== undefined &&
      before.type === after.type &&
      before.parentId === after.parentId &&
      (before.countedDone === null) === (after.countedDone === null)
    ) {
      continue;
    }
    enter.add(id);
    exit.add(id);
    for (const node of [before, after]) {
      if (node !== undefined && node.parentId !== null) exit.add(node.parentId);
    }
  }
  for (const id of view.countedNodes()) exit.add(id);
  return enter.size === 0 && exit.size === 0 ? null : { enter, exit };
}

/** Выполненность на начало шага: запомненная в копии или посчитанная по исходному графу. */
export function donenessBeforeStep(draft: GraphDraft, settings: GraphSettings): DonenessState {
  return draft.donenessAtStep(settingsKey(settings)) ?? donenessOf(draft.base, settings);
}
