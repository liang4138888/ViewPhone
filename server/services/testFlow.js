import { randomUUID } from 'node:crypto';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { createAdapter, findDevice } from './devices.js';
import { compareImages } from './imageDiff.js';
import { recognizeOcrFrame } from './ocrLayout.js';
import { publishSettledFrame, waitForPageSettled } from './pageSettle.js';
import { archiveTestRun } from './archiveStore.js';
import { run } from '../utils/command.js';
import {
  actionToDeviceAction,
  auditVisionStep,
  decideVisionAction,
  getVisionModelConfig,
  verifyVisionCompletion,
} from './visionModel.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = config.testRunsRoot
  ? resolve(config.testRunsRoot)
  : join(root, '.artifacts/test-runs');
const runs = new Map();
const activeDevices = new Set();
const RUN_ID = /^[a-f0-9-]{20,40}$/i;
const MAX_INSTRUCTIONS = 40;
const MAX_INSTRUCTION_LENGTH = 4_000;
const STAGE_LABELS = {
  pending: '待执行',
  preparing: '准备动作',
  readingScreen: '读取当前画面',
  recognizing: '页面识别',
  thinking: '视觉决策',
  locating: '定位目标',
  acting: '执行动作',
  stabilizing: '等待稳定',
  capturingResult: '保存执行结果',
  comparing: '对比差异',
  verifying: '独立验收',
  done: '完成',
  failed: '失败',
};

/** Parse known instructions; vision mode receives any natural-language goal. */
export function parseTestFlow(input, { allowUnknown = false } = {}) {
  if (typeof input !== 'string') throw flowError('测试流程必须是文字');
  if (input.length > MAX_INSTRUCTION_LENGTH) {
    throw flowError(`测试流程不能超过 ${MAX_INSTRUCTION_LENGTH} 个字符`);
  }
  const clauses = splitGoalInstructions(input, { allowUnknown });
  if (clauses.length === 0) throw flowError('请输入至少一步测试流程');
  if (clauses.length > MAX_INSTRUCTIONS) {
    throw flowError(`一次最多执行 ${MAX_INSTRUCTIONS} 步`);
  }
  return clauses.map((text, index) => {
    let instruction;
    try {
      instruction = parseInstruction(text);
    } catch (error) {
      if (!allowUnknown) throw error;
      instruction = { type: 'vision', target: text, description: text };
    }
    return {
      index: index + 1,
      source: text,
      ...instruction,
      description: instruction.description || text,
    };
  });
}

export function previewTestFlow(input) {
  return placeholderSteps(input);
}

export function placeholderSteps(input) {
  const text = String(input || '').trim();
  return text ? [{
    index: 1,
    source: '目标已接收',
    type: 'vision',
    description: '视觉模型将根据当前截图逐步决定操作',
    target: text,
  }] : [];
}

export function parseInstruction(raw) {
  const text = normalizeCommand(raw)
    .replace(/^(?:\d+[.、:：)）]|[-*])\s*/, '')
    .replace(/[。；;]\s*$/, '')
    .trim();
  if (!text) return { type: 'noop', description: '空步骤' };

  let match;
  if ((match = text.match(/^(?:等待|直到)?(?:页面)?(?:出现|显示|打开|加载出)\s*[「“"'‘]?(.+?)[」”"'’]?$/))) {
    return { type: 'waitFor', target: cleanTarget(match[1]), timeoutMs: 10_000 };
  }
  if ((match = text.match(/^(?:等待|停留|稍等)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?$/i))) {
    return { type: 'wait', durationMs: clampDuration(Number(match[1]) * 1000) };
  }
  if (/^(?:等待|稍等)(?:页面)?(?:稳定|加载完成|加载完毕)$/.test(text)) {
    return { type: 'wait', durationMs: 800 };
  }
  if (/^(?:截图|截屏|保存截图)$/.test(text)) {
    return { type: 'screenshot', description: '保存当前画面' };
  }
  if ((match = text.match(/^(?:应该|确认|检查|验证)(?:可以)?(?:看到|出现|显示|打开)\s*[「“"'‘]?(.+?)[」”"'’]?$/))) {
    return { type: 'assert', target: cleanTarget(match[1]), timeoutMs: 3_000 };
  }
  if ((match = text.match(/^在\s*[「“"'‘]?(.+?)[」”"'’]?\s*(?:中|里)?\s*(?:输入|填写|键入)\s*[「“"'‘]?(.+?)[」”"'’]?$/))) {
    const target = cleanInputTarget(match[1]);
    const value = cleanTarget(match[2]);
    return {
      type: 'input',
      target,
      value,
      description: target ? `在「${target}」输入「${value}」` : `输入「${value}」`,
    };
  }
  if ((match = text.match(/^(?:输入|填写|键入)\s*[「“"'‘]?(.+?)[」”"'’]?$/))) {
    return { type: 'input', value: cleanTarget(match[1]), description: `输入「${cleanTarget(match[1])}」` };
  }
  if ((match = text.match(/^(?:点击|点按|轻触|选择|点开|打开|进入|按)\s*[「“"'‘]?(.+?)[」”"'’]?$/))) {
    const target = cleanTarget(match[1]);
    if (!target) throw flowError(`“${raw}”缺少要点击的文字`);
    return { type: 'tap', target, description: `点击「${target}」` };
  }
  if ((match = text.match(/^(向上|向下|向左|向右)(?:滑动|滑|滚动|滚|拖)(?:页面|屏幕|列表)?$/))) {
    return { type: 'swipe', direction: match[1], description: `${match[1]}滑动页面` };
  }
  if (/^(?:下拉|下拉刷新)$/.test(text)) return { type: 'swipe', direction: '向下', description: '下拉刷新' };
  if (/^(?:上拉|上拉加载)$/.test(text)) return { type: 'swipe', direction: '向上', description: '上拉加载' };
  if (/^(?:返回|后退|按返回)$/.test(text)) return { type: 'key', key: 'back', description: '返回上一页' };
  if (/^(?:回到)?(?:首页|主页|桌面)$/.test(text)) return { type: 'key', key: 'home', description: '回到手机主页' };
  if (/^(?:最近任务|打开多任务|任务列表)$/.test(text)) return { type: 'key', key: 'recents', description: '打开最近任务' };
  if (/^(?:调高音量|增大音量)$/.test(text)) return { type: 'key', key: 'volumeUp', description: '调高音量' };
  if (/^(?:降低音量|静音)$/.test(text)) return { type: 'key', key: 'volumeDown', description: '降低音量' };
  if (/^(?:锁屏|关闭屏幕)$/.test(text)) return { type: 'key', key: 'power', description: '锁定屏幕' };
  throw flowError(`无法识别步骤“${raw}”。可用“点击…、向上滑动、等待3秒、等待页面出现…、应该看到…”`);
}

export function splitInstructions(input) {
  return String(input || '')
    .replace(/\r/g, '')
    .replace(/[→➜➡]/g, '\n')
    .replace(/然后|接着|下一步|随后/g, '\n')
    .replace(/[，,]\s*(?=(?:点击|点按|轻触|选择|点开|打开|进入|按|向上|向下|向左|向右|输入|填写|键入|等待|应该|确认|检查|验证|截图|截屏|返回|后退|首页|主页|最近任务))/g, '\n')
    .split(/[\n;；。]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Offline mode keeps the exact-command parser. Vision mode only needs a bounded
 * goal, so its punctuation and conditional clauses must not be split apart.
 */
function splitGoalInstructions(input, { allowUnknown }) {
  if (!allowUnknown) return splitInstructions(input);
  return String(input || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function createTestRun({ deviceId, flow, engine = 'vision' }) {
  if (typeof deviceId !== 'string' || !deviceId) throw flowError('请选择要测试的手机');
  if (!['vision', 'steps'].includes(engine)) throw flowError(`不支持的测试模式：${engine}`);
  if (engine === 'vision') {
    const status = getVisionModelConfig();
    if (!status.configured) {
      throw Object.assign(new Error(`视觉模型尚未配置：${status.missing.join('、')}`), {
        statusCode: 503,
        code: 'VISION_MODEL_NOT_CONFIGURED',
      });
    }
  }
  const result = await findDevice(deviceId);
  if (!result) {
    throw Object.assign(new Error('手机未连接、已断开或尚未授权'), { statusCode: 404, code: 'DEVICE_NOT_FOUND' });
  }
  if (activeDevices.has(deviceId)) {
    throw Object.assign(new Error('这台手机已有测试流程正在执行'), { statusCode: 409, code: 'TEST_RUN_BUSY' });
  }
  const run = {
    id: randomUUID(),
    deviceId,
    deviceName: result.device.name,
    platform: result.device.platform,
    engine,
    flow: String(flow || '').trim(),
    maxSteps: config.visionMaxSteps,
    historyRounds: config.visionHistoryRounds,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: undefined,
    finishedAt: undefined,
    error: undefined,
    steps: engine === 'steps' ? parseTestFlow(flow).map((step) => ({
      ...step,
      status: 'pending',
      stage: 'pending',
      stageLabel: '待执行',
      stageMessage: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      logs: [],
      image: undefined,
      imageDiff: undefined,
      elementDiff: undefined,
      resolvedElement: undefined,
      error: undefined,
    })) : [],
  };
  if (engine === 'vision' && !run.flow) throw flowError('请输入测试目标');
  runs.set(run.id, run);
  activeDevices.add(deviceId);
  // Create the archive before the first screenshot so a queued or running test
  // is immediately visible in the execution records page.
  await checkpointTestRun(run);
  const execute = engine === 'vision' ? executeVisionRun : executeRun;
  void execute(run, result.device).finally(() => activeDevices.delete(deviceId));
  return publicRun(run);
}

export function getTestRun(runId) {
  const run = runs.get(runId);
  return run ? publicRun(run) : undefined;
}

export async function archiveCompletedTestRun(runId) {
  const run = runs.get(runId);
  if (!run) {
    throw Object.assign(new Error('测试记录不存在或服务已重启'), {
      statusCode: 404,
      code: 'TEST_RUN_NOT_FOUND',
    });
  }
  if (['queued', 'running'].includes(run.status)) {
    throw Object.assign(new Error('测试仍在执行，完成后再归档'), {
      statusCode: 409,
      code: 'TEST_RUN_ACTIVE',
    });
  }
  const result = await archiveTestRun(run);
  return { record: publicRun(run), ...result };
}

export function testRunAssetPath(runId, fileName) {
  const validComparisonAsset = /^comparison-(?:device-\d+|overview)\.(?:png|jpe?g)$/i.test(fileName);
  if (!RUN_ID.test(runId) || (!/^step-\d{2,3}\.(?:png|jpe?g)$/i.test(fileName) && !validComparisonAsset)) {
    return undefined;
  }
  return join(artifactRoot, runId, fileName);
}

export function assetContentType(fileName) {
  const extension = extname(fileName).toLowerCase();
  return extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png';
}

async function executeRun(run, device) {
  run.status = 'running';
  run.startedAt = new Date().toISOString();
  const adapter = createAdapter(device);
  const directory = join(artifactRoot, run.id);
  const temporaryDirectory = join(directory, '.frames');
  await mkdir(directory, { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  let currentInspection;
  try {
    for (const step of run.steps) {
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      markStage(step, 'preparing', '准备执行动作，正在唤醒手机');
      await checkpointTestRun(run);
      try {
        await adapter.prepareForInput?.();
        if (currentInspection) {
          markStage(step, 'readingScreen', '复用上一步的执行结果，无需再次截图');
        } else {
          markStage(step, 'readingScreen', '正在读取当前手机画面用于首步定位');
          currentInspection = await captureInspection(device, adapter, temporaryDirectory);
        }
        currentInspection = await executeStep(
          run,
          step,
          device,
          adapter,
          directory,
          temporaryDirectory,
          currentInspection,
        );
        step.status = 'passed';
        step.finishedAt = new Date().toISOString();
        markStage(step, 'done', '动作完成，执行结果和页面差异已生成');
        await checkpointTestRun(run);
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
        step.finishedAt = new Date().toISOString();
        markStage(step, 'failed', step.error);
        throw error;
      }
    }
    run.status = 'completed';
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    for (const step of run.steps) if (step.status === 'pending') step.status = 'skipped';
  } finally {
    run.finishedAt = new Date().toISOString();
    await checkpointTestRun(run);
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeStep(
  run,
  step,
  device,
  adapter,
  directory,
  temporaryDirectory,
  before,
) {
  let after = before;
  try {
    if (step.type === 'tap') {
      const target = findVisibleElement(before.layout, step.target);
      if (!target) throw new Error(`当前页面没有找到「${step.target}」`);
      step.resolvedElement = publicElement(target.node, target.score);
      const action = { type: 'tap', ...scalePoint(centerOf(target.node.bounds), before.layout, adapter.inputSize()) };
      markStage(step, 'acting', `已定位「${step.resolvedElement.text}」，正在点击`);
      await adapter.prepareForInput?.();
      await adapter.perform(action);
      markStage(step, 'stabilizing', '点击已发送，等待页面稳定');
      after = await settleAndPublishAfterAction(run, step, before, device, adapter, directory);
    } else if (step.type === 'input') {
      const target = (step.target && findVisibleElement(before.layout, step.target)) || findEditableElement(before.layout);
      if (!target) {
        throw new Error(step.target ? `当前页面没有找到「${step.target}」输入框` : '当前页面没有找到可输入的文字框');
      }
      step.resolvedElement = publicElement(target.node, target.score);
      const point = scalePoint(centerOf(target.node.bounds), before.layout, adapter.inputSize());
      markStage(step, 'acting', '正在点击输入框并输入文字');
      await adapter.prepareForInput?.();
      await adapter.perform({ type: 'tap', ...point });
      await pause(250);
      await adapter.perform({ type: 'text', text: step.value, ...(device.platform === 'harmony' ? point : {}) });
      markStage(step, 'stabilizing', '文字已发送，等待输入框和页面稳定');
      after = await settleAndPublishAfterAction(
        run,
        step,
        before,
        device,
        adapter,
        directory,
        { expectChange: false },
      );
    } else if (step.type === 'swipe') {
      const action = swipeAction(step.direction, adapter.inputSize(), before.layout);
      markStage(step, 'acting', `正在${step.direction}滑动页面`);
      await adapter.prepareForInput?.();
      await adapter.perform(action);
      markStage(step, 'stabilizing', '滑动已发送，等待页面稳定');
      after = await settleAndPublishAfterAction(run, step, before, device, adapter, directory);
    } else if (step.type === 'key') {
      markStage(step, 'acting', `正在执行${step.description}`);
      await adapter.prepareForInput?.();
      await adapter.perform({ type: 'key', key: step.key });
      markStage(step, 'stabilizing', '按键已发送，等待页面稳定');
      after = await settleAndPublishAfterAction(run, step, before, device, adapter, directory);
    } else if (step.type === 'wait') {
      markStage(step, 'stabilizing', `等待 ${Math.round((step.durationMs || 0) / 1000 * 10) / 10} 秒`);
      after = await settleAndPublishAfterAction(
        run,
        step,
        before,
        device,
        adapter,
        directory,
        { expectChange: false, minimumWaitMs: Math.max(700, step.durationMs || 0) },
      );
    } else if (step.type === 'waitFor' || step.type === 'assert') {
      const deadline = Date.now() + (step.timeoutMs || 10_000);
      let found = findVisibleElement(before.layout, step.target);
      let attempts = 0;
      while (!found && Date.now() < deadline) {
        attempts += 1;
        markStage(step, 'locating', `正在等待页面出现「${step.target}」（第 ${attempts} 次识别）`);
        await pause(Math.min(600, Math.max(50, deadline - Date.now())));
        markStage(step, 'readingScreen', '正在读取当前页面');
        after = await captureInspection(device, adapter, temporaryDirectory);
        found = findVisibleElement(after.layout, step.target);
      }
      if (!found) {
        throw new Error(
          step.type === 'assert'
            ? `页面上没有出现「${step.target}」`
            : `等待 ${Math.round((step.timeoutMs || 10_000) / 1000)} 秒后仍未出现「${step.target}」`,
        );
      }
      step.resolvedElement = publicElement(found.node, found.score);
      markStage(step, 'locating', `已确认页面出现「${step.target}」`);
    } else if (step.type !== 'screenshot' && step.type !== 'noop') {
      throw new Error(`暂不支持的步骤类型：${step.type}`);
    }
  } catch (error) {
    step.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    // Each action owns one result image. The next action consumes this same
    // stable image as its starting view instead of saving a duplicate before.
    if (!after.publishedName) {
      after = await publishInspection(run, step, directory, after);
    } else {
      step.image = after.publishedUrl;
    }
    if (after.path !== before.path) {
      markStage(step, 'comparing', '正在对比本步结果与上一步结果');
      step.imageDiff = await compareImages(before.path, after.path, config.ffmpegPath)
        .catch(() => undefined);
      step.elementDiff = compareElements(before.layout, after.layout);
      step.snapshot = summarizeLayout(after.layout);
    } else {
      step.snapshot = summarizeLayout(after.layout);
    }
    await removeTemporaryFrame(before.path, temporaryDirectory);
    await removeTemporaryFrame(after.temporaryPath, temporaryDirectory);
  }
  return after;
}

async function executeVisionRun(run, device) {
  run.status = 'running';
  run.startedAt = new Date().toISOString();
  const adapter = createAdapter(device);
  const directory = join(artifactRoot, run.id);
  const temporaryDirectory = join(directory, '.frames');
  await mkdir(directory, { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  let lastTap;
  let priorInspection;
  let previousVisionAction;
  try {
    for (let index = 1; index <= config.visionMaxSteps; index += 1) {
      const step = createVisionStep(index);
      run.steps.push(step);
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      markStage(step, 'preparing', '准备读取当前手机画面');
      await checkpointTestRun(run);
      try {
        await wakeForVision(adapter, device);
        let before;
        if (priorInspection) {
          markStage(step, 'readingScreen', '复用上一步的执行结果，无需再次截图');
          before = priorInspection;
        } else {
          markStage(step, 'readingScreen', '正在读取当前手机画面用于首轮决策');
          before = await captureInspection(device, adapter, temporaryDirectory);
        }
        markStage(step, 'thinking', '视觉模型正在查看当前画面并决定下一步');
        const action = await decideVisionAction({
          goal: run.flow,
          history: visionHistory(run.steps.slice(0, -1)),
          screenshot: before,
          historyRounds: run.historyRounds,
          config: getVisionModelConfig(),
        });
        applyVisionActionToStep(step, action);
        if (action.type === 'finished') {
          markStage(step, 'acting', '视觉模型申请完成，正在检查最终页面');
          const after = await settleAndPublishAfterAction(
            run,
            step,
            before,
            device,
            adapter,
            directory,
            { expectChange: false, minimumWaitMs: 900 },
          );
          await compareVisionEvidence(run, step, before, after);
          priorInspection = after;
          markStage(step, 'verifying', '正在独立核验测试目标和最终页面');
          const verdict = await verifyVisionCompletion({
            goal: run.flow,
            history: visionHistory(run.steps),
            screenshot: after,
            finishClaim: action.description,
            config: getVisionModelConfig(),
          });
          run.verdict = verdict;
          step.audit = {
            status: verdict.passed ? 'passed' : 'issue',
            expected: action.expected || '最终页面满足完整测试目标',
            actual: verdict.reason,
            ...(verdict.passed ? {} : {
              title: '最终验收未通过',
              category: 'assertion',
              severity: 'critical',
            }),
          };
          if (!verdict.passed) {
            throw new Error(`最终验收未通过：${verdict.reason}`);
          }
          step.status = 'passed';
          step.finishedAt = new Date().toISOString();
          markStage(step, 'done', `独立验收通过：${verdict.reason}`);
          await removeTemporaryFrame(before.temporaryPath, temporaryDirectory);
          run.status = 'completed';
          run.termination = 'finished';
          return;
        }
        if (action.type === 'assert_fail') {
          markStage(step, 'acting', '视觉模型判断测试目标无法完成');
          const after = await settleAndPublishAfterAction(
            run,
            step,
            before,
            device,
            adapter,
            directory,
            { expectChange: false, minimumWaitMs: 900 },
          );
          await compareVisionEvidence(run, step, before, after);
          step.audit = {
            status: 'issue',
            expected: action.expected || '继续完成完整测试目标',
            actual: action.description || '视觉模型判断测试目标无法完成',
            title: '测试流程无法继续',
            reason: action.thought,
            category: 'assertion',
            severity: 'critical',
          };
          priorInspection = after;
          await removeTemporaryFrame(before.temporaryPath, temporaryDirectory);
          throw new Error(action.description);
        }

        const deviceAction = actionToDeviceAction(action, adapter.inputSize());
        if (!deviceAction) throw new Error(`无法执行视觉动作：${action.type}`);
        if (deviceAction.type === 'text' && device.platform === 'harmony' && lastTap) {
          deviceAction.x = lastTap.x;
          deviceAction.y = lastTap.y;
        }
        markStage(step, 'locating', action.thought || `视觉模型选择：${action.description}`);
        markStage(step, 'acting', `正在${action.description}`);
        await adapter.prepareForInput?.();
        if (action.type !== 'wait') {
          await adapter.perform(deviceAction);
        }
        if (deviceAction.type === 'tap') lastTap = { x: deviceAction.x, y: deviceAction.y };
        markStage(step, 'stabilizing', action.type === 'wait'
          ? `等待 ${action.seconds} 秒后检查页面`
          : '动作已发送，正在检查加载状态、页面稳定和内容就绪');
        if (action.type === 'wait') await pause(action.seconds * 1_000);
        const after = await settleAndPublishAfterAction(run, step, before, device, adapter, directory, {
          expectChange: action.type !== 'input' && action.type !== 'wait',
          minimumWaitMs: action.type === 'wait' ? 500 : 700,
        });
        await compareVisionEvidence(run, step, before, after);
        markStage(step, 'verifying', '正在独立检查本步动作是否到达预期页面');
        const audit = await auditVisionStep({
          goal: run.flow,
          action,
          expectation: action.expected,
          previousAction: previousVisionAction,
          before,
          after,
          visualChanged: step.imageDiff?.changedRatio,
          config: getVisionModelConfig(),
        });
        step.audit = applyDeterministicAudit(audit, action, previousVisionAction, step.imageDiff);
        run.quality = buildVisionQuality(run);
        previousVisionAction = action;
        if (step.audit.status === 'issue') {
          markStage(step, 'verifying', `发现过程问题：${step.audit.title || step.audit.actual}`);
        } else if (step.audit.status === 'unverified') {
          markStage(step, 'verifying', '本步结果未能完成独立校验');
        } else {
          markStage(step, 'verifying', '本步动作结果符合预期');
        }
        priorInspection = after;
        await removeTemporaryFrame(before.temporaryPath, temporaryDirectory);
        step.status = 'passed';
        step.finishedAt = new Date().toISOString();
        markStage(step, 'done', '动作完成，执行结果和页面差异已保存');
        await checkpointTestRun(run);
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
        step.finishedAt = new Date().toISOString();
        markStage(step, 'failed', step.error);
        throw error;
      }
    }
    run.status = 'failed';
    run.termination = 'max_steps';
    run.error = `已执行 ${config.visionMaxSteps} 步仍未完成，疑似循环或目标无法到达`;
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    for (const step of run.steps) if (step.status === 'pending') step.status = 'skipped';
  } finally {
    run.finishedAt = new Date().toISOString();
    run.quality = buildVisionQuality(run);
    await checkpointTestRun(run);
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function createVisionStep(index) {
  return {
    index,
    source: '视觉模型逐步决策',
    type: 'vision',
    description: '正在分析当前页面',
    status: 'pending',
    stage: 'pending',
    stageLabel: '待执行',
    logs: [],
  };
}

/**
 * Build the tester-facing summary independently from the automation verdict.
 * A flow can reach its goal while still exposing real navigation or response
 * defects that were recovered by later actions.
 */
export function buildVisionQuality(run) {
  const issues = [];
  let unverifiedCount = 0;
  for (const step of run?.steps || []) {
    const audit = step.audit;
    if (!audit) continue;
    if (audit.status === 'unverified') {
      unverifiedCount += 1;
      continue;
    }
    if (audit.status !== 'issue') continue;
    issues.push({
      stepIndex: step.index,
      category: audit.category || 'other',
      severity: audit.severity || 'major',
      title: audit.title || '动作结果与预期不一致',
      expected: audit.expected,
      actual: audit.actual,
      evidence: step.image,
      recovered: run.status === 'completed' && Boolean(run.verdict?.passed),
    });
  }
  if (run?.status === 'failed' && run.error && issues.length === 0) {
    const failedStep = [...(run.steps || [])].reverse().find((step) => step.status === 'failed');
    issues.push({
      stepIndex: failedStep?.index || Math.max(1, run.steps?.length || 1),
      category: 'assertion',
      severity: 'critical',
      title: run.termination === 'max_steps' ? '达到执行步数上限' : '测试流程未完成',
      expected: '完成自然语言测试目标',
      actual: run.error,
      evidence: failedStep?.image,
      recovered: false,
    });
  }
  const categoryCounts = issues.reduce((counts, issue) => {
    counts[issue.category] = (counts[issue.category] || 0) + 1;
    return counts;
  }, {});
  const categorySummary = Object.entries(categoryCounts)
    .sort((first, second) => second[1] - first[1])
    .map(([category, count]) => `${issueCategoryName(category)} ${count} 个`)
    .join('、');
  let summary;
  if (issues.length > 0) {
    summary = run?.status === 'completed'
      ? `目标已完成，但发现 ${issues.length} 个过程问题：${categorySummary}。`
      : `测试未完成，发现 ${issues.length} 个问题：${categorySummary}。`;
  } else if (unverifiedCount > 0) {
    summary = `执行完成，但有 ${unverifiedCount} 个步骤未能完成独立结果校验。`;
  } else {
    summary = run?.status === 'completed'
      ? '所有已执行动作及最终结果均通过独立校验。'
      : '没有可用的问题审计结果。';
  }
  if (issues.length > 0 && unverifiedCount > 0) {
    summary += `另有 ${unverifiedCount} 个步骤未能完成独立校验。`;
  }
  return {
    status: issues.length > 0 ? 'issues' : unverifiedCount > 0 ? 'unverified' : 'passed',
    issueCount: issues.length,
    summary,
    issues,
  };
}

export function applyDeterministicAudit(audit, action, previousAction, imageDiff) {
  if (!action || !['click', 'long_press'].includes(action.type)) return audit;
  const expected = audit?.expected || action.expected || action.description || '动作产生预期页面变化';
  const actual = audit?.actual || '';
  if (sameVisionAction(action, previousAction) && audit?.status !== 'issue') {
    return {
      status: 'issue',
      expected,
      actual: actual || '连续执行了相同点击，页面没有推进到新的测试步骤',
      title: '连续点击相同目标',
      reason: '当前动作的控件和坐标与上一轮相同，未形成新的业务操作。',
      category: 'repeat_action',
      severity: 'major',
    };
  }
  if ((imageDiff?.changedRatio ?? 1) === 0 && audit?.status !== 'issue') {
    return {
      status: 'issue',
      expected,
      actual: actual || '动作发送后截图没有任何可见变化',
      title: '点击后页面无响应',
      reason: '动作完成后的稳定截图与动作前完全相同，点击目标可能未生效。',
      category: 'no_response',
      severity: 'major',
    };
  }
  return audit;
}

function sameVisionAction(current, previous) {
  if (!current || !previous || current.type !== previous.type) return false;
  if (current.description === previous.description) {
    if (current.x === undefined && previous.x === undefined) return true;
    return Math.abs(current.x - previous.x) <= 8 && Math.abs(current.y - previous.y) <= 8;
  }
  return false;
}

function issueCategoryName(category) {
  return ({
    navigation: '误导航',
    no_response: '无响应',
    repeat_action: '重复操作',
    unexpected_dialog: '异常弹窗',
    ui_mismatch: 'UI 异常',
    data_mismatch: '数据异常',
    assertion: '目标未完成',
    recovery: '异常恢复',
    other: '其他问题',
  })[category] || '其他问题';
}

async function checkpointTestRun(run) {
  await archiveTestRun(run).catch((error) => {
    console.error(`[归档] 测试 ${run.id} 自动保存失败`, error);
  });
}

function applyVisionActionToStep(step, action) {
  step.description = action.description;
  step.source = `视觉动作：${action.type}`;
  step.thought = action.thought;
  step.expected = action.expected;
  step.type = ({
    click: 'tap', long_press: 'tap', input: 'input', swipe: 'swipe', scroll: 'swipe',
    back: 'key', home: 'key', wait: 'wait', finished: 'assert', assert_fail: 'assert',
  })[action.type] || 'vision';
  if (action.type === 'back' || action.type === 'home') step.key = action.type;
  if (action.type === 'input') step.value = action.text;
  if (action.type === 'wait') step.durationMs = action.seconds * 1_000;
}

async function settleAfterAction(
  run,
  step,
  before,
  device,
  adapter,
  directory,
  { expectChange = true, minimumWaitMs = 700 } = {},
) {
  const result = await waitForPageSettled({
    before,
    expectChange,
    minimumWaitMs,
    timeoutMs: 30_000,
    compare: (first, second) => compareImages(first, second, config.ffmpegPath),
    capture: () => captureInspection(
      device,
      adapter,
      join(directory, '.frames'),
    ),
    onObservation: ({ attempt, loading, contentReady, stable }) => {
      const detail = loading
        ? '检测到页面加载中'
        : !contentReady
          ? '页面内容尚未就绪'
          : stable
            ? '页面已稳定'
            : '页面仍在变化';
      markStage(step, 'stabilizing', `第 ${attempt} 次检查：${detail}`);
    },
  });
  if (!result.settled) {
    markStage(step, 'stabilizing', '等待页面稳定超时，使用当前页面继续识别');
  }
  return result;
}

async function settleAndPublishAfterAction(
  run,
  step,
  before,
  device,
  adapter,
  directory,
  options,
) {
  const result = await publishSettledFrame({
    settle: () => settleAfterAction(
      run,
      step,
      before,
      device,
      adapter,
      directory,
      options,
    ),
    publish: (inspection) => publishInspection(
      run,
      step,
      directory,
      inspection,
    ),
  });
  return result.inspection;
}

function visionHistory(steps) {
  return steps.map((step) => ({
    index: step.index,
    thought: step.thought,
    description: step.description,
    action: step.type,
    passed: step.status === 'passed',
    status: step.status,
  }));
}

async function wakeForVision(adapter, device) {
  await adapter.prepareForInput?.();
  if (device.platform !== 'android') return;
  const status = await runCommand(adapter.adb, ['-s', device.nativeId, 'shell', 'dumpsys', 'power'], 4_000)
    .catch(() => '');
  if (!/mWakefulness=(Asleep|Dozing)/i.test(status)) return;
  await runCommand(adapter.adb, ['-s', device.nativeId, 'shell', 'input', 'keyevent', '224'], 5_000);
  await runCommand(adapter.adb, ['-s', device.nativeId, 'shell', 'wm', 'dismiss-keyguard'], 5_000).catch(() => '');
  await pause(500);
  await adapter.prepareForInput?.();
}

async function runCommand(command, args, timeoutMs) {
  const result = await run(command, args, { timeoutMs });
  return String(result.stdout || '');
}

async function compareVisionEvidence(run, step, before, after) {
  markStage(step, 'comparing', '正在比较本步结果与上一步结果的画面和文字变化');
  step.imageDiff = await compareImages(before.path, after.path, config.ffmpegPath).catch(() => undefined);
  step.elementDiff = compareElements(before.layout, after.layout);
  step.snapshot = summarizeLayout(after.layout);
}

async function publishInspection(run, step, directory, inspection) {
  const publishedName = await saveFrame(directory, step.index, inspection);
  const publishedPath = join(directory, publishedName);
  const publishedUrl = assetUrl(run.id, publishedName);
  step.image = publishedUrl;
  markStage(step, 'capturingResult', '已保存稳定执行结果，将直接用于下一步');
  return {
    ...inspection,
    temporaryPath: inspection.temporaryPath || inspection.path,
    path: publishedPath,
    publishedName,
    publishedUrl,
  };
}

async function captureInspection(device, adapter, temporaryDirectory, onFrame) {
  const frame = await adapter.screenshot();
  const extension = imageExtension(frame.buffer);
  const framePath = join(temporaryDirectory, `${randomUUID()}.${extension}`);
  await writeFile(framePath, frame.buffer);
  if (onFrame) await onFrame({ ...frame, path: framePath });

  // A visual-action loop needs one clear view of the screen before calling the
  // model. A transient lock screen or splash frame must not become the target.
  const blank = isBlankFrame(frame.buffer);
  if (blank) {
    await pause(500);
    const retry = await adapter.screenshot();
    if (!isBlankFrame(retry.buffer)) {
      const retryExtension = imageExtension(retry.buffer);
      const retryPath = join(temporaryDirectory, `${randomUUID()}.${retryExtension}`);
      await writeFile(retryPath, retry.buffer);
      if (onFrame) await onFrame({ ...retry, path: retryPath });
      const inspection = await inspectFrame(device, adapter, retry, retryPath);
      return { ...inspection, temporaryPath: retryPath };
    }
  }

  const inspection = await inspectFrame(device, adapter, frame, framePath);
  return { ...inspection, temporaryPath: framePath };
}

async function inspectFrame(device, adapter, frame, framePath) {

  // OCR is fast enough to run for every step and covers WebViews that expose
  // no useful accessibility nodes. Only pay for the slower native tree when
  // OCR found nothing at all.
  const ocr = await recognizeOcrFrame(device, frame).catch(() => undefined);
  // A sparse frame may contain only a textless skeleton. Read the native tree
  // as a secondary signal, while avoiding that slower call on rich screens.
  const native = (ocr?.nodes?.length || 0) >= 4
    ? undefined
    : await adapter.layout().catch(() => undefined);
  const layout = mergeLayouts(ocr, native, frame);
  return { path: framePath, buffer: frame.buffer, layout };
}

function isBlankFrame(buffer) {
  if (!buffer?.length) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 128 * 1024));
  let variance = 0;
  for (let index = 16; index + 2 < sample.length; index += 997) {
    variance += Math.abs(sample[index] - sample[index + 1]) + Math.abs(sample[index + 1] - sample[index + 2]);
  }
  return variance < 100;
}

async function saveFrame(directory, index, inspection) {
  const extension = imageExtension(inspection.buffer);
  const name = `step-${String(index).padStart(2, '0')}.${extension}`;
  await writeFile(join(directory, name), inspection.buffer);
  return name;
}

async function removeTemporaryFrame(filePath, temporaryDirectory) {
  if (!filePath || !resolve(filePath).startsWith(`${resolve(temporaryDirectory)}/`)) return;
  await unlink(filePath).catch(() => {});
}

function mergeLayouts(ocr, native, frame) {
  const width = Number(native?.width || ocr?.width || frame.width || frame.inputWidth);
  const height = Number(native?.height || ocr?.height || frame.height || frame.inputHeight);
  const nodes = [];
  for (const node of native?.nodes || []) nodes.push(node);
  for (const node of ocr?.nodes || []) {
    const text = normalizeText(displayText(node));
    if (!text || text.length < 2) continue;
    if (nodes.some((existing) =>
      normalizeText(displayText(existing)) === text && boundsOverlap(existing.bounds, node.bounds) > 0.25,
    )) continue;
    nodes.push(node);
  }
  return { width, height, nodes };
}

export function findVisibleElement(layout, target) {
  const wanted = normalizeText(target);
  if (!wanted) return undefined;
  const candidates = (layout?.nodes || [])
    .filter((node) => isVisibleIdentity(node, layout))
    .map((node) => ({ node, score: textMatchScore(node, wanted) }))
    .filter((item) => item.score >= 55)
    .sort((a, b) => b.score - a.score || area(a.node.bounds) - area(b.node.bounds));
  return candidates[0];
}

export function compareElements(before, after) {
  const left = elementGroups(before);
  const right = elementGroups(after);
  const added = [];
  const removed = [];
  const moved = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const paired = pairNodes(left.get(key) || [], right.get(key) || [], before, after);
    for (const pair of paired.pairs) {
      const distance = normalizedDistance(pair.before, pair.after, before, after);
      if (distance >= 0.018) {
        moved.push({
          text: displayText(pair.after) || displayText(pair.before),
          before: roundBounds(pair.before.bounds),
          after: roundBounds(pair.after.bounds),
          distance: round(distance),
        });
      }
    }
    for (const node of paired.removed) removed.push(elementSummary(node));
    for (const node of paired.added) added.push(elementSummary(node));
  }
  return {
    added: uniqueElements(added).slice(0, 30),
    removed: uniqueElements(removed).slice(0, 30),
    moved: moved.sort((a, b) => b.distance - a.distance).slice(0, 30),
  };
}

function findEditableElement(layout) {
  const candidates = (layout?.nodes || [])
    .filter((node) => node.enabled && node.bounds && (
      /EditText|TextInput|TextField|SearchField|SecureTextField/i.test(node.kind || '') ||
      /输入|搜索|请输入|search/i.test([node.hint, node.text, node.label].join(' '))
    ))
    .sort((a, b) => Number(b.clickable) - Number(a.clickable) || area(a.bounds) - area(b.bounds));
  return candidates[0] ? { node: candidates[0], score: 100 } : undefined;
}

function textMatchScore(node, wanted) {
  const candidates = [node.text, node.label, node.hint, node.id].map(normalizeText).filter(Boolean);
  let best = 0;
  for (const candidate of candidates) {
    if (candidate === wanted) best = Math.max(best, 100);
    else if (candidate.includes(wanted) || wanted.includes(candidate)) {
      best = Math.max(best, Math.max(60, 90 - Math.abs(candidate.length - wanted.length)));
    } else if (wanted.length >= 2 && candidate.length >= 2) {
      const overlap = bigramOverlap(candidate, wanted);
      if (overlap >= 0.55) best = Math.max(best, Math.round(55 + overlap * 30));
    }
  }
  return best;
}

function isVisibleIdentity(node, layout) {
  if (!node?.enabled || !displayText(node) || !node.bounds) return false;
  if (node.bounds.right <= node.bounds.left || node.bounds.bottom <= node.bounds.top) return false;
  const layoutArea = Math.max(1, Number(layout?.width) * Number(layout?.height));
  const pageLike = /WebView|ScrollView|Recycler|ListView|FrameLayout|ViewGroup|Layout/i.test(node.kind || '');
  return !(area(node.bounds) >= layoutArea * 0.55 && !node.clickable && pageLike);
}

function elementGroups(layout) {
  const groups = new Map();
  for (const node of layout?.nodes || []) {
    if (!isVisibleIdentity(node, layout)) continue;
    const key = normalizeText(displayText(node));
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(node);
    groups.set(key, list);
  }
  return groups;
}

function pairNodes(beforeNodes, afterNodes, before, after) {
  const available = new Set(afterNodes);
  const pairs = [];
  const removed = [];
  for (const left of beforeNodes) {
    let best;
    for (const right of available) {
      const distance = normalizedDistance(left, right, before, after);
      if (!best || distance < best.distance) best = { right, distance };
    }
    if (best && best.distance < 0.35) {
      pairs.push({ before: left, after: best.right });
      available.delete(best.right);
    } else removed.push(left);
  }
  return { pairs, removed, added: [...available] };
}

function swipeAction(direction, inputSize, layout) {
  const width = Number(inputSize.width);
  const height = Number(inputSize.height);
  if (!(width > 1) || !(height > 1)) throw new Error('手机缺少可用的触控尺寸');
  const container = (layout?.nodes || [])
    .filter((node) => node.scrollable && node.bounds)
    .sort((a, b) => area(b.bounds) - area(a.bounds))[0];
  const layoutWidth = Number(layout?.width) || width;
  const layoutHeight = Number(layout?.height) || height;
  const left = container?.bounds.left ?? 0;
  const top = container?.bounds.top ?? 0;
  const right = container?.bounds.right ?? layoutWidth;
  const bottom = container?.bounds.bottom ?? layoutHeight;
  const scaleX = width / layoutWidth;
  const scaleY = height / layoutHeight;
  const centerX = Math.round(((left + right) / 2) * scaleX);
  const centerY = Math.round(((top + bottom) / 2) * scaleY);
  const startRatio = () => (['向上', '向左'].includes(direction) ? 0.78 : 0.22);
  const endRatio = () => (['向上', '向左'].includes(direction) ? 0.22 : 0.78);
  if (direction === '向上' || direction === '向下') {
    return {
      type: 'swipe',
      fromX: centerX,
      fromY: Math.round((top + (bottom - top) * startRatio()) * scaleY),
      toX: centerX,
      toY: Math.round((top + (bottom - top) * endRatio()) * scaleY),
      duration: 500,
    };
  }
  return {
    type: 'swipe',
    fromX: Math.round((left + (right - left) * startRatio()) * scaleX),
    fromY: centerY,
    toX: Math.round((left + (right - left) * endRatio()) * scaleX),
    toY: centerY,
    duration: 500,
  };
}

function scalePoint(point, layout, input) {
  return {
    x: Math.min(input.width - 1, Math.max(0, Math.round(point.x * input.width / Math.max(1, layout.width)))),
    y: Math.min(input.height - 1, Math.max(0, Math.round(point.y * input.height / Math.max(1, layout.height)))),
  };
}

function summarizeLayout(layout) {
  return {
    width: layout?.width,
    height: layout?.height,
    nodeCount: (layout?.nodes || []).filter((node) => isVisibleIdentity(node, layout)).length,
  };
}

function publicElement(node, score) {
  return { text: displayText(node), kind: node.kind || '', bounds: roundBounds(node.bounds), score };
}

function elementSummary(node) {
  return { text: displayText(node), kind: node.kind || '', bounds: roundBounds(node.bounds) };
}

function uniqueElements(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeText(item.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedDistance(a, b, beforeLayout, afterLayout) {
  const ac = centerOf(a.bounds);
  const bc = centerOf(b.bounds);
  return Math.hypot(
    ac.x / Math.max(1, beforeLayout.width) - bc.x / Math.max(1, afterLayout.width),
    ac.y / Math.max(1, beforeLayout.height) - bc.y / Math.max(1, afterLayout.height),
  );
}

function boundsOverlap(a, b) {
  if (!a || !b) return 0;
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return (width * height) / Math.max(1, Math.min(area(a), area(b)));
}

function displayText(node) {
  return String(node?.text || node?.label || node?.hint || node?.id || '').replace(/\s+/g, ' ').trim();
}

function bigramOverlap(left, right) {
  const grams = (value) => {
    const result = new Set();
    for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
    return result;
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[「」“”"'‘’\s]/g, '')
    .toLocaleLowerCase();
}

function normalizeCommand(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function cleanTarget(value) {
  return String(value || '')
    .replace(/^[「“"'‘]+|[」”"'’]+$/g, '')
    .trim();
}

function cleanInputTarget(value) {
  const target = cleanTarget(value);
  if (/^(?:搜索框|输入框|文本框)$/.test(target)) return '';
  return target.replace(/(?:搜索框|输入框|文本框)$/, '').trim();
}

function centerOf(bounds) {
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
}

function area(bounds) {
  return Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
}

function roundBounds(bounds) {
  return bounds
    ? Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value)]))
    : undefined;
}

function round(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

function clampDuration(value) {
  return Math.min(60_000, Math.max(100, Math.round(value)));
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function imageExtension(buffer) {
  return buffer?.[0] === 0xff && buffer?.[1] === 0xd8 ? 'jpg' : 'png';
}

function assetUrl(runId, name, version) {
  const url = `/api/test-runs/${encodeURIComponent(runId)}/assets/${encodeURIComponent(name)}`;
  return version ? `${url}?v=${version}` : url;
}

function publicRun(run) {
  return {
    ...run,
    steps: run.steps.map((step) => ({ ...step, logs: step.logs.map((log) => ({ ...log })) })),
  };
}

function markStage(step, stage, message) {
  const at = new Date().toISOString();
  step.stage = stage;
  step.stageLabel = STAGE_LABELS[stage] || stage;
  step.stageMessage = message;
  const previous = step.logs.at(-1);
  if (!previous || previous.stage !== stage || previous.message !== message) {
    step.logs.push({ at, stage, message });
  }
}

function flowError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_TEST_FLOW' });
}
