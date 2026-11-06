// Ошибки операций. Только коды и данные для сообщения: сам текст подставляет интерфейс на языке пользователя.

import type { EdgeId, NodeId, TaskId } from './ids';
import type { NodePatchField, NodeType, TaskStatus } from './types';

/** Почему значение поля не подходит. */
export type InvalidReason =
  'too_long' | 'too_many' | 'duplicate' | 'not_integer' | 'negative' | 'bad_format';

export type GraphError =
  /** viewer ничего не меняет; подтвердить «на проверке» → done может только master. */
  | { readonly code: 'FORBIDDEN'; readonly reason: 'viewer' | 'review_requires_master' }
  | { readonly code: 'NODE_NOT_FOUND'; readonly id: NodeId }
  | { readonly code: 'TASK_NOT_FOUND'; readonly id: TaskId }
  | { readonly code: 'EDGE_NOT_FOUND'; readonly id: EdgeId }
  | { readonly code: 'DUPLICATE_ID'; readonly id: string }
  /** Операция ждёт ноду другого типа: например, задачу кладут не в блок. */
  | { readonly code: 'WRONG_NODE_TYPE'; readonly id: NodeId; readonly expected: NodeType }
  /** parentId указывает на несуществующую ноду или не на роадмапу. */
  | { readonly code: 'INVALID_PARENT'; readonly parentId: NodeId }
  /** Роадмапа может стоять только на корневом уровне. */
  | { readonly code: 'NESTING_TOO_DEEP'; readonly id: NodeId }
  /** Стрелка ведёт в ту же ноду, из которой выходит (в том числе от задачи к её же блоку). */
  | { readonly code: 'SELF_LOOP'; readonly edgeId: EdgeId }
  | { readonly code: 'DUPLICATE_EDGE'; readonly edgeId: EdgeId }
  /**
   * path — найденный цикл из нод, чтобы его можно было подсветить. Сюда же попадает тупик через
   * границу роадмапы: например, блок внутри роадмапы ждёт ноду, которая сама ждёт эту роадмапу.
   */
  | { readonly code: 'CYCLE'; readonly path: readonly NodeId[] }
  | {
      readonly code: 'FIELD_NOT_APPLICABLE';
      readonly field: NodePatchField;
      readonly nodeType: NodeType;
    }
  | { readonly code: 'INVALID_VALUE'; readonly field: string; readonly reason: InvalidReason }
  /** Например, 'in_review' в envi со statusMode = 'free'. */
  | { readonly code: 'STATUS_NOT_ALLOWED'; readonly status: TaskStatus }
  /** Обратно в блок превращается только пустая роадмапа. */
  | { readonly code: 'ROADMAP_NOT_EMPTY'; readonly id: NodeId }
  /** В ветке уже максимум нод, задач или стрелок, или в пакете слишком много операций (LIMITS). */
  | {
      readonly code: 'LIMIT_EXCEEDED';
      readonly records: 'nodes' | 'tasks' | 'edges' | 'ops';
      readonly limit: number;
    };

export type GraphErrorCode = GraphError['code'];

// Record заставляет перечислить каждый код: забытый код — ошибка компиляции.
const ERROR_CODE_SET: Record<GraphErrorCode, true> = {
  FORBIDDEN: true,
  NODE_NOT_FOUND: true,
  TASK_NOT_FOUND: true,
  EDGE_NOT_FOUND: true,
  DUPLICATE_ID: true,
  WRONG_NODE_TYPE: true,
  INVALID_PARENT: true,
  NESTING_TOO_DEEP: true,
  SELF_LOOP: true,
  DUPLICATE_EDGE: true,
  CYCLE: true,
  FIELD_NOT_APPLICABLE: true,
  INVALID_VALUE: true,
  STATUS_NOT_ALLOWED: true,
  ROADMAP_NOT_EMPTY: true,
  LIMIT_EXCEEDED: true,
};

/** Все коды ошибок. Интерфейс по нему проверяет, что у каждого кода есть перевод. */
export const GRAPH_ERROR_CODES = Object.keys(ERROR_CODE_SET) as readonly GraphErrorCode[];

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: GraphError };
