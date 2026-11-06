// Линтер: ошибки, которые не ловит компилятор (забытые await, лишние условия, небезопасные any).
// Форматирование — дело Prettier, здесь правил стиля нет.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/', '**/dist/', 'coverage/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Из строгого набора — то, что ловит реальные ошибки, а не вкус.
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: 'error',
      'no-console': 'error',
    },
  },
  {
    // graph-core — чистые функции (CLAUDE.md): время, случайность, сеть и диск приходят
    // параметрами. Тесты сюда не входят: им можно мерить время.
    files: ['packages/graph-core/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/test-helpers.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^node:', message: 'graph-core без I/O: передайте данные параметром.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Время передаётся параметром (ctx.now).' },
        { object: 'Math', property: 'random', message: 'Случайность передаётся параметром.' },
        {
          object: 'crypto',
          property: 'randomUUID',
          message: 'id создаёт клиент и передаёт в операции.',
        },
        { object: 'performance', property: 'now', message: 'Время передаётся параметром.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Текущее время передаётся параметром (ctx.now).',
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'fetch',
          'setTimeout',
          'setInterval',
          'window',
          'document',
          'localStorage',
          'indexedDB',
          'process',
        ].map((name) => ({
          name,
          message: 'graph-core без I/O и без окружения: передайте параметром.',
        })),
      ],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
