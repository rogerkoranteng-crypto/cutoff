import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@engine': path.resolve(import.meta.dirname, '../backend/src/engine.js') } },
  server: { port: 5173, proxy: { '/api': process.env.API_URL || 'http://localhost:8787' }, fs: { allow: ['..'] } },
  build: { chunkSizeWarningLimit: 4000, sourcemap: false },
});
