import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const moduleId = id.replaceAll('\\\\', '/');
            if (!moduleId.includes('/node_modules/')) return undefined;
            if (
              moduleId.includes('/react/') ||
              moduleId.includes('/react-dom/') ||
              moduleId.includes('/scheduler/')
            ) {
              return 'react-vendor';
            }
            if (moduleId.includes('/@tiptap/') || moduleId.includes('/prosemirror-')) {
              return 'editor-vendor';
            }
            if (moduleId.includes('/dexie')) {
              return 'storage-vendor';
            }
            if (moduleId.includes('/fuse.js/')) {
              return 'search-vendor';
            }
            return undefined;
          },
        },
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