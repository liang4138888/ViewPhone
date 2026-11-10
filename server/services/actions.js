const limits = {
  maxCoordinate: 100_000,
  minDuration: 100,
  maxDuration: 10_000,
  maxTextLength: 4_000,
};

const keys = new Set(['back', 'home', 'recents', 'volumeUp', 'volumeDown', 'power']);

export function validateAction(input) {
  if (!input || typeof input !== 'object') throw validation('操作请求格式无效');
  const type = input.type;
  if (type === 'tap') return { type, x: coordinate(input.x, 'x'), y: coordinate(input.y, 'y') };
  if (type === 'longPress') {
    return {
      type,
      x: coordinate(input.x, 'x'),
      y: coordinate(input.y, 'y'),
      duration: duration(input.duration),
    };
  }
  if (type === 'swipe') {
    return {
      type,
      fromX: coordinate(input.fromX, 'fromX'),
      fromY: coordinate(input.fromY, 'fromY'),
      toX: coordinate(input.toX, 'toX'),
      toY: coordinate(input.toY, 'toY'),
      duration: duration(input.duration),
    };
  }
  if (type === 'text') {
    if (typeof input.text !== 'string') throw validation('文本不能为空');
    if (input.text.length > limits.maxTextLength) throw validation('单次输入不能超过 4000 个字符');
    return {
      type,
      text: input.text,
      ...(Number.isFinite(input.x) ? { x: coordinate(input.x, 'x') } : {}),
      ...(Number.isFinite(input.y) ? { y: coordinate(input.y, 'y') } : {}),
    };
  }
  if (type === 'key') {
    if (!keys.has(input.key)) throw validation('不支持的按键');
    return { type, key: input.key };
  }
  throw validation('不支持的操作类型');
}

function coordinate(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > limits.maxCoordinate) {
    throw validation(`${field} 坐标无效`);
  }
  return Math.round(value);
}

function duration(value) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < limits.minDuration || value > limits.maxDuration) {
    throw validation('操作时长需要在 100 到 10000 毫秒之间');
  }
  return Math.round(value);
}

function validation(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_ACTION' });
}
