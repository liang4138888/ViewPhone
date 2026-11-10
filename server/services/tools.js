import { commandExists, firstLine, run } from '../utils/command.js';
import { config } from '../config.js';
import { httpJson } from '../utils/http.js';

export async function diagnoseTool(command, args = ['--version'], timeoutMs = 4_000) {
  try {
    const result = await commandExists(command);
    if (result.available) return { ...result, message: '已安装' };
    const fallback = await run(command, args, { timeoutMs });
    return {
      available: true,
      path: command,
      version: firstLine(fallback.stdout),
      message: '已安装',
    };
  } catch (error) {
    return {
      available: false,
      path: command,
      message: error instanceof Error ? error.message : '工具不可用',
    };
  }
}

export async function diagnosticTools() {
  const [adb, hdc, ffmpeg, wda] = await Promise.all([
    diagnoseTool(config.adbPath),
    diagnosticHdc(),
    diagnoseTool(config.ffmpegPath, ['-version']),
    diagnosticWda(),
  ]);
  return { adb, hdc, ffmpeg, wda };
}

export async function diagnosticHdc() {
  try {
    const result = await run(config.hdcPath, ['checkserver'], { timeoutMs: 5_000 });
    const output = `${result.stdout}\n${result.stderr}`;
    const client = output.match(/Client version:\s*([^,\r\n]+)/i)?.[1]?.trim();
    const server = output.match(/server version:\s*([^\r\n]+)/i)?.[1]?.trim();
    if (!client) throw new Error(firstLine(output) || 'HDC 未返回版本信息');
    const mismatch = Boolean(server && server !== client);
    return {
      available: true,
      path: config.hdcPath,
      version: client,
      message: mismatch
        ? `客户端 ${client}，后台 ${server}，请重启 HDC`
        : `HDC ${client} 已连接`,
    };
  } catch (error) {
    return {
      available: false,
      path: config.hdcPath,
      message: error instanceof Error ? error.message : 'HDC 不可用',
    };
  }
}

export async function diagnosticWda() {
  try {
    const result = await httpJson(`${config.wdaUrl}/status`, { timeoutMs: 1_500 });
    const value = result.body?.value ?? {};
    return {
      available: true,
      url: config.wdaUrl,
      message: `WebDriverAgent 已连接${value.ios?.version ? ` · iOS ${value.ios.version}` : ''}`,
      xcode: value.build?.version,
    };
  } catch (error) {
    return {
      available: false,
      url: config.wdaUrl,
      message: error instanceof Error ? error.message : 'WebDriverAgent 不可用',
    };
  }
}

export async function detectXcode() {
  try {
    const result = await run('xcodebuild', ['-version'], { timeoutMs: 2_000 });
    return result.stdout.replace(/\s+/g, ' ').trim();
  } catch {
    return undefined;
  }
}
