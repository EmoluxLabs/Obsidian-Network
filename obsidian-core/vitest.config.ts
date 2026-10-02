import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Consensus code is deterministic; running suites in parallel is safe.
    pool: 'threads',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
