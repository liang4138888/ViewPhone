import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDeterministicAudit,
  buildVisionQuality,
  compareElements,
  findVisibleElement,
  parseTestFlow,
  previewTestFlow,
  testRunAssetPath,
} from '../server/services/testFlow.js';
import {
  actionToDeviceAction,
  parseVisionStepAudit,
  parseVisionDecision,
  parseVisionVerdict,
} from '../server/services/visionModel.js';

const before = {
  width: 1080,
  height: 2340,
  nodes: [
    node('我的', 40, 2100, 240, 2200),
    node('待支付', 80, 500, 360, 620),
    node('订单列表', 80, 1200, 540, 1300),
  ],
};

test('Chinese test flow is split into executable semantic steps', () => {
  const steps = parseTestFlow(
    '点击“我的” → 向上滑动 → 点击待支付，然后等待页面出现全部订单',
  );
  assert.deepEqual(
    steps.map((step) => [step.type, step.target || step.direction]),
    [
      ['tap', '我的'],
      ['swipe', '向上'],
      ['tap', '待支付'],
      ['waitFor', '全部订单'],
    ],
  );
});

test('input commands do not treat the preposition as the field name', () => {
  const [step] = parseTestFlow('在搜索框输入苹果');
  assert.deepEqual(step, {
    index: 1,
    source: '在搜索框输入苹果',
    type: 'input',
    target: '',
    value: '苹果',
    description: '输入「苹果」',
  });
});

test('a visible control keeps “按钮” when it is part of its real label', () => {
  const [step] = parseTestFlow('点击同步点击按钮');
  assert.equal(step.target, '同步点击按钮');
  const layout = {
    width: 1080,
    height: 2340,
    nodes: [node('同步点击按钮', 300, 1155, 783, 1239)],
  };
  assert.equal(findVisibleElement(layout, step.target)?.node.text, '同步点击按钮');
});

test('unknown commands fail explicitly instead of tapping guessed coordinates', () => {
  assert.throws(
    () => parseTestFlow('随便操作一下'),
    /无法识别步骤/,
  );
});

test('vision preview keeps a free-form goal instead of rejecting its final verification', () => {
  const goal = '点击底部栏 → 输入“牛奶” → 查看商品列表是否有刚加入购物车的商品';
  const steps = previewTestFlow(goal);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'vision');
  assert.equal(steps[0].target, goal);
});

test('vision swipe accepts a center point and a finger direction on every screen size', () => {
  const action = parseVisionDecision(JSON.stringify({
    thought: '当前页面看不到列表项目八，需要向上滑动',
    action: {
      type: 'swipe',
      description: '向上滑动页面',
      x: 500,
      y: 300,
      duration: 500,
    },
  }));
  const small = actionToDeviceAction(action, { width: 1080, height: 2340 });
  const large = actionToDeviceAction(action, { width: 1260, height: 2720 });
  assert.equal(small.type, 'swipe');
  assert.equal(large.type, 'swipe');
  assert.ok((small.fromY ?? 0) > (small.toY ?? 0));
  assert.ok((large.fromY ?? 0) > (large.toY ?? 0));
  assert.ok((large.toX ?? 0) <= 1260);
  assert.ok((large.toY ?? 0) <= 2720);
});

test('vision action parsing handles scroll, start_point/end_point and absolute pixels', () => {
  const scroll = parseVisionDecision(JSON.stringify({
    action: { type: 'scroll', description: '向下浏览列表', direction: 'down' },
  }));
  assert.equal(scroll.type, 'scroll');
  assert.equal(scroll.direction, 'down');

  const drag = parseVisionDecision(JSON.stringify({
    action: {
      type: 'drag',
      description: '拖动卡片',
      start_point: [250, 750],
      end_point: [250, 250],
    },
  }));
  assert.deepEqual(
    [drag.fromX, drag.fromY, drag.toX, drag.toY],
    [250, 750, 250, 250],
  );
  const mapped = actionToDeviceAction(drag, { width: 1080, height: 2340 });
  assert.deepEqual(
    [mapped.fromX, mapped.fromY, mapped.toX, mapped.toY],
    [270, 1755, 270, 585],
  );

  const absolute = parseVisionDecision(JSON.stringify({
    action: {
      type: 'click',
      description: '点击按钮',
      coordinate_space: 'absolute',
      x: 540,
      y: 1170,
    },
  }), { width: 1080, height: 2340 });
  assert.deepEqual([absolute.x, absolute.y], [500, 500]);

  const wait = parseVisionDecision(JSON.stringify({
    action: { type: 'wait', description: '等待商品页加载完成', seconds: 3 },
  }));
  assert.deepEqual(actionToDeviceAction(wait, { width: 1080, height: 2340 }), {
    type: 'wait',
    seconds: 3,
  });
});

test('vision action parsing repairs literal newlines inside a JSON description', () => {
  const action = parseVisionDecision(`{
    "thought": "页面仍在加载
需要等待输入框出现",
    "action": {
      "type": "wait",
      "description": "等待搜索框加载",
      "seconds": 2
    }
  }`);
  assert.equal(action.type, 'wait');
  assert.equal(action.seconds, 2);
  assert.match(action.thought, /页面仍在加载/);
});

test('independent acceptance only trusts PASS/FAIL and keeps its reason', () => {
  assert.deepEqual(parseVisionVerdict('{"verdict":"PASS","reason":"商品出现在列表"}'), {
    passed: true,
    reason: '商品出现在列表',
  });
  assert.deepEqual(parseVisionVerdict('FAIL: 最终页面仍是登录页'), {
    passed: false,
    reason: '最终页面仍是登录页',
  });
  assert.throws(() => parseVisionVerdict('已经完成'), /PASS 或 FAIL/);
});

test('vision actions declare a visible outcome and step audits report a wrong destination', () => {
  const action = parseVisionDecision(JSON.stringify({
    thought: '点击待支付入口',
    expected: '进入待支付订单列表并显示订单状态',
    action: { type: 'click', description: '点击待支付', x: 110, y: 415 },
  }));
  assert.equal(action.expected, '进入待支付订单列表并显示订单状态');
  const audit = parseVisionStepAudit(JSON.stringify({
    status: 'issue',
    severity: 'major',
    category: 'navigation',
    title: '点击待支付进入错误页面',
    expected: '进入待支付订单列表',
    actual: '进入了发票服务页面',
    reason: 'after 截图标题为发票服务',
  }), { action });
  assert.equal(audit.status, 'issue');
  assert.equal(audit.category, 'navigation');
  assert.equal(audit.title, '点击待支付进入错误页面');
});

test('tester review reports issues even when the vision agent later completes the goal', () => {
  const run = {
    status: 'completed',
    verdict: { passed: true, reason: '最终进入全部订单页' },
    steps: [
      {
        index: 4,
        status: 'passed',
        image: '/step-04.jpg',
        audit: {
          status: 'issue',
          severity: 'major',
          category: 'navigation',
          title: '点击待支付进入错误页面',
          expected: '进入待支付订单列表',
          actual: '进入了发票服务页面',
        },
      },
      { index: 5, status: 'passed', audit: { status: 'passed', expected: '返回我的页面', actual: '返回成功' } },
    ],
  };
  const quality = buildVisionQuality(run);
  assert.equal(quality.status, 'issues');
  assert.equal(quality.issueCount, 1);
  assert.match(quality.summary, /目标已完成，但发现 1 个过程问题/);
  assert.equal(quality.issues[0].recovered, true);
});

test('identical clicks are flagged even if the visual auditor incorrectly reports pass', () => {
  const action = { type: 'click', description: '点击全部', x: 100, y: 300 };
  const audit = applyDeterministicAudit(
    { status: 'passed', expected: '展示全部订单', actual: '页面显示全部订单' },
    action,
    action,
    { changedRatio: 0 },
  );
  assert.equal(audit.status, 'issue');
  assert.equal(audit.category, 'repeat_action');
});

test('visible elements are resolved by semantic text and bounded target area', () => {
  const result = findVisibleElement(before, '待支付');
  assert.equal(result?.node.text, '待支付');
  assert.equal(result?.score, 100);
  assert.equal(findVisibleElement(before, '购物车'), undefined);
});

test('each test action exposes one result image and no before/after pair', () => {
  const runId = '12345678-1234-1234-1234-123456789abc';
  assert.match(testRunAssetPath(runId, 'step-01.png') || '', /step-01\.png$/);
  assert.equal(testRunAssetPath(runId, 'step-01-before.png'), undefined);
  assert.equal(testRunAssetPath(runId, 'step-01-after.png'), undefined);
});

test('a full-page WebView label is not treated as a tappable element', () => {
  const layout = {
    width: 1080,
    height: 2340,
    nodes: [
      {
        ...node('ViewPhone 同步测试', 0, 200, 1080, 2200),
        kind: 'android.webkit.WebView',
        scrollable: true,
        clickable: false,
      },
      node('同步点击按钮', 40, 400, 1040, 520),
    ],
  };
  assert.equal(findVisibleElement(layout, 'ViewPhone 同步测试'), undefined);
  assert.equal(findVisibleElement(layout, '同步点击按钮')?.node.text, '同步点击按钮');
});

test('element comparison reports added, removed, and repositioned labels', () => {
  const after = {
    width: 1080,
    height: 2340,
    nodes: [
      node('我的', 40, 2100, 240, 2200),
      node('待支付', 80, 1000, 360, 1120),
      node('新提示', 80, 1500, 540, 1600),
    ],
  };
  const diff = compareElements(before, after);
  assert.deepEqual(diff.added.map((item) => item.text), ['新提示']);
  assert.deepEqual(diff.removed.map((item) => item.text), ['订单列表']);
  assert.deepEqual(diff.moved.map((item) => item.text), ['待支付']);
});

function node(
  text: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return {
    text,
    label: '',
    hint: '',
    id: '',
    kind: 'Text',
    bounds: { left, top, right, bottom },
    depth: 0,
    clickable: true,
    scrollable: false,
    enabled: true,
  };
}
