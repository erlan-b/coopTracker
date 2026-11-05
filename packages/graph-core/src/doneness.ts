// Какие ноды выполнены — для стрелок, готовности роадмап и пометки «засчитано».
// Полные состояния для интерфейса (доступна, в работе, «пусто», «Досрочно», просрочка) — следующий
// подшаг; они строятся на этом же обходе.

import type { NodeId, TaskId } from './ids';
import { getOwn, valuesOf } from './records';
import { isTaskCompleted } from './status';
import { dependencyOrder } from './structure';
import type { EdgeSource, Graph, GraphNode, GraphSettings } from './types';

export type Doneness = {
  /** Нода выполнена для всего после неё: по-настоящему или с пометкой «засчитано». */
  readonly done: ReadonlySet<NodeId>;
  /** Нода заблокирована: не выполнено что-то, что она ждёт, или заблокирована её роадмапа. */
  readonly locked: ReadonlySet<NodeId>;
  /** Ноды в порядке зависимостей. */
  readonly order: readonly NodeId[];
  /** Ноды с пометкой «засчитано», которые снова выполнены по-настоящему: пометка больше не нужна. */
  readonly countedNoLongerNeeded: readonly NodeId[];
  /** Ноды, которые должны получить пометку «засчитано» (см. countIfWasDone). */
  readonly toCount: readonly NodeId[];
};

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Выполненность нод (DESIGN.md, «Вычисляемые состояния»):
 * - нода заблокирована, если не выполнен источник хоть одной входящей стрелки или заблокирована
 *   роадмапа, внутри которой она лежит;
 * - нода выполнена по-настоящему, если не заблокирована и: у блока есть задачи и все выполнены,
 *   у роадмапы есть ноды внутри и все выполнены, у milestone есть входящие стрелки;
 * - пометка «засчитано» делает ноду выполненной для всего после неё.
 *
 * countIfWasDone — ноды, выполненные до операции с «не блокировать». Та из них, что перестала
 * быть выполненной, получает пометку. Обход идёт в порядке зависимостей и учитывает уже
 * поставленные пометки, поэтому пометку получают только первые в цепочке: всё после них
 * остаётся выполненным само.
 */
export function doneness(
  graph: Graph,
  settings: GraphSettings,
  countIfWasDone?: ReadonlySet<NodeId>,
): Doneness {
  const incoming = new Map<NodeId, EdgeSource[]>();
  for (const edge of valuesOf(graph.edges)) append(incoming, edge.target.nodeId, edge.source);
  const children = new Map<NodeId, NodeId[]>();
  for (const node of valuesOf(graph.nodes)) {
    if (node.parentId !== null) append(children, node.parentId, node.id);
  }
  const taskStatuses = new Map<NodeId, boolean[]>();
  for (const task of valuesOf(graph.tasks)) {
    append(taskStatuses, task.blockId, isTaskCompleted(task.status, settings));
  }

  const done = new Set<NodeId>();
  const locked = new Set<NodeId>();
  const order: NodeId[] = [];
  const countedNoLongerNeeded: NodeId[] = [];
  const toCount: NodeId[] = [];

  const taskCompleted = (taskId: TaskId): boolean => {
    const task = getOwn(graph.tasks, taskId);
    return task !== undefined && isTaskCompleted(task.status, settings);
  };
  const satisfied = (source: EdgeSource): boolean =>
    source.kind === 'task' ? taskCompleted(source.taskId) : done.has(source.nodeId);
  const ownConditionMet = (node: GraphNode): boolean => {
    switch (node.type) {
      case 'block': {
        const statuses = taskStatuses.get(node.id) ?? [];
        return statuses.length > 0 && statuses.every(Boolean);
      }
      case 'roadmap': {
        const inside = children.get(node.id) ?? [];
        return inside.length > 0 && inside.every((id) => done.has(id));
      }
      case 'milestone':
        return (incoming.get(node.id) ?? []).length > 0;
    }
  };

  for (const { step, id } of dependencyOrder(graph)) {
    const node = getOwn(graph.nodes, id);
    if (!node) continue;
    if (step === 'enter') {
      const parentLocked = node.parentId !== null && locked.has(node.parentId);
      if (parentLocked || (incoming.get(id) ?? []).some((source) => !satisfied(source))) {
        locked.add(id);
      }
      continue;
    }
    order.push(id);
    const complete = !locked.has(id) && ownConditionMet(node);
    if (complete) {
      done.add(id);
      if (node.countedDone !== null) countedNoLongerNeeded.push(id);
    } else if (node.countedDone !== null) {
      done.add(id);
    } else if (countIfWasDone?.has(id)) {
      done.add(id);
      toCount.push(id);
    }
  }
  return { done, locked, order, countedNoLongerNeeded, toCount };
}
