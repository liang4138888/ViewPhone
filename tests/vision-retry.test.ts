import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareVisionSyncPages,
  decideVisionAction,
  mapVisionSyncAction,
  parseUiComparison,
  parseVisionSyncDecision,
} from '../server/services/visionModel.js';

test('a truncated action JSON gets one automatic retry before execution', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body || '{}')));
    const content = requests.length === 1
      ? '{"thought":"需要继续点击顶部搜索框","action":{"type":"click","description":"点击顶部'
      : '{"thought":"搜索框仍然可见","action":{"type":"click","description":"点击搜索框","x":500,"y":80}}';
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const action = await decideVisionAction({
      goal: '点击搜索框并输入牛奶',
      history: [{ index: 6, thought: '搜索框未聚焦', description: '点击空白区域', status: 'passed' }],
      screenshot: { buffer: Buffer.from('image'), width: 1080, height: 2340 },
      historyRounds: 5,
      config: {
        configured: true,
        provider: 'openai',
        model: 'test-vision-model',
        apiKey: 'test-key',
        apiUrl: 'http://vision.invalid/v1/chat/completions',
        missing: [],
        timeoutMs: 10_000,
      },
    });

    assert.equal(action.type, 'click');
    assert.deepEqual([action.x, action.y], [500, 80]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].max_tokens, 2_400);
    assert.equal(requests[1].max_tokens, 1_200);
    const retryPrompt = requests[1].messages as Array<{ content: string | Array<{ text?: string }> }>;
    assert.match(JSON.stringify(retryPrompt), /上一次答复不是有效 JSON/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vision sync maps normalized target gestures and skips an unmatched page', () => {
  const tap = parseVisionSyncDecision(JSON.stringify({
    match: true,
    reason: '目标页也显示同步点击按钮',
    x: 500,
    y: 250,
  }), {
    action: { type: 'tap', x: 200, y: 100 },
    targetSize: { width: 1080, height: 2340 },
  });
  assert.equal(tap.matched, true);
  assert.deepEqual(tap.action, { type: 'tap', x: 540, y: 585 });

  const swipe = parseVisionSyncDecision(JSON.stringify({
    match: true,
    reason: '商品列表使用同一处滚动区域',
    fromX: 500,
    fromY: 760,
    toX: 500,
    toY: 240,
  }), {
    action: { type: 'swipe', fromX: 540, fromY: 1700, toX: 540, toY: 500 },
    targetSize: { width: 1260, height: 2720 },
  });
  assert.equal(swipe.matched, true);
  assert.deepEqual(swipe.action, {
    type: 'swipe',
    fromX: 630,
    fromY: 2067,
    toX: 630,
    toY: 653,
  });

  const skipped = parseVisionSyncDecision(JSON.stringify({
    match: false,
    reason: '目标页仍是首页，没有搜索框',
  }), {
    action: { type: 'tap', x: 200, y: 100 },
    targetSize: { width: 1080, height: 2340 },
  });
  assert.deepEqual(skipped, { matched: false, reason: '目标页仍是首页，没有搜索框' });
});

test('vision sync sends one labeled comparison image and retries an invalid JSON response', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  const comparisons: Array<{ source: Buffer; target: Buffer }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body || '{}')));
    const content = requests.length === 1
      ? '{"match":true,"x":'
      : '{"match":true,"reason":"目标页有相同按钮","x":500,"y":300}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await mapVisionSyncAction({
      action: { type: 'tap', x: 200, y: 200 },
      sourceSize: { width: 1080, height: 2340 },
      targetSize: { width: 1260, height: 2720 },
      sourceFrame: { buffer: Buffer.from('source'), width: 1080, height: 2340 },
      targetFrame: { buffer: Buffer.from('target'), width: 1260, height: 2720 },
      comparisonImage: async (source: Buffer, target: Buffer) => {
        comparisons.push({ source: source.buffer, target: target.buffer });
        return { buffer: Buffer.from('comparison'), layout: 'source-left-target-right' };
      },
      config: {
        configured: true,
        provider: 'openai',
        model: 'test-vision-model',
        apiKey: 'test-key',
        apiUrl: 'http://vision.invalid/v1/chat/completions',
        missing: [],
        timeoutMs: 10_000,
      },
    });
    assert.equal(result.matched, true);
    assert.deepEqual(result.action, { type: 'tap', x: 630, y: 816 });
    assert.equal(requests.length, 2);
    const message = requests[0].messages[1];
    assert.equal(message.content.filter((item: any) => item.type === 'image_url').length, 1);
    assert.match(message.content[0].text, /左侧是动作发生前的来源截图/);
    assert.match(message.content[0].text, /右侧目标画面/);
    assert.deepEqual(comparisons, [{ source: Buffer.from('source'), target: Buffer.from('target') }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a single-image comparison is sent through the Anthropic protocol', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"match":true,"reason":"右侧有同一控件","x":500,"y":300}' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await mapVisionSyncAction({
      action: { type: 'tap', x: 540, y: 700 },
      sourceSize: { width: 1080, height: 2340 },
      targetSize: { width: 1260, height: 2720 },
      sourceFrame: { buffer: Buffer.from('source'), width: 1080, height: 2340 },
      targetFrame: { buffer: Buffer.from('target'), width: 1260, height: 2720 },
      comparisonImage: async () => ({ buffer: Buffer.from('comparison'), layout: 'source-left-target-right' }),
      config: {
        configured: true,
        provider: 'anthropic',
        model: 'test-vision-model',
        apiKey: 'test-key',
        apiUrl: 'http://vision.invalid/v1/messages',
        missing: [],
        timeoutMs: 10_000,
      },
    });
    assert.deepEqual(result.action, { type: 'tap', x: 630, y: 816 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].messages[0].content.filter((item: any) => item.type === 'image').length, 1);
    assert.equal(requests[0].messages[0].content.at(-1).type, 'text');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UI comparison parsing keeps evidence, clamps target regions and removes duplicates', () => {
  const result = parseUiComparison(JSON.stringify({
    same: false,
    summary: '目标页少一个筛选入口，商品价格文案不同',
    differences: [
      {
        type: 'missing',
        title: '筛选入口',
        description: '来源顶部有“筛选”，目标页没有',
        region: { x: 760, y: 80, width: 180, height: 50 },
      },
      {
        type: 'missing',
        title: '筛选入口',
        description: '来源顶部有“筛选”，目标页没有',
        region: { x: 760, y: 80, width: 180, height: 50 },
      },
      {
        type: 'text',
        title: '商品价格',
        description: '来源显示 ¥12.9，目标显示 ¥13.9',
        region: { left: 40, top: 900, right: 400, bottom: 1_200 },
      },
      {
        type: 'spacing',
        title: '底部按钮间距',
        description: '目标底部按钮间距更大',
      },
    ],
  }));
  assert.equal(result.same, false);
  assert.equal(result.differences.length, 3);
  assert.deepEqual(result.differences[0], {
    type: 'missing',
    title: '筛选入口',
    description: '来源顶部有“筛选”，目标页没有',
    region: { x: 760, y: 80, width: 180, height: 50 },
  });
  assert.deepEqual(result.differences[1].region, { x: 40, y: 900, width: 360, height: 100 });
  assert.equal(result.differences[1].type, 'text');
  assert.equal(result.differences[2].type, 'layout');
  assert.equal('region' in result.differences[2], false);
});

test('UI comparison sends the two settled pages as one image and accepts no differences', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  let comparisonCalls = 0;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({
      choices: [{
        message: { content: '{"same":true,"summary":"除状态栏外未发现明显 UI 差异","differences":[]}' },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await compareVisionSyncPages({
      action: { type: 'swipe', fromX: 540, fromY: 1_600, toX: 540, toY: 700 },
      sourceName: 'Mi 10',
      targetName: 'ALN-AL00',
      sourceSize: { width: 1080, height: 2340 },
      targetSize: { width: 1260, height: 2720 },
      sourceFrame: { buffer: Buffer.from('source-result'), width: 1080, height: 2340 },
      targetFrame: { buffer: Buffer.from('target-result'), width: 1260, height: 2720 },
      comparisonImage: async () => {
        comparisonCalls += 1;
        return { buffer: Buffer.from('settled-comparison'), layout: 'source-left-target-right' };
      },
      config: {
        configured: true,
        provider: 'openai',
        model: 'test-vision-model',
        apiKey: 'test-key',
        apiUrl: 'http://vision.invalid/v1/chat/completions',
        missing: [],
        timeoutMs: 10_000,
      },
    });
    assert.equal(result.same, true);
    assert.deepEqual(result.differences, []);
    assert.equal(result.summary, '除状态栏外未发现明显 UI 差异');
    assert.equal(comparisonCalls, 1);
    const content = requests[0].messages[1].content;
    assert.equal(content.filter((item: any) => item.type === 'image_url').length, 1);
    assert.match(content[0].text, /左侧是参考设备当前页面/);
    assert.match(content[0].text, /忽略状态栏时间、电量、信号/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UI comparison retries malformed JSON and shows a valid difference on the second response', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body || '{}')));
    const content = requests.length === 1
      ? '{"same":false,"summary":"价格不同","differences":['
      : JSON.stringify({
          same: false,
          summary: '目标商品价格上涨',
          differences: [{
            type: 'text',
            title: '商品价格',
            description: '来源显示 ¥12.9，目标显示 ¥13.9',
            region: { x: 40, y: 600, width: 300, height: 90 },
          }],
        });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await compareVisionSyncPages({
      action: { type: 'tap', x: 540, y: 1_000 },
      sourceName: 'Mi 10',
      targetName: 'ALN-AL00',
      sourceSize: { width: 1080, height: 2340 },
      targetSize: { width: 1260, height: 2720 },
      sourceFrame: { buffer: Buffer.from('source-result'), width: 1080, height: 2340 },
      targetFrame: { buffer: Buffer.from('target-result'), width: 1260, height: 2720 },
      comparisonImage: async () => ({ buffer: Buffer.from('settled-comparison') }),
      config: {
        configured: true,
        provider: 'openai',
        model: 'test-vision-model',
        apiKey: 'test-key',
        apiUrl: 'http://vision.invalid/v1/chat/completions',
        missing: [],
        timeoutMs: 10_000,
      },
    });
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1].messages), /上一次没有返回完整的 UI 对比 JSON/);
    assert.equal(result.same, false);
    assert.equal(result.differences.length, 1);
    assert.equal(result.differences[0].type, 'text');
    assert.deepEqual(result.differences[0].region, { x: 40, y: 600, width: 300, height: 90 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UI comparison retries an empty thinking-only response before showing differences', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body || '{}')));
    const payload = requests.length === 1
      ? {
          content: [{ type: 'thinking', thinking: '分析两张页面截图，但结果前额度耗尽' }],
          stop_reason: 'max_tokens',
        }
      : {
          content: [{
            type: 'text',
            text: JSON.stringify({
              same: false,
              summary: '目标页多出购物车入口',
              differences: [{
                type: 'extra',
                title: '购物车入口',
                description: '参考页没有购物车入口，目标页底部显示了购物车入口',
                region: { x: 700, y: 900, width: 180, height: 80 },
              }],
            }),
          }],
          stop_reason: 'end_turn',
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await compareVisionSyncPages({
      sourceName: 'Mi 10',
      targetName: 'ALN-AL00',
      sourceSize: { width: 1080, height: 2340 },
      targetSize: { width: 1260, height: 2720 },
      sourceFrame: { buffer: Buffer.from('source-current'), width: 1080, height: 2340 },
      targetFrame: { buffer: Buffer.from('target-current'), width: 1260, height: 2720 },
      comparisonImage: async () => ({ buffer: Buffer.from('settled-comparison') }),
      config: {
        configured: true,
        provider: 'anthropic',
        model: 'test-vision-model',
        apiKey: 'test-key',
        apiUrl: 'http://vision.invalid/v1/messages',
        missing: [],
        timeoutMs: 10_000,
      },
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].max_tokens, 12_000);
    assert.equal(requests[1].max_tokens, 8_000);
    assert.match(JSON.stringify(requests[1].messages), /不要输出思考过程/);
    assert.equal(result.same, false);
    assert.equal(result.differences.length, 1);
    assert.equal(result.differences[0].type, 'extra');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UI comparison rejects an inconsistent result instead of reporting pages as identical', () => {
  assert.throws(
    () => parseUiComparison(JSON.stringify({
      same: false,
      summary: '页面存在差异，但模型漏掉了差异项',
      differences: [],
    })),
    (error: any) => error?.code === 'VISION_COMPARISON_INVALID',
  );
  assert.throws(
    () => parseUiComparison(JSON.stringify({ summary: '缺少对比结论' })),
    (error: any) => error?.code === 'VISION_COMPARISON_INVALID',
  );
  assert.throws(
    () => parseUiComparison(JSON.stringify({
      same: false,
      differences: [{ type: 'text', title: '价格', description: '   ' }],
    })),
    (error: any) => error?.code === 'VISION_COMPARISON_INVALID',
  );
});

test('manual UI comparison captures current pages without inventing an action', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body || '{}')));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '{"same":true,"summary":"当前页面一致","differences":[]}',
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await compareVisionSyncPages({
      sourceName: 'Mi 10',
      targetName: 'ALN-AL00',
      sourceSize: { width: 1080, height: 2340 },
      targetSize: { width: 1260, height: 2720 },
      sourceFrame: { buffer: Buffer.from('source-current'), width: 1080, height: 2340 },
      targetFrame: { buffer: Buffer.from('target-current'), width: 1260, height: 2720 },
      comparisonImage: async () => ({ buffer: Buffer.from('settled-comparison') }),
      config: {
        configured: true,
        provider: 'openai',
        model: 'test-vision-model',
        apiKey: 'test-key',
        apiUrl: 'http://vision.invalid/v1/chat/completions',
        missing: [],
        timeoutMs: 10_000,
      },
    });
    const prompt = requests[0].messages[1].content[0].text;
    assert.match(prompt, /没有执行新的手机操作/);
    assert.match(prompt, /左侧是参考设备当前页面/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
