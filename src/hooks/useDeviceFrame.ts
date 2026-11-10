import { useEffect, useRef, useState } from 'react';
import { frameUrl } from '../lib/api';

type FrameSize = { width: number; height: number };

export function useDeviceFrame(deviceId?: string, intervalMs = 450, paused = false) {
  const [url, setUrl] = useState<string>();
  const [size, setSize] = useState<FrameSize>();
  const [inputSize, setInputSize] = useState<FrameSize>();
  const [latencyMs, setLatencyMs] = useState<number>();
  const [error, setError] = useState<string>();
  const [capturedAt, setCapturedAt] = useState<number>();
  const currentUrl = useRef<string | undefined>(undefined);

  useEffect(() => {
    setUrl(undefined);
    setSize(undefined);
    setInputSize(undefined);
    setLatencyMs(undefined);
    setError(undefined);
    setCapturedAt(undefined);
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    currentUrl.current = undefined;
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId || paused) return;
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      controller = new AbortController();
      const started = performance.now();
      try {
        const response = await fetch(frameUrl(deviceId), {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => undefined)) as { error?: string };
          throw new Error(body?.error || `无法读取画面（HTTP ${response.status}）`);
        }
        const width = Number(response.headers.get('X-Device-Width'));
        const height = Number(response.headers.get('X-Device-Height'));
        const inputWidth = Number(response.headers.get('X-Input-Width'));
        const inputHeight = Number(response.headers.get('X-Input-Height'));
        const blob = await response.blob();
        if (cancelled) return;
        const nextUrl = URL.createObjectURL(blob);
        if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
        currentUrl.current = nextUrl;
        setUrl(nextUrl);
        if (width > 0 && height > 0) setSize({ width, height });
        if (inputWidth > 0 && inputHeight > 0) {
          setInputSize({ width: inputWidth, height: inputHeight });
        }
        setLatencyMs(Math.round(performance.now() - started));
        setCapturedAt(Date.now());
        setError(undefined);
      } catch (caught) {
        if (!cancelled && !(caught instanceof DOMException && caught.name === 'AbortError')) {
          setError(caught instanceof Error ? caught.message : '画面读取失败');
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, intervalMs);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [deviceId, intervalMs, paused]);

  useEffect(
    () => () => {
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    },
    [],
  );

  return { url, size, inputSize, latencyMs, error, capturedAt };
}
