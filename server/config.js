import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import dotenv from 'dotenv';

// Local credentials stay in .env.local (ignored by Git).
dotenv.config({ path: '.env.local', quiet: true });

function availablePath(candidates, fallback) {
  for (const candidate of candidates.filter(Boolean)) {
    if (!candidate.includes('/')) return candidate;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next installation location.
    }
  }
  return fallback;
}

const androidAdbCandidates = [
  process.env.ADB_PATH,
  process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
  process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
  join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
  join(homedir(), 'Android/Sdk/platform-tools/adb'),
];

const harmonyHdcCandidates = [
  process.env.HDC_PATH,
  process.env.HDC_HOME && join(process.env.HDC_HOME, 'hdc'),
  '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc',
  join(homedir(), 'Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc'),
  join(homedir(), 'Library/OpenHarmony/Sdk/12/toolchains/hdc'),
  join(homedir(), 'Library/Huawei/Sdk/HarmonyOS-NEXT-DP2/base/toolchains/hdc'),
  join(homedir(), 'Library/HarmonyOS/next/command-line-tools/sdk/default/openharmony/toolchains/hdc'),
  join(homedir(), 'Library/Huawei/Sdk/hmscore/3.1.0/toolchains/hdc'),
];

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3123),
  adbPath: availablePath(androidAdbCandidates, 'adb'),
  hdcPath: availablePath(harmonyHdcCandidates, 'hdc'),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  wdaUrl: (process.env.WDA_URL || 'http://127.0.0.1:8100').replace(/\/$/, ''),
  wdaSessionId: process.env.WDA_SESSION_ID || '',
  frameIntervalMs: Math.max(250, Number(process.env.CLIENT_FRAME_INTERVAL_MS || 450)),
  visionMaxSteps: Math.max(1, Math.min(100, Number(process.env.VISION_MAX_STEPS || 30))),
  visionHistoryRounds: Math.max(1, Math.min(20, Number(process.env.VISION_HISTORY_ROUNDS || 5))),
  archive: {
    root: process.env.VIEWPHONE_ARCHIVE_ROOT || '',
    mysqlUrl: process.env.MYSQL_URL
      || process.env.SPRING_DATASOURCE_URL
      || process.env.SPRING_DATASOURCE_URL_DEFAULT
      || '',
    mysqlUser: process.env.MYSQL_USER
      || process.env.SPRING_DATASOURCE_USERNAME
      || '',
    mysqlPassword: process.env.MYSQL_PASSWORD
      || process.env.SPRING_DATASOURCE_PASSWORD
      || '',
    mysqlDriver: process.env.MYSQL_DRIVER
      || process.env.SPRING_DATASOURCE_DRIVER_CLASS_NAME
      || 'com.mysql.cj.jdbc.Driver',
    shareTtlDays: Math.max(1, Number(process.env.ARCHIVE_SHARE_TTL_DAYS || 30)),
  },
  testRunsRoot: process.env.VIEWPHONE_TEST_RUNS_ROOT || '',
};
