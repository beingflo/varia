import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";

// Required for SharedArrayBuffer, which the sqlite `opfs` VFS needs. CORP is not optional:
// WebKit refuses to start the worker the OPFS VFS spawns without it (Chrome is laxer).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// Local HTTPS for testing on a phone: point these at a mkcert-issued cert.
const https =
  process.env.VARIA_HTTPS_CERT && process.env.VARIA_HTTPS_KEY
    ? {
        cert: readFileSync(process.env.VARIA_HTTPS_CERT),
        key: readFileSync(process.env.VARIA_HTTPS_KEY),
      }
    : undefined;

// The dev and preview servers only have the shell; `/api` lives in the Rust service. Without this
// proxy, signup answers 404 and the sync panel shows "signup failed: 404".
const api = {
  "/api": {
    target: process.env.VARIA_API ?? "http://127.0.0.1:8099",
    changeOrigin: false,
  },
};

const host = Boolean(https) || process.env.VARIA_BIND_ALL === "1";

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      // Stale precached bundles are the one way an old client keeps running an old bug.
      registerType: "autoUpdate",
      workbox: { cleanupOutdatedCaches: true },
      manifest: {
        name: "varia",
        start_url: "/app",
        display: "standalone",
        background_color: "#111",
        theme_color: "#111",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: { headers: isolation, https, host, proxy: api },
  preview: { headers: isolation, https, host, proxy: api },
});
