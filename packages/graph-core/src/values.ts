// Сравнение значений полей графа.

/** Равенство значений из графа: строки, числа, null, списки и простые объекты (сроки, ссылки). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]))
    );
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/** Собственное поле объекта: поле прототипа (constructor, toString…) не считается. */
export function ownField(object: object, key: string): unknown {
  return Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined;
}

/** Округление до сотых — для оценок и их сумм (DESIGN.md, «Сводка блока»). */
export const toHundredths = (value: number): number => Math.round(value * 100) / 100;
