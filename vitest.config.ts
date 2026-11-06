import { defineConfig } from 'vitest/config';

// Два набора: обычные тесты и замеры скорости (*.perf.test.ts). Замеры идут отдельным запуском,
// без других тестов рядом: на нагруженной машине они бы мигали.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.perf.test.ts'],
        },
      },
      {
        test: {
          name: 'perf',
          include: ['packages/*/src/**/*.perf.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
