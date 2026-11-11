import { config } from '../config.js';
import { HttpError, httpJson } from '../utils/http.js';
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

function wdaErrorText(error) {
  const body = error?.body;
  const value = body && typeof body === 'object' ? body.value : body;
  if (!value) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** WDA answers 404 both for a dead session and for a route it does not have. */
function isInvalidSession(error) {
  return /invalid session id|session does not exist|session is not created/i.test(wdaErrorText(error));
}

async function wda(path, { method = 'GET', body, timeoutMs = 15_000 } = {}) {
  const options = { method, body, timeoutMs };
  const sessionId = await getSessionId();
  try {
    return await sendSessionRequest(sessionId, path, options);
  } catch (error) {
    const missingRoute = (error.status === 404 || error.status === 410) && !isInvalidSession(error);
    if (missingRoute && (error instanceof HttpError || error.code)) {
      // Retrying with a fresh session cannot fix an endpoint this WDA build
      // does not implement, so report it instead of hiding it behind a 404.
      const detail = wdaErrorText(error);
      if (/unhandled endpoint|unknown command/i.test(detail)) {
        throw Object.assign(
          new Error(`WebDriverAgent 不支持该操作端点：${path.split('?')[0]}`),
          { statusCode: 409, code: 'WDA_ENDPOINT_UNSUPPORTED' },
        );
      }
    }
    if (!config.wdaSessionId && (error.status === 404 || error.status === 410) && isInvalidSession(error)) {
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
      // WDA removed the indexed /wda/tap/0 route; /wda/tap takes absolute points.
      await wda('/wda/tap', { method: 'POST', body: { x: action.x, y: action.y } });
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
      await this.pressKey(action.key);
    }
  }

  /**
   * WDA's pressButton only accepts a few names; asking for anything else makes
   * it reply HTTP 500. iOS also has no hardware back or app-switch key, so map
   * those to what the system actually does.
   */
  async pressKey(key) {
    if (key === 'back') {
      const { width, height } = this.inputSize();
      const middle = Math.round(height / 2);
      await wda('/wda/dragfromtoforduration', {
        method: 'POST',
        body: {
          fromX: 1,
          fromY: middle,
          toX: Math.round(width * 0.45),
          toY: middle,
          duration: 0.2,
        },
      });
      return;
    }
    if (key === 'power') {
      await wda('/wda/lock', { method: 'POST', body: {} });
      return;
    }
    const buttons = { home: 'home', volumeUp: 'volumeUp', volumeDown: 'volumeDown' };
    const name = buttons[key];
    if (!name) {
      throw Object.assign(
        new Error(
          key === 'recents'
            ? 'iOS 没有最近任务键，请用 Home 键回到主屏幕'
            : `iOS 不支持按键：${key}`,
        ),
        { statusCode: 422, code: 'IOS_KEY_UNSUPPORTED' },
      );
    }
    await wda('/wda/pressButton', { method: 'POST', body: { name } });
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
