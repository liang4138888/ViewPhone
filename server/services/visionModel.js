import { composeVisionComparison } from './visionComparison.js';

const DEFAULT_TIMEOUT_MS = 120_000;

const ACTION_SYSTEM_PROMPT = `你是 ViewPhone 的手机 UI 自动化操作器。你会收到一张当前手机截图和完整测试目标。

你的工作方式与 ai-phone 的 VLM Runner 一致：每一轮只看当前截图，决定唯一一个下一步动作；动作执行后系统会重新截图，再让你判断下一步。不要试图一次输出整段脚本。

必须只输出一个 JSON 对象，不要 Markdown，不要解释 JSON 之外的内容：
{
  "thought": "对当前页面的简短观察，以及这一步如何推进目标",
  "expected": "这个动作完成后，下一张截图应出现的可验证结果",
  "action": {
    "type": "click | long_press | swipe | scroll | input | back | home | wait | finished | assert_fail",
    "description": "用中文描述这一动作"
  }
}

动作参数：
- click: {"type":"click","description":"点击顶部搜索框","x":500,"y":130}
- long_press: 同上，另可带 "duration":700
- swipe: {"type":"swipe","description":"向上滑动商品列表","fromX":500,"fromY":750,"toX":500,"toY":250,"duration":500}
- scroll: {"type":"scroll","description":"向下浏览商品","direction":"down","x":500,"y":500}。direction 指想看的内容方向：down 看下方，up 看上方，right 看右侧，left 看左侧。
- input: {"type":"input","description":"输入牛奶","text":"牛奶"}
- back/home/wait: {"type":"wait","description":"等待页面加载","seconds":2}
- finished: {"type":"finished","description":"购物车页面已出现刚加入的商品"}
- assert_fail: {"type":"assert_fail","description":"多次尝试后仍未找到购物车入口"}

坐标 x/y、fromX/fromY/toX/toY 一律使用相对整张截图的 0-1000 整数坐标。不要返回设备像素坐标。点击目标不明确时先滚动或返回查看，绝不能盲点。

输入文字前，先确认输入框已在当前截图里获得焦点；如果尚未点击输入框，本轮只输出 click。
wait 的 seconds 必须在 1-30 之间。
只有当前截图已经满足测试目标的可见证据时，才能输出 finished。
任务确实无法继续或预期结果明确不满足时，输出 assert_fail，并在 description 中说明期望、当前状态和尝试过的动作。
expected 必须描述动作后应能直接看到的页面、选中状态、文字或控件变化，不能只写“操作成功”。
`;

const VERDICT_SYSTEM_PROMPT = `你是手机自动化任务的最终验收裁决器。你只验收，不操作手机。

必须只输出一个 JSON 对象：
{"verdict":"PASS","reason":"指向过程或最终画面的完成证据"}
或
{"verdict":"FAIL","reason":"说明明确要求与哪一步或最终状态矛盾"}

判断规则：
- 执行历史记录的是每一步执行前的当前观察，随后动作可能改变页面；后续步骤或最终画面可以证明之前的未满足状态已经解决。
- 中间页面不必在最终截图中重复出现；但主模型声称完成不是证据。
- 不要因为路径、同义文案或界面表达的合理差异判失败。
- 只有明确要求被跳过、错误页面/状态、数值不符或任务尚未完成等明显矛盾时才 FAIL。
- 没有明确矛盾，且执行过程和最终画面共同支持完成时 PASS。
`;

const STEP_AUDIT_SYSTEM_PROMPT = `你是独立的手机 UI 测试审计员。你只检查刚刚执行的一个动作是否达到预期，不负责继续操作手机，也不判断整个测试目标最终是否完成。

你会看到两张截图：before 是动作执行前，after 是动作执行后。请比较实际页面变化与动作预期。

必须只输出一个 JSON 对象：
{
  "status": "pass | issue | unverified",
  "severity": "critical | major | minor",
  "category": "navigation | no_response | repeat_action | unexpected_dialog | ui_mismatch | data_mismatch | other",
  "title": "简短的问题标题；通过时为空",
  "expected": "这一步原本应出现的结果",
  "actual": "截图里实际出现的结果",
  "reason": "判断依据"
}

判定规则：
- 点击后进入了与预期不同的页面、点击命中了错误控件、页面显示错误/空状态，记为 navigation，通常为 major；关键流程被阻断时可为 critical。
- 点击、滑动或返回后页面完全无变化，或者动作没有生效，记为 no_response，通常为 major。
- 本轮动作与紧邻的上一轮动作完全相同，且页面没有推进，记为 repeat_action。正常连续滚动或连续输入不强制算问题。
- 出现遮挡、异常弹窗、错误提示或非预期登录/权限页，记为 unexpected_dialog 或 ui_mismatch。
- 文字、数值、选中状态或业务内容不符合预期，记为 data_mismatch。
- 只有截图证据明确显示动作已达到预期时才返回 pass。无法确认时返回 unverified，不能猜测通过或猜测问题。
- 不要把系统状态栏的时间、电量和网络变化当成业务问题。
- after 页面即使不是整个测试目标的最终页，只要符合本轮动作的 expected，也应该 pass。
`;

const SYNC_SYSTEM_PROMPT = `你是 ViewPhone 的多设备页面视觉同步器。你会收到一张左右拼接的对比图：左半部分是操作来源手机，中间有白色竖线分隔，右半部分是目标手机。你不会操作手机，只负责判断目标截图中是否存在与来源操作相同的可视目标。

必须只输出一个 JSON 对象，不要 Markdown，不要输出 JSON 以外的解释：
- 点击或长按（坐标只相对右侧目标画面）：{"match":true,"reason":"目标页上的同一控件","x":500,"y":200}
- 滑动（坐标只相对右侧目标画面）：{"match":true,"reason":"目标页上的同一滚动区域","fromX":500,"fromY":760,"toX":500,"toY":240}
- 无法安全匹配：{"match":false,"reason":"目标页没有看到同一控件，已跳过"}

坐标使用相对右半部分目标画面的 0-1000 整数坐标，不使用设备像素，也不使用整张拼接图的坐标。必须依据控件的文字、图标、位置关系、页面结构和动作语义匹配，不能仅因为坐标相近就认为匹配。目标页与来源页不同、目标控件被遮挡、页面正在加载或无法确定时返回 match=false。宁可跳过，也不能猜测点击。
`;

const PAGE_COMPARISON_SYSTEM_PROMPT = `你是 ViewPhone 的多设备 UI 一致性对比器。你会收到一张左右拼接的截图：左半部分是参考手机页面，右半部分是另一台手机的可对比页面。

你只分析两个页面中的可见 UI 差异，不操作设备。忽略时间、电量、网络信号和状态栏等设备系统噪声，也忽略两台手机因缩放造成的尺寸差异。重点找出：
- 来源有但目标缺失的内容或控件
- 目标额外出现的内容或控件
- 同位置控件的文字、价格、数量或状态不同
- 控件顺序、间距、换行或位置明显不同
- 按钮/标签的形态或选中状态明显不同

必须只输出一个 JSON 对象，不要 Markdown，也不要输出 JSON 以外内容：
{
  "same": false,
  "summary": "一句话概述主要差异",
  "differences": [
    {
      "type": "missing | extra | text | layout | style | other",
      "title": "简短、明确的差异标题",
      "description": "来源与目标分别看到了什么",
      "region": {"x": 500, "y": 300, "width": 200, "height": 80}
    }
  ]
}

region 只表示右侧目标页面的 0-1000 归一化坐标，用于圈出差异。没有可定位区域时可省略 region。最多返回 12 项，去掉重复项。如果左右页面除系统状态栏外没有明显差异，返回 {"same":true,"summary":"未发现明显 UI 差异","differences":[]}。不要因为无法确认而对正常页面强行列出差异。`;

export function getVisionModelConfig(env = process.env) {
  const explicitProvider = firstValue(env.VISION_MODEL_PROVIDER).toLowerCase();
  const anthropicBase = firstValue(env.ANTHROPIC_BASE_URL);
  const openaiBase = firstValue(
    env.OPENAI_BASE_URL,
    env.ARK_BASE_URL,
    env.VISION_MODEL_BASE_URL,
  );
  const provider = explicitProvider || (anthropicBase || env.ANTHROPIC_AUTH_TOKEN ? 'anthropic' : 'openai');
  const apiKey = firstValue(
    env.VISION_MODEL_API_KEY,
    provider === 'anthropic' ? env.ANTHROPIC_AUTH_TOKEN : undefined,
    provider === 'anthropic' ? env.ANTHROPIC_API_KEY : undefined,
    env.OPENAI_API_KEY,
    env.ARK_API_KEY,
  );
  const model = firstValue(
    env.VISION_MODEL_NAME,
    provider === 'anthropic' ? env.ANTHROPIC_MODEL : undefined,
    provider === 'anthropic' ? env.ANTHROPIC_DEFAULT_SONNET_MODEL : undefined,
    env.OPENAI_MODEL,
  );
  const apiUrl = firstValue(
    env.VISION_MODEL_API_URL,
    provider === 'anthropic'
      ? messagesEndpoint(anthropicBase)
      : completionsEndpoint(firstValue(env.VISION_MODEL_BASE_URL, openaiBase)),
  );
  const missing = [
    !apiKey && 'VISION_MODEL_API_KEY',
    !model && 'VISION_MODEL_NAME',
    !apiUrl && 'VISION_MODEL_API_URL',
  ].filter(Boolean);
  return {
    configured: missing.length === 0,
    provider: provider === 'anthropic' ? 'anthropic' : 'openai',
    model,
    apiKey,
    apiUrl,
    missing,
    timeoutMs: clampTimeout(env.VISION_MODEL_TIMEOUT_MS),
  };
}

export function publicVisionModelConfig(env = process.env) {
  const config = getVisionModelConfig(env);
  return {
    configured: config.configured,
    provider: config.provider,
    model: config.model || '',
    missing: config.missing,
  };
}

export async function decideVisionAction({
  goal,
  history,
  screenshot,
  historyRounds = 10,
  config = getVisionModelConfig(),
}) {
  return decideVisionActionWithJsonRetry({
    goal,
    history,
    screenshot,
    historyRounds,
    config,
  });
}

/**
 * Map one source gesture to the visually corresponding control or scroll
 * region in a target screenshot. Unlike the semantic/OCR path, this asks the
 * configured vision model to compare both images and understand their layout.
 */
export async function mapVisionSyncAction({
  action,
  sourceSize,
  targetSize,
  sourceFrame,
  targetFrame,
  config = getVisionModelConfig(),
  comparisonImage = composeVisionComparison,
}) {
  requireConfigured(config);
  const sourceImage = visionImage(sourceFrame, sourceSize);
  const targetImage = visionImage(targetFrame, targetSize);
  const comparison = await comparisonImage(sourceImage, targetImage);
  const sourceAction = normalizedSyncAction(action, sourceSize);
  const prompt = [
    '来源手机执行了下面的一个动作。',
    `动作：${JSON.stringify(sourceAction)}`,
    `来源触控尺寸：${sourceSize.width} × ${sourceSize.height}`,
    `目标触控尺寸：${targetSize.width} × ${targetSize.height}`,
    '图中左侧是动作发生前的来源截图，白色竖线右侧是当前目标截图。请在右侧目标画面里找到与来源动作指向的相同控件、文字、图标或滚动区域。页面有合理的位置和样式差异时仍可匹配；页面不一致或目标不可见时拒绝。',
    '只返回约定的 JSON 对象。所有返回坐标都只相对右侧目标画面，使用 0-1000 归一化坐标；不要使用整张拼接图的坐标。',
  ].join('\n\n');

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const requestPrompt = attempt === 1
      ? prompt
      : `${prompt}\n\n上一次输出无法解析或坐标不完整。只返回简短、完整、可直接解析的 JSON 对象。`;
    const raw = await requestVisionText({
      prompt: requestPrompt,
      screenshot: comparison,
      config,
      // Anthropic-compatible gateways may emit a hidden thinking block before
      // the short JSON verdict. A 1,600-token budget can end at max_tokens with
      // only thinking present, which is indistinguishable from an empty answer
      // to the caller unless enough room is reserved for the final text.
      maxTokens: 6_000,
      systemPrompt: SYNC_SYSTEM_PROMPT,
    });
    try {
      return parseVisionSyncDecision(raw, { action, targetSize });
    } catch (error) {
      lastError = error;
      if (!['VISION_OUTPUT_INVALID', 'VISION_SYNC_INVALID'].includes(error?.code)
        || attempt === 2) break;
    }
  }
  throw lastError;
}

export function parseVisionSyncDecision(raw, { action, targetSize }) {
  const payload = parseJsonObject(raw);
  const matched = payload.match === true || payload.matched === true || payload.found === true;
  if (!matched) {
    return {
      matched: false,
      reason: cleanText(payload.reason || payload.message, 300) || '视觉模型未在目标页找到同一控件，已跳过',
    };
  }

  const reason = cleanText(payload.reason || payload.thought || payload.message, 300) || '视觉模型已匹配同一页面目标';
  if (action.type === 'tap' || action.type === 'longPress') {
    const point = normalizedSyncPoint(payload, '', 'x', 'y');
    if (!point) throw visionError('视觉同步没有返回有效的目标点击坐标', 'VISION_SYNC_INVALID');
    return {
      matched: true,
      reason,
      action: {
        ...action,
        ...normalizedToTargetPoint(point, targetSize),
      },
    };
  }
  if (action.type === 'swipe') {
    const from = normalizedSyncPoint(payload, 'from', 'fromX', 'fromY');
    const to = normalizedSyncPoint(payload, 'to', 'toX', 'toY');
    if (!from || !to || (from.x === to.x && from.y === to.y)) {
      throw visionError('视觉同步没有返回有效的目标滑动起止坐标', 'VISION_SYNC_INVALID');
    }
    return {
      matched: true,
      reason,
      action: {
        ...action,
        ...normalizedToTargetPoint(from, targetSize, 'from'),
        ...normalizedToTargetPoint(to, targetSize, 'to'),
      },
    };
  }
  if (action.type === 'text' && Number.isFinite(action.x) && Number.isFinite(action.y)) {
    const point = normalizedSyncPoint(payload, '', 'x', 'y');
    if (!point) throw visionError('视觉同步没有返回有效的目标输入框坐标', 'VISION_SYNC_INVALID');
    return {
      matched: true,
      reason,
      action: { ...action, ...normalizedToTargetPoint(point, targetSize) },
    };
  }
  return { matched: true, reason, action: { ...action } };
}

/**
 * Compare the settled screens after one synchronized action. This is an
 * independent visual pass from action mapping: a page can receive the same
 * gesture while still rendering different controls or content.
 */
export async function compareVisionSyncPages({
  action,
  sourceName,
  targetName,
  sourceSize,
  targetSize,
  sourceFrame,
  targetFrame,
  config = getVisionModelConfig(),
  comparisonImage = composeVisionComparison,
}) {
  requireConfigured(config);
  const sourceImage = visionImage(sourceFrame, sourceSize);
  const targetImage = visionImage(targetFrame, targetSize);
  const comparison = await comparisonImage(sourceImage, targetImage);
  const prompt = [
    `来源设备：${sourceName}`,
    `目标设备：${targetName}`,
    action
      ? `本次对比发生在同步动作 ${action.type} 完成之后`
      : '本次是手动识别当前页面差异，没有执行新的手机操作。',
    `来源触控尺寸：${sourceSize.width} × ${sourceSize.height}`,
    `目标触控尺寸：${targetSize.width} × ${targetSize.height}`,
    '图中左侧是参考设备当前页面，右侧是目标设备当前页面。请只对比页面业务 UI，忽略状态栏时间、电量、信号和设备缩放差异。',
    '找出所有有证据的 UI 不同点，尤其是来源控件在目标上缺失、目标多出的控件、文字/价格/数量和布局/样式差异。',
    '只返回约定 JSON；每项 region 只相对右侧目标画面，使用 0-1000 归一化坐标。',
  ].join('\n\n');

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = await requestVisionText({
        prompt: attempt === 1
          ? prompt
          : `${prompt}\n\n上一次没有返回完整的 UI 对比 JSON。请直接给出最终结论，不要输出思考过程、Markdown 或其他解释。`,
        screenshot: comparison,
        config,
        // A gateway may spend the response budget on hidden reasoning before
        // emitting the comparison. Leave enough room for the concise result,
        // then retry once if no text block is returned at all.
        maxTokens: attempt === 1 ? 12_000 : 8_000,
        systemPrompt: PAGE_COMPARISON_SYSTEM_PROMPT,
      });
      return parseUiComparison(raw);
    } catch (error) {
      lastError = error;
      const retryable = ['VISION_OUTPUT_INVALID', 'VISION_COMPARISON_INVALID', 'VISION_MODEL_EMPTY']
        .includes(error?.code);
      if (!retryable || attempt === 2) break;
      console.warn(`[视觉] 第 1 次页面对比输出异常（${error.code}），正在自动重试`);
    }
  }
  throw lastError;
}

export function parseUiComparison(raw) {
  const payload = parseJsonObject(raw);
  const items = Array.isArray(payload?.differences)
    ? payload.differences
    : Array.isArray(payload?.differentPoints)
      ? payload.differentPoints
      : [];
  const differences = [];
  const seen = new Set();
  for (const item of items.slice(0, 20)) {
    const description = cleanText(
      item?.description || item?.detail || item?.details || item?.target,
      600,
    );
    if (!description) continue;
    const title = cleanText(item?.title || item?.label || item?.element || item?.type, 100)
      || '界面差异';
    const signature = `${normalizeDifferenceType(item?.type)}\n${title}\n${description}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const region = normalizedComparisonRegion(item?.region || item?.bounds || item?.area);
    differences.push({
      type: normalizeDifferenceType(item?.type),
      title,
      description,
      ...(region ? { region } : {}),
    });
    if (differences.length >= 12) break;
  }
  const declaredSame = payload?.same === true
    || payload?.identical === true
    || payload?.match === true;
  const declaredDifferent = payload?.same === false
    || payload?.identical === false
    || payload?.match === false;
  if (differences.length === 0 && !declaredSame) {
    throw visionError(
      declaredDifferent
        ? '视觉模型判断页面不一致，但没有返回有效差异项，请重试'
        : '视觉模型没有返回 UI 差异项或一致结论，无法确认页面是否一致，请重试',
      'VISION_COMPARISON_INVALID',
    );
  }
  const same = differences.length === 0;
  return {
    same,
    summary: cleanText(payload?.summary || payload?.reason || payload?.message, 500)
      || (same ? '未发现明显 UI 差异' : `发现 ${differences.length} 处 UI 差异`),
    differences,
  };
}

function visionImage(frame, size) {
  if (!Buffer.isBuffer(frame?.buffer) || frame.buffer.length === 0) {
    throw visionError('视觉同步缺少来源或目标截图', 'VISION_SYNC_SCREENSHOT_MISSING');
  }
  return {
    buffer: frame.buffer,
    width: Number(frame.width || frame.inputWidth || size?.width) || 1,
    height: Number(frame.height || frame.inputHeight || size?.height) || 1,
  };
}

export async function verifyVisionCompletion({
  goal,
  history,
  screenshot,
  finishClaim,
  config = getVisionModelConfig(),
}) {
  requireConfigured(config);
  const prompt = [
    '你是手机测试流程的最终验收裁决器。',
    '根据完整目标、实际执行过程和最终截图，判断测试目标是否真实完成。',
    '不要因为最终截图没有重复展示中间页面就否定已经发生的过程；也不要把模型声称完成当成证据。',
    '只检查明确目标和预期结果。没有明确矛盾且过程与最终状态支持完成时判 PASS。',
    `完整测试目标：\n${goal}`,
    `主模型申请完成时的说明（不是完成证据）：\n${finishClaim || '未提供'}`,
    `已执行过程：\n${formatHistory(history)}`,
    '只返回一个 JSON 对象：{"verdict":"PASS","reason":"完成证据"} 或 {"verdict":"FAIL","reason":"具体矛盾"}。',
  ].join('\n\n');
  const raw = await requestVisionText({
    prompt,
    screenshot,
    config,
    // Some gateways emit hidden reasoning before the verdict. Keep enough
    // room for both that block and the short final verdict JSON.
    maxTokens: 800,
    systemPrompt: VERDICT_SYSTEM_PROMPT,
  });
  return parseVisionVerdict(raw);
}

/**
 * Audit the result of one action independently from the agent that chose it.
 * This catches wrong navigation and ineffective actions even when the next
 * screenshot lets the agent recover and ultimately complete the goal.
 */
export async function auditVisionStep({
  goal,
  action,
  expectation,
  previousAction,
  before,
  after,
  visualChanged,
  config = getVisionModelConfig(),
}) {
  requireConfigured(config);
  const basePrompt = [
    '请审计刚刚执行的一个动作，只返回约定的 JSON。',
    `完整测试目标：\n${goal}`,
    `本轮动作：${JSON.stringify(publicAction(action))}`,
    `本轮预期：${expectation || action.description || '动作按描述生效'}`,
    previousAction
      ? `紧邻的上一轮动作：${JSON.stringify(publicAction(previousAction))}`
      : '紧邻的上一轮动作：无',
    `画面像素变化比例：${formatRatio(visualChanged)}`,
    'before 截图是动作前，after 截图是动作后。请独立判断本轮动作是否达到预期。',
  ];
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = [
      ...basePrompt,
      attempt === 1
        ? '只输出 JSON。'
        : '上一次输出无效。现在只输出一个简短、完整且可解析的 JSON 对象。',
    ].join('\n\n');
    const raw = await requestVisionText({
      prompt,
      screenshots: [
        { screenshot: before, label: 'before' },
        { screenshot: after, label: 'after' },
      ],
      config,
      maxTokens: attempt === 1 ? 1_200 : 800,
      systemPrompt: STEP_AUDIT_SYSTEM_PROMPT,
    }).catch((error) => {
      lastError = error;
      return '';
    });
    if (!raw) continue;
    try {
      return parseVisionStepAudit(raw, { expectation, action });
    } catch (error) {
      lastError = error;
      if (attempt === 1) console.warn('[视觉] 第 1 次步骤审计输出异常，正在自动重试');
    }
  }
  return {
    status: 'unverified',
    expected: expectation || action?.description || '动作按描述生效',
    actual: '独立步骤审计未返回可用结果',
    reason: lastError instanceof Error ? lastError.message : '视觉模型没有返回步骤审计结果',
  };
}

async function decideVisionActionWithJsonRetry({
  goal,
  history,
  screenshot,
  historyRounds,
  config,
}) {
  requireConfigured(config);
  const basePrompt = [
    '请分析当前截图并决定唯一一个下一步动作。',
    `完整测试目标：\n${goal}`,
    `已执行过程：\n${formatHistory(history, historyRounds)}`,
  ];
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = [
      ...basePrompt,
      attempt === 1
        ? '只返回约定的 JSON 对象。'
        : '上一次答复不是有效 JSON。这次只返回简短、完整、可直接解析的 JSON 对象；不要在 JSON 外输出思考过程或 Markdown。',
    ].join('\n\n');
    const raw = await requestVisionText({
      prompt,
      screenshot,
      config,
      maxTokens: attempt === 1 ? 2_400 : 1_200,
      systemPrompt: ACTION_SYSTEM_PROMPT,
    });
    try {
      return parseVisionDecision(raw, screenshot);
    } catch (error) {
      lastError = error;
      const retryable = ['VISION_OUTPUT_INVALID', 'VISION_ACTION_INVALID']
        .includes(error?.code);
      if (!retryable || attempt === 2) break;
      console.warn(`[视觉] 第 1 次动作输出格式异常（${error.code}），正在自动重试`);
    }
  }
  throw lastError;
}

export function parseVisionDecision(raw, screenshot) {
  const payload = parseJsonObject(raw);
  const thought = String(payload?.thought || '').trim();
  const input = payload?.action || payload?.nextAction
    || (payload?.type || payload?.actionType ? payload : undefined);
  if (!input || typeof input !== 'object') {
    throw visionError('视觉模型没有返回有效动作，请在页面重新执行', 'VISION_ACTION_INVALID');
  }
  const type = normalizeActionType(input.type || input.action);
  const description = cleanText(input.description || input.summary, 300);
  if (!type) throw visionError(`视觉模型返回了不支持的动作：${input.type || input.action || '空'}`, 'VISION_ACTION_INVALID');
  const expected = cleanText(
    input.expected || input.expectation || payload.expected || payload.expectation,
    500,
  );
  const action = { type, description, thought, ...(expected ? { expected } : {}) };
  if (type === 'click' || type === 'long_press') {
    const point = normalizedPoint(input, '', screenshot);
    if (!point) throw visionError(`${type} 动作缺少有效的 0-1000 坐标`, 'VISION_ACTION_INVALID');
    Object.assign(action, point);
    if (type === 'long_press') action.duration = clampInteger(input.duration, 300, 3_000, 700);
  } else if (type === 'swipe') {
    // Prefer coordinate pairs before convenience x/y fields. Models commonly
    // use x/y as a gesture center while start_point/end_point hold the path.
    const start = normalizedPoint(input, 'from', screenshot, false);
    const end = normalizedPoint(input, 'to', screenshot, false);
    if (start && end) {
      Object.assign(action, {
        fromX: start.x,
        fromY: start.y,
        toX: end.x,
        toY: end.y,
      });
    } else {
      const center = normalizedPoint(input, '', screenshot, true) || start || end;
      const direction = normalizeDirection(input.direction)
        || swipeDirectionFromText(description, thought);
      if (!center || !direction) {
        throw visionError('swipe 动作缺少有效的起止坐标或可判断的滑动方向', 'VISION_ACTION_INVALID');
      }
      Object.assign(action, swipeAroundCenter(center, direction));
      action.direction = direction;
    }
    action.duration = clampInteger(input.duration, 150, 3_000, 500);
  } else if (type === 'scroll') {
    const direction = normalizeDirection(input.direction)
      || (description || thought ? directionFromText(description, thought) : 'down');
    action.direction = direction;
    Object.assign(action, normalizedPoint(input, '', screenshot) || { x: 500, y: 500 });
  } else if (type === 'input') {
    action.text = String(input.text ?? input.value ?? input.content ?? '').slice(0, 4_000)
      || textFromDescription(description);
    if (!action.text) throw visionError('input 动作缺少 text', 'VISION_ACTION_INVALID');
  } else if (type === 'wait') {
    action.seconds = clampInteger(input.seconds, 1, 30, 2);
  }
  if (!action.description) action.description = defaultDescription(action);
  return action;
}

export function parseVisionVerdict(raw) {
  let payload;
  try {
    payload = parseJsonObject(raw);
  } catch {
    const first = String(raw || '').split(/\r?\n/)[0].trim();
    const line = first.match(/^(PASS|FAIL)\s*[:：]\s*(.*)$/i);
    if (line) return {
      passed: line[1].toUpperCase() === 'PASS',
      reason: cleanText(line[2], 1_000) || (line[1].toUpperCase() === 'PASS' ? '最终页面满足测试目标' : '最终页面不能满足测试目标'),
    };
    throw visionError('最终验收没有返回 PASS 或 FAIL', 'VISION_VERDICT_INVALID');
  }
  const verdict = String(payload?.verdict || payload?.result || payload?.status || '').trim().toUpperCase();
  if (verdict !== 'PASS' && verdict !== 'FAIL') {
    throw visionError('最终验收没有返回 PASS 或 FAIL', 'VISION_VERDICT_INVALID');
  }
  return {
    passed: verdict === 'PASS',
    reason: cleanText(payload.reason || payload.message, 1_000) || (verdict === 'PASS' ? '最终页面满足测试目标' : '最终页面不能满足测试目标'),
  };
}

export function parseVisionStepAudit(raw, { expectation, action } = {}) {
  let payload;
  try {
    payload = parseJsonObject(raw);
  } catch {
    throw visionError('步骤审计没有返回有效 JSON', 'VISION_AUDIT_INVALID');
  }
  const rawStatus = String(payload?.status || payload?.result || '').trim().toLowerCase();
  const status = rawStatus === 'pass' || rawStatus === 'passed'
    ? 'passed'
    : rawStatus === 'issue' || rawStatus === 'fail' || rawStatus === 'failed'
      ? 'issue'
      : rawStatus === 'unverified'
        ? 'unverified'
        : undefined;
  if (!status) throw visionError('步骤审计没有返回 pass、issue 或 unverified', 'VISION_AUDIT_INVALID');
  const expected = cleanText(payload?.expected || expectation || action?.description, 500);
  const actual = cleanText(payload?.actual || payload?.observation || payload?.reason, 800);
  if (!actual) throw visionError('步骤审计没有说明实际页面状态', 'VISION_AUDIT_INVALID');
  const audit = { status, expected: expected || '动作按描述生效', actual };
  if (payload?.title) audit.title = cleanText(payload.title, 180);
  if (payload?.reason) audit.reason = cleanText(payload.reason, 800);
  if (status === 'issue') {
    const category = normalizeIssueCategory(payload?.category);
    const severity = normalizeIssueSeverity(payload?.severity);
    audit.category = category;
    audit.severity = severity;
    audit.title ||= issueDefaultTitle(category);
  }
  return audit;
}

/** Keep a bounded, redacted sample of malformed model output for diagnostics. */
export function diagnosticVisionOutput(raw, maxLength = 500) {
  return redact(String(raw || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, maxLength));
}

export function actionToDeviceAction(action, screen) {
  const point = (x, y) => ({
    x: normalizedToPixel(x, screen.width),
    y: normalizedToPixel(y, screen.height),
  });
  if (action.type === 'click') return { type: 'tap', ...point(action.x, action.y) };
  if (action.type === 'long_press') return { type: 'longPress', ...point(action.x, action.y), duration: action.duration };
  if (action.type === 'swipe') return {
    type: 'swipe',
    ...Object.fromEntries([
      ['fromX', normalizedToPixel(action.fromX, screen.width)],
      ['fromY', normalizedToPixel(action.fromY, screen.height)],
      ['toX', normalizedToPixel(action.toX, screen.width)],
      ['toY', normalizedToPixel(action.toY, screen.height)],
    ]),
    duration: action.duration,
  };
  if (action.type === 'scroll') {
    const direction = action.direction;
    const vertical = direction === 'down' || direction === 'up';
    // direction describes the content the model wants to inspect. To reveal
    // lower content, the finger moves up; to reveal content on the left, the
    // finger moves right. This also keeps different phone sizes independent.
    const startRatio = direction === 'down' || direction === 'right' ? 0.76 : 0.24;
    const endRatio = direction === 'down' || direction === 'right' ? 0.24 : 0.76;
    return {
      type: 'swipe',
      fromX: vertical ? point(action.x, action.y).x : normalizedToPixel(startRatio * 1_000, screen.width),
      fromY: vertical ? normalizedToPixel(startRatio * 1_000, screen.height) : point(action.x, action.y).y,
      toX: vertical ? point(action.x, action.y).x : normalizedToPixel(endRatio * 1_000, screen.width),
      toY: vertical ? normalizedToPixel(endRatio * 1_000, screen.height) : point(action.x, action.y).y,
      duration: 500,
    };
  }
  if (action.type === 'input') return { type: 'text', text: action.text };
  if (action.type === 'back' || action.type === 'home') return { type: 'key', key: action.type };
  if (action.type === 'wait') return { type: 'wait', seconds: action.seconds };
  return undefined;
}

export function describeCurrentScreen(screenshot) {
  return {
    width: Number(screenshot.width) || 1,
    height: Number(screenshot.height) || 1,
  };
}

async function requestVisionText({ prompt, screenshot, screenshots, config, maxTokens, systemPrompt }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const images = Array.isArray(screenshots) && screenshots.length > 0
    ? screenshots
    : screenshot
      ? [{ screenshot, label: 'current' }]
      : [];
  try {
    const response = config.provider === 'anthropic'
      ? await requestAnthropic({ prompt, images, config, maxTokens, systemPrompt, signal: controller.signal })
      : await requestOpenAiCompatible({ prompt, images, config, maxTokens, systemPrompt, signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw visionError(
        `视觉模型请求失败（HTTP ${response.status}）：${redact(detail).slice(0, 500)}`,
        'VISION_MODEL_REQUEST_FAILED',
        502,
      );
    }
    const payload = await response.json();
    const text = config.provider === 'anthropic' ? anthropicText(payload) : openAiText(payload);
    if (!text) {
      // Content types and stop reasons are safe diagnostics; never log image
      // data, prompts, credentials, or model reasoning blocks.
      console.warn('[视觉响应摘要]', {
        provider: config.provider,
        status: response.status,
        contentTypes: Array.isArray(payload?.content)
          ? payload.content.map((block) => block?.type || 'unknown')
          : [],
        stopReason: payload?.stop_reason || payload?.choices?.[0]?.finish_reason,
      });
      const emptyDetail = emptyResponseDetail(payload);
      throw visionError(
        `视觉模型返回了空结果${emptyDetail ? `（${emptyDetail}）` : ''}`,
        'VISION_MODEL_EMPTY',
        502,
      );
    }
    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw visionError(`视觉模型在 ${Math.round(config.timeoutMs / 1_000)} 秒内没有响应`, 'VISION_MODEL_TIMEOUT', 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function assertVisionModelConnection(config = getVisionModelConfig()) {
  requireConfigured(config);
  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: config.provider === 'anthropic'
      ? {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': config.apiKey,
          Authorization: `Bearer ${config.apiKey}`,
        }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
    body: JSON.stringify(config.provider === 'anthropic'
      ? {
          model: config.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
        }
      : {
          model: config.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
        }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw visionError(
      `视觉模型连接失败（HTTP ${response.status}）：${redact(detail).slice(0, 500)}`,
      'VISION_MODEL_REQUEST_FAILED',
      502,
    );
  }
  return { ok: true, provider: config.provider, model: config.model };
}

function requestAnthropic({ prompt, images, config, maxTokens, systemPrompt, signal }) {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': config.apiKey,
    Authorization: `Bearer ${config.apiKey}`,
  };
  return fetch(config.apiUrl, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      temperature: 0,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          ...images.map(({ screenshot }) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType(screenshot.buffer),
              data: screenshot.buffer.toString('base64'),
            },
          })),
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
}

function requestOpenAiCompatible({ prompt, images, config, maxTokens, systemPrompt, signal }) {
  return fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.map(({ screenshot }) => ({
              type: 'image_url',
              image_url: { url: `data:${mediaType(screenshot.buffer)};base64,${screenshot.buffer.toString('base64')}` },
            })),
          ],
        },
      ],
    }),
  });
}

function anthropicText(payload) {
  if (typeof payload?.content === 'string') return payload.content;
  if (typeof payload?.completion === 'string') return payload.completion;
  const blocks = Array.isArray(payload?.content)
    ? payload.content
    : Array.isArray(payload?.message?.content)
      ? payload.message.content
      : [];
  const text = blocks
    .filter((block) => (
      ['text', 'output_text'].includes(block?.type)
      && (typeof block.text === 'string' || typeof block.output_text === 'string')
    ))
    .map((block) => block.text || block.output_text)
    .join('\n');
  return text || openAiText(payload);
}

function openAiText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => item?.text || '').join('\n');
  return '';
}

function emptyResponseDetail(payload) {
  if (payload?.error) return '网关返回错误对象';
  const types = Array.isArray(payload?.content)
    ? [...new Set(payload.content.map((block) => block?.type).filter(Boolean))]
    : [];
  if (types.length === 1 && types[0] === 'thinking' && payload?.stop_reason === 'max_tokens') {
    return '模型只输出了思考内容，正式结果前输出额度已耗尽';
  }
  if (types.length > 0) return `仅收到 ${types.join('、')} 内容块`;
  return '';
}

function parseJsonObject(raw) {
  const original = String(raw || '').trim();
  const text = original.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  // Repair raw control characters inside JSON strings before requiring a
  // retry. These are common in model descriptions and otherwise make an
  // otherwise valid object fail JSON.parse.
  const sanitized = sanitizeJsonControlCharacters(text);
  if (sanitized !== text) candidates.push(sanitized);
  if (start >= 0 && sanitized.lastIndexOf('}') > start) {
    candidates.push(sanitized.slice(start, sanitized.lastIndexOf('}') + 1));
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Try the next candidate.
    }
  }
  const sample = diagnosticVisionOutput(original, 260);
  throw visionError(
    `视觉模型输出不是有效 JSON，请重试${sample ? `。模型返回：${sample}` : '。模型返回为空'}`,
    'VISION_OUTPUT_INVALID',
    502,
  );
}

function sanitizeJsonControlCharacters(text) {
  let inString = false;
  let escaped = false;
  let output = '';
  for (const character of String(text || '')) {
    if (inString) {
      if (escaped) {
        output += character;
        escaped = false;
        continue;
      }
      if (character === '\\') {
        output += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        output += character;
        inString = false;
        continue;
      }
      if (character === '\n' || character === '\r' || character === '\t') {
        output += character === '\t' ? '\\t' : character === '\n' ? '\\n' : '\\r';
        continue;
      }
      output += character;
      continue;
    }
    output += character;
    if (character === '"') inString = true;
  }
  return output;
}

function normalizedPoint(input, prefix = '', screenshot, allowXY = true) {
  const value = pointValue(input, prefix);
  const xValue = input[`${prefix}X`] ?? input[`${prefix}_x`] ?? value?.[0]
    ?? (allowXY && prefix === '' ? input.x ?? input.left ?? input.clientX : undefined);
  const yValue = input[`${prefix}Y`] ?? input[`${prefix}_y`] ?? value?.[1]
    ?? (allowXY && prefix === '' ? input.y ?? input.top ?? input.clientY : undefined);
  const x = Number(xValue);
  const y = Number(yValue);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const declaredSpace = String(
    input.coordinate_space ?? input.coord_space ?? input.coordinateSpace ?? '',
  ).trim().toLowerCase();
  const pixelSpace = ['absolute', 'pixel', 'pixels', 'device'].includes(declaredSpace)
    || (declaredSpace === '' && (x > 1_000 || y > 1_000));
  if (pixelSpace) {
    const width = Number(screenshot?.width || screenshot?.inputWidth);
    const height = Number(screenshot?.height || screenshot?.inputHeight);
    if (!(width > 1) || !(height > 1)) {
      throw visionError('视觉模型返回像素坐标，但当前缺少截图尺寸', 'VISION_ACTION_INVALID');
    }
    return {
      x: Math.round(Math.max(0, Math.min(1_000, x / width * 1_000))),
      y: Math.round(Math.max(0, Math.min(1_000, y / height * 1_000))),
    };
  }
  return {
    x: Math.round(Math.max(0, Math.min(1_000, x))),
    y: Math.round(Math.max(0, Math.min(1_000, y))),
  };
}

function pointValue(input, prefix) {
  const keys = prefix === 'from'
    ? ['fromPoint', 'from_point', 'startPoint', 'start_point', 'start', 'from']
    : prefix === 'to'
      ? ['toPoint', 'to_point', 'endPoint', 'end_point', 'end', 'to']
      : ['point', 'position', 'coordinate', 'coordinates'];
  for (const key of keys) {
    const result = parsePoint(input?.[key]);
    if (result) return result;
  }
  return undefined;
}

function parsePoint(value) {
  if (Array.isArray(value) && value.length >= 2) {
    return [Number(value[0]), Number(value[1])];
  }
  if (value && typeof value === 'object') {
    const x = Number(value.x ?? value.left);
    const y = Number(value.y ?? value.top);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  if (typeof value === 'string') {
    const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (numbers.length >= 2) return numbers.slice(0, 2);
  }
  return undefined;
}

function normalizeActionType(value) {
  return ({
    click: 'click', tap: 'click', left_click: 'click', point: 'click',
    long_press: 'long_press', longpress: 'long_press',
    swipe: 'swipe', drag: 'swipe',
    scroll: 'scroll',
    input: 'input', type: 'input', type_text: 'input',
    back: 'back', press_back: 'back',
    home: 'home', press_home: 'home',
    wait: 'wait', sleep: 'wait',
    finished: 'finished', finish: 'finished',
    assert_fail: 'assert_fail', fail: 'assert_fail',
  })[String(value || '').trim().toLowerCase()];
}

function normalizeDirection(value) {
  return ({
    up: 'up', top: 'up', 上: 'up', 向上: 'up', 上方: 'up',
    down: 'down', bottom: 'down', 下: 'down', 向下: 'down', 下方: 'down',
    left: 'left', 左: 'left', 向左: 'left', 左侧: 'left',
    right: 'right', 右: 'right', 向右: 'right', 右侧: 'right',
  })[String(value || '').trim().toLowerCase()];
}

function normalizeIssueCategory(value) {
  const category = String(value || '').trim().toLowerCase();
  return ({
    navigation: 'navigation', wrong_page: 'navigation', wrong_control: 'navigation',
    no_response: 'no_response', ineffective: 'no_response', no_change: 'no_response',
    repeat_action: 'repeat_action', repeated: 'repeat_action', repeat: 'repeat_action',
    unexpected_dialog: 'unexpected_dialog', dialog: 'unexpected_dialog', popup: 'unexpected_dialog',
    ui_mismatch: 'ui_mismatch', layout: 'ui_mismatch', style: 'ui_mismatch',
    data_mismatch: 'data_mismatch', data: 'data_mismatch', text: 'data_mismatch',
  })[category] || 'other';
}

function normalizeIssueSeverity(value) {
  const severity = String(value || '').trim().toLowerCase();
  return ['critical', 'major', 'minor'].includes(severity) ? severity : 'major';
}

function issueDefaultTitle(category) {
  return ({
    navigation: '动作进入非预期页面',
    no_response: '操作后页面没有响应',
    repeat_action: '重复执行相同操作',
    unexpected_dialog: '出现非预期弹窗或提示',
    ui_mismatch: '页面 UI 与预期不一致',
    data_mismatch: '页面业务内容与预期不一致',
    other: '动作结果与预期不一致',
  })[category] || '动作结果与预期不一致';
}

function publicAction(action) {
  return Object.fromEntries(
    ['type', 'description', 'x', 'y', 'fromX', 'fromY', 'toX', 'toY', 'direction', 'text', 'seconds']
      .filter((key) => action?.[key] !== undefined)
      .map((key) => [key, action[key]]),
  );
}

function formatRatio(value) {
  return Number.isFinite(value) ? `${(Math.max(0, value) * 100).toFixed(2)}%` : '未知';
}

function swipeDirectionFromText(...values) {
  const text = values.filter(Boolean).join(' ');
  const match = text.match(/(?:向|往)?(上|下|左|右)(?:方|侧)?(?:滑|拖|划|滚)/)
    || text.match(/(?:swipe|drag|scroll)\s+(up|down|left|right)/i);
  return normalizeDirection(match?.[1]);
}

function directionFromText(...values) {
  const text = values.filter(Boolean).join(' ');
  const match = text.match(/(?:向|往)?(上|下|左|右)(?:方|侧)?(?:浏览|查看|滑|拖|划|滚)?/)
    || text.match(/\b(up|down|left|right)\b/i);
  return normalizeDirection(match?.[1]);
}

function swipeAroundCenter(center, direction) {
  const vertical = direction === 'up' || direction === 'down';
  // For swipe, direction is the finger movement. The separate scroll action
  // uses content-view direction instead (scroll down = finger moves up).
  const startRatio = direction === 'up' || direction === 'left' ? 0.76 : 0.24;
  const endRatio = direction === 'up' || direction === 'left' ? 0.24 : 0.76;
  return vertical
    ? { fromX: center.x, fromY: Math.round(startRatio * 1_000), toX: center.x, toY: Math.round(endRatio * 1_000) }
    : { fromX: Math.round(startRatio * 1_000), fromY: center.y, toX: Math.round(endRatio * 1_000), toY: center.y };
}

function textFromDescription(description) {
  const match = String(description || '').match(/(?:输入|填写|键入)\s*[「“"'‘](.+?)[」”"'’]/);
  return match?.[1]?.slice(0, 4_000) || '';
}

function defaultDescription(action) {
  return ({
    click: '点击页面目标', long_press: '长按页面目标', swipe: '滑动页面', scroll: '滚动页面',
    input: '输入文字', back: '返回上一页', home: '回到手机主页', wait: '等待页面稳定',
    finished: '确认测试目标已完成', assert_fail: '测试目标无法完成',
  })[action.type];
}

function formatHistory(history = [], maximumRounds = 10) {
  if (!Array.isArray(history) || history.length === 0) return '尚未执行动作。';
  const limit = Math.max(1, Math.min(100, Number(maximumRounds) || 10));
  return history.slice(-limit).map((item) => {
    const status = item.passed === false ? '失败' : item.passed === true ? '成功' : item.status || '已执行';
    return `第 ${item.index} 步\n当前观察与判断：${item.thought || '(无)'}\n随后动作：${item.description || item.action || '动作'}\n执行状态：${status}`;
  }).join('\n');
}

function messagesEndpoint(base) {
  if (!base) return '';
  const normalized = base.replace(/\/$/, '');
  if (/\/messages$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

function completionsEndpoint(base) {
  if (!base) return '';
  const normalized = base.replace(/\/$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function normalizedToPixel(value, size) {
  const maximum = Math.max(1, Number(size) || 1);
  return Math.max(0, Math.min(maximum - 1, Math.round((Number(value) / 1_000) * maximum)));
}

function normalizedSyncPoint(input, prefix, xKey, yKey) {
  const value = input?.[prefix ? `${prefix}Point` : 'point']
    ?? input?.[prefix ? `${prefix}_point` : 'position'];
  const x = Number(input?.[xKey] ?? (prefix ? value?.[0] : value?.x));
  const y = Number(input?.[yKey] ?? (prefix ? value?.[1] : value?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {
    x: Math.max(0, Math.min(1_000, x)),
    y: Math.max(0, Math.min(1_000, y)),
  };
}

function normalizeDifferenceType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (['missing', 'extra', 'text', 'layout', 'style', 'other'].includes(type)) return type;
  if (/missing|absent|缺失|来源有|目标无/.test(type)) return 'missing';
  if (/extra|added|新增|多出|额外/.test(type)) return 'extra';
  if (/text|copy|content|文案|文字|价格|数量/.test(type)) return 'text';
  if (/layout|position|spacing|布局|位置|间距/.test(type)) return 'layout';
  if (/style|color|shape|样式|颜色|形态/.test(type)) return 'style';
  return 'other';
}

function normalizedComparisonRegion(value) {
  if (!value || typeof value !== 'object') return undefined;
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.top);
  const width = Number(value.width ?? (value.right !== undefined ? value.right - x : undefined));
  const height = Number(value.height ?? (value.bottom !== undefined ? value.bottom - y : undefined));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  const left = Math.max(0, Math.min(1_000, x));
  const top = Math.max(0, Math.min(1_000, y));
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.min(1_000 - left, width)),
    height: Math.round(Math.min(1_000 - top, height)),
  };
}

function normalizedToTargetPoint(point, targetSize, prefix = '') {
  const x = Math.max(0, Math.min(targetSize.width - 1, Math.round(point.x / 1_000 * targetSize.width)));
  const y = Math.max(0, Math.min(targetSize.height - 1, Math.round(point.y / 1_000 * targetSize.height)));
  return prefix ? { [`${prefix}X`]: x, [`${prefix}Y`]: y } : { x, y };
}

function normalizedSyncAction(action, sourceSize) {
  const normalized = (x, y) => ({
    x: Math.round(x / Math.max(1, sourceSize.width) * 1_000),
    y: Math.round(y / Math.max(1, sourceSize.height) * 1_000),
  });
  if (action.type === 'tap' || action.type === 'longPress') {
    return { type: action.type, ...normalized(action.x, action.y) };
  }
  if (action.type === 'swipe') {
    return {
      type: action.type,
      from: normalized(action.fromX, action.fromY),
      to: normalized(action.toX, action.toY),
    };
  }
  if (action.type === 'text') {
    return {
      type: action.type,
      text: action.text,
      ...(Number.isFinite(action.x) && Number.isFinite(action.y)
        ? normalized(action.x, action.y)
        : {}),
    };
  }
  return { ...action };
}

function mediaType(buffer) {
  return buffer?.[0] === 0xff && buffer?.[1] === 0xd8 ? 'image/jpeg' : 'image/png';
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(minimum, Math.min(maximum, number)));
}

function clampTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 10_000 ? Math.min(number, 300_000) : DEFAULT_TIMEOUT_MS;
}

function cleanText(value, maximum) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function requireConfigured(config) {
  if (config.configured) return;
  throw visionError(
    `视觉模型尚未配置：${config.missing.join('、') || '缺少模型参数'}`,
    'VISION_MODEL_NOT_CONFIGURED',
    503,
  );
}

function redact(value) {
  return String(value || '').replace(/(?:sk-|key-)[A-Za-z0-9_-]{12,}/g, '<已隐藏>');
}

function visionError(message, code, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode });
}
