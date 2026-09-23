import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { configureTestDatabase } from './scripts/test-environment.js';

configureTestDatabase();
// Test-only signing key; production startup has no secret fallback.
process.env.JWT_SECRET = 'be03-test-only-signing-key-not-for-production';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.e2e-spec.ts', 'test/**/*.e2e-spec.ts'],
  },
});
