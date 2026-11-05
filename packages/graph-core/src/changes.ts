// Что изменило действие: каждая затронутая запись «до» и «после» (DESIGN.md, «Undo»).

import { getOwn, valuesOf } from './records';
import type { Changes, Graph, RecordChange } from './types';
import { sameValue } from './values';

function diffRecords<K extends string, V extends { readonly id: K }>(
  before: Readonly<Record<K, V>>,
  after: Readonly<Record<K, V>>,
): RecordChange<V>[] {
  if (before === after) return [];
  const result: RecordChange<V>[] = [];
  for (const old of valuesOf(before)) {
    const now = getOwn(after, old.id);
    if (now === undefined) result.push({ before: old, after: null });
    else if (now !== old && !sameValue(now, old)) result.push({ before: old, after: now });
  }
  for (const now of valuesOf(after)) {
    if (!Object.hasOwn(before, now.id)) result.push({ before: null, after: now });
  }
  return result;
}

/**
 * Изменения от графа «до» к графу «после». Неизменённые записи — те же объекты (graph-core их не
 * пересоздаёт), поэтому сравнение по ссылке отсекает их сразу.
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
  const byId = new Map<string, { before: V | null; after: V | null }>();
  for (const change of first) {
    const id = idOf(change);
    if (id !== undefined) byId.set(id, { before: change.before, after: change.after });
  }
  for (const change of second) {
    const id = idOf(change);
    if (id === undefined) continue;
    const known = byId.get(id);
    if (known) known.after = change.after;
    else byId.set(id, { before: change.before, after: change.after });
  }
  return [...byId.values()].filter(({ before, after }) => !sameValue(before, after));
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
