import { spawn } from 'node:child_process';

export class CommandError extends Error {
  constructor(message, { code, stderr, stdout, command } = {}) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.stderr = stderr;
    this.stdout = stdout;
    this.command = command;
  }
}

export function run(command, args = [], options = {}) {
  const { timeoutMs = 20_000, stdin, env, encoding = 'utf8' } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let finished = false;

    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    // An early child exit can make stdin.close produce an unhandled EPIPE.
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      finish(
        new CommandError(
          error.code === 'ENOENT'
            ? `找不到命令 ${command}，请安装工具或配置绝对路径`
            : `无法执行 ${command}：${error.message}`,
          { code: error.code, command },
        ),
      );
    });
    child.once('close', (code, signal) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const result = {
        stdout: encoding === 'buffer' ? stdoutBuffer : stdoutBuffer.toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal,
      };
      if (code === 0) finish(null, result);
      else {
        const text = result.stderr.trim() || (Buffer.isBuffer(result.stdout) ? '' : result.stdout.trim());
        finish(
          new CommandError(text || `${command} 执行失败（退出码 ${code}）`, {
            code,
            stderr: result.stderr,
            stdout: Buffer.isBuffer(result.stdout) ? undefined : result.stdout,
            command,
          }),
        );
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new CommandError(`${command} 在 ${Math.round(timeoutMs / 1000)} 秒后超时`, {
          code: 'TIMEOUT',
          command,
        }),
      );
    }, timeoutMs);

    if (finished) return;
    if (stdin instanceof Uint8Array || Buffer.isBuffer(stdin)) child.stdin.end(stdin);
    else child.stdin.end(stdin ?? '');
  });
}

export async function commandExists(command) {
  try {
    const result = await run(command, ['--version'], { timeoutMs: 3_000 });
    return { available: true, path: command, version: result.stdout.trim().split('\n')[0] };
  } catch {
    return { available: false, path: command, version: undefined };
  }
}

export function firstLine(text) {
  return text.trim().split(/\r?\n/)[0] ?? '';
}

export class SerialQueue {
  #tail = Promise.resolve();

  run(task) {
    const result = this.#tail.then(task, task);
    this.#tail = result.catch(() => {});
    return result;
  }
}
