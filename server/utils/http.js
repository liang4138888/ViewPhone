import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export class HttpError extends Error {
  constructor(message, { status = 502, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export function httpJson(url, { method = 'GET', body, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(
      target,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 500;
          let parsed;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = text;
          }
          if (status >= 200 && status < 300) resolve({ status, body: parsed, text });
          else reject(new HttpError(`WebDriverAgent 返回 HTTP ${status}`, { status, body: parsed }));
        });
      },
    );
    request.once('error', (error) =>
      reject(new HttpError(`无法连接 WebDriverAgent：${error.message}`)),
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('连接 WebDriverAgent 超时'));
    });
    if (payload) request.write(payload);
    request.end();
  });
}
