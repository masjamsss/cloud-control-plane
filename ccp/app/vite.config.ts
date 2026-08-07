/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 0025 RX-6: React Compiler pilot, ANNOTATION MODE ONLY.
// `compilationMode: 'annotation'` means the compiler touches ONLY functions
// that carry a `"use memo"` directive as their first statement — every other
// component/hook in the app passes through babel unchanged (JSX/TS stripped,
// nothing else). This is deliberately NOT repo-wide auto-compilation; broad
// enablement (`infer`/`all` mode) is a separate, later, owner-gated decision
// (0025 §3.2, §4 RX-6/RX-8). `target: '19'` pins the compiler to the app's
// actual React version so it emits the React-19 built-in memo-cache calls
// instead of requiring the `react-compiler-runtime` package — i.e. this pilot
// adds zero runtime dependencies and the frozen 9-entry allowlist
// (src/test/standalone.test.ts) is untouched; babel-plugin-react-compiler is
// a build-time devDependency only.
const REACT_COMPILER_CONFIG = {
  compilationMode: 'annotation' as const,
  target: '19' as const,
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler', REACT_COMPILER_CONFIG]],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    // Installs a working localStorage polyfill when the runtime's own one is
    // absent or non-functional (see src/test/setup.ts) — every store already
    // treats localStorage as fallible, but a few tests (project-scope legacy
    // migration) need REAL get/set/remove/clear round-trips to mean anything.
    setupFiles: ['./src/test/setup.ts'],
    // TEST-5 — code coverage, measured and enforced. See ccp/api/vitest.config.ts for the
    // rationale; the floors here are much lower and that is the honest reading, not a
    // lenient one: the SPA has no DOM/interaction testing (TEST-7), so ~25 files pin UI by
    // inspecting source strings rather than by rendering. Functions at 54.6% is what that
    // costs, and writing it down is the first step to moving it.
    //
    // Measured at the time of writing: statements 73.90, branches 83.11,
    // functions 54.62, lines 73.90.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary'],
      thresholds: { statements: 71, branches: 80, functions: 52, lines: 71 },
    },
  },
});
