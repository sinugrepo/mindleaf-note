import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), cloudflare()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      // Disable HMR and file watching via DISABLE_HMR env var (e.g. during agent edits).
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Proxy /api requests to the Hono backend so cookies (HttpOnly)
      // are forwarded automatically — no CORS hassle in dev.
      proxy: {
        '/api': {
          target: process.env.VITE_API_URL ?? 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },
  };
});