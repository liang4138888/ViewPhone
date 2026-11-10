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
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
await vite.listen();
vite.printUrls();
