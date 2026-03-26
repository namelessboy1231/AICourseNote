import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_RUNTIME_CONFIG_FILE = 'aicoursenote.local.json';

type LocalRuntimeConfigFile = {
  mode?: string;
  dataDir?: string;
};

export type LocalRuntimePaths = {
  configPath: string;
  appDir: string;
  dataDir: string;
  userDataDir: string;
  sessionDataDir: string;
  logsDir: string;
  crashDumpsDir: string;
};

function tryReadJson(filePath: string) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const normalized = raw.replace(/^\uFEFF/, '').trim();
    return JSON.parse(normalized) as LocalRuntimeConfigFile;
  } catch {
    return null;
  }
}

function resolveConfigPath() {
  const explicitConfigPath = process.env.AICOURSENOTE_LOCAL_CONFIG?.trim();

  if (explicitConfigPath && fs.existsSync(explicitConfigPath)) {
    return explicitConfigPath;
  }

  if (!app.isPackaged) {
    return null;
  }

  const executableDir = path.dirname(process.execPath);
  const packagedConfigPath = path.join(executableDir, LOCAL_RUNTIME_CONFIG_FILE);
  return fs.existsSync(packagedConfigPath) ? packagedConfigPath : null;
}

export function resolveLocalRuntimePaths(): LocalRuntimePaths | null {
  const configPath = resolveConfigPath();

  if (!configPath) {
    return null;
  }

  const config = tryReadJson(configPath);

  if (!config || (config.mode && config.mode !== 'directory-local')) {
    return null;
  }

  const appDir = path.dirname(configPath);
  const dataDir = path.resolve(appDir, config.dataDir?.trim() || '../data');

  return {
    configPath,
    appDir,
    dataDir,
    userDataDir: path.join(dataDir, 'electron-user-data'),
    sessionDataDir: path.join(dataDir, 'session-data'),
    logsDir: path.join(dataDir, 'logs'),
    crashDumpsDir: path.join(dataDir, 'crash-dumps')
  };
}

export function applyLocalRuntimePaths() {
  const paths = resolveLocalRuntimePaths();

  if (!paths) {
    return null;
  }

  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.userDataDir, { recursive: true });
  fs.mkdirSync(paths.sessionDataDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.crashDumpsDir, { recursive: true });

  process.env.AICOURSENOTE_DATA_DIR = paths.dataDir;
  process.env.AICOURSENOTE_INSTALL_ROOT = path.dirname(paths.appDir);

  app.setPath('userData', paths.userDataDir);
  app.setPath('sessionData', paths.sessionDataDir);
  app.setPath('crashDumps', paths.crashDumpsDir);
  app.setAppLogsPath(paths.logsDir);

  return paths;
}
