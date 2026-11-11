import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { VitePWA } from 'vite-plugin-pwa';

const api = 'http://localhost:3000';
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate', manifest: false, injectRegister: false,
      workbox: {
        // the app shell + every lazy chunk (Mermaid, editor) is precached so the app and diagrams work offline;
        // BlockNote's other UI languages are fetched on demand only
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'], globIgnores: ['**/assets/{ar,de,en,es,fa,fr,he,hr,is,it,ja,ko,nb,nl,pl,pt,ru,sk,tr,uk,uz,vi,zh}-*.js', '**/assets/emoji-data-*.js'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//, /^\/mcp/, /^\/oauth/, /^\/\.well-known/, /^\/auth\//, /^\/healthz/, /^\/invite/],
        cleanupOutdatedCaches: true, clientsClaim: true, skipWaiting: true,
      },
    }),
  ],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: { fs: { allow: ['..'] }, port: 5173, proxy: { '/api': api, '/mcp': api, '/oauth': api, '/.well-known': api, '/healthz': api, '/invite': api } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'tests/**/*.test.mjs'] },
});
