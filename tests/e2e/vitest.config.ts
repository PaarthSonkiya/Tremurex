import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // One file, but the schema-engine subprocess can take a while to boot.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
