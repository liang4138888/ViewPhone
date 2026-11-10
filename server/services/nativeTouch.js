import { spawn } from 'node:child_process';
import { run } from '../utils/command.js';

const sessions = new Map();
const starting = new Map();
const MAX_BUFFERED_EVENTS = 300;

/**
 * Converts Linux evdev multi-touch events from `getevent -lt` into one of the
 * gestures understood by the existing device adapters. Only the first finger
 * participates: spreading/lifting a second finger must not move the primary
 * pointer or produce an extra action.
 */
export class AndroidTouchParser {
  constructor({ width, height, onGesture, now = Date.now }) {
    if (!(width > 1) || !(height > 1)) throw new RangeError('触控设备尺寸无效');
    this.width = width;
    this.height = height;
    this.onGesture = onGesture;
    this.now = now;
    this.currentSlot = 0;
    this.activeSlot = undefined;
    this.active = false;
    this.fromX = undefined;
    this.fromY = undefined;
    this.toX = undefined;
    this.toY = undefined;
    this.downAt = undefined;
    this.slotPositions = new Map();
  }

  push(line) {
    const match = String(line).match(
      /\/dev\/input\/event\d+:\s+EV_(ABS|SYN)\s+(ABS_MT_SLOT|ABS_MT_TRACKING_ID|ABS_MT_POSITION_X|ABS_MT_POSITION_Y|SYN_REPORT)\s+(-?[0-9a-f]+)/i,
    );
    if (!match) return;
    const [, eventType, name, raw] = match;
    let value = Number.parseInt(raw, 16);
    // getevent prints the 32-bit unsigned representation of a signed -1.
    if (name === 'ABS_MT_TRACKING_ID' && /^f{8}$/i.test(raw)) value = -1;

    if (eventType === 'ABS' && name === 'ABS_MT_SLOT') {
      this.currentSlot = value;
      return;
    }

    if (eventType === 'ABS' && name === 'ABS_MT_TRACKING_ID') {
      if (value === -1) {
        if (this.active && this.currentSlot === this.activeSlot) this.finish();
      } else if (!this.active) {
        this.begin(this.currentSlot);
      }
      return;
    }

    if (eventType !== 'ABS') return;
    if (name === 'ABS_MT_POSITION_X') this.record('x', value);
    if (name === 'ABS_MT_POSITION_Y') this.record('y', value);
  }

  begin(slot) {
    this.active = true;
    this.activeSlot = slot;
    this.downAt = this.now();
    const position = this.slotPositions.get(slot) || {};
    this.fromX = position.x;
    this.fromY = position.y;
    this.toX = position.x;
    this.toY = position.y;
  }

  record(axis, value) {
    const maximum = (axis === 'x' ? this.width : this.height) - 1;
    const coordinate = Math.min(maximum, Math.max(0, value));
    const slot = this.slotPositions.get(this.currentSlot) || {};
    slot[axis] = coordinate;
    this.slotPositions.set(this.currentSlot, slot);

    // Android kernel drivers do not guarantee that tracking-id arrives before
    // the first X/Y sample. Keep per-slot coordinates so a real tap is recorded
    // regardless of event ordering. Other fingers never move the primary one.
    if (!this.active || this.currentSlot !== this.activeSlot) return;
    if (axis === 'x') {
      if (this.fromX === undefined) this.fromX = coordinate;
      this.toX = coordinate;
    } else {
      if (this.fromY === undefined) this.fromY = coordinate;
      this.toY = coordinate;
    }
  }

  finish() {
    const elapsed = Math.max(0, this.now() - (this.downAt ?? this.now()));
    const fromX = this.fromX;
    const fromY = this.fromY;
    const toX = this.toX ?? fromX;
    const toY = this.toY ?? fromY;
    if (this.activeSlot !== undefined) this.slotPositions.delete(this.activeSlot);
    this.reset();
    if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) return;
    const distance = Math.hypot(toX - fromX, toY - fromY);
    const duration = Math.min(10_000, Math.max(100, elapsed));
    const action = distance > 8
      ? { type: 'swipe', fromX, fromY, toX, toY, duration }
      : elapsed >= 600
        ? { type: 'longPress', x: fromX, y: fromY, duration }
        : { type: 'tap', x: fromX, y: fromY };
    this.onGesture?.(action);
  }

  reset() {
    this.active = false;
    this.activeSlot = undefined;
    this.fromX = undefined;
    this.fromY = undefined;
    this.toX = undefined;
    this.toY = undefined;
    this.downAt = undefined;
  }
}

export async function startNativeTouch(device) {
  assertAndroid(device);
  if (starting.has(device.id)) return starting.get(device.id);
  const current = sessions.get(device.id);
  if (current?.enabled && current.child && current.state !== 'error') return statusFor(device.id);
  if (current) stopNativeTouch(device.id);

  const session = {
    id: device.id,
    enabled: true,
    state: 'starting',
    error: undefined,
    eventPath: undefined,
    sourceWidth: undefined,
    sourceHeight: undefined,
    events: [],
    sequence: 0,
    child: undefined,
    parser: undefined,
    cancelled: false,
  };
  sessions.set(device.id, session);

  const task = launch(device, session).finally(() => {
    if (starting.get(device.id) === task) starting.delete(device.id);
  });
  starting.set(device.id, task);
  return task;
}

async function launch(device, session) {
  try {
    const touch = await findTouchEvent(device);
    if (session.cancelled || sessions.get(device.id) !== session) return statusFor(device.id);
    session.eventPath = touch.path;
    session.sourceWidth = touch.width;
    session.sourceHeight = touch.height;
    session.parser = new AndroidTouchParser({
      width: touch.width,
      height: touch.height,
      onGesture(action) {
        if (session.cancelled) return;
        session.events.push({ sequence: ++session.sequence, action, at: Date.now() });
        if (session.events.length > MAX_BUFFERED_EVENTS) session.events.shift();
      },
    });

    const child = spawn(device.adb, [
      '-s',
      device.nativeId,
      'shell',
      'getevent',
      '-lt',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    session.child = child;
    session.state = 'listening';

    let buffered = '';
    child.stdout.on('data', (chunk) => {
      if (session.cancelled) return;
      session.state = 'listening';
      buffered += chunk.toString('utf8');
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      // Keep a runaway line bounded if ADB ever returns an unterminated chunk.
      if (buffered.length > 64_000) buffered = '';
      for (const line of lines) session.parser?.push(line);
    });
    child.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      if (message && /permission denied|not found|no such device|closed/i.test(message)) {
        session.error = message;
      }
    });
    child.once('error', (error) => {
      if (session.cancelled) return;
      session.error = `无法启动 Android 触控监听：${error.message}`;
      session.state = 'error';
      session.enabled = false;
    });
    child.once('close', (code) => {
      if (session.cancelled || sessions.get(device.id) !== session) return;
      if (!session.error && code !== 0) {
        session.error = `Android 触控监听已退出（代码 ${code ?? 'unknown'}）`;
      }
      session.enabled = false;
      session.state = session.error ? 'error' : 'stopped';
    });
    return statusFor(device.id);
  } catch (error) {
    if (session.cancelled || sessions.get(device.id) !== session) return statusFor(device.id);
    session.enabled = false;
    session.state = 'error';
    session.error = errorMessage(error);
    return statusFor(device.id);
  }
}

export function stopNativeTouch(deviceId) {
  const session = sessions.get(deviceId);
  if (!session) return;
  session.cancelled = true;
  session.enabled = false;
  session.state = 'stopped';
  session.events = [];
  if (session.child && !session.child.killed) session.child.kill('SIGTERM');
  sessions.delete(deviceId);
}

export function stopAllNativeTouch() {
  for (const deviceId of [...sessions.keys()]) stopNativeTouch(deviceId);
}

export function nativeTouchStatus(deviceId, after = 0) {
  return statusFor(deviceId, after);
}

function statusFor(deviceId, after = 0) {
  const session = sessions.get(deviceId);
  if (!session) {
    return { enabled: false, state: 'stopped', events: [], sequence: 0 };
  }
  return {
    enabled: session.enabled,
    state: session.state,
    error: session.error,
    eventPath: session.eventPath,
    sourceWidth: session.sourceWidth,
    sourceHeight: session.sourceHeight,
    events: session.events.filter((event) => event.sequence > after),
    sequence: session.sequence,
  };
}

async function findTouchEvent(device) {
  let output;
  try {
    output = (await run(device.adb, [
      '-s',
      device.nativeId,
      'shell',
      'getevent',
      '-pl',
    ], { timeoutMs: 5_000 })).stdout;
  } catch (error) {
    throw Object.assign(
      new Error(`无法读取 Android 触控设备：${errorMessage(error)}`),
      { statusCode: 502, code: 'NATIVE_TOUCH_UNAVAILABLE' },
    );
  }
  const touch = parseTouchEventInfo(output);
  if (!touch) {
    throw Object.assign(
      new Error('没有找到 Android 多点触控设备，请确认屏幕已解锁并允许 ADB 调试'),
      { statusCode: 422, code: 'NATIVE_TOUCH_UNAVAILABLE' },
    );
  }
  return touch;
}

export function parseTouchEventInfo(output) {
  const blocks = String(output).split(/(?=add device \d+:)/g);
  for (const block of blocks) {
    if (!/ABS_MT_POSITION_X/.test(block) || !/ABS_MT_POSITION_Y/.test(block)) continue;
    const path = block.match(/add device \d+:\s+(\/dev\/input\/event\d+)/)?.[1];
    const x = block.match(/ABS_MT_POSITION_X\s*:\s*value\s+-?\d+,\s*min\s+-?\d+,\s*max\s+(\d+)/);
    const y = block.match(/ABS_MT_POSITION_Y\s*:\s*value\s+-?\d+,\s*min\s+-?\d+,\s*max\s+(\d+)/);
    if (!path || !x || !y) continue;
    const width = Number(x[1]) + 1;
    const height = Number(y[1]) + 1;
    if (width > 1 && height > 1) return { path, width, height };
  }
  return undefined;
}

function assertAndroid(device) {
  if (device.platform !== 'android') {
    throw Object.assign(new Error('实体触控监听目前仅支持 Android 手机'), {
      statusCode: 422,
      code: 'NATIVE_TOUCH_UNSUPPORTED',
    });
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
