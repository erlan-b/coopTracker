// Публичный API graph-core (см. DESIGN.md, «Порядок работы»).
export * from './ids';
export * from './types';
export * from './errors';
export * from './apply';
export { changesBetween, combineChanges, isEmptyChanges } from './changes';
export { checkGraph } from './invariants';
export { graphFromSnapshot, toSnapshot } from './snapshot';
export { deadlinePassed, graphStates } from './states';
export type { GraphStates, NodeState, NodeView, Now, Summary, TaskState, TaskView } from './states';
export type { RevertSkip } from './revert';
export { merge } from './merge';
export type { FieldConflict, MergeConflict, MergeOptions, MergeSide, Merged } from './merge';
