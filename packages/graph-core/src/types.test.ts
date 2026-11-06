// Проверки схемы данных. expectTypeOf проверяется компилятором (npm run typecheck), it — Vitest.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { GRAPH_ERROR_CODES } from './errors';
import type { NodeId, TaskId, UserId } from './ids';
import type { Graph, MilestoneNode, NewNode, NewTask, RoadmapNode, Task } from './types';
import { EDITABLE_NODE_FIELDS } from './types';

describe('ноды', () => {
  it('у блока и роадмапы — название, описание, срок, метки и «засчитано»', () => {
    const fields = ['title', 'description', 'deadline', 'labelIds', 'countedDone'];
    expect(EDITABLE_NODE_FIELDS.block).toEqual(fields);
    expect(EDITABLE_NODE_FIELDS.roadmap).toEqual(fields);
  });

  it('у milestone — название, описание, срок и «засчитано»', () => {
    expect(EDITABLE_NODE_FIELDS.milestone).toEqual([
      'title',
      'description',
      'deadline',
      'countedDone',
    ]);
  });

  it('статуса и ответственных у нод нет — они только у задач', () => {
    expectTypeOf<RoadmapNode>().not.toHaveProperty('status');
    expectTypeOf<MilestoneNode>().not.toHaveProperty('assigneeIds');
    expectTypeOf<Task>().toHaveProperty('status');
    expectTypeOf<Task>().toHaveProperty('assigneeIds');
  });

  it('новая нода не задаёт авторство и «засчитано»', () => {
    expectTypeOf<NewNode>().not.toHaveProperty('createdBy');
    expectTypeOf<NewNode>().not.toHaveProperty('countedDone');
  });
});

describe('задачи', () => {
  it('новая задача не задаёт номер, предупреждения и авторство', () => {
    expectTypeOf<NewTask>().not.toHaveProperty('number');
    expectTypeOf<NewTask>().not.toHaveProperty('warnings');
    expectTypeOf<NewTask>().not.toHaveProperty('createdBy');
  });
});

describe('брендированные id', () => {
  it('id разных сущностей не взаимозаменяемы', () => {
    expectTypeOf<UserId>().not.toEqualTypeOf<NodeId>();
    expectTypeOf<TaskId>().not.toEqualTypeOf<NodeId>();
  });

  it('задачу нельзя прочитать по id ноды', () => {
    const read = (graph: Graph, id: NodeId) =>
      // @ts-expect-error — id ноды не подходит как ключ словаря задач
      graph.tasks.get(id);
    expect(read).toBeTypeOf('function');
  });
});

describe('коды ошибок', () => {
  it('без повторов', () => {
    expect(new Set(GRAPH_ERROR_CODES).size).toBe(GRAPH_ERROR_CODES.length);
  });
});
