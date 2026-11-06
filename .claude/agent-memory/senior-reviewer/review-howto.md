# Как проверять в этом репозитории

- Временные тесты — `packages/graph-core/src/review-tmp/*.test.ts`, импорты `../test-helpers`, `../merge` и т. п.
  Запуск: `npx vitest run --project unit packages/graph-core/src/review-tmp/<файл>` из корня. У прошедших
  тестов vitest 5 не показывает `console.log` — добавить `--silent=false`. `-t "<часть имени>"` — один тест.
- Полезные заготовки в test-helpers: `build`, `buildLarge` (пакетами по 1 000, без проверок), `applyOpsOk`,
  `mergeChecked` (замораживает входы, сверяет changes с полным diff и тождественность), `deepFreeze`.
  `cachedDerived(graph)` из draft.ts — запомненное графа (указатели), его тоже можно заморозить.
- Мутации: скопировать файл в scratchpad, править `sed -i`, гонять только нужные тесты, восстанавливать
  копированием, в конце `git diff --stat` должен быть пустым.
- `npm run check` ~10 с; `npm audit` локально падает (exit 1) на 10 moderate в цепочке ESLint — допущено в
  DESIGN.md, CI использует `--audit-level=high`.
- Prettier игнорирует `*.md` и `docs/` (.prettierignore) — отчёт формат не ломает.
- Дата отчёта: `date +%F`. Каталог `docs/reviews/` создан этим агентом 2026-11-07.
- В git лежат `.claude/agents`, `.claude/skills`, `.claude/agent-memory` и `docs/reviews` (с 2026-11-07);
  `.claude/settings.local.json` — нет. Изменения в отчёте и своей памяти — не нарушение чистоты `git status`.
