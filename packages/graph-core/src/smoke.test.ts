// Временный тест: проверяет, что Vitest находит и запускает тесты пакета. Удаляется в подшаге 1b.
import { expect, it } from 'vitest';
import * as core from './index';

it('модуль graph-core загружается', () => {
  expect(core).toBeDefined();
});
