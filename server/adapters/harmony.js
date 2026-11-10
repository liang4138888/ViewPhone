import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../utils/command.js';
import { imageDimensions } from '../utils/image.js';
import { parseHarmonyLayout } from '../services/uiLayout.js';
import { DeviceAdapter } from './base.js';

const keyEvents = {
  back: 'Back',
  home: 'Home',
  recents: '10011',
  power: 'Power',
  volumeUp: '16',
  volumeDown: '17',
};

export class HarmonyAdapter extends DeviceAdapter {
  constructor(device) {
    super(device);
    this.hdc = device.hdc;
  }

  async shell(command, timeoutMs = 12_000) {
    const result = await run(this.hdc, ['-t', this.device.nativeId, 'shell', command], {
      timeoutMs,
    });
    return assertHarmonyCommand(result);
  }

  async captureScreenshot() {
    const directory = await mkdtemp(join(tmpdir(), 'viewphone-harmony-'));
    const remote = `/data/local/tmp/viewphone-${process.pid}-${Date.now()}.jpeg`;
    const local = join(directory, 'screen.jpeg');
    try {
      await this.shell(`snapshot_display -f ${remote}`, 10_000);
      await run(this.hdc, ['-t', this.device.nativeId, 'file', 'recv', remote, local], {
        timeoutMs: 12_000,
      });
      const buffer = await readFile(local);
      const size = imageDimensions(buffer);
      if (!size) throw new Error('HarmonyOS 截图格式无法识别');
      return { buffer, ...size };
    } finally {
      await this.shell(`rm -f ${remote}`, 4_000).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }

  async performUnlocked(action) {
    if (action.type === 'tap') {
      await this.uiInput('click', action.x, action.y);
    } else if (action.type === 'longPress') {
      await this.uiInput('longClick', action.x, action.y);
    } else if (action.type === 'swipe') {
      const speed = Math.max(
        200,
        Math.min(40_000, Math.round(1000 * (1000 / Math.max(100, action.duration ?? 350)))),
      );
      await this.uiInput(
        'swipe',
        action.fromX,
        action.fromY,
        action.toX,
        action.toY,
        speed,
      );
    } else if (action.type === 'key') {
      await this.uiInput('keyEvent', keyEvents[action.key]);
    } else if (action.type === 'text') {
      if (!action.text) return;
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
        throw Object.assign(
          new Error('HarmonyOS 文本输入需要先在画面中点击输入框'),
          { statusCode: 422 },
        );
      }
      const escaped = action.text.replace(/'/g, "'\\''");
      await this.uiInput('inputText', action.x, action.y, `'${escaped}'`);
    }
  }

  async captureLayout() {
    const remote = `/data/local/tmp/viewphone-${process.pid}-${Date.now()}-layout.json`;
    try {
      await this.shell(`uitest dumpLayout -p ${remote}`, 10_000);
      const result = await this.shell(`cat ${remote}`, 10_000);
      return parseHarmonyLayout(result.stdout, {
        width: this.device.inputWidth ?? this.device.width,
        height: this.device.inputHeight ?? this.device.height,
      });
    } finally {
      await this.shell(`rm -f ${remote}`, 4_000).catch(() => {});
    }
  }

  async uiInput(operation, ...args) {
    await this.shell(
      `uitest uiInput ${operation} ${args.map((item) => String(item)).join(' ')}`,
      10_000,
    );
  }
}

/** HDC can return a failure on stdout while still exiting with status 0. */
export function assertHarmonyCommand(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const failure = output.match(/\[Fail\](?:\[([A-Z0-9]+)\])?\s*([^\r\n]*)/i);
  if (failure) {
    const detail = failure[2] || '未知错误';
    if (/hdc(?:\.exe)? version is too low/i.test(detail)) {
      throw Object.assign(
        new Error(
          '鸿蒙 HDC 客户端与后台服务版本不一致。请使用 DevEco Studio 自带的 HDC，并重新启动 HDC 服务。',
        ),
        { statusCode: 409, code: 'HARMONY_HDC_VERSION_MISMATCH' },
      );
    }
    throw Object.assign(new Error(`HarmonyOS 设备命令失败：${detail}`), {
      statusCode: 502,
      code: 'HARMONY_COMMAND_FAILED',
    });
  }
  if (/Invalid parameters|Missing parameter|Too many parameters|Please confirm/i.test(output)) {
    throw Object.assign(new Error(`HarmonyOS 操作未生效：${output}`), {
      statusCode: 422,
      code: 'HARMONY_ACTION_FAILED',
    });
  }
  return result;
}
