import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const api = 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: { fs: { allow: ['..'] }, port: 5173, proxy: { '/api': api, '/mcp': api, '/oauth': api, '/.well-known': api, '/healthz': api, '/invite': api } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
