import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zc, gzip } from 'node:zlib';
import { VitePWA } from 'vite-plugin-pwa';

const api = 'http://localhost:3000';

/** Chunks that only Mermaid reaches (the core and every diagram engine: elk, cytoscape, katex …). They stay out of the
 *  precache, so installing the app does not wait for them; the page fetches them in the background once it is idle
 *  (src/warmup.ts reads the list written here, warmup.json) and the service worker keeps them (see runtimeCaching).
 *  Found from the chunk graph, not from file names:
 *  everything reachable from the entry without entering Mermaid's dynamic import is precached; a chunk Mermaid shares
 *  with the editor is reachable that way and stays in. */
const onDemand = new Set<string>();
const WARMUP_LIST = 'warmup.json';
const MERMAID = /[\\/]node_modules[\\/]mermaid[\\/]/;
function mermaidOnDemand(): Plugin {
  return {
    name: 'specs:mermaid-on-demand',
    apply: 'build',
    generateBundle(_, bundle) {
      onDemand.clear();
      const chunks = Object.values(bundle).flatMap((c) => (c.type === 'chunk' ? [c] : []));
      const byName = new Map(chunks.map((c) => [c.fileName, c]));
      const seen = new Set<string>(),
        todo = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
      while (todo.length) {
        const c = byName.get(todo.pop()!);
        if (!c || seen.has(c.fileName)) continue;
        seen.add(c.fileName);
        todo.push(...c.imports, ...c.dynamicImports.filter((f) => !MERMAID.test(byName.get(f)?.facadeModuleId ?? '')));
      }
      const css = (c: (typeof chunks)[number]) => [...(c.viteMetadata?.importedCss ?? [])];
      const keptCss = new Set(chunks.filter((c) => seen.has(c.fileName)).flatMap(css));
      for (const c of chunks)
        if (!seen.has(c.fileName)) {
          onDemand.add(c.fileName);
          css(c)
            .filter((f) => !keptCss.has(f))
            .forEach((f) => onDemand.add(f));
        }
      this.emitFile({ type: 'asset', fileName: WARMUP_LIST, source: JSON.stringify([...onDemand].sort().map((f) => `/${f}`)) });
    },
  };
}

/** Writes .br and .gz next to every compressible file in dist (after the service worker is generated, so sw.js gets them too);
 *  server/index.js serves them instead of compressing on every request. Only where it pays: ≥ 1 KiB and actually smaller. */
function precompress(): Plugin {
  let outDir = 'dist';
  const br = promisify(brotliCompress),
    gz = promisify(gzip);
  return {
    name: 'specs:precompress',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        const files = (await readdir(outDir, { recursive: true }))
          .filter((f) => /\.(js|mjs|css|html|svg|json|webmanifest|txt|xml|map)$/.test(f))
          .map((f) => join(outDir, f));
        await Promise.all(
          files.map(async (f) => {
            const data = await readFile(f);
            if (data.length < 1024) return;
            const [b, g] = await Promise.all([
              br(data, {
                params: {
                  [zc.BROTLI_PARAM_QUALITY]: 11,
                  [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT,
                  [zc.BROTLI_PARAM_SIZE_HINT]: data.length,
                },
              }),
              gz(data, { level: 9 }),
            ]);
            if (b.length < data.length) await writeFile(`${f}.br`, b);
            if (g.length < data.length) await writeFile(`${f}.gz`, g);
          }),
        );
      },
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    mermaidOnDemand(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      injectRegister: false,
      workbox: {
        // Precache = what it takes to open, edit and sync specs offline: the app shell, every page (lazy route chunks
        // included), the editor (BlockNote) and the form editor. Installing the app waits for exactly that. Mermaid with its
        // diagram engines is most of the build (~5 MB of 7), so it is not part of the install: the page loads it in the
        // background right after start (src/warmup.ts) and the runtime cache below keeps it. Offline-first is kept – every
        // kind of diagram renders offline once that download has finished – without making the first visit wait for it.
        // BlockNote's other UI languages and the emoji data are fetched (and then cached) on demand as well.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        globIgnores: [
          '**/*.{br,gz}',
          '**/assets/{ar,de,en,es,fa,fr,he,hr,is,it,ja,ko,nb,nl,pl,pt,ru,sk,tr,uk,uz,vi,zh}-*.js',
          '**/assets/emoji-data-*.js',
        ],
        manifestTransforms: [async (entries) => ({ manifest: entries.filter((e) => !onDemand.has(e.url)), warnings: [] })],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: '/index.html',
        // /authorize, /token, /register and /revoke: the MCP OAuth endpoints (mcpAuthRouter mounts them at the root).
        // Workbox tests these against pathname + search, so a rule ending a path must also accept "?".
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/mcp/,
          /^\/(authorize|token|register|revoke)([/?]|$)/,
          /^\/oauth/,
          /^\/\.well-known/,
          /^\/auth\//,
          /^\/healthz/,
          /^\/invite/,
        ],
        // /assets/ names carry a content hash, so a cached copy is never stale: cache first. Precached files never get here.
        // Chunks of older builds stay until evicted (least recently used first), so a page still running an old build keeps its diagrams.
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'assets-on-demand',
              expiration: { maxEntries: 250, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
    precompress(),
  ],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
  server: {
    fs: { allow: ['..'] },
    port: 5173,
    proxy: { '/api': api, '/mcp': api, '/oauth': api, '/.well-known': api, '/healthz': api, '/invite': api },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'tests/**/*.test.mjs'] },
});
