import { useEffect, useRef, useState } from 'react';
import type {
  ActionRequest,
  DeviceInfo,
  NativeTouchStatus,
} from '../../shared/types';
import type { DeviceSize } from '../../shared/coordinates';
import {
  fetchNativeTouch,
  startNativeTouch,
  stopNativeTouch,
} from '../lib/api';

const POLL_INTERVAL_MS = 120;
const REQUEST_TIMEOUT_MS = 5_000;

type Props = {
  enabled: boolean;
  source?: DeviceInfo;
  fallbackSize?: DeviceSize;
  onGesture: (action: ActionRequest, sourceSize: DeviceSize, sourceId: string) => void;
};

export function useNativeTouch({ enabled, source, fallbackSize, onGesture }: Props) {
  const [status, setStatus] = useState<NativeTouchStatus>();
  const [readError, setReadError] = useState<string>();
  const owner = useRef(0);
  const callback = useRef(onGesture);
  const connectionQueue = useRef(Promise.resolve());
  callback.current = onGesture;

  useEffect(() => {
    const activation = ++owner.current;
    setStatus(undefined);
    setReadError(undefined);
    if (!enabled || !source || source.platform !== 'android' || source.state !== 'device') return;

    let cancelled = false;
    let cursor = 0;
    let pollTimer: number | undefined;
    let polling = false;
    let failures = 0;

    const current = () => !cancelled && owner.current === activation;

    const schedule = (delay = POLL_INTERVAL_MS) => {
      if (!current()) return;
      if (pollTimer) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (!current() || polling) return;
      polling = true;
      try {
        const next = await fetchNativeTouch(source.id, cursor);
        if (!current()) return;
        failures = 0;
        setReadError(undefined);
        setStatus(next);
        cursor = Math.max(cursor, next.sequence);
        const size = touchSourceSize(next, fallbackSize);
        if (size) {
          for (const event of next.events) {
            callback.current(event.action, size, source.id);
          }
        }
        if (next.enabled) schedule();
      } catch (error) {
        if (!current()) return;
        failures += 1;
        setReadError(errorMessage(error));
        // A restarted local server may briefly drop the request. Keep trying so
        // the listener can recover without requiring a browser refresh.
        if (failures < 3) schedule(400);
        else setStatus((previous) => previous
          ? { ...previous, enabled: false, state: 'error', error: errorMessage(error) }
          : { enabled: false, state: 'error', error: errorMessage(error), events: [], sequence: 0 });
      } finally {
        polling = false;
      }
    };

    const connect = async () => {
      try {
        const initial = await withTimeout(
          enqueueConnection(connectionQueue, () => startNativeTouch(source.id)),
        );
        if (!current()) return;
        setStatus(initial);
        cursor = initial.sequence;
        if (initial.enabled) schedule(0);
        else if (initial.state === 'error') setReadError(initial.error);
      } catch (error) {
        if (!current()) return;
        setReadError(errorMessage(error));
        setStatus({
          enabled: false,
          state: 'error',
          error: errorMessage(error),
          events: [],
          sequence: 0,
        });
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (pollTimer) window.clearTimeout(pollTimer);
      // Stop the server-side getevent process as soon as this source is turned
      // off, the phone disappears, or the page closes. Browser requests from
      // the replacement effect are sent after this cleanup request.
      void withTimeout(
        enqueueConnection(connectionQueue, () => stopNativeTouch(source.id)),
      ).catch(() => undefined);
    };
  }, [enabled, source?.id, fallbackSize?.width, fallbackSize?.height]);

  return { status, readError };
}

function enqueueConnection<T>(
  queue: { current: Promise<void> },
  task: () => Promise<T>,
): Promise<T> {
  const result = queue.current.then(task, task);
  queue.current = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function touchSourceSize(
  status: NativeTouchStatus,
  fallback?: DeviceSize,
): DeviceSize | undefined {
  if (status.sourceWidth && status.sourceHeight) {
    return { width: status.sourceWidth, height: status.sourceHeight };
  }
  return fallback;
}

async function withTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(
          () => reject(new Error('连接实体触控监听超时')),
          REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
