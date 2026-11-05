// Публичный API graph-core. Наполняется в подшагах 1b–1e (см. DESIGN.md, «Порядок работы»).
export * from './ids';
export * from './types';
export * from './errors';
export * from './apply';
export * from './changes';
export { checkGraph } from './invariants';
export { planRevert } from './revert';
export type { Reverted, RevertSkip } from './revert';
