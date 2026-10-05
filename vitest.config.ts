import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests don't load the single-file build plugins.
// Core logic is pure, so everything runs in the node environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
