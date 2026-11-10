import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeAndroidText,
  isAndroidTextInputFailure,
  androidTextBridgePayload,
  isMissingAccessibilityResult,
  isAndroidAccessibilityServiceEnabled,
} from '../server/adapters/android.js';
import { assertHarmonyCommand } from '../server/adapters/harmony.js';
import { validateAction } from '../server/services/actions.js';

test('tap actions reject missing and negative coordinates', () => {
  assert.throws(() => validateAction({ type: 'tap', x: -1, y: 2 }), /坐标无效/);
  assert.throws(() => validateAction({ type: 'tap', x: 1 }), /坐标无效/);
});

test('swipe and long press keep their valid duration', () => {
  assert.deepEqual(
    validateAction({ type: 'longPress', x: 20, y: 30, duration: 850 }),
    { type: 'longPress', x: 20, y: 30, duration: 850 },
  );
  assert.deepEqual(
    validateAction({
      type: 'swipe',
      fromX: 1,
      fromY: 2,
      toX: 3,
      toY: 4,
      duration: 400,
    }),
    { type: 'swipe', fromX: 1, fromY: 2, toX: 3, toY: 4, duration: 400 },
  );
});

test('unsupported keys and excessive input are rejected', () => {
  assert.throws(() => validateAction({ type: 'key', key: 'deleteEverything' }), /不支持的按键/);
  assert.throws(() => validateAction({ type: 'text', text: 'x'.repeat(4001) }), /4000/);
});

test('Android shell text is safely quoted', () => {
  assert.equal(escapeAndroidText('hello world'), 'hello%sworld');
  assert.equal(escapeAndroidText('a;b'), 'a\\;b');
  assert.equal(escapeAndroidText('single\'quote'), "single\\'quote");
  assert.equal(escapeAndroidText(undefined), '');
});

test('Android text shell null failures use the Unicode fallback path', () => {
  assert.equal(isAndroidTextInputFailure(new Error(
    "Exception occurred while executing 'text': java.lang.NullPointerException: Attempt to get length of null array",
  )), true);
  assert.equal(isAndroidTextInputFailure(new Error('Android 设备已断开或未授权')), false);
});

test('Android accessibility text payload preserves Unicode and spaces exactly', () => {
  assert.equal(androidTextBridgePayload('你好 ViewPhone 123'), '5L2g5aW9IFZpZXdQaG9uZSAxMjM');
});

test('Android accessibility service accepts the system fully-qualified name', () => {
  assert.equal(isAndroidAccessibilityServiceEnabled(
    'cn.viewphone.axprobe/cn.viewphone.axprobe.AXProbe',
  ), true);
  assert.equal(isAndroidAccessibilityServiceEnabled(
    'cn.viewphone.axprobe/.AXProbe:other.service/.Other',
  ), true);
  assert.equal(isAndroidAccessibilityServiceEnabled('com.example/.Other'), false);
});

test('Android private accessibility results are read after a missing public result', () => {
  assert.equal(isMissingAccessibilityResult(
    'cat: /sdcard/Android/data/cn.viewphone.axprobe/files/text-complete-test: No such file or directory',
  ), true);
  assert.equal(isMissingAccessibilityResult('OK'), false);
  assert.equal(isMissingAccessibilityResult('<hierarchy><node text="搜索"/></hierarchy>'), false);
});

test('HarmonyOS stdout failures are not treated as successful commands', () => {
  assert.throws(
    () =>
      assertHarmonyCommand({
        stdout: '[Fail][E000001]:The sdk hdc.exe version is too low, please upgrade to the latest version.',
        stderr: '',
      }),
    (error) => error.code === 'HARMONY_HDC_VERSION_MISMATCH',
  );
  assert.deepEqual(
    assertHarmonyCommand({ stdout: 'probe\n', stderr: '' }),
    { stdout: 'probe\n', stderr: '' },
  );
});
