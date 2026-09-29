import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname);

/**
 * The browser bundles resolve their crypto libraries (`@noble/*`, `@scure/*`)
 * from the core package's dependencies — `scripts/build-web.mjs` passes
 * obsidian-core/node_modules as an esbuild `nodePaths` entry. The page tests
 * import the same modules Vite, so they need the same resolution or they fail
 * on an import the real bundle never has trouble with.
 */
const browserLibs = ['@noble', '@scure'];

export default defineConfig({
  resolve: {
    alias: browserLibs.map((scope) => ({
      find: new RegExp(`^${scope.replace('/', '\\/')}/`),
      replacement: resolve(root, '..', 'obsidian-core', 'node_modules', scope) + '/',
    })),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
