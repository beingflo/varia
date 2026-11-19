import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { VitePWA } from 'vite-plugin-pwa';

// Required for SharedArrayBuffer, which the sqlite `opfs` VFS needs. CORP is not optional:
// WebKit refuses to start the worker the OPFS VFS spawns without it (Chrome is laxer).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// Local HTTPS for testing on a phone: point these at a mkcert-issued cert.
const https =
  process.env.VARIA_HTTPS_CERT && process.env.VARIA_HTTPS_KEY
    ? { cert: readFileSync(process.env.VARIA_HTTPS_CERT), key: readFileSync(process.env.VARIA_HTTPS_KEY) }
    : undefined;

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      // Stale precached bundles are the one way an old client keeps running an old bug.
      registerType: 'autoUpdate',
      workbox: { cleanupOutdatedCaches: true },
      manifest: { name: 'varia', start_url: '/', display: 'standalone', background_color: '#111', theme_color: '#111' },
    }),
  ],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: { headers: isolation, https, host: Boolean(https) },
  preview: { headers: isolation, https, host: Boolean(https) },
});
