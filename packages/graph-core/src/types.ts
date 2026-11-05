// Типы графа: то, что хранится, синхронизируется и сливается. Смысл полей — в DESIGN.md.

import type { EdgeId, LabelId, NodeId, TaskId, UserId } from './ids';

export const NODE_TYPES = ['block', 'roadmap', 'milestone'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Срок: календарная дата (одинакова для всех) или момент в UTC (каждый видит в своём часовом поясе). */
export type Deadline =
  | { readonly kind: 'date'; readonly date: string } // 'YYYY-MM-DD'
  | { readonly kind: 'datetime'; readonly at: string }; // ISO 8601 в UTC

type Authorship = {
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly updatedBy: UserId;
  readonly updatedAt: string;
};

// ---- Ноды: то, что стоит на холсте ----

type BaseNode = Authorship & {
  readonly id: NodeId;
  /** null — корневой уровень; иначе id ноды типа 'roadmap'. */
  readonly parentId: NodeId | null;
  readonly title: string;
  readonly description: string;
  /** Целые пиксели в координатах холста. */
  readonly x: number;
  readonly y: number;
};

/** Блок: карточка с шапкой, описанием и списком задач. */
export type BlockNode = BaseNode & {
  readonly type: 'block';
  readonly deadline: Deadline | null;
  readonly labelIds: readonly LabelId[];
};

/** Блок-роадмапа: вместо списка задач открывается во вложенный граф. Только на корневом уровне. */
export type RoadmapNode = BaseNode & {
  readonly type: 'roadmap';
  readonly deadline: Deadline | null;
  readonly labelIds: readonly LabelId[];
};

/** Точка вроде «Релиз 1.0»: без задач, выполнена, когда выполнено всё, что в неё ведёт. */
export type MilestoneNode = BaseNode & {
  readonly type: 'milestone';
  readonly deadline: Deadline | null;
};

export type GraphNode = BlockNode | RoadmapNode | MilestoneNode;

// ---- Задачи: пункты внутри блока ----

/** Предупреждение «предыдущая задача изменена»: sourceTaskId — задача, которая перестала быть выполненной. */
export type TaskWarning = { readonly sourceTaskId: TaskId; readonly at: string };

export type Task = Authorship & {
  readonly id: TaskId;
  /** Блок, в котором лежит задача. Всегда нода типа 'block'. */
  readonly blockId: NodeId;
  /** Позиция в блоке — дробный индекс: строки сравниваются как обычно, при равенстве решает id. */
  readonly order: string;
  /** Короткий номер (CT-42). Выдаёт сервер; у неподтверждённой задачи — null. */
  readonly number: number | null;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly assigneeIds: readonly UserId[];
  readonly deadline: Deadline | null;
  readonly priority: Priority;
  readonly labelIds: readonly LabelId[];
  readonly estimate: number | null;
  readonly warnings: readonly TaskWarning[];
};

// ---- Рёбра ----

/** Откуда идёт стрелка: выход в шапке ноды («нода выполнена целиком») или выход у задачи («выполнена эта задача»). */
export type EdgeSource =
  | { readonly kind: 'node'; readonly nodeId: NodeId }
  | { readonly kind: 'task'; readonly taskId: TaskId };

/**
 * Куда входит стрелка. Сейчас вход есть только у нод; форма такая же, как у источника,
 * чтобы вход у задачи ({ kind: 'task' }) можно было добавить без переделки сохранённых данных.
 */
export type EdgeTarget = { readonly kind: 'node'; readonly nodeId: NodeId };

/**
 * Ребро «source блокирует target». Может пересекать границу вложенной роадмапы в любом
 * направлении — снаружи такое ребро рисуется пунктиром из ноды-роадмапы или в неё.
 */
export type GraphEdge = {
  readonly id: EdgeId;
  readonly source: EdgeSource;
  readonly target: EdgeTarget;
};

/** Состояние графа одной ветки. Обычные объекты, а не Map, чтобы снимок напрямую сериализовался в JSON. */
export type Graph = {
  readonly nodes: Readonly<Record<NodeId, GraphNode>>;
  readonly tasks: Readonly<Record<TaskId, Task>>;
  readonly edges: Readonly<Record<EdgeId, GraphEdge>>;
};

// ---- Изменения полей ----
// Пропущенное поле не трогается; null очищает поле.

export type NodePatch = {
  readonly title?: string;
  readonly description?: string;
  readonly deadline?: Deadline | null;
  readonly labelIds?: readonly LabelId[];
};
export type NodePatchField = keyof NodePatch;

/** Какие поля можно менять у какого типа ноды. */
export const EDITABLE_NODE_FIELDS = {
  block: ['title', 'description', 'deadline', 'labelIds'],
  roadmap: ['title', 'description', 'deadline', 'labelIds'],
  milestone: ['title', 'description', 'deadline'],
} as const satisfies {
  readonly [T in NodeType]: readonly (NodePatchField & keyof Extract<GraphNode, { type: T }>)[];
};

export type TaskPatch = {
  readonly title?: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly assigneeIds?: readonly UserId[];
  readonly deadline?: Deadline | null;
  readonly priority?: Priority;
  readonly labelIds?: readonly LabelId[];
  readonly estimate?: number | null;
};

export const LIMITS = {
  maxAssignees: 10,
  maxLabels: 20,
  titleMaxLength: 200,
  descriptionMaxLength: 20_000,
} as const;

// ---- Операции ----

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AuthorshipField = keyof Authorship;

/** Нода в операции создания: без авторства — его проставляет graph-core. */
export type NewNode = DistributiveOmit<GraphNode, AuthorshipField>;

/** Задача в операции создания: без номера (его выдаёт сервер), предупреждений и авторства. */
export type NewTask = Omit<Task, AuthorshipField | 'number' | 'warnings'>;

export type NodeMove = { readonly id: NodeId; readonly x: number; readonly y: number };

/** Атомарное изменение графа. Все изменения графа — только операциями. */
export type Op =
  | { readonly kind: 'createNode'; readonly node: NewNode }
  | { readonly kind: 'updateNode'; readonly id: NodeId; readonly patch: NodePatch }
  /** И перетаскивание, и автораскладка. Позиции никогда не конфликтуют. */
  | { readonly kind: 'moveNodes'; readonly moves: readonly NodeMove[] }
  /** Удаляет ноду со всеми её задачами и рёбрами, а у роадмапы — и всё внутри. */
  | { readonly kind: 'deleteNode'; readonly id: NodeId }
  /**
   * Разросшийся блок → роадмапа. Задачи переезжают в новый блок innerBlockId внутри неё
   * (id создаёт клиент, чтобы у всех получился одинаковый граф). Стрелки задач остаются как были.
   */
  | { readonly kind: 'blockToRoadmap'; readonly id: NodeId; readonly innerBlockId: NodeId }
  /** Обратно в блок — только пустая роадмапа. */
  | { readonly kind: 'roadmapToBlock'; readonly id: NodeId }
  | { readonly kind: 'createTask'; readonly task: NewTask }
  | { readonly kind: 'updateTask'; readonly id: TaskId; readonly patch: TaskPatch }
  /** Порядок внутри блока или перенос в другой блок. Номер, поля и стрелки задачи сохраняются. */
  | {
      readonly kind: 'moveTask';
      readonly id: TaskId;
      readonly blockId: NodeId;
      readonly order: string;
    }
  /** Удаляет задачу и её исходящие стрелки. */
  | { readonly kind: 'deleteTask'; readonly id: TaskId }
  | { readonly kind: 'createEdge'; readonly edge: GraphEdge }
  | { readonly kind: 'deleteEdge'; readonly id: EdgeId }
  | {
      readonly kind: 'dismissWarnings';
      readonly taskId: TaskId;
      readonly scope: 'this' | 'downstream';
    }
  /**
   * Возвращает удалённое как было: с теми же id и номерами (undo удаления, корзина).
   * Сервер принимает только то, что совпадает с его копией в корзине.
   */
  | {
      readonly kind: 'restore';
      readonly nodes: readonly GraphNode[];
      readonly tasks: readonly Task[];
      readonly edges: readonly GraphEdge[];
    };
export type OpKind = Op['kind'];

// ---- Контекст ----

export const ENVI_ROLES = ['master', 'member', 'viewer'] as const;
export type EnviRole = (typeof ENVI_ROLES)[number];

/** Кто выполняет операцию. Роль — уже итоговая: владелец организации приходит сюда как master. */
export type Actor = { readonly id: UserId; readonly role: EnviRole };

export type StatusMode = 'free' | 'review';

/** Настройки envi, от которых зависят правила графа. Остальные настройки envi живут на сервере. */
export type GraphSettings = {
  readonly statusMode: StatusMode;
  readonly reviewUnlocks: boolean;
};

/** Всё, что операции нужно знать, кроме самого графа. Время передаётся параметром, чтобы функции оставались чистыми. */
export type ApplyContext = {
  readonly actor: Actor;
  readonly settings: GraphSettings;
  readonly now: string;
};
