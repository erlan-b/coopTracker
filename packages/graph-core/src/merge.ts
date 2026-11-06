// Трёхстороннее слияние веток (DESIGN.md, «Как устроено слияние»): по записям и полям, а не по
// строкам текста. База — граф на момент ответвления, ветка — что вливаем, целевая — куда.
// Результат строится поверх целевого графа: всё, что слияние не трогает, остаётся теми же
// объектами, а изменения от целевого графа к результату получаются без сравнения всего графа.

import { checkLimits } from './apply';
import { changesOfDraft } from './changes';
import { sourceKey } from './consequences';
import { GraphDraft, viewOf } from './draft';
import type { Result } from './errors';
import type { EdgeId, NodeId, TaskId } from './ids';
import { checkEdge, checkStep } from './invariants';
import { LIMITS } from './types';
import type {
  ApplyContext,
  Changes,
  Graph,
  GraphEdge,
  GraphNode,
  NodeType,
  Task,
  TaskWarning,
} from './types';
import { ownField, sameValue } from './values';

/** Чья сторона: ветка, которую вливаем, или целевая ветка. */
export type MergeSide = 'branch' | 'target';

type Decision = {
  /**
   * Ключ конфликта: по нему передаётся решение. При пересчёте слияния на новой версии целевой
   * ветки у того же конфликта тот же ключ.
   */
  readonly key: string;
  /** Решение: как в ветке или как в целевой; null — не решён, и в результате как в целевой. */
  readonly chosen: MergeSide | null;
};

type RecordRef =
  | { readonly record: 'node'; readonly id: NodeId }
  | { readonly record: 'task'; readonly id: TaskId };

/**
 * Конфликт поля: оно изменено с обеих сторон по-разному. Для места задачи поле — blockId, а
 * решение переносит блок вместе с порядком.
 */
export type FieldConflict = Decision &
  RecordRef & {
    readonly kind: 'field';
    readonly field: string;
    /** Значение в базе; undefined — записи в базе не было (её добавили с обеих сторон). */
    readonly base: unknown;
    readonly branch: unknown;
    readonly target: unknown;
  };

/**
 * Запись удалена с одной стороны (deletedIn), а с другой в ней или на ней что-то изменилось:
 * её поля, задачи и ноды внутри (в том числе новые и перенесённые туда), новые стрелки к ней или
 * от неё. id — верхняя удалённая запись: роадмапа, блок или задача; всё удалённое внутри неё
 * решается вместе с ней. «Как в ветке» и «как в целевой» — запись остаётся или удаляется так,
 * как на этой стороне, вместе со всем, что в ней на другой стороне.
 */
export type DeletedConflict = Decision &
  RecordRef & { readonly kind: 'deleted'; readonly deletedIn: MergeSide };

/**
 * Нода превращена с одной стороны (блок ↔ роадмапа), а с другой в неё добавили то, что новому
 * типу не подходит: ноды в блок или задачи в роадмапу, внутри которой нет нового блока для них.
 * Остаётся тип выбранной стороны, а неподходящее ему содержимое удаляется.
 */
export type TypeConflict = Decision & {
  readonly kind: 'type';
  readonly record: 'node';
  readonly id: NodeId;
  readonly branch: NodeType;
  readonly target: NodeType;
};

export type MergeConflict = FieldConflict | DeletedConflict | TypeConflict;

export type MergeOptions = {
  /** Решения конфликтов по ключу. Решение, для которого конфликта нет, не используется. */
  readonly resolutions?: ReadonlyMap<string, MergeSide>;
  /**
   * Ноды, которые двигали с обеих сторон и чья позиция остаётся целевой. Остальные такие ноды
   * получают позицию из ветки. Кому оставить целевую, решает сервер: по правам и по логу
   * операций, где видно, кто и когда двигал ноду.
   */
  readonly keepTargetPositions?: ReadonlySet<NodeId>;
};

export type Merged = {
  /** Граф, который заменит целевой. */
  readonly graph: Graph;
  /**
   * Изменения от целевого графа к результату, записи по id: по ним preview показывает
   * добавленное, удалённое и изменённое, а сервер пишет их в лог операций.
   */
  readonly changes: Changes;
  /** Все конфликты, решённые и нет, по записи, id и полю. */
  readonly conflicts: readonly MergeConflict[];
  /** Ноды, которые двигали с обеих сторон, а позиция осталась целевой: «позиции N нод не перенесены». */
  readonly positionsKept: readonly NodeId[];
};

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Fields = Record<string, unknown>;

const textOf = (record: Fields, key: string): string => {
  const value = ownField(record, key);
  return typeof value === 'string' ? value : '';
};

/** Пишет поле так, что даже имя вроде `__proto__` остаётся обычным полем. */
function setField(record: Fields, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// ---- Списки ----

/** Списки id как множества: удалённое с одной стороны убирается, добавленное — добавляется. */
function mergeIds(
  base: readonly unknown[],
  branch: readonly unknown[],
  target: readonly unknown[],
) {
  const inBase = new Set(base);
  const inBranch = new Set(branch);
  const kept = target.filter((item) => !inBase.has(item) || inBranch.has(item));
  const inKept = new Set(kept);
  return [...kept, ...branch.filter((item) => !inBase.has(item) && !inKept.has(item))];
}

const byTime = (a: TaskWarning, b: TaskWarning): number => byId(a.at, b.at);

/**
 * Предупреждения как множества: снятое с одной стороны снимается, новое с любой стороны остаётся.
 * Предупреждение с новым временем — новое: тот, кто снял старое, его ещё не видел. От одного
 * источника остаётся одно — более позднее; самые новые в конце, сверх лимита уходят самые старые.
 */
function mergeWarnings(
  base: readonly TaskWarning[],
  branch: readonly TaskWarning[],
  target: readonly TaskWarning[],
): TaskWarning[] {
  const keyOf = (warning: TaskWarning) => `${warning.at} ${sourceKey(warning.source)}`;
  const inBase = new Set(base.map(keyOf));
  const inBranch = new Set(branch.map(keyOf));
  const kept = target.filter(
    (warning) => !inBase.has(keyOf(warning)) || inBranch.has(keyOf(warning)),
  );
  const added = branch.filter((warning) => !inBase.has(keyOf(warning)));
  const bySource = new Map<string, TaskWarning>();
  for (const warning of [...kept, ...added]) {
    const source = sourceKey(warning.source);
    const known = bySource.get(source);
    if (known === undefined || warning.at > known.at) bySource.set(source, warning);
  }
  return [...bySource.values()].sort(byTime).slice(-LIMITS.maxWarnings);
}

const SET_LIMITS: Readonly<Record<string, number>> = {
  labelIds: LIMITS.maxLabels,
  assigneeIds: LIMITS.maxAssignees,
};

// ---- Слияние одной записи ----

/** Поля, которые сливаются только вместе: позиция ноды, место задачи, авторство. */
const GROUPS: Readonly<Record<'node' | 'task', readonly (readonly string[])[]>> = {
  node: [
    ['x', 'y'],
    ['createdBy', 'createdAt'],
    ['updatedBy', 'updatedAt'],
  ],
  task: [
    ['blockId', 'order'],
    ['createdBy', 'createdAt'],
    ['updatedBy', 'updatedAt'],
  ],
};

/** Что взять, когда группа полей изменена с обеих сторон по-разному. */
type Divergence = MergeSide | { readonly value: unknown };

/** Конфликты и решения к ним. */
class Decisions {
  readonly conflicts: MergeConflict[] = [];

  constructor(private readonly resolutions: ReadonlyMap<string, MergeSide>) {}

  /** Решение по ключу; null — не решён. */
  chosen(key: string): MergeSide | null {
    const wanted = this.resolutions.get(key);
    return wanted === 'branch' || wanted === 'target' ? wanted : null;
  }

  add(conflict: MergeConflict): void {
    this.conflicts.push(conflict);
  }

  sorted(): MergeConflict[] {
    const kinds: readonly MergeConflict['kind'][] = ['deleted', 'type', 'field'];
    const fieldOf = (conflict: MergeConflict) => (conflict.kind === 'field' ? conflict.field : '');
    return this.conflicts.sort(
      (a, b) =>
        byId(a.record, b.record) ||
        byId(a.id, b.id) ||
        kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
        byId(fieldOf(a), fieldOf(b)),
    );
  }
}

class RecordMerger {
  readonly positionsKept: NodeId[] = [];

  constructor(
    private readonly decisions: Decisions,
    private readonly keepTargetPositions: ReadonlySet<NodeId>,
  ) {}

  /**
   * Запись, изменённая с обеих сторон (или добавленная с обеих сторон с одним id). Если итог
   * совпадает с одной из сторон — возвращается её объект.
   */
  merge<V extends GraphNode | Task>(
    record: 'node' | 'task',
    base: V | undefined,
    branch: V,
    target: V,
  ): V {
    const b = base as Fields | undefined;
    const o = branch as Fields;
    const t = target as Fields;
    const result: Fields = { ...t };
    const grouped = new Set<string>(['id']);
    const groups = GROUPS[record].map((keys) => {
      for (const key of keys) grouped.add(key);
      return keys;
    });
    for (const key of new Set([...Object.keys(o), ...Object.keys(t)])) {
      if (!grouped.has(key)) groups.push([key]);
    }

    for (const keys of groups) {
      const valuesOf = (fields: Fields) => keys.map((key) => ownField(fields, key));
      const was = b === undefined ? undefined : valuesOf(b);
      const ours = valuesOf(o);
      const theirs = valuesOf(t);
      if (sameValue(ours, theirs) || sameValue(ours, was)) continue;
      const side: Divergence = sameValue(theirs, was)
        ? 'branch'
        : this.diverged(record, branch.id, keys, b, o, t);
      if (side === 'target') continue;
      if (side === 'branch') {
        for (const key of keys) setField(result, key, ownField(o, key));
      } else {
        setField(result, keys[0] ?? '', side.value);
      }
    }

    if (sameValue(result, t)) return target;
    if (sameValue(result, o)) return branch;
    return result as V;
  }

  /** Группа полей изменена с обеих сторон по-разному. */
  private diverged(
    record: 'node' | 'task',
    id: string,
    keys: readonly string[],
    base: Fields | undefined,
    branch: Fields,
    target: Fields,
  ): Divergence {
    const key = keys[0] ?? '';
    const field = (fields: Fields | undefined) =>
      fields === undefined ? undefined : ownField(fields, key);
    switch (key) {
      case 'x':
        if (!this.keepTargetPositions.has(id as NodeId)) return 'branch';
        this.positionsKept.push(id as NodeId);
        return 'target';
      case 'blockId':
        // Порядок внутри одного блока не конфликтует; перенос побеждает порядок в старом блоке;
        // перенос в разные блоки с обеих сторон — конфликт.
        if (field(branch) === field(target)) return 'branch';
        if (field(branch) === field(base)) return 'target';
        if (field(target) === field(base)) return 'branch';
        return this.conflict(record, id, key, base, branch, target);
      case 'createdBy':
        // Создание не меняется; разное оно только у записи, добавленной с обеих сторон с одним id.
        return 'target';
      case 'updatedBy':
        // Авторство — той стороны, где запись правили позже.
        return textOf(branch, 'updatedAt') > textOf(target, 'updatedAt') ? 'branch' : 'target';
      case 'countedDone':
        // Пометку после слияния перепроверяют последствия; разные пометки — не повод для вопроса.
        return 'target';
      case 'number':
        // Номер выдаёт сервер один раз: берётся тот, что есть.
        return field(target) === null ? 'branch' : 'target';
      case 'warnings':
        return {
          value: mergeWarnings(
            (field(base) ?? []) as TaskWarning[],
            field(branch) as TaskWarning[],
            field(target) as TaskWarning[],
          ),
        };
      case 'labelIds':
      case 'assigneeIds': {
        const merged = mergeIds(
          (field(base) ?? []) as unknown[],
          field(branch) as unknown[],
          field(target) as unknown[],
        );
        const limit = SET_LIMITS[key] ?? Infinity;
        return merged.length <= limit
          ? { value: merged }
          : this.conflict(record, id, key, base, branch, target);
      }
      default:
        return this.conflict(record, id, key, base, branch, target);
    }
  }

  private conflict(
    record: 'node' | 'task',
    id: string,
    field: string,
    base: Fields | undefined,
    branch: Fields,
    target: Fields,
  ): MergeSide {
    const key = `field:${field}:${record}:${id}`;
    const chosen = this.decisions.chosen(key);
    const values = {
      key,
      field,
      base: base === undefined ? undefined : ownField(base, field),
      branch: ownField(branch, field),
      target: ownField(target, field),
      chosen,
    };
    this.decisions.add(
      record === 'node'
        ? { kind: 'field', record, id: id as NodeId, ...values }
        : { kind: 'field', record, id: id as TaskId, ...values },
    );
    return chosen ?? 'target';
  }
}

// ---- Записи с разных сторон ----

const same = <V>(a: V | undefined, b: V | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && sameValue(a, b));

/** Поля, изменение которых не меняет смысла записи: позиция, порядок в блоке, последствия, авторство. */
const COSMETIC: ReadonlySet<string> = new Set([
  'x',
  'y',
  'order',
  'warnings',
  'countedDone',
  'number',
  'createdBy',
  'createdAt',
  'updatedBy',
  'updatedAt',
]);

/** Запись изменена по смыслу. Сдвинутая нода или полученное предупреждение удалению не мешают. */
function meaningChanged(before: object, after: object): boolean {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!COSMETIC.has(key) && !sameValue(ownField(before, key), ownField(after, key))) return true;
  }
  return false;
}

/** Записи одного вида, разобранные по сторонам. */
type Sorted<K, V> = {
  /** Есть с обеих сторон, и итог слияния полей отличается от целевой записи. */
  readonly merged: Map<K, V>;
  /** Новые в ветке: нет ни в базе, ни в целевой. */
  readonly branchNew: Map<K, V>;
  /** Удалены в целевой, есть в ветке: запись из ветки. */
  readonly deletedInTarget: Map<K, V>;
  /** Удалены в ветке, есть в целевой: запись из целевой. */
  readonly deletedInBranch: Map<K, V>;
};

/**
 * Смотрим записи ветки и базы; записи, которых нет ни там, ни там, — новые в целевой, они уже
 * в результате. Изменённое только веткой берётся из ветки, изменённое с обеих сторон — сливается.
 */
function sortRecords<K extends string, V extends { readonly id: K }>(
  base: ReadonlyMap<K, V>,
  branch: ReadonlyMap<K, V>,
  target: ReadonlyMap<K, V>,
  mergeBoth: (base: V | undefined, branch: V, target: V) => V,
): Sorted<K, V> {
  const sorted: Sorted<K, V> = {
    merged: new Map(),
    branchNew: new Map(),
    deletedInTarget: new Map(),
    deletedInBranch: new Map(),
  };
  for (const [id, ours] of branch) {
    const was = base.get(id);
    const theirs = target.get(id);
    if (theirs === undefined) {
      if (was === undefined) sorted.branchNew.set(id, ours);
      else sorted.deletedInTarget.set(id, ours);
      continue;
    }
    if (theirs === ours || same(was, ours)) continue;
    const result = was !== undefined && same(was, theirs) ? ours : mergeBoth(was, ours, theirs);
    if (result !== theirs) sorted.merged.set(id, result);
  }
  for (const id of base.keys()) {
    if (branch.has(id)) continue;
    const theirs = target.get(id);
    if (theirs !== undefined) sorted.deletedInBranch.set(id, theirs);
  }
  return sorted;
}

// ---- Удалённое с одной стороны ----

/**
 * Удалённое с одной стороны вместе со всем, что на другой стороне лежит внутри него: решается
 * целиком. Корень — верхняя удалённая запись.
 */
type Unit = {
  readonly root: RecordRef;
  readonly deletedIn: MergeSide;
  /** Сам корень и всё внутри него: удалённое на стороне deletedIn и новое на другой стороне. */
  readonly nodes: ReadonlySet<NodeId>;
  readonly tasks: ReadonlySet<TaskId>;
  /** Задачи, которые другая сторона перенесла внутрь удалённого. */
  readonly movedIn: ReadonlySet<TaskId>;
  /** Другая сторона что-то в нём меняла: тогда это конфликт, иначе удаление просто применяется. */
  readonly touched: boolean;
};

type UnitSides = {
  readonly deletedIn: MergeSide;
  readonly base: Graph;
  /** Сторона, где удалённое осталось. */
  readonly kept: Graph;
  /** Сторона, где его удалили. */
  readonly deleter: Graph;
  readonly deletedNodes: ReadonlyMap<NodeId, GraphNode>;
  readonly deletedTasks: ReadonlyMap<TaskId, Task>;
  /** Блок задачи, которая есть с обеих сторон, после слияния полей. */
  readonly finalBlockOf: (id: TaskId) => NodeId | undefined;
};

function findUnits(sides: UnitSides): Unit[] {
  const { base, kept, deleter, deletedNodes, deletedTasks } = sides;
  const view = viewOf(kept);
  const isNewNode = (id: NodeId) => !base.nodes.has(id) && !deleter.nodes.has(id);
  const isNewTask = (id: TaskId) => !base.tasks.has(id) && !deleter.tasks.has(id);
  /** Лежит ли контейнер внутри удалённого — напрямую или через новые ноды. */
  const insideDeleted = (container: NodeId | null): boolean => {
    for (let id = container; id !== null;) {
      if (deletedNodes.has(id)) return true;
      const node = kept.nodes.get(id);
      if (node === undefined || !isNewNode(id)) return false;
      id = node.parentId;
    }
    return false;
  };

  const unitOf = (
    root: RecordRef,
    nodes: Set<NodeId>,
    tasks: Set<TaskId>,
    movedIn: Set<TaskId>,
  ): Unit => {
    const edges = new Set<EdgeId>();
    for (const id of nodes) {
      for (const edgeId of view.edgesInto(id)) edges.add(edgeId);
      for (const edgeId of view.edgesOut(id)) edges.add(edgeId);
    }
    for (const id of [...tasks, ...movedIn]) {
      for (const edgeId of view.edgesFromTask(id)) edges.add(edgeId);
    }
    const changed = <V extends object>(was: V | undefined, now: V | undefined) =>
      was === undefined || (now !== undefined && meaningChanged(was, now));
    const touched =
      movedIn.size > 0 ||
      [...nodes].some((id) => changed(base.nodes.get(id), kept.nodes.get(id))) ||
      [...tasks].some((id) => changed(base.tasks.get(id), kept.tasks.get(id))) ||
      [...edges].some((id) => !base.edges.has(id));
    return { root, deletedIn: sides.deletedIn, nodes, tasks, movedIn, touched };
  };

  const units: Unit[] = [];
  for (const [rootId, node] of deletedNodes) {
    if (insideDeleted(node.parentId)) continue;
    const nodes = new Set<NodeId>();
    const tasks = new Set<TaskId>();
    const movedIn = new Set<TaskId>();
    const stack = [rootId];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      nodes.add(id);
      for (const childId of view.childrenOf(id)) {
        if (deletedNodes.has(childId) || isNewNode(childId)) stack.push(childId);
      }
      for (const taskId of view.tasksIn(id)) {
        if (deletedTasks.has(taskId) || isNewTask(taskId)) tasks.add(taskId);
        else if (sides.finalBlockOf(taskId) === id) movedIn.add(taskId);
      }
    }
    units.push(unitOf({ record: 'node', id: rootId }, nodes, tasks, movedIn));
  }
  for (const [id, task] of deletedTasks) {
    if (insideDeleted(task.blockId)) continue;
    units.push(unitOf({ record: 'task', id }, new Set(), new Set([id]), new Set()));
  }
  return units;
}

/** Удалённое остаётся в результате: возвращается из ветки или не удаляется из целевой. */
function decideUnit(unit: Unit, decisions: Decisions): boolean {
  if (!unit.touched) return false;
  const key = `deleted:${unit.root.record}:${unit.root.id}`;
  const chosen = decisions.chosen(key);
  decisions.add({ kind: 'deleted', key, ...unit.root, deletedIn: unit.deletedIn, chosen });
  return unit.deletedIn === 'target' ? chosen === 'branch' : chosen !== 'branch';
}

// ---- Запись в результат ----

function removeTaskWithEdges(draft: GraphDraft, id: TaskId): void {
  for (const edgeId of [...draft.edgesFromTask(id)]) draft.removeEdge(edgeId);
  draft.removeTask(id);
}

/** Нода и стрелки в неё и от неё самой. Стрелки её задач уходят вместе с задачами. */
function removeNodeWithEdges(draft: GraphDraft, id: NodeId): void {
  for (const edgeId of [...draft.edgesInto(id)]) draft.removeEdge(edgeId);
  for (const edgeId of [...draft.edgesOut(id)]) {
    if (draft.edge(edgeId)?.source.kind === 'node') draft.removeEdge(edgeId);
  }
  draft.removeNode(id);
}

type Refs = { readonly nodes: ReadonlySet<NodeId>; readonly tasks: ReadonlySet<TaskId> };

function touches(edge: GraphEdge, refs: Refs): boolean {
  const { source } = edge;
  return (
    refs.nodes.has(edge.target.nodeId) ||
    (source.kind === 'node' ? refs.nodes.has(source.nodeId) : refs.tasks.has(source.taskId))
  );
}

function refsOf(units: readonly Unit[]): Refs {
  return {
    nodes: new Set(units.flatMap((unit) => [...unit.nodes])),
    tasks: new Set(units.flatMap((unit) => [...unit.tasks])),
  };
}

/**
 * Стрелка из ветки, если может встать: концы есть и такой же стрелки ещё нет. Стрелка к тому,
 * что не вернулось, не встаёт — это решение конфликта удаления. Петли и циклы — подшаг 2c.
 */
function putBranchEdge(draft: GraphDraft, edge: GraphEdge): void {
  const problem = checkEdge(draft, edge);
  if (problem === null || problem.code === 'SELF_LOOP') draft.putEdge(edge);
}

/** Новый блок внутри роадмапы на превратившей её стороне: самый ранний, при равенстве — по id. */
function innerBlock(
  draft: GraphDraft,
  base: Graph,
  converter: Graph,
  roadmapId: NodeId,
): NodeId | undefined {
  let best: GraphNode | undefined;
  for (const childId of viewOf(converter).childrenOf(roadmapId)) {
    const child = converter.nodes.get(childId);
    if (!child || child.type !== 'block' || base.nodes.has(childId)) continue;
    if (draft.node(childId)?.type !== 'block') continue;
    if (
      best === undefined ||
      child.createdAt < best.createdAt ||
      (child.createdAt === best.createdAt && child.id < best.id)
    ) {
      best = child;
    }
  }
  return best?.id;
}

/**
 * Блок ↔ роадмапа с одной стороны против содержимого с другой. Задачи, попавшие в ставший
 * роадмапой блок, переезжают в новый блок внутри неё (самый ранний: туда превращение перенесло
 * задачи блока). Если такого блока нет или в ставшую блоком роадмапу добавили ноды — конфликт.
 */
function settleTypes(
  draft: GraphDraft,
  base: Graph,
  branch: Graph,
  target: Graph,
  decisions: Decisions,
): void {
  const changed: NodeId[] = [];
  for (const [id, ours] of branch.nodes) {
    const theirs = target.nodes.get(id);
    if (theirs !== undefined && theirs.type !== ours.type) changed.push(id);
  }
  for (const id of changed.sort(byId)) {
    const node = draft.node(id);
    const ours = branch.nodes.get(id);
    const theirs = target.nodes.get(id);
    if (!node || !ours || !theirs || node.type === 'milestone') continue;
    if (node.type === 'roadmap') {
      const stray = [...draft.tasksIn(id)];
      if (stray.length === 0) continue;
      const inner = innerBlock(draft, base, node.type === ours.type ? branch : target, id);
      if (inner !== undefined) {
        for (const taskId of stray) {
          const task = draft.task(taskId);
          if (task) draft.putTask({ ...task, blockId: inner });
        }
        continue;
      }
    } else if (draft.childrenOf(id).size === 0) {
      continue;
    }
    const key = `type:node:${id}`;
    const chosen = decisions.chosen(key);
    decisions.add({
      kind: 'type',
      key,
      record: 'node',
      id,
      branch: ours.type,
      target: theirs.type,
      chosen,
    });
    const type = (chosen === 'branch' ? ours : theirs).type;
    if (type === 'milestone') continue;
    if (type !== node.type) draft.putNode({ ...node, type });
    if (type === 'roadmap') {
      for (const taskId of [...draft.tasksIn(id)]) removeTaskWithEdges(draft, taskId);
    } else {
      for (const childId of [...draft.childrenOf(id)]) {
        for (const taskId of [...draft.tasksIn(childId)]) removeTaskWithEdges(draft, taskId);
        removeNodeWithEdges(draft, childId);
      }
    }
  }
}

function must<V>(value: V | undefined): V {
  if (value === undefined) throw new Error('merge: запись должна быть');
  return value;
}

// ---- Слияние графов ----

/**
 * Трёхстороннее слияние: base — граф на момент ответвления, branch — что вливаем, target —
 * текущая версия целевой ветки. Нерешённый конфликт оставляет всё как в целевой ветке; мерж
 * возможен, когда решены все конфликты. Ошибка — если результат нарушил бы инвариант или лимит.
 */
export function merge(
  base: Graph,
  branch: Graph,
  target: Graph,
  ctx: ApplyContext,
  options: MergeOptions = {},
): Result<Merged> {
  const decisions = new Decisions(options.resolutions ?? new Map());
  const merger = new RecordMerger(decisions, options.keepTargetPositions ?? new Set());
  const nodes = sortRecords(base.nodes, branch.nodes, target.nodes, (was, ours, theirs) =>
    merger.merge('node', was, ours, theirs),
  );
  const tasks = sortRecords(base.tasks, branch.tasks, target.tasks, (was, ours, theirs) =>
    merger.merge('task', was, ours, theirs),
  );
  const finalBlockOf = (id: TaskId) => (tasks.merged.get(id) ?? target.tasks.get(id))?.blockId;
  const units = [
    ...findUnits({
      deletedIn: 'target',
      base,
      kept: branch,
      deleter: target,
      deletedNodes: nodes.deletedInTarget,
      deletedTasks: tasks.deletedInTarget,
      finalBlockOf,
    }),
    ...findUnits({
      deletedIn: 'branch',
      base,
      kept: target,
      deleter: branch,
      deletedNodes: nodes.deletedInBranch,
      deletedTasks: tasks.deletedInBranch,
      finalBlockOf,
    }),
  ];
  const kept = new Set(units.filter((unit) => decideUnit(unit, decisions)));
  const restored = refsOf(units.filter((unit) => unit.deletedIn === 'target' && kept.has(unit)));
  const notDeleted = refsOf(units.filter((unit) => unit.deletedIn === 'branch' && kept.has(unit)));
  const insideDeleted = refsOf(units.filter((unit) => unit.deletedIn === 'target'));

  const draft = new GraphDraft(target);
  // Изменённое с обеих сторон и новое в ветке. Новое внутри удалённого в целевой — вместе с ним.
  for (const node of nodes.merged.values()) draft.putNode(node);
  for (const task of tasks.merged.values()) draft.putTask(task);
  for (const [id, node] of nodes.branchNew) if (!insideDeleted.nodes.has(id)) draft.putNode(node);
  for (const [id, task] of tasks.branchNew) if (!insideDeleted.tasks.has(id)) draft.putTask(task);

  // Удалённое с одной стороны: возвращается из ветки, удаляется из целевой или остаётся.
  for (const unit of units) {
    if (unit.deletedIn === 'target' && kept.has(unit)) {
      for (const id of unit.nodes) draft.putNode(must(branch.nodes.get(id)));
      for (const id of unit.tasks) draft.putTask(must(branch.tasks.get(id)));
    } else if (unit.deletedIn === 'branch' && !kept.has(unit)) {
      for (const id of unit.tasks) removeTaskWithEdges(draft, id);
      for (const id of unit.nodes) removeNodeWithEdges(draft, id);
    }
  }
  // Перенесённое внутрь удалённого, если оно удаляется: место — с той стороны, где удалили.
  // Если и там блока больше нет, задача уходит вместе с удалённым.
  for (const unit of units) {
    if (kept.has(unit)) continue;
    const deleter = unit.deletedIn === 'target' ? target : branch;
    for (const id of unit.movedIn) {
      const task = draft.task(id);
      const there = deleter.tasks.get(id);
      if (!task || !there) continue;
      if (draft.node(there.blockId)?.type !== 'block') {
        removeTaskWithEdges(draft, id);
        continue;
      }
      const placed = { ...task, blockId: there.blockId, order: there.order };
      const theirs = target.tasks.get(id);
      draft.putTask(theirs !== undefined && sameValue(placed, theirs) ? theirs : placed);
    }
  }

  // Стрелки: удалённые в ветке уходят, если не держатся за оставленное; новые в ветке встают;
  // удалённые в целевой возвращаются вместе с возвращённым из ветки.
  for (const [id, edge] of base.edges) {
    const inBranch = branch.edges.get(id);
    const inTarget = target.edges.has(id);
    if (inBranch === undefined && inTarget) {
      if (!touches(edge, notDeleted)) draft.removeEdge(id);
    } else if (inBranch !== undefined && !inTarget && touches(edge, restored)) {
      putBranchEdge(draft, inBranch);
    }
  }
  for (const [id, edge] of branch.edges) {
    if (!base.edges.has(id) && !target.edges.has(id)) putBranchEdge(draft, edge);
  }

  settleTypes(draft, base, branch, target, decisions);

  const problem = checkLimits(draft) ?? checkStep(draft, draft.peekStep());
  if (problem) return { ok: false, error: problem };

  const changes = changesOfDraft(draft, ctx.now);
  return {
    ok: true,
    value: {
      graph: draft.finish(),
      changes,
      conflicts: decisions.sorted(),
      positionsKept: merger.positionsKept.sort(byId),
    },
  };
}
