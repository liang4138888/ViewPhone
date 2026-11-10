import { CommandError, run } from '../utils/command.js';
import { imageDimensions } from '../utils/image.js';
import { parseAndroidLayout } from '../services/uiLayout.js';
import { hasUsefulSemanticNodes } from '../services/ocrLayout.js';
import { DeviceAdapter } from './base.js';
import { parseAndroidSize } from '../discovery/android.js';

const keyCodes = {
  back: '4',
  home: '3',
  recents: '187',
  volumeUp: '24',
  volumeDown: '25',
  power: '26',
};

const ACCESSIBILITY_APP = 'cn.viewphone.axprobe';
const ACCESSIBILITY_FILES = `/sdcard/Android/data/${ACCESSIBILITY_APP}/files`;
const ACCESSIBILITY_PRIVATE_FILES = 'files';

export class AndroidAdapter extends DeviceAdapter {
  constructor(device) {
    super(device);
    this.adb = device.adb;
    this.nativeLayoutRetryAt = 0;
    this.accessibilityProbeAvailable = undefined;
  }

  args(...args) {
    return ['-s', this.device.nativeId, ...args];
  }

  async captureScreenshot() {
    const result = await run(this.adb, this.args('exec-out', 'screencap', '-p'), {
      timeoutMs: 5_000,
      encoding: 'buffer',
    });
    const buffer = result.stdout;
    if (buffer.length < 8) throw new Error('Android 设备返回了空截图');
    const size = imageDimensions(buffer);
    if (!size) throw new Error('Android 截图格式无法识别，请确认设备已解锁');
    // `wm size` reports the physical portrait dimensions, while a rotated
    // emulator/phone can expose a landscape input surface (for example
    // 1920x1080). The screenshot is the authoritative orientation for touch.
    this.setInputSize({ width: size.width, height: size.height });
    return { buffer, ...size };
  }

  async performUnlocked(action) {
    if (action.type === 'tap') {
      await this.input('tap', action.x, action.y);
    } else if (action.type === 'longPress') {
      await this.input(
        'swipe',
        action.x,
        action.y,
        action.x,
        action.y,
        action.duration ?? 700,
      );
    } else if (action.type === 'swipe') {
      await this.input(
        'swipe',
        action.fromX,
        action.fromY,
        action.toX,
        action.toY,
        action.duration ?? 350,
      );
    } else if (action.type === 'text') {
      const text = String(action.text ?? '');
      if (!text.trim()) return;
      const bridge = await this.setTextViaAccessibility(text);
      if (bridge.ok) return;
      try {
        await this.execShell('input', 'text', escapeAndroidText(text));
      } catch (error) {
        if (!isAndroidTextInputFailure(error)) throw error;
        throw textBridgeError(bridge.reason);
      }
    } else if (action.type === 'key') {
      await this.execShell('input', 'keyevent', keyCodes[action.key]);
    }
  }

  async prepareForInput() {
    let power = '';
    try {
      const result = await run(this.adb, this.args('shell', 'dumpsys', 'power'), {
        timeoutMs: 3_000,
      });
      power = String(result.stdout || '');
    } catch {
      // The key command below is harmless when the output cannot be read.
    }
    if (!/mWakefulness=(Asleep|Dozing)/i.test(power)) return;

    await this.execShell('input', 'keyevent', '224');
    await this.execShell('wm', 'dismiss-keyguard');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  async captureLayout() {
    if (Date.now() < this.nativeLayoutRetryAt) {
      throw new Error('Android 原生界面树暂不可用，正在改用截图文字识别');
    }
    const remote = `/sdcard/viewphone-${process.pid}-${Date.now()}-ui.xml`;
    try {
      let dumpError;
      try {
        await run(this.adb, this.args('shell', 'uiautomator', 'dump', '--compressed', remote), {
          timeoutMs: 5_000,
        });
      } catch (error) {
        dumpError = error;
      }
      let xml = '';
      try {
        const result = await run(this.adb, this.args('exec-out', 'cat', remote), {
          timeoutMs: 5_000,
        });
        xml = String(result.stdout || '');
      } catch {
        // MIUI's uiautomator can delete the output while terminating. Fall
        // through to the accessibility probe only when no usable XML exists.
      }
      if (!/<hierarchy\b/i.test(xml) && await this.hasAccessibilityProbe()) {
        xml = await this.captureAccessibilityLayout();
      }
      // The XML bounds follow the current display orientation. Let the parser
      // infer its size from those bounds rather than supplying a stale
      // portrait size from discovery.
      const layout = parseAndroidLayout(xml, {});
      if (!hasUsefulSemanticNodes(layout)) {
        // MIUI often takes many seconds and still returns only a root frame.
        // Avoid repeating that delay for every click; use visual OCR fallback.
        this.nativeLayoutRetryAt = Date.now() + 30_000;
        const cause = dumpError instanceof Error ? `：${dumpError.message}` : '';
        throw new Error(`Android 界面树中没有可用控件${cause}`);
      }
      this.nativeLayoutRetryAt = 0;
      return layout;
    } finally {
      await this.execShell('rm', '-f', remote).catch(() => {});
    }
  }

  async captureAccessibilityLayout() {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await run(this.adb, this.args('shell', 'am', 'broadcast', '-n', `${ACCESSIBILITY_APP}/.DumpReceiver`, '-a', `${ACCESSIBILITY_APP}.DUMP`, '--es', 'token', token), {
        timeoutMs: 5_000,
      });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const result = await this.readAccessibilityResult('complete', token);
        if (result?.stdout?.trim() !== 'OK') {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const layout = await this.readAccessibilityResult('layout', `${token}.xml`);
        return String(layout.stdout || '');
      }
      throw new Error('Android 无障碍读取未响应，请安装 ViewPhone 界面读取服务');
    } finally {
      await run(this.adb, this.args('shell', 'rm', '-f', `${ACCESSIBILITY_FILES}/layout-${token}.xml`, `${ACCESSIBILITY_FILES}/complete-${token}`), {
        timeoutMs: 3_000,
      }).catch(() => {});
    }
  }

  /**
   * Android 12's `input text` can create a null Unicode payload even when an
   * input is focused. Use the optional local accessibility bridge to set the
   * exact text through ACTION_SET_TEXT; the ADB command remains the fallback.
   */
  async setTextViaAccessibility(text) {
    const service = await this.accessibilityServiceEnabled();
    if (!service) {
      return { ok: false, reason: 'accessibility-service-not-ready' };
    }
    if (!(await this.hasAccessibilityProbe())) {
      return { ok: false, reason: 'helper-not-installed' };
    }
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const encodedText = androidTextBridgePayload(text);
    try {
      await run(
        this.adb,
        this.args(
          'shell',
          'am',
          'broadcast',
          '-n',
          `${ACCESSIBILITY_APP}/.DumpReceiver`,
          '-a',
          `${ACCESSIBILITY_APP}.SET_TEXT`,
          '--es',
          'token',
          token,
          '--es',
          'text',
          encodedText,
        ),
        { timeoutMs: 5_000 },
      );
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const result = await this.readAccessibilityResult('text-complete', token);
        const message = String(result?.stdout || '').trim();
        if (message === 'OK') return { ok: true };
        if (message.startsWith('ERROR:')) {
          return { ok: false, reason: message.slice(6) || 'accessibility-error' };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ok: false, reason: 'accessibility-timeout' };
    } finally {
      await run(
        this.adb,
        this.args('shell', 'run-as', ACCESSIBILITY_APP, 'rm', '-f', `text-complete-${token}`),
        { timeoutMs: 3_000 },
      ).catch(() => {});
    }
  }

  async readAccessibilityResult(prefix, name) {
    const direct = await run(
      this.adb,
      this.args('exec-out', 'cat', `${ACCESSIBILITY_FILES}/${prefix}-${name}`),
      { timeoutMs: 2_000 },
    ).catch(() => undefined);
    if (direct?.stdout && !isMissingAccessibilityResult(direct.stdout)) return direct;
    return run(
      this.adb,
      this.args('shell', 'run-as', ACCESSIBILITY_APP, 'cat', `${ACCESSIBILITY_PRIVATE_FILES}/${prefix}-${name}`),
      { timeoutMs: 2_000 },
    ).catch(() => undefined);
  }

  async hasAccessibilityProbe() {
    if (this.accessibilityProbeAvailable !== undefined) {
      return this.accessibilityProbeAvailable;
    }
    try {
      const result = await run(
        this.adb,
        this.args('shell', 'pm', 'path', ACCESSIBILITY_APP),
        { timeoutMs: 2_000 },
      );
      this.accessibilityProbeAvailable = Boolean(result.stdout?.trim());
    } catch {
      this.accessibilityProbeAvailable = false;
    }
    return this.accessibilityProbeAvailable;
  }

  async accessibilityServiceEnabled() {
    const result = await run(
      this.adb,
      this.args('shell', 'settings', 'get', 'secure', 'enabled_accessibility_services'),
      { timeoutMs: 3_000 },
    ).catch(() => undefined);
    return isAndroidAccessibilityServiceEnabled(result?.stdout);
  }

  async openDeveloperSettings() {
    await run(
      this.adb,
      this.args('shell', 'am', 'start', '-a', 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS'),
      { timeoutMs: 8_000 },
    );
  }

  async input(...args) {
    await this.execShell('input', ...args.map(String));
  }

  inputSize() {
    return {
      width: this.device.inputWidth ?? this.device.width,
      height: this.device.inputHeight ?? this.device.height,
    };
  }

  async ensureInputSize() {
    const explicitWidth = Number(this.device.inputWidth);
    const explicitHeight = Number(this.device.inputHeight);
    if (explicitWidth > 1 && explicitHeight > 1) {
      return { width: explicitWidth, height: explicitHeight };
    }

    // Discovery's width/height are the physical panel size, not necessarily
    // the current rotation. A screenshot gives us the actual input surface.
    await this.captureScreenshot();
    return this.inputSize();
  }

  async execShell(...args) {
    try {
      await run(this.adb, this.args('shell', ...args), { timeoutMs: 8_000 });
    } catch (error) {
      if (
        error instanceof CommandError &&
        /INJECT_EVENTS permission|Injecting to another application requires INJECT_EVENTS/i.test(
          error.message,
        )
      ) {
        throw Object.assign(
          new Error(
            '小米/MIUI 拦截了模拟操作。请打开“开发者选项”，开启“USB 调试（安全设置）”，然后重新点击手机画面。',
          ),
          {
            statusCode: 409,
            code: 'ANDROID_SECURITY_SETTINGS_REQUIRED',
          },
        );
      }
      if (error instanceof CommandError && /unauthorized|offline|no devices|not found/i.test(error.message)) {
        throw new Error('Android 设备已断开或未授权，请检查数据线和手机上的 USB 调试弹窗');
      }
      throw error;
    }
  }
}

export function escapeAndroidText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([;&|<>()[\]{}*?$`"'!~])/g, '\\$1')
    .replace(/ /g, '%s');
}

export function isAndroidTextInputFailure(error) {
  const detail = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`;
  return /Exception occurred while executing ['"]?text['"]?|NullPointerException|Attempt to get length of null array|sendText/i.test(detail);
}

export function androidTextBridgePayload(text) {
  return Buffer.from(String(text ?? ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function isAndroidAccessibilityServiceEnabled(value) {
  const enabled = String(value ?? '');
  return enabled.includes(`${ACCESSIBILITY_APP}/.AXProbe`)
    || enabled.includes(`${ACCESSIBILITY_APP}/${ACCESSIBILITY_APP}.AXProbe`);
}

export function isMissingAccessibilityResult(output) {
  return /No such file or directory|\bENOENT\b/i.test(String(output ?? ''));
}

function textBridgeError(reason) {
  const hints = {
    'helper-not-installed': '请安装 ViewPhone Android 界面读取组件',
    'accessibility-service-not-ready': '请在手机设置中启用“ViewPhone 界面读取”无障碍服务',
    'no-focused-input': '请先点击需要输入文字的输入框',
    'not-editable': '当前焦点不是可编辑输入框，请重新点击输入框',
    'action-set-text-rejected': '该应用不允许无障碍写入文字，请确认输入框已获得焦点',
    'accessibility-timeout': 'Android 无障碍输入没有响应，请检查无障碍服务是否开启',
  };
  return Object.assign(
    new Error(
      `Android 无法发送文字：${hints[reason] || '输入服务返回空文本'}。` +
        '（这是 Android 12 的 input text 兼容问题，不是测试流程本身失败。）',
    ),
    { statusCode: 422, code: 'ANDROID_TEXT_INPUT_UNAVAILABLE' },
  );
}
