import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Integration test files share the tremurex_test database; parallel
    // workers would truncate each other's fixtures.
    fileParallelism: false,
  },
});
