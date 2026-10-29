import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const TWENTY_API_URL = process.env.TWENTY_API_URL ?? 'http://localhost:2020';
// Never hardcoded, even the seed key of a local dev instance: a credential in a
// tracked file is one copy-paste away from being a real one. Export it before
// running integration tests — `src/__tests__/global-setup.ts` explains how.
const TWENTY_API_KEY = process.env.TWENTY_API_KEY ?? '';

// Make env vars available to globalSetup (test.env only applies to workers)
process.env.TWENTY_API_URL = TWENTY_API_URL;
process.env.TWENTY_API_KEY = TWENTY_API_KEY;

export default defineConfig({
  plugins: [
    tsconfigPaths({
      projects: ['tsconfig.spec.json'],
      ignoreConfigErrors: true,
    }),
  ],
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    include: ['src/**/*.integration-test.ts'],
    globalSetup: ['src/__tests__/global-setup.ts'],
    env: {
      TWENTY_API_URL,
      TWENTY_API_KEY,
    },
  },
});
