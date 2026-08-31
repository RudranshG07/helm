import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  publicDir: resolve(import.meta.dirname, 'landing'),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dashboard: resolve(import.meta.dirname, 'dashboard.html'),
        onboard: resolve(import.meta.dirname, 'onboard.html'),
        authorize: resolve(import.meta.dirname, 'authorize.html'),
        proof: resolve(import.meta.dirname, 'proof.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
