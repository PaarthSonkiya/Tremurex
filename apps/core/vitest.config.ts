import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package from source so tests need no prebuild.
      // Production still uses the package's `default` export (dist/index.js).
      '@tremurex/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Integration test files share the tremurex_test database; parallel
    // workers would truncate each other's fixtures.
    fileParallelism: false,
  },
});
