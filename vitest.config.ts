import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
