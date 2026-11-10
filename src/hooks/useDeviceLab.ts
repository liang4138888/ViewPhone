import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionRequest, DeviceInfo, DeviceListResponse } from '../../shared/types';
import { fetchDevices, openDeveloperSettings, sendAction } from '../lib/api';

export type LabStatus = 'loading' | 'ready' | 'error';

export function useDeviceLab() {
  const [snapshot, setSnapshot] = useState<DeviceListResponse>();
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState<LabStatus>('loading');
  const [error, setError] = useState<string>();
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const data = await fetchDevices(force);
      setSnapshot(data);
      setError(undefined);
      setStatus('ready');
      setSelectedId((current) => {
        if (current && data.devices.some((device) => device.id === current)) return current;
        return data.devices.find((device) => device.state === 'device')?.id;
      });
    } catch (caught) {
      setStatus((current) => (current === 'loading' ? 'error' : current));
      setError(caught instanceof Error ? caught.message : '无法读取设备列表');
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const selectedDevice = snapshot?.devices.find((device) => device.id === selectedId);
  return { snapshot, selectedDevice, selectedId, setSelectedId, status, error, refresh };
}

export function useDeviceActions(device?: DeviceInfo) {
  const [pending, setPending] = useState(0);
  const [lastError, setLastError] = useState<string>();
  const [lastErrorCode, setLastErrorCode] = useState<string>();
  const [lastActionAt, setLastActionAt] = useState<number>();
  const queue = useRef(Promise.resolve());

  const execute = useCallback(
    (action: ActionRequest) => {
      if (!device) return Promise.resolve(false);
      setPending((count) => count + 1);
      const task = queue.current.then(async () => {
        try {
          await sendAction(device.id, action);
          setLastActionAt(Date.now());
          setLastError(undefined);
          setLastErrorCode(undefined);
          return true;
        } catch (caught) {
          setLastError(caught instanceof Error ? caught.message : '操作失败');
          setLastErrorCode(
            caught && typeof caught === 'object' && 'code' in caught && typeof caught.code === 'string'
              ? caught.code
              : undefined,
          );
          return false;
        } finally {
          setPending((count) => Math.max(0, count - 1));
        }
      });
      queue.current = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    [device],
  );

  const openSettings = useCallback(async () => {
    if (!device) return false;
    try {
      await openDeveloperSettings(device.id);
      setLastError(undefined);
      setLastErrorCode(undefined);
      return true;
    } catch (caught) {
      setLastError(caught instanceof Error ? caught.message : '无法打开开发者选项');
      setLastErrorCode(undefined);
      return false;
    }
  }, [device]);

  return {
    execute,
    pending,
    lastError,
    lastErrorCode,
    lastActionAt,
    openSettings,
    clearError: () => {
      setLastError(undefined);
      setLastErrorCode(undefined);
    },
  };
}
