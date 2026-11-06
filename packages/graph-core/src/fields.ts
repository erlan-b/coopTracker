// Записи только из известных полей. restore и revert несут целые записи от клиента: лишнее,
// в том числе во вложенных объектах, в граф не попадает (DESIGN.md, «Модель данных графа»).
// Запись без лишнего возвращается тем же объектом — ничего не пересоздаётся зря.

import type {
  CountedDone,
  Deadline,
  EdgeSource,
  EdgeTarget,
  GraphEdge,
  GraphNode,
  NodeType,
  Task,
  TaskWarning,
} from './types';

/** У объекта ровно эти собственные поля. */
function hasExactly(value: object, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

const AUTHORSHIP = ['createdBy', 'createdAt', 'updatedBy', 'updatedAt'] as const;
const NODE_BASE = ['id', 'parentId', 'title', 'description', 'x', 'y', 'countedDone'] as const;

const NODE_KEYS: Readonly<Record<NodeType, readonly string[]>> = {
  block: [...NODE_BASE, ...AUTHORSHIP, 'type', 'deadline', 'labelIds'],
  roadmap: [...NODE_BASE, ...AUTHORSHIP, 'type', 'deadline', 'labelIds'],
  milestone: [...NODE_BASE, ...AUTHORSHIP, 'type', 'deadline'],
};

const TASK_KEYS: readonly (keyof Task)[] = [
  'id',
  'blockId',
  'order',
  'number',
  'title',
  'description',
  'status',
  'assigneeIds',
  'deadline',
  'priority',
  'labelIds',
  'estimate',
  'warnings',
  ...AUTHORSHIP,
];

function knownDeadline(deadline: Deadline | null): Deadline | null {
  if (deadline === null) return null;
  if (deadline.kind === 'date') {
    return hasExactly(deadline, ['kind', 'date'])
      ? deadline
      : { kind: 'date', date: deadline.date };
  }
  return hasExactly(deadline, ['kind', 'at']) ? deadline : { kind: 'datetime', at: deadline.at };
}

function knownCounted(counted: CountedDone | null): CountedDone | null {
  if (counted === null || hasExactly(counted, ['by', 'at'])) return counted;
  return { by: counted.by, at: counted.at };
}

function knownSource(source: EdgeSource): EdgeSource {
  if (source.kind === 'node') {
    return hasExactly(source, ['kind', 'nodeId'])
      ? source
      : { kind: 'node', nodeId: source.nodeId };
  }
  return hasExactly(source, ['kind', 'taskId']) ? source : { kind: 'task', taskId: source.taskId };
}

function knownTarget(target: EdgeTarget): EdgeTarget {
  return hasExactly(target, ['kind', 'nodeId']) ? target : { kind: 'node', nodeId: target.nodeId };
}

function knownWarning(warning: TaskWarning): TaskWarning {
  const source = knownSource(warning.source);
  return source === warning.source && hasExactly(warning, ['source', 'at'])
    ? warning
    : { source, at: warning.at };
}

export function knownNode(node: GraphNode): GraphNode {
  const deadline = knownDeadline(node.deadline);
  const countedDone = knownCounted(node.countedDone);
  if (
    hasExactly(node, NODE_KEYS[node.type]) &&
    deadline === node.deadline &&
    countedDone === node.countedDone
  ) {
    return node;
  }
  const base = {
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    description: node.description,
    x: node.x,
    y: node.y,
    countedDone,
    createdBy: node.createdBy,
    createdAt: node.createdAt,
    updatedBy: node.updatedBy,
    updatedAt: node.updatedAt,
  };
  switch (node.type) {
    case 'block':
      return { ...base, type: 'block', deadline, labelIds: node.labelIds };
    case 'roadmap':
      return { ...base, type: 'roadmap', deadline, labelIds: node.labelIds };
    case 'milestone':
      return { ...base, type: 'milestone', deadline };
  }
}

export function knownTask(task: Task): Task {
  const deadline = knownDeadline(task.deadline);
  const warnings = task.warnings.map(knownWarning);
  if (
    hasExactly(task, TASK_KEYS) &&
    deadline === task.deadline &&
    warnings.every((warning, i) => warning === task.warnings[i])
  ) {
    return task;
  }
  return {
    id: task.id,
    blockId: task.blockId,
    order: task.order,
    number: task.number,
    title: task.title,
    description: task.description,
    status: task.status,
    assigneeIds: task.assigneeIds,
    deadline,
    priority: task.priority,
    labelIds: task.labelIds,
    estimate: task.estimate,
    warnings,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedBy: task.updatedBy,
    updatedAt: task.updatedAt,
  };
}

export function knownEdge(edge: GraphEdge): GraphEdge {
  const source = knownSource(edge.source);
  const target = knownTarget(edge.target);
  if (
    hasExactly(edge, ['id', 'source', 'target']) &&
    source === edge.source &&
    target === edge.target
  ) {
    return edge;
  }
  return { id: edge.id, source, target };
}
