import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiRouter } from './routes/api.js';
import { config } from './config.js';
import { CommandError } from './utils/command.js';
import { HttpError } from './utils/http.js';
import { stopAllNativeTouch } from './services/nativeTouch.js';
import { closeArchiveStore } from './services/archiveStore.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use('/api', createApiRouter());

if (process.env.NODE_ENV === 'production') {
  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'index.html'))) {
    console.warn('未找到 dist/index.html，请先运行 npm run build');
  } else {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.use((request, response, next) => {
      if (request.method !== 'GET' || request.path.startsWith('/api/')) return next();
      response.sendFile(join(dist, 'index.html'));
    });
  }
}

app.use((error, _request, response, _next) => {
  const status =
    error.statusCode || error.status || (error instanceof HttpError ? error.status : 500);
  const message =
    error instanceof CommandError
      ? error.message
      : error instanceof Error
        ? error.message
        : '服务器发生未知错误';
  if (status >= 500) console.error(error);
  response.status(status).json({
    error: message,
    code: error.code || 'INTERNAL_ERROR',
    ...(process.env.NODE_ENV !== 'production' && error.stack
      ? { details: error.stack.split('\n').slice(0, 4).join('\n') }
      : {}),
  });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`ViewPhone 已启动：http://${config.host}:${config.port}`);
});

function shutdown() {
  stopAllNativeTouch();
  void closeArchiveStore().finally(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
