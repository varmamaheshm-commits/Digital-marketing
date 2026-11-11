import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the same build runs from the desktop app (app://),
// the Android wrapper (https://localhost) and any web host / sub-folder.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
