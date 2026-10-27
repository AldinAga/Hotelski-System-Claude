import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Pinned before workers start: the property's zone, so "today" in tests is
// computed the way the front desk sees it, not in the runner's UTC.
process.env.TZ = 'Europe/Belgrade';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  test: {
    environment: 'jsdom',
    // Globals let Testing Library register its automatic cleanup between tests.
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
