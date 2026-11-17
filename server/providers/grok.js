import fs from 'node:fs';
import path from 'node:path';
import { resolveBin } from './bin.js';
import {
  grokHome,
  startGrokStream,
  listSessions as listGrokSessions,
  readSession as readGrokSession,
  deleteSession as deleteGrokSession,
  findSessionDir,
} from '../sessions.js';

export const id = 'grok';
export const label = 'Grok';

export function bin() {
  return resolveBin('grok', { envVar: 'GROK_BIN', candidates: [path.join(grokHome(), 'bin', 'grok')] });
}

function hasApiKey() {
  if (process.env.XAI_API_KEY) return true;
  try {
    return /^\s*api_key\s*=/m.test(fs.readFileSync(path.join(grokHome(), 'config.toml'), 'utf8'));
  } catch {
    return false;
  }
}

export function status() {
  if (!bin()) return { installed: false, ready: false, reason: '未安装 Grok' };
  if (fs.existsSync(path.join(grokHome(), 'auth.json')) || hasApiKey()) {
    return { installed: true, ready: true };
  }
  return { installed: true, ready: false, reason: '未登录，终端运行 grok login' };
}

export function start(options) {
  return startGrokStream(options);
}

export const listSessions = listGrokSessions;
export const readSession = readGrokSession;
export const deleteSession = deleteGrokSession;

export function terminalArgv(sessionId) {
  return [bin() || 'grok', '--resume', sessionId];
}

export function hasSession(sessionId) {
  return !!findSessionDir(sessionId);
}
