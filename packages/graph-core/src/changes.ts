// Что изменило действие: каждая затронутая запись «до» и «после» (DESIGN.md, «Undo»).
// Списки упорядочены по id: одно и то же изменение у сервера и клиента записывается одинаково,
// и сервер может сравнить отмену со своим логом.

import type { GraphDraft } from './draft';
import type { Changes, Graph, RecordChange } from './types';
import { sameValue } from './values';

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Изменения по списку затронутых id: запись до (undefined — не было) и после. */
function collect<K extends string, V>(
  touched: Iterable<readonly [K, V | undefined]>,
  after: ReadonlyMap<K, V>,
): RecordChange<V>[] {
  const result: [K, RecordChange<V>][] = [];
  for (const [id, was] of touched) {
    const now = after.get(id);
    if (was === now || (was !== undefined && now !== undefined && sameValue(was, now))) continue;
    result.push([id, { before: was ?? null, after: now ?? null }]);
  }
  return result.sort(([a], [b]) => byId(a, b)).map(([, change]) => change);
}

/** Изменения рабочей копии с начала её работы: за O(изменённого), а не всего графа. */
export function changesOfDraft(draft: GraphDraft, at: string): Changes {
  const touched = draft.touched();
  return {
    at,
    nodes: collect(touched.nodes, draft.nodes),
    tasks: collect(touched.tasks, draft.tasks),
    edges: collect(touched.edges, draft.edges),
  };
}

function diffRecords<K extends string, V>(
  before: ReadonlyMap<K, V>,
  after: ReadonlyMap<K, V>,
): RecordChange<V>[] {
  if (before === after) return [];
  const touched: [K, V | undefined][] = [...before];
  for (const id of after.keys()) if (!before.has(id)) touched.push([id, undefined]);
  return collect(touched, after);
}

/**
 * Изменения от графа «до» к графу «после» — для любых двух графов. Результат операции уже
 * содержит свои изменения (Applied.changes); эта функция — для остального. Неизменённые записи —
 * те же объекты, поэтому сравнение по ссылке отсекает их сразу.
 */
export function changesBetween(before: Graph, after: Graph, at: string): Changes {
  return {
    at,
    nodes: diffRecords(before.nodes, after.nodes),
    tasks: diffRecords(before.tasks, after.tasks),
    edges: diffRecords(before.edges, after.edges),
  };
}

function idOf<V extends { readonly id: string }>(change: RecordChange<V>): string | undefined {
  return (change.before ?? change.after)?.id;
}

function combineRecords<V extends { readonly id: string }>(
  first: readonly RecordChange<V>[],
  second: readonly RecordChange<V>[],
): RecordChange<V>[] {
  const byRecord = new Map<string, { before: V | null; after: V | null }>();
  for (const change of first) {
    const id = idOf(change);
    if (id !== undefined) byRecord.set(id, { before: change.before, after: change.after });
  }
  for (const change of second) {
    const id = idOf(change);
    if (id === undefined) continue;
    const known = byRecord.get(id);
    if (known) known.after = change.after;
    else byRecord.set(id, { before: change.before, after: change.after });
  }
  return [...byRecord]
    .filter(([, { before, after }]) => !sameValue(before, after))
    .sort(([a], [b]) => byId(a, b))
    .map(([, change]) => change);
}

/**
 * Два изменения подряд как одно: действие пользователя из нескольких операций — один шаг отмены.
 * Время — первого изменения.
 */
export function combineChanges(first: Changes, second: Changes): Changes {
  return {
    at: first.at,
    nodes: combineRecords(first.nodes, second.nodes),
    tasks: combineRecords(first.tasks, second.tasks),
    edges: combineRecords(first.edges, second.edges),
  };
}

export function isEmptyChanges(changes: Changes): boolean {
  return changes.nodes.length === 0 && changes.tasks.length === 0 && changes.edges.length === 0;
}
