// Трёхстороннее слияние веток (DESIGN.md, «Как устроено слияние»): по записям и полям, а не по
// строкам текста. База — граф на момент ответвления, ветка — что вливаем, целевая — куда.
// Результат строится поверх целевого графа: всё, что слияние не трогает, остаётся теми же
// объектами, а изменения от целевого графа к результату получаются без сравнения всего графа.

import { checkLimits } from './apply';
import { changesOfDraft } from './changes';
import { relockOf, settle, sourceKey } from './consequences';
import type { Relock } from './consequences';
import { GraphDraft, viewOf } from './draft';
import type { GraphError, Result } from './errors';
import type { EdgeId, NodeId, TaskId } from './ids';
import { checkEdge, checkStep } from './invariants';
import {
  dependencyOrder,
  edgeCyclePath,
  edgeOnCycle,
  findCycle,
  hasCycle,
  isForward,
} from './structure';
import type { CyclePath, DependencyOrder } from './structure';
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
  RecordRef & {
    readonly kind: 'deleted';
    readonly deletedIn: MergeSide;
    /** Что пропадёт, если запись удалить: она сама и всё внутри неё на стороне, где она осталась. */
    readonly inside: { readonly nodes: readonly NodeId[]; readonly tasks: readonly TaskId[] };
    /**
     * Задачи, которых не удаляла ни одна сторона, но которые пропадут, если запись удалить: их
     * перенесли внутрь неё, а блока, где они лежат на удалившей стороне, в итоге нет.
     */
    readonly orphans: readonly TaskId[];
  };

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

/**
 * Изменение из ветки — новая или возвращённая стрелка или перенос задачи со стрелками —
 * замкнуло бы цикл и не перенесено: без него задача остаётся там, где в целевой, а стрелки нет.
 * Целевая ветка сама без циклов, поэтому в любом цикле есть хотя бы одно изменение ветки.
 *
 * «Из ветки» — перенести, а цикл разорвать другим изменением ветки на нём: их ключи — в
 * instead (там решение «из целевой»). Тогда конфликт переезжает на то изменение. Если
 * перенести нельзя (на цикле нет других изменений ветки или все выбраны «перенести»), выбор не
 * исполняется и конфликт снова не решён.
 */
export type CycleConflict = Decision &
  (
    | { readonly record: 'edge'; readonly id: EdgeId }
    | { readonly record: 'task'; readonly id: TaskId }
  ) & {
    readonly kind: 'cycle';
    /** Ноды цикла по порядку: от цели стрелки до её начала, дальше по стрелке — снова к цели. */
    readonly cycle: readonly NodeId[];
    /** Ключи конфликтов других изменений ветки на этом цикле: их можно не переносить вместо. */
    readonly instead: readonly string[];
  };

export type MergeConflict = FieldConflict | DeletedConflict | TypeConflict | CycleConflict;

export type MergeOptions = {
  /** Решения конфликтов по ключу. Решение, для которого конфликта нет, не используется. */
  readonly resolutions?: ReadonlyMap<string, MergeSide>;
  /**
   * «Не блокировать» на всё слияние: ноды, которые из-за него перестали бы быть выполненными,
   * получают «засчитано», и предупреждений нет. По умолчанию — блокировать.
   */
  readonly keepDone?: boolean;
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
  /**
   * Что слияние снова заблокирует — для «Последующие задачи (N) снова заблокируются»: считается
   * до последствий и одинаково при любом keepDone.
   */
  readonly relock: Relock;
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

/**
 * Поля, правка которых не меняет авторство (DESIGN.md, «Модель данных графа»): косметические и
 * место задачи. Остальное — содержимое.
 */
const UNSIGNED: ReadonlySet<string> = new Set([...COSMETIC, 'id', 'blockId']);

/** У двух версий записи одинаковое содержимое. */
function sameContent(a: object, b: object): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!UNSIGNED.has(key) && !sameValue(ownField(a, key), ownField(b, key))) return false;
  }
  return true;
}

/**
 * Подпись итога слияния записи: чьё содержимое, того и подпись; вперемешку — той стороны, где
 * запись правили позже, при равном времени — целевой. Итог, совпавший со стороной, — её объект.
 */
function signed<V extends GraphNode | Task>(result: Fields, branch: V, target: V): V {
  const o = branch as Fields;
  const t = target as Fields;
  const author = sameContent(result, t)
    ? t
    : sameContent(result, o) || textOf(o, 'updatedAt') > textOf(t, 'updatedAt')
      ? o
      : t;
  setField(result, 'updatedBy', ownField(author, 'updatedBy'));
  setField(result, 'updatedAt', ownField(author, 'updatedAt'));
  if (sameValue(result, t)) return target;
  if (sameValue(result, o)) return branch;
  return result as V;
}

/** Поля, которые сливаются только вместе: позиция ноды, место задачи, создание. */
const GROUPS: Readonly<Record<'node' | 'task', readonly (readonly string[])[]>> = {
  node: [
    ['x', 'y'],
    ['createdBy', 'createdAt'],
  ],
  task: [
    ['blockId', 'order'],
    ['createdBy', 'createdAt'],
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
    const kinds: readonly MergeConflict['kind'][] = ['deleted', 'type', 'field', 'cycle'];
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
   * Запись, изменённая с обеих сторон (или добавленная с обеих сторон с одним id). Авторство —
   * по итогу (signed); если итог совпадает с одной из сторон — возвращается её объект.
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
    const grouped = new Set<string>(['id', 'updatedBy', 'updatedAt']);
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
    return signed(result, branch, target);
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
    // Стрелки в ноды и от их шапок; стрелки задач — только тех, что внутри удалённого. Задача,
    // которую удалившая сторона вынесла наружу, остаётся и без удалённого.
    const edges = new Set<EdgeId>();
    for (const id of nodes) {
      for (const edgeId of view.edgesInto(id)) edges.add(edgeId);
      for (const edgeId of view.edgesOut(id)) {
        if (view.edge(edgeId)?.source.kind === 'node') edges.add(edgeId);
      }
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
      // Перенесённая сюда задача делает удалённое конфликтом, что бы ни решили о её месте:
      // иначе набор конфликтов зависел бы от решений.
      for (const taskId of view.tasksIn(id)) {
        if (deletedTasks.has(taskId) || isNewTask(taskId)) tasks.add(taskId);
        else if (base.tasks.get(taskId)?.blockId !== id) movedIn.add(taskId);
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

const unitKey = (unit: Unit): string => `deleted:${unit.root.record}:${unit.root.id}`;

/** Удалённое остаётся в результате: возвращается из ветки или не удаляется из целевой. */
function unitKept(unit: Unit, decisions: Decisions): boolean {
  if (!unit.touched) return false;
  const chosen = decisions.chosen(unitKey(unit));
  return unit.deletedIn === 'target' ? chosen === 'branch' : chosen !== 'branch';
}

/** Конфликт удаления: что пропадёт, если удалить, — содержимое и задачи, которым негде остаться. */
function addDeletedConflict(unit: Unit, orphans: readonly TaskId[], decisions: Decisions): void {
  const key = unitKey(unit);
  decisions.add({
    kind: 'deleted',
    key,
    ...unit.root,
    deletedIn: unit.deletedIn,
    chosen: decisions.chosen(key),
    inside: { nodes: [...unit.nodes].sort(byId), tasks: [...unit.tasks].sort(byId) },
    orphans,
  });
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
 * что не вернулось, не встаёт — это решение конфликта удаления. Петля встаёт: её, как и циклы,
 * разбирает resolveCycles. Вставшие запоминаются в put.
 */
function putBranchEdge(draft: GraphDraft, edge: GraphEdge, put: Set<EdgeId>): void {
  const problem = checkEdge(draft, edge);
  if (problem !== null && problem.code !== 'SELF_LOOP') return;
  draft.putEdge(edge);
  put.add(edge.id);
}

// ---- Циклы ----

/**
 * Изменение из ветки, которое может замкнуть цикл: стрелка (новая или возвращённая) или перенос
 * задачи со стрелками. stay — задача на месте из целевой: так она стоит, если перенос не
 * переносится.
 */
type Change =
  | { readonly key: string; readonly edge: GraphEdge }
  | { readonly key: string; readonly moved: Task; readonly stay: Task };

/** Изменения ветки в результате, которые могут замкнуть цикл. */
function changesFromBranch(
  draft: GraphDraft,
  branch: Graph,
  target: Graph,
  branchEdges: ReadonlySet<EdgeId>,
): Change[] {
  const changes: Change[] = [];
  for (const id of branchEdges) {
    const edge = draft.edge(id);
    if (edge) changes.push({ key: `cycle:edge:${id}`, edge });
  }
  for (const id of draft.peekStep().tasks.keys()) {
    const moved = draft.task(id);
    const theirs = target.tasks.get(id);
    if (!moved || !theirs || moved.blockId === theirs.blockId) continue;
    if (moved.blockId !== branch.tasks.get(id)?.blockId) continue;
    if (draft.edgesFromTask(id).size === 0) continue;
    // Перенос, который некуда вернуть (прежний блок удалён), — не кандидат: он остаётся.
    if (draft.node(theirs.blockId)?.type !== 'block') continue;
    const back = { ...moved, blockId: theirs.blockId, order: theirs.order };
    changes.push({ key: `cycle:task:${id}`, moved, stay: sameValue(back, theirs) ? theirs : back });
  }
  return changes;
}

/**
 * Пробует перенести изменение. Если оно замкнёт цикл — не переносит и возвращает этот цикл.
 * order — порядок зависимостей, пока он верен: стрелка «вперёд» по нему проверяется без обхода и
 * порядок не ломает. После стрелки «назад» порядок неверен, и дальше проверяет обход. Обход —
 * по порядку вершин: путь цикла и «вместо» в конфликте одинаковы у сервера и клиента.
 */
function tryCarry(
  draft: GraphDraft,
  change: Change,
  order: { current: DependencyOrder | null },
): CyclePath | null {
  const forward = (edge: GraphEdge) =>
    order.current !== null && isForward(order.current, draft, edge);
  if ('edge' in change) {
    if (!forward(change.edge)) {
      const path = edgeCyclePath(draft, change.edge, true);
      if (path) return path;
      order.current = null;
    }
    draft.putEdge(change.edge);
    return null;
  }
  draft.putTask(change.moved);
  let allForward = true;
  for (const edgeId of [...draft.edgesFromTask(change.moved.id)].sort(byId)) {
    const edge = draft.edge(edgeId);
    if (!edge || forward(edge)) continue;
    allForward = false;
    const path = edgeCyclePath(draft, edge, true);
    if (path) {
      draft.putTask(change.stay);
      return path;
    }
  }
  if (!allForward) order.current = null;
  return null;
}

/** Изменение лежит на цикле: его стрелка или одна из стрелок перенесённой задачи. */
function onCycle(draft: GraphDraft, path: CyclePath, change: Change): boolean {
  if ('edge' in change) return edgeOnCycle(draft, path, change.edge);
  for (const edgeId of draft.edgesFromTask(change.moved.id)) {
    const edge = draft.edge(edgeId);
    if (edge && edgeOnCycle(draft, path, edge)) return true;
  }
  return false;
}

/**
 * Циклы после слияния. Обычно их нет, и ничего не делается. Иначе изменения ветки, которые могут
 * замкнуть цикл, убираются и переносятся заново по одному: сначала выбранные «из ветки», потом
 * нерешённые, потом выбранные «из целевой»; внутри — по ключу (стрелки по id, потом переносы).
 * Изменение, которое замкнуло бы цикл, не переносится — это конфликт цикла. Так по умолчанию не
 * переносится последнее по порядку изменение каждого цикла, а результат всегда без циклов.
 */
function resolveCycles(
  draft: GraphDraft,
  branch: Graph,
  target: Graph,
  branchEdges: ReadonlySet<EdgeId>,
  decisions: Decisions,
): GraphError | null {
  if (!draft.structureChanged || !hasCycle(draft)) return null;
  const changes = changesFromBranch(draft, branch, target, branchEdges);
  for (const change of changes) {
    if ('edge' in change) draft.removeEdge(change.edge.id);
    else draft.putTask(change.stay);
  }
  // Без изменений ветки цикла быть не может: целевая без циклов. Если всё же есть — ошибка.
  if (hasCycle(draft)) return { code: 'CYCLE', path: findCycle(draft) ?? [] };

  const rank = (change: Change) => {
    const chosen = decisions.chosen(change.key);
    return chosen === 'branch' ? 0 : chosen === null ? 1 : 2;
  };
  const queue = [...changes].sort((a, b) => rank(a) - rank(b) || byId(a.key, b.key));
  const order = { current: dependencyOrder(draft) as DependencyOrder | null };
  const carried: Change[] = [];
  for (const change of queue) {
    const path = tryCarry(draft, change, order);
    if (path === null) {
      carried.push(change);
      continue;
    }
    const chosen = decisions.chosen(change.key);
    const ref: { record: 'edge'; id: EdgeId } | { record: 'task'; id: TaskId } =
      'edge' in change
        ? { record: 'edge', id: change.edge.id }
        : { record: 'task', id: change.moved.id };
    decisions.add({
      kind: 'cycle',
      key: change.key,
      ...ref,
      // «Перенести» здесь исполнить нельзя: конфликт снова не решён.
      chosen: chosen === 'target' ? 'target' : null,
      cycle: path.nodes,
      instead: carried.filter((other) => onCycle(draft, path, other)).map((other) => other.key),
    });
  }
  return null;
}

/**
 * Новый блок внутри роадмапы на превратившей её стороне: самый ранний (туда превращение
 * перенесло задачи блока), при равенстве — по id. accept — какие блоки годятся.
 */
function innerBlock(
  base: Graph,
  converter: Graph,
  roadmapId: NodeId,
  accept: (id: NodeId) => boolean = () => true,
): NodeId | undefined {
  let best: GraphNode | undefined;
  for (const childId of viewOf(converter).childrenOf(roadmapId)) {
    const child = converter.nodes.get(childId);
    if (!child || child.type !== 'block' || base.nodes.has(childId) || !accept(childId)) continue;
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
      const converter = node.type === ours.type ? branch : target;
      const inner = innerBlock(base, converter, id, (child) => draft.node(child)?.type === 'block');
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
    // Тип вернулся к одной из сторон — и подпись по итогу: без этого нода, где ничего не
    // поменялось, выглядела бы изменённой.
    if (type !== node.type) draft.putNode(signed({ ...node, type }, ours, theirs));
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

/**
 * Запись, которая с одной стороны milestone, а с другой — блок или роадмапа. Так бывает только
 * при повторном id; слить такие записи нельзя. Первая по id — чтобы ошибка была однозначной.
 */
function mixedKinds(branch: Graph, target: Graph): NodeId | undefined {
  let found: NodeId | undefined;
  for (const [id, ours] of branch.nodes) {
    const theirs = target.nodes.get(id);
    if (theirs === undefined) continue;
    if ((ours.type === 'milestone') === (theirs.type === 'milestone')) continue;
    if (found === undefined || id < found) found = id;
  }
  return found;
}

/**
 * Блок стал роадмапой с обеих сторон — это одно превращение, и внутренний блок остаётся целевой.
 * В ветке её внутренний блок заменяется целевым: задачи переезжают в него, стрелки переводятся
 * на него, а сам блок ветки не переносится. Без замены ветка прошла бы как есть.
 */
function foldInnerBlocks(base: Graph, branch: Graph, target: Graph): Graph {
  const renames = new Map<NodeId, NodeId>();
  for (const [id, was] of base.nodes) {
    if (was.type !== 'block') continue;
    if (branch.nodes.get(id)?.type !== 'roadmap' || target.nodes.get(id)?.type !== 'roadmap') {
      continue;
    }
    const ours = innerBlock(base, branch, id);
    const theirs = innerBlock(base, target, id);
    if (ours !== undefined && theirs !== undefined && ours !== theirs) renames.set(ours, theirs);
  }
  if (renames.size === 0) return branch;

  const view = viewOf(branch);
  const renamed = (id: NodeId) => renames.get(id) ?? id;
  const nodes = new Map(branch.nodes);
  const tasks = new Map(branch.tasks);
  const edges = new Map(branch.edges);
  for (const [from, to] of renames) {
    nodes.delete(from);
    for (const id of view.tasksIn(from)) {
      tasks.set(id, { ...must(branch.tasks.get(id)), blockId: to });
    }
    for (const id of new Set([...view.edgesInto(from), ...view.edgesOut(from)])) {
      const edge = must(branch.edges.get(id));
      const { source } = edge;
      if (source.kind === 'task' && edge.target.nodeId !== from) continue;
      edges.set(id, {
        ...edge,
        source: source.kind === 'node' ? { kind: 'node', nodeId: renamed(source.nodeId) } : source,
        target: { kind: 'node', nodeId: renamed(edge.target.nodeId) },
      });
    }
  }
  return { nodes, tasks, edges };
}

// ---- Слияние графов ----

/**
 * Трёхстороннее слияние: base — граф на момент ответвления, branch — что вливаем, target —
 * текущая версия целевой ветки. Нерешённый конфликт оставляет всё как в целевой ветке; мерж
 * возможен, когда решены все конфликты. Ошибка — если результат нарушил бы инвариант или лимит.
 *
 * Все три графа должны быть корректными и собранными сервером из операций: записи ветки
 * берутся как есть, с номерами, авторством и «засчитано» (DESIGN.md, «Доверие к ветке»).
 */
export function merge(
  base: Graph,
  incoming: Graph,
  target: Graph,
  ctx: ApplyContext,
  options: MergeOptions = {},
): Result<Merged> {
  const clash = mixedKinds(incoming, target);
  if (clash !== undefined) return { ok: false, error: { code: 'DUPLICATE_ID', id: clash } };
  const branch = foldInnerBlocks(base, incoming, target);

  const decisions = new Decisions(options.resolutions ?? new Map());
  const merger = new RecordMerger(decisions, options.keepTargetPositions ?? new Set());
  const nodes = sortRecords(base.nodes, branch.nodes, target.nodes, (was, ours, theirs) =>
    merger.merge('node', was, ours, theirs),
  );
  const tasks = sortRecords(base.tasks, branch.tasks, target.tasks, (was, ours, theirs) =>
    merger.merge('task', was, ours, theirs),
  );
  const units = [
    ...findUnits({
      deletedIn: 'target',
      base,
      kept: branch,
      deleter: target,
      deletedNodes: nodes.deletedInTarget,
      deletedTasks: tasks.deletedInTarget,
    }),
    ...findUnits({
      deletedIn: 'branch',
      base,
      kept: target,
      deleter: branch,
      deletedNodes: nodes.deletedInBranch,
      deletedTasks: tasks.deletedInBranch,
    }),
  ];
  const kept = new Set(units.filter((unit) => unitKept(unit, decisions)));
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
  // Если этого блока в итоге нет, задача уходит вместе с удалённым, и конфликт её называет.
  // Ноды к этому моменту уже на местах, поэтому список одинаков при любом решении.
  const placeOf = (unit: Unit, id: TaskId) =>
    (unit.deletedIn === 'target' ? target : branch).tasks.get(id);
  const orphaned = (unit: Unit, id: TaskId) => {
    const there = placeOf(unit, id);
    return there !== undefined && draft.node(there.blockId)?.type !== 'block';
  };
  for (const unit of units) {
    if (!unit.touched) continue;
    const orphans = [...unit.movedIn].filter((id) => orphaned(unit, id)).sort(byId);
    addDeletedConflict(unit, orphans, decisions);
  }
  for (const unit of units) {
    if (kept.has(unit)) continue;
    for (const id of unit.movedIn) {
      const task = draft.task(id);
      const there = placeOf(unit, id);
      if (!task || !there) continue;
      if (orphaned(unit, id)) {
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
  const branchEdges = new Set<EdgeId>();
  for (const [id, edge] of base.edges) {
    const inBranch = branch.edges.get(id);
    const inTarget = target.edges.has(id);
    if (inBranch === undefined && inTarget) {
      if (!touches(edge, notDeleted)) draft.removeEdge(id);
    } else if (inBranch !== undefined && !inTarget && touches(edge, restored)) {
      putBranchEdge(draft, inBranch, branchEdges);
    }
  }
  for (const [id, edge] of branch.edges) {
    if (!base.edges.has(id) && !target.edges.has(id)) putBranchEdge(draft, edge, branchEdges);
  }

  settleTypes(draft, base, branch, target, decisions);

  const problem =
    resolveCycles(draft, branch, target, branchEdges, decisions) ??
    checkLimits(draft) ??
    checkStep(draft, draft.peekStep());
  if (problem) return { ok: false, error: problem };

  // Последствия — как у пакета операций: слияние — одно действие в целевой ветке.
  const relock = relockOf(draft, ctx.settings);
  settle(draft, ctx, { keepDone: options.keepDone === true, warnOnlyChangedAfter: null });
  const changes = changesOfDraft(draft, ctx.now);
  return {
    ok: true,
    value: {
      graph: draft.finish(),
      changes,
      conflicts: decisions.sorted(),
      positionsKept: merger.positionsKept.sort(byId),
      relock,
    },
  };
}
