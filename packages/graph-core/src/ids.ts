// Брендированные id: во время работы это обычные строки, но компилятор не даёт перепутать,
// например, id задачи с id пользователя.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NodeId = Brand<string, 'NodeId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type EdgeId = Brand<string, 'EdgeId'>;
export type UserId = Brand<string, 'UserId'>;
export type LabelId = Brand<string, 'LabelId'>;

// Превращение строки в id. Только там, где id появляются: создание, чтение из БД,
// разбор входящих сообщений (после проверки по схеме), тесты. Внутри логики id берутся из объектов.
export const asNodeId = (raw: string): NodeId => raw as NodeId;
export const asTaskId = (raw: string): TaskId => raw as TaskId;
export const asEdgeId = (raw: string): EdgeId => raw as EdgeId;
export const asUserId = (raw: string): UserId => raw as UserId;
export const asLabelId = (raw: string): LabelId => raw as LabelId;
