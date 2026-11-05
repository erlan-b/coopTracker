// Записи графа (ноды, задачи, стрелки по id) без мутаций.
//
// Id приходят от клиентов, поэтому читаем только собственные поля объекта — иначе id
// «constructor» нашёл бы Object.prototype, — а пишем через defineProperty: обычное
// присваивание с id «__proto__» подменило бы прототип.

export function getOwn<K extends string, V>(record: Readonly<Record<K, V>>, key: K): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function valuesOf<K extends string, V>(record: Readonly<Record<K, V>>): V[] {
  return Object.values(record) as V[];
}

/** Новая запись с добавленными или заменёнными значениями (ключ — их id). */
export function putAll<K extends string, V extends { readonly id: K }>(
  record: Readonly<Record<K, V>>,
  values: readonly V[],
): Readonly<Record<K, V>> {
  if (values.length === 0) return record;
  const result = { ...record } as Record<K, V>;
  for (const value of values) {
    Object.defineProperty(result, value.id, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/** Новая запись без этих ключей. Если удалять нечего — та же запись. */
export function removeAll<K extends string, V>(
  record: Readonly<Record<K, V>>,
  keys: ReadonlySet<K>,
): Readonly<Record<K, V>> {
  if (![...keys].some((key) => Object.hasOwn(record, key))) return record;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.has(key as K)),
  ) as Record<K, V>;
}
