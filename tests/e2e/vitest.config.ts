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
    // One file, but the schema-engine subprocess can take a while to boot.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
