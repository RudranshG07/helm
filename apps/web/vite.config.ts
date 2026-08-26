import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { dashboard: resolve(import.meta.dirname, 'dashboard.html') },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
