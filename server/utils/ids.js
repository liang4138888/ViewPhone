const prefix = { android: 'a', ios: 'i', harmony: 'h' };

export function encodeDeviceId(platform, nativeId) {
  return `${prefix[platform]}_${Buffer.from(nativeId, 'utf8').toString('base64url')}`;
}

export function decodeDeviceId(id) {
  const separator = id.indexOf('_');
  if (separator < 1) return undefined;
  const platform = Object.entries(prefix).find(([, value]) => value === id[0])?.[0];
  if (!platform) return undefined;
  try {
    const nativeId = Buffer.from(id.slice(separator + 1), 'base64url').toString('utf8');
    return nativeId ? { platform, nativeId } : undefined;
  } catch {
    return undefined;
  }
}
