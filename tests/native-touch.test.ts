import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AndroidTouchParser,
  parseTouchEventInfo,
} from '../server/services/nativeTouch.js';
import type { ActionRequest } from '../shared/types.ts';

function event(name: string, value: string, type = 'ABS') {
  return `/dev/input/event5: EV_${type} ${name} ${value}`;
}

function setup(now = () => 1_000) {
  const actions: ActionRequest[] = [];
  const parser = new AndroidTouchParser({
    width: 1080,
    height: 2340,
    now,
    onGesture: (action) => actions.push(action),
  });
  return { parser, actions };
}

function down(parser: AndroidTouchParser, x: number, y: number) {
  parser.push(event('ABS_MT_SLOT', '00000000'));
  parser.push(event('ABS_MT_TRACKING_ID', '00000001'));
  parser.push(event('ABS_MT_POSITION_X', x.toString(16).padStart(8, '0')));
  parser.push(event('ABS_MT_POSITION_Y', y.toString(16).padStart(8, '0')));
  parser.push(event('SYN_REPORT', '00000000', 'SYN'));
}

function up(parser: AndroidTouchParser) {
  parser.push(event('ABS_MT_TRACKING_ID', 'ffffffff'));
  parser.push(event('SYN_REPORT', '00000000', 'SYN'));
}

test('physical tap is emitted once after tracking id ends', () => {
  const { parser, actions } = setup();
  down(parser, 690, 1272);
  assert.deepEqual(actions, []);
  up(parser);
  assert.deepEqual(actions, [{ type: 'tap', x: 690, y: 1272 }]);
});

test('physical tap keeps coordinates that arrive before the tracking id', () => {
  const { parser, actions } = setup();
  parser.push(event('ABS_MT_SLOT', '00000000'));
  parser.push(event('ABS_MT_POSITION_X', (690).toString(16).padStart(8, '0')));
  parser.push(event('ABS_MT_POSITION_Y', (1272).toString(16).padStart(8, '0')));
  parser.push(event('ABS_MT_TRACKING_ID', '00000001'));
  up(parser);
  assert.deepEqual(actions, [{ type: 'tap', x: 690, y: 1272 }]);
});

test('physical swipe has separate start and end coordinates', () => {
  let now = 1_000;
  const { parser, actions } = setup(() => now);
  down(parser, 540, 1800);
  now = 1_300;
  parser.push(event('ABS_MT_POSITION_Y', (500).toString(16).padStart(8, '0')));
  up(parser);
  assert.deepEqual(actions, [{
    type: 'swipe',
    fromX: 540,
    fromY: 1800,
    toX: 540,
    toY: 500,
    duration: 300,
  }]);
});

test('physical long press includes its actual duration', () => {
  let now = 1_000;
  const { parser, actions } = setup(() => now);
  down(parser, 400, 800);
  now = 1_780;
  up(parser);
  assert.deepEqual(actions, [{ type: 'longPress', x: 400, y: 800, duration: 780 }]);
});

test('a second finger cannot move the first finger or end its gesture early', () => {
  const { parser, actions } = setup();
  down(parser, 300, 500);
  parser.push(event('ABS_MT_SLOT', '00000001'));
  parser.push(event('ABS_MT_TRACKING_ID', '00000002'));
  parser.push(event('ABS_MT_POSITION_X', (900).toString(16).padStart(8, '0')));
  parser.push(event('ABS_MT_TRACKING_ID', 'ffffffff'));
  assert.deepEqual(actions, []);
  parser.push(event('ABS_MT_SLOT', '00000000'));
  up(parser);
  assert.deepEqual(actions, [{ type: 'tap', x: 300, y: 500 }]);
});

test('evdev coordinate limits produce the device input dimensions', () => {
  assert.deepEqual(
    parseTouchEventInfo(`
add device 1: /dev/input/event5
  name: "fts"
    ABS_MT_POSITION_X : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
    ABS_MT_POSITION_Y : value 0, min 0, max 2339, fuzz 0, flat 0, resolution 0
`),
    { path: '/dev/input/event5', width: 1080, height: 2340 },
  );
});
