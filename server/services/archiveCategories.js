export const ARCHIVE_CATEGORIES = [
  '首页',
  '分类',
  '搜索',
  '商品',
  '购物车',
  '结算',
  '订单',
  '支付',
  '我的',
  '其他',
];

const CATEGORY_RULES = [
  ['首页', ['首页', '主页', '主屏', '首屏', '底部栏', '底部 bar', '底部bar', '底栏', 'bottom bar', 'tab栏', 'tab 栏']],
  ['分类', ['分类', '类目', '品类', '商品分类', '频道分类']],
  ['搜索', ['搜索', '检索', '搜一搜', '搜索框', '搜索页', '关键词']],
  ['商品', ['商品', '商品详情', '详情页', '加购', '加入购物车', '规格', 'sku', '货号', '库存']],
  ['购物车', ['购物车', '购物袋', '去结算', '暂不追加', '继续购物']],
  ['结算', ['结算', '确认订单', '提交订单', '订单确认', '确认下单', '收货地址', '配送方式', '自提']],
  ['订单', ['我的订单', '全部订单', '订单列表', '订单详情', '待支付', '待付款', '待发货', '待收货', '退款订单']],
  ['支付', ['去支付', '立即支付', '确认支付', '支付方式', '支付按钮', '支付成功', '支付失败', '收银台', '去付款', '立即付款', '付款方式', '付款成功', '付款失败', '微信支付', '支付宝', '银联', '免密支付']],
  ['我的', ['我的', '我的页', '个人中心', '账户中心', '用户中心', '会员中心']],
];

/** Classify a persisted run from its goal, observed actions and page evidence. */
export function classifyRun(run) {
  const persisted = Array.isArray(run?.categories)
    ? run.categories.filter((name) => ARCHIVE_CATEGORIES.includes(name))
    : [];
  const text = runText(run).toLocaleLowerCase();
  const matched = CATEGORY_RULES
    .filter(([, keywords]) => keywords.some((keyword) => text.includes(keyword.toLocaleLowerCase())))
    .map(([name]) => name);
  const categories = [...new Set([...persisted, ...matched])];
  // A generic page flow such as “点击底部栏首页” is not itself a 首页
  // checkpoint. Only an explicitly named checkpoint can drive that category.
  const checkpointName = run?.comparison?.checkpointName;
  if (checkpointName) {
    const checkpointCategories = CATEGORY_RULES
      .filter(([, keywords]) => keywords.some((keyword) => (
        checkpointName.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())
      )))
      .map(([name]) => name);
    if (checkpointCategories.length > 0) {
      return [...new Set([...checkpointCategories, ...(categories.length ? categories : ['其他'])])];
    }
  }
  return categories.length > 0 ? categories : ['其他'];
}

export function categoryCounts(runs) {
  const counts = new Map(ARCHIVE_CATEGORIES.map((name) => [name, 0]));
  for (const run of runs) {
    for (const category of classifyRun(run)) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }
  return ARCHIVE_CATEGORIES.map((name) => ({ name, count: counts.get(name) || 0 }));
}

export function withArchiveCategories(run) {
  if (!run) return run;
  return { ...run, categories: classifyRun(run) };
}

/**
 * Search natural-language goals, action decisions and visual differences. The
 * archive summary endpoint intentionally searches more than just the title so
 * a phrase such as "暂不追加" can find the cart step that produced it.
 */
export function runMatchesQuery(run, query) {
  const normalized = String(query || '').trim().toLocaleLowerCase();
  if (!normalized) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const text = runText(run).toLocaleLowerCase();
  return tokens.every((token) => text.includes(token));
}

export function runText(run) {
  if (!run) return '';
  const parts = [run.id, run.deviceName, run.flow, run.status, run.error, run.verdict?.reason];
  for (const step of run.steps || []) {
    parts.push(
      step.source,
      step.description,
      step.target,
      step.value,
      step.thought,
      step.error,
      step.stageMessage,
      step.resolvedElement?.text,
      step.resolvedElement?.kind,
    );
    for (const item of step.imageDiff?.changedRegions || []) {
      // Regions have coordinates rather than language, but keeping the field
      // in the search corpus leaves room for future OCR descriptions.
      void item;
    }
    for (const item of step.elementDiff?.added || []) parts.push(item.text);
    for (const item of step.elementDiff?.removed || []) parts.push(item.text);
    for (const item of step.elementDiff?.moved || []) parts.push(item.text);
  }
  for (const category of run.categories || []) parts.push(category);
  if (run.comparison?.checkpointName) parts.push(run.comparison.checkpointName);
  return parts.filter((value) => value !== undefined && value !== null).join('\n');
}
