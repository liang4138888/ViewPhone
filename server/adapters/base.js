import { SerialQueue } from '../utils/command.js';

export class DeviceAdapter {
  constructor(device) {
    this.device = device;
    this.queue = new SerialQueue();
    // Screenshot/layout inspection can take several seconds on Android. Input
    // must not wait behind that media queue or a normal mouse click appears
    // unresponsive even though the device is still online.
    this.inputQueue = new SerialQueue();
  }

  platform() {
    return this.device.platform;
  }

  async screenshot() {
    const frame = await this.queue.run(() => this.captureScreenshot());
    if (frame?.inputWidth > 1 && frame?.inputHeight > 1) {
      this.setInputSize({ width: frame.inputWidth, height: frame.inputHeight });
    } else if (frame?.width > 1 && frame?.height > 1 && this.device.platform !== 'ios') {
      // Android and HarmonyOS screencaps are in the same coordinate space as
      // touch input after device rotation. Keep the current frame orientation
      // instead of using a stale portrait size from discovery.
      this.setInputSize({ width: frame.width, height: frame.height });
    }
    return frame;
  }

  async perform(action) {
    return this.inputQueue.run(() => this.performUnlocked(action));
  }

  async captureScreenshot() {
    throw new Error('此设备适配器尚未实现截图');
  }

  async captureLayout() {
    throw Object.assign(new Error('当前设备不支持读取界面控件'), {
      statusCode: 422,
      code: 'LAYOUT_NOT_SUPPORTED',
    });
  }

  async layout() {
    return this.queue.run(() => this.captureLayout());
  }

  inputSize() {
    const width = Number(this.device.inputWidth ?? this.device.width);
    const height = Number(this.device.inputHeight ?? this.device.height);
    return { width, height };
  }

  setInputSize(size) {
    if (!(size?.width > 1) || !(size?.height > 1)) return;
    this.device.inputWidth = Math.round(size.width);
    this.device.inputHeight = Math.round(size.height);
  }

  async ensureInputSize() {
    const current = this.inputSize();
    if (current.width > 1 && current.height > 1) return current;
    const frame = await this.captureScreenshot();
    this.setInputSize({
      width: frame.inputWidth ?? frame.width,
      height: frame.inputHeight ?? frame.height,
    });
    return this.inputSize();
  }

  /** Platform hook for waking a sleeping receiving device before injecting input. */
  async prepareForInput() {}

  async performUnlocked() {
    throw new Error('此设备适配器尚未实现操作');
  }

  async openDeveloperSettings() {
    throw Object.assign(new Error('当前设备不支持从 ViewPhone 打开开发者选项'), {
      statusCode: 422,
      code: 'SETTINGS_NOT_SUPPORTED',
    });
  }
}
