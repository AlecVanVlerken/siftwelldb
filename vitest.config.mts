import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{spec,test}.mts', 'examples/**/*.test.mts', 'benchmarks/**/*.spec.mts'],
    fileParallelism: false,
    coverage: {
      include: ['src/**/*.mts', 'src/webclient/frontend/ts/**/*.ts'],
      exclude: ['**/*.{spec,test}.*', 'src/webclient/fixtures/**'],
    },
  },
});
