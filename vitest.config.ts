import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Release scripts use Node's test runner and are executed explicitly in CI.
    exclude: [...configDefaults.exclude, 'scripts/*.test.mjs'],
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
