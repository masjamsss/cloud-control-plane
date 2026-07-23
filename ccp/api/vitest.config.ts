import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@app-lib': fileURLToPath(new URL('../app/src/lib', import.meta.url)),
      '@': fileURLToPath(new URL('../app/src', import.meta.url)),
    },
  },
  test: { environment: 'node', setupFiles: ['./test/setup.ts'] },
});
