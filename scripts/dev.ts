import { createServer } from 'vite';

const apiPort = Number(process.env.VIEWPHONE_API_PORT || 3124);
const clientPort = Number(process.env.PORT || 3123);
process.env.PORT = String(apiPort);

await import('../server/index.js');

const vite = await createServer({
  server: {
    host: '127.0.0.1',
    port: clientPort,
    proxy: {
      // Keep the browser's Host header: share links are built from the
      // request host, and rewriting it to the API port produced URLs that
      // 404 in dev (the API server has no /share route).
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
});
await vite.listen();
vite.printUrls();
