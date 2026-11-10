const MAX_NODES = 8_000;
const MAX_TEXT = 500;

/** Parse Android's uiautomator XML without adding a platform-specific XML dependency. */
export function parseAndroidLayout(xml, screen = {}) {
  const text = String(xml || '');
  const nodes = [];
  let depth = 0;
  const tags = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  for (const match of text.matchAll(tags)) {
    if (match[0] === '</node>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attributes = attributesFromXml(match[1]);
    const bounds = parseBounds(attributes.bounds);
    if (bounds) {
      const password = attributes.password === 'true';
      const kind = clean(attributes.class);
      nodes.push({
        text: password ? '' : clean(attributes.text),
        label: password ? '' : clean(attributes['content-desc']),
        hint: password ? '' : clean(attributes.hint),
        id: clean(attributes['resource-id']),
        kind,
        bounds,
        depth,
        clickable: attributes.clickable === 'true',
        scrollable: attributes.scrollable === 'true' || scrollKind(kind),
        enabled: attributes.enabled !== 'false',
      });
    }
    if (!match[2]) depth += 1;
    if (nodes.length >= MAX_NODES) break;
  }
  return finishLayout(nodes, screen);
}

/** Parse the JSON hierarchy produced by `uitest dumpLayout` on HarmonyOS. */
export function parseHarmonyLayout(input, screen = {}) {
  let tree = input;
  if (typeof tree === 'string') {
    try {
      tree = JSON.parse(tree);
    } catch {
      return finishLayout([], screen);
    }
  }
  const nodes = [];
  walkHarmony(tree, 0, nodes);
  return finishLayout(nodes, screen);
}

function walkHarmony(node, depth, nodes) {
  if (!node || typeof node !== 'object' || nodes.length >= MAX_NODES) return;
  const attributes = node.attributes || node;
  if (attributes && attributes.visible !== 'false' && attributes.visible !== false) {
    const bounds = parseBounds(attributes.bounds);
    if (bounds) {
      const kind = clean(attributes.type || attributes.className);
      const password =
        attributes.password === 'true' ||
        attributes.password === true ||
        /password|secure/i.test(String(attributes.type || attributes.className || ''));
      nodes.push({
        text: password ? '' : clean(attributes.text || attributes.originalText),
        label: password ? '' : clean(attributes.description || attributes.accessibilityText),
        hint: password ? '' : clean(attributes.hint),
        id: meaningfulHarmonyId(attributes),
        kind,
        bounds,
        depth,
        clickable: attributes.clickable === 'true' || attributes.clickable === true,
        scrollable:
          attributes.scrollable === 'true' ||
          attributes.scrollable === true ||
          scrollKind(kind),
        enabled: attributes.enabled !== 'false' && attributes.enabled !== false,
      });
    }
  }
  for (const child of node.children || node.$children || []) walkHarmony(child, depth + 1, nodes);
}

function meaningfulHarmonyId(attributes) {
  const key = clean(attributes.key);
  if (key) return key;
  const id = clean(attributes.id || attributes.accessibilityId);
  // ArkUI often numbers nodes sequentially. Those numbers are not stable across phones.
  return /^\d+$/.test(id) ? '' : id;
}

function scrollKind(kind) {
  return /ScrollView|RecyclerView|ListView|GridView|Scroll|List|Grid|WebView|Web/i.test(kind);
}

/** Parse WebDriverAgent's JSON or XML page source into the common node shape. */
export function parseIosLayout(input, screen = {}) {
  let tree = input;
  if (typeof input === 'string') {
    const value = input.trim();
    if (value.startsWith('<')) return parseIosXml(value, screen);
    try {
      tree = JSON.parse(value);
    } catch {
      return finishLayout([], screen);
    }
  }
  const nodes = [];
  walkIosJson(tree, 0, nodes);
  return finishLayout(nodes, screen);
}

function walkIosJson(node, depth, nodes) {
  if (!node || typeof node !== 'object' || nodes.length >= MAX_NODES) return;
  const rect = node.rect || directRect(node);
  const bounds = parseBounds(rect);
  const visible = node.isVisible !== false && node.visible !== 'false';
  if (bounds && visible) {
    const password = /SecureTextField|SecureText|password/i.test(
      String(node.type || node.className || ''),
    );
    nodes.push({
      text: password ? '' : clean(node.value ?? node.text),
      label: password ? '' : clean(node.label || node.name || node.accessibilityLabel),
      hint: password ? '' : clean(node.placeholderValue),
      id: clean(node.identifier || node.accessibilityIdentifier || node.name),
      kind: clean(node.type || node.className),
      bounds,
      depth,
      clickable: node.isAccessibilityElement !== false && Boolean(node.label || node.name || node.type),
      scrollable: /ScrollView|Table|Collection|WebView/i.test(String(node.type || '')),
      enabled: node.isEnabled !== false && node.enabled !== 'false',
    });
  }
  for (const child of node.children || []) walkIosJson(child, depth + 1, nodes);
}

function parseIosXml(xml, screen) {
  const nodes = [];
  let depth = 0;
  const tags = /<(XCUIElementType\w+)\b([^>]*?)(\/?)>|<\/XCUIElementType\w+>/g;
  for (const match of xml.matchAll(tags)) {
    if (match[0].startsWith('</')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attributes = attributesFromXml(match[2]);
    const x = Number(attributes.x);
    const y = Number(attributes.y);
    const width = Number(attributes.width);
    const height = Number(attributes.height);
    if (attributes.visible !== 'false' && width > 0 && height > 0) {
      const password = /SecureTextField|SecureText|password/i.test(match[1]);
      nodes.push({
        text: password ? '' : clean(attributes.value),
        label: password ? '' : clean(attributes.label || attributes.name),
        hint: password ? '' : clean(attributes.placeholderValue),
        id: clean(attributes.identifier),
        kind: match[1],
        bounds: { left: x, top: y, right: x + width, bottom: y + height },
        depth,
        clickable: attributes.enabled !== 'false' && Boolean(attributes.label || attributes.name),
        scrollable: /ScrollView|Table|Collection|WebView/.test(match[1]),
        enabled: attributes.enabled !== 'false',
      });
    }
    if (!match[3]) depth += 1;
  }
  return finishLayout(nodes, screen);
}

export function parseBounds(value) {
  if (typeof value === 'string') {
    const numbers = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (numbers?.length >= 4) {
      const [left, top, right, bottom] = numbers;
      return bounds(left, top, right, bottom);
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    if ('left' in value || 'x' in value) {
      const left = Number(value.left ?? value.x);
      const top = Number(value.top ?? value.y);
      const right = value.right !== undefined
        ? Number(value.right)
        : left + Number(value.width);
      const bottom = value.bottom !== undefined
        ? Number(value.bottom)
        : top + Number(value.height);
      return bounds(left, top, right, bottom);
    }
  }
  return undefined;
}

export function pointInBounds(point, rectangle) {
  return (
    point.x >= rectangle.left &&
    point.x <= rectangle.right &&
    point.y >= rectangle.top &&
    point.y <= rectangle.bottom
  );
}

function finishLayout(nodes, screen) {
  const filtered = nodes.filter((node) => node.enabled && node.bounds.right > node.bounds.left && node.bounds.bottom > node.bounds.top);
  let width = Number(screen.width) || 0;
  let height = Number(screen.height) || 0;
  if (!(width > 1) || !(height > 1)) {
    const maximum = filtered.reduce(
      (size, node) => ({
        width: Math.max(size.width, node.bounds.right),
        height: Math.max(size.height, node.bounds.bottom),
      }),
      { width: 0, height: 0 },
    );
    width = maximum.width;
    height = maximum.height;
  }
  return { width, height, nodes: filtered };
}

function bounds(left, top, right, bottom) {
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return undefined;
  }
  return { left, top, right, bottom };
}

function directRect(node) {
  if (node.x === undefined && node.y === undefined) return undefined;
  return { x: Number(node.x), y: Number(node.y), width: Number(node.width), height: Number(node.height) };
}

function attributesFromXml(source) {
  return Object.fromEntries(
    [...String(source).matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [
      match[1],
      decodeXml(match[2]),
    ]),
  );
}

function decodeXml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}
