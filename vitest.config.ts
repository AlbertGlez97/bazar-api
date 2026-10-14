import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { configureTestDatabase } from './scripts/test-environment.js';

configureTestDatabase();

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // lcov is the report SonarQube reads (see sonar-project.properties).
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      exclude: ['src/generated/**', '**/*.spec.ts'],
    },
  },
});
