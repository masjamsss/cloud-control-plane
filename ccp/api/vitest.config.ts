import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@app-lib': fileURLToPath(new URL('../app/src/lib', import.meta.url)),
      '@': fileURLToPath(new URL('../app/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    // TEST-5 — code coverage, measured and enforced. Nothing measured it before, so
    // untested paths were invisible: the audit could not say how much of the 1,077-line
    // driftProposals.ts or the request route's contention-retry branches the suite
    // actually executes, only that a lot of tests existed.
    //
    // The floors are the MEASURED numbers rounded down, in the same ratchet spirit as
    // catalogctl.yml's COVERAGE_FLOOR (93.0 against an actual 98.6): a small margin so
    // ordinary churn does not trip the gate, tight enough that real erosion does. Raise
    // them as coverage improves — a floor that is never raised is a floor nobody reads.
    //
    // Measured at the time of writing: statements 96.00, branches 87.85,
    // functions 95.04, lines 96.00.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary'],
      thresholds: { statements: 94, branches: 85, functions: 92, lines: 94 },
    },
  },
});
