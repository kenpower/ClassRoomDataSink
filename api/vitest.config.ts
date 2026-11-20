import { defineConfig } from 'vitest/config';

// Two projects: `unit` needs nothing; `db` (integration + abuse) starts MySQL via Testcontainers once.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 180_000,
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'db',
          include: ['test/integration/**/*.test.ts', 'test/abuse/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
