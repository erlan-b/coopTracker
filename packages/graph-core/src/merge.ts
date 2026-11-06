// Трёхстороннее слияние веток (DESIGN.md, «Как устроено слияние»): по записям и полям, а не по
// строкам текста. База — граф на момент ответвления, ветка — что вливаем, целевая — куда.
// Результат строится поверх целевого графа: всё, что слияние не трогает, остаётся теми же
// объектами, а изменения от целевого графа к результату получаются без сравнения всего графа.

import { changesOfDraft } from './changes';
import { sourceKey } from './consequences';
import { GraphDraft } from './draft';
import type { Result } from './errors';
import type { NodeId, TaskId } from './ids';
import { checkStep } from './invariants';
import { LIMITS } from './types';
import type { ApplyContext, Changes, Graph, GraphNode, Task, TaskWarning } from './types';
import { ownField, sameValue } from './values';

/** Чья сторона: ветка, которую вливаем, или целевая ветка. */
export type MergeSide = 'branch' | 'target';

type ConflictValues = {
  /**
   * Ключ конфликта: по нему передаётся решение. При пересчёте слияния на новой версии целевой
   * ветки у того же конфликта тот же ключ.
   */
  readonly key: string;
  /** Значение в базе; undefined — записи в базе не было (её добавили с обеих сторон). */
  readonly base: unknown;
  readonly branch: unknown;
  readonly target: unknown;
  /** Решение; null — конфликт не решён, и в результате значение целевой ветки. */
  readonly chosen: MergeSide | null;
};

/**
 * Конфликт поля: оно изменено с обеих сторон по-разному. Для места задачи поле — blockId, а
 * решение переносит блок вместе с порядком.
 */
export type FieldConflict = ConflictValues & { readonly kind: 'field'; readonly field: string } & (
    | { readonly record: 'node'; readonly id: NodeId }
    | { readonly record: 'task'; readonly id: TaskId }
  );

export type MergeConflict = FieldConflict;

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

class RecordMerger {
  readonly conflicts: MergeConflict[] = [];
  readonly positionsKept: NodeId[] = [];

  constructor(
    private readonly resolutions: ReadonlyMap<string, MergeSide>,
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
    const wanted = this.resolutions.get(key);
    const chosen = wanted === 'branch' || wanted === 'target' ? wanted : null;
    const values = {
      key,
      field,
      base: base === undefined ? undefined : ownField(base, field),
      branch: ownField(branch, field),
      target: ownField(target, field),
      chosen,
    };
    this.conflicts.push(
      record === 'node'
        ? { kind: 'field', record, id: id as NodeId, ...values }
        : { kind: 'field', record, id: id as TaskId, ...values },
    );
    return chosen ?? 'target';
  }
}

// ---- Слияние графов ----

type Writer<K extends string, V> = {
  readonly put: (value: V) => void;
  readonly remove: (id: K) => void;
};

/**
 * Записи одного вида. Смотрим только то, что изменила ветка: остальное в целевом графе уже как
 * надо. Изменённое только веткой берётся из ветки, изменённое с обеих сторон — сливается.
 */
function mergeRecords<K extends string, V extends { readonly id: K }>(
  base: ReadonlyMap<K, V>,
  branch: ReadonlyMap<K, V>,
  target: ReadonlyMap<K, V>,
  writer: Writer<K, V>,
  mergeBoth: (base: V | undefined, branch: V, target: V) => V,
): void {
  const same = (a: V | undefined, b: V | undefined) =>
    a === b || (a !== undefined && b !== undefined && sameValue(a, b));
  for (const [id, ours] of branch) {
    const was = base.get(id);
    if (same(was, ours)) continue;
    const theirs = target.get(id);
    if (theirs === undefined) {
      // Удалённое в целевой ветке и изменённое в ветке — подшаг 2b; пока остаётся удалённым.
      if (was === undefined) writer.put(ours);
      continue;
    }
    if (theirs === ours) continue;
    const merged = was !== undefined && same(was, theirs) ? ours : mergeBoth(was, ours, theirs);
    if (merged !== theirs) writer.put(merged);
  }
  for (const [id, was] of base) {
    if (branch.has(id)) continue;
    // Удалённое в ветке и изменённое в целевой — подшаг 2b; пока остаётся как в целевой.
    if (same(was, target.get(id))) writer.remove(id);
  }
}

/**
 * Трёхстороннее слияние: base — граф на момент ответвления, branch — что вливаем, target —
 * текущая версия целевой ветки. Нерешённый конфликт оставляет значение целевой ветки; мерж
 * возможен, когда решены все конфликты. Ошибка — если результат нарушил бы инвариант.
 */
export function merge(
  base: Graph,
  branch: Graph,
  target: Graph,
  ctx: ApplyContext,
  options: MergeOptions = {},
): Result<Merged> {
  const draft = new GraphDraft(target);
  const merger = new RecordMerger(
    options.resolutions ?? new Map(),
    options.keepTargetPositions ?? new Set(),
  );
  mergeRecords(
    base.nodes,
    branch.nodes,
    target.nodes,
    { put: (node) => draft.putNode(node), remove: (id) => draft.removeNode(id) },
    (was, ours, theirs) => merger.merge('node', was, ours, theirs),
  );
  mergeRecords(
    base.tasks,
    branch.tasks,
    target.tasks,
    { put: (task) => draft.putTask(task), remove: (id) => draft.removeTask(id) },
    (was, ours, theirs) => merger.merge('task', was, ours, theirs),
  );
  // Стрелки не меняются, только появляются и удаляются: с обеих сторон одна и та же стрелка.
  mergeRecords(
    base.edges,
    branch.edges,
    target.edges,
    { put: (edge) => draft.putEdge(edge), remove: (id) => draft.removeEdge(id) },
    (_was, _ours, theirs) => theirs,
  );

  const problem = checkStep(draft, draft.peekStep());
  if (problem) return { ok: false, error: problem };

  const conflicts = merger.conflicts.sort(
    (a, b) => byId(a.record, b.record) || byId(a.id, b.id) || byId(a.field, b.field),
  );
  const changes = changesOfDraft(draft, ctx.now);
  return {
    ok: true,
    value: {
      graph: draft.finish(),
      changes,
      conflicts,
      positionsKept: merger.positionsKept.sort(byId),
    },
  };
}
