import { config } from '../config.js';
import { httpJson } from '../utils/http.js';
import { imageDimensions } from '../utils/image.js';
import { parseIosLayout } from '../services/uiLayout.js';
import { DeviceAdapter } from './base.js';

const base = `${config.wdaUrl}/session`;
let sharedSessionId = config.wdaSessionId || '';
let sessionPromise;

async function getSessionId() {
  if (sharedSessionId) return sharedSessionId;
  if (!sessionPromise) {
    sessionPromise = httpJson(base, {
      method: 'POST',
      body: {
        capabilities: {
          alwaysMatch: {
            platformName: 'iOS',
            'appium:shouldWaitForQuiescence': false,
            'appium:usePrebuiltWDA': true,
          },
        },
      },
      timeoutMs: 40_000,
    })
      .then((result) => {
        const id = result.body?.value?.sessionId || result.body?.sessionId;
        if (!id) throw new Error('WebDriverAgent 未返回有效的会话 ID');
        sharedSessionId = id;
        return id;
      })
      .finally(() => {
        sessionPromise = undefined;
      });
  }
  return sessionPromise;
}

function sendSessionRequest(sessionId, path, options) {
  return httpJson(`${base}/${encodeURIComponent(sessionId)}${path}`, options);
}

async function wda(path, { method = 'GET', body, timeoutMs = 15_000 } = {}) {
  const options = { method, body, timeoutMs };
  const sessionId = await getSessionId();
  try {
    return await sendSessionRequest(sessionId, path, options);
  } catch (error) {
    if (!config.wdaSessionId && (error.status === 404 || error.status === 410)) {
      sharedSessionId = '';
      const renewedSessionId = await getSessionId();
      return sendSessionRequest(renewedSessionId, path, options);
    }
    throw error;
  }
}

export class IosAdapter extends DeviceAdapter {
  async captureScreenshot() {
    const [result, inputSize] = await Promise.all([
      wda('/screenshot'),
      readWindowSize().catch(() => undefined),
    ]);
    const data = result.body?.value;
    if (typeof data !== 'string' || !data) throw new Error('iPhone 未返回画面');
    const buffer = Buffer.from(data, 'base64');
    const size = imageDimensions(buffer);
    if (!size) throw new Error('iPhone 截图格式无法识别');
    return {
      buffer,
      ...size,
      inputWidth: inputSize?.width,
      inputHeight: inputSize?.height,
    };
  }

  async performUnlocked(action) {
    if (action.type === 'tap') {
      await wda('/wda/tap/0', { method: 'POST', body: { x: action.x, y: action.y } });
    } else if (action.type === 'longPress') {
      await wda('/wda/touchAndHold', {
        method: 'POST',
        body: { x: action.x, y: action.y, duration: (action.duration ?? 700) / 1000 },
      });
    } else if (action.type === 'swipe') {
      await wda('/wda/dragfromtoforduration', {
        method: 'POST',
        body: {
          fromX: action.fromX,
          fromY: action.fromY,
          toX: action.toX,
          toY: action.toY,
          duration: (action.duration ?? 350) / 1000,
        },
      });
    } else if (action.type === 'text') {
      if (!action.text) return;
      await wda('/wda/keys', {
        method: 'POST',
        body: { value: [...action.text] },
      });
    } else if (action.type === 'key') {
      const mapping = {
        back: 'back',
        home: 'home',
        recents: 'appswitch',
        volumeUp: 'volumeUp',
        volumeDown: 'volumeDown',
        power: 'lock',
      };
      await wda('/wda/pressButton', {
        method: 'POST',
        body: { name: mapping[action.key] ?? action.key },
      });
    }
  }

  async captureLayout() {
    const result = await wda('/source?format=json', { timeoutMs: 15_000 });
    return parseIosLayout(result.body?.value ?? result.body, {
      width: this.device.inputWidth ?? this.device.width,
      height: this.device.inputHeight ?? this.device.height,
    });
  }
}

export async function discoverIos() {
  try {
    const result = await httpJson(`${config.wdaUrl}/status`, { timeoutMs: 1_500 });
    const value = result.body?.value ?? {};
    const ready = value.ready !== false;
    if (!ready) {
      return {
        devices: [],
        warning: 'WebDriverAgent 正在启动，尚未就绪',
      };
    }
    // readWindowSize() resolves an object; destructuring it as an array made
    // every discovery run fail with "is not iterable" once WDA was reachable.
    const { width, height } = await readWindowSize().catch(() => ({}));
    return {
      devices: [
        {
          nativeId: 'wda',
          id: 'i_wda',
          platform: 'ios',
          name: value.deviceName || value.device?.name || value.build?.productBundleIdentifier || 'iOS 设备',
          model: value.device?.model || undefined,
          osVersion: value.ios?.version || value.os?.version || undefined,
          state: 'device',
          width,
          height,
          detail: '已通过 WebDriverAgent 连接',
        },
      ],
    };
  } catch (error) {
    return {
      devices: [],
      warning: `iOS 未连接：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readWindowSize() {
  const result = await wda('/window/size');
  const window = result.body?.value?.window || result.body?.value;
  if (!(window?.width > 0) || !(window?.height > 0)) {
    throw new Error('WebDriverAgent 未返回触控画面尺寸');
  }
  return { width: window.width, height: window.height };
}
