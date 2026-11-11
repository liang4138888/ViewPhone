import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 3123,
    watch: {
      // Archive JSON and step screenshots are written under .artifacts while a
      // test or page comparison runs. Watching them made the dev server reload
      // the whole workbench mid-run (losing the running UI state), so only the
      // source tree is watched.
      ignored: ['**/.artifacts/**', '**/dist/**', '**/tmp/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
