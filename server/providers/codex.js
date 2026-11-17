import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBin, spawnJsonLines } from './bin.js';
import { headLines, tailLines, parseLines, memoByFile, removeUnder } from './files.js';
import { stripInjectedContext, toActivityEvent } from '../sessions.js';

export const id = 'codex';
export const label = 'Codex';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const TAIL_BYTES = 4 * 1024 * 1024;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function sessionsRoot() {
  return path.join(codexHome(), 'sessions');
}

export function bin() {
  return resolveBin('codex', { envVar: 'CODEX_BIN' });
}

export function status() {
  const file = bin();
  if (!file) return { installed: false, ready: false, reason: '未安装 Codex' };
  if (process.env.OPENAI_API_KEY || fs.existsSync(path.join(codexHome(), 'auth.json'))) {
    return { installed: true, ready: true };
  }
  return { installed: true, ready: false, reason: '未登录，终端运行 codex login' };
}

function itemActivity(item, status) {
  const base = { toolCallId: item.id, status, type: status === 'in_progress' ? 'tool_call' : 'tool_call_update' };
  if (item.type === 'command_execution') return toActivityEvent({ ...base, kind: 'execute', toolName: 'shell' });
  if (item.type === 'file_change') {
    return toActivityEvent({ ...base, kind: 'edit', toolName: 'apply_patch', rawInput: { path: item.changes?.[0]?.path } });
  }
  if (item.type === 'web_search') {
    return toActivityEvent({ ...base, kind: 'search', toolName: 'web_search', rawInput: { query: item.query } });
  }
  if (item.type === 'mcp_tool_call') return toActivityEvent({ ...base, toolName: item.tool || 'mcp' });
  return null;
}

/**
 * Map one `codex exec --json` line. Codex sends whole agent messages, not
 * deltas, and reports config warnings as `error` items — those are not fatal.
 */
export function mapExecEvent(event, state) {
  const out = [];
  if (event.type === 'thread.started' && event.thread_id) {
    state.sessionId = event.thread_id;
    return out;
  }
  if (event.type === 'turn.failed') {
    state.error = String(event.error?.message || 'Codex turn failed');
    return out;
  }
  if (event.type === 'error') {
    // Also used for retries ("Reconnecting…"); only fatal if the process fails.
    state.lastError = String(event.message || 'Codex error');
    return out;
  }
  const item = event.item;
  if (!item) return out;
  if (event.type === 'item.completed' && item.type === 'agent_message' && item.text) {
    const data = state.text ? `\n\n${item.text}` : item.text;
    state.text += data;
    out.push({ type: 'text', data });
    return out;
  }
  if (item.type === 'reasoning' && event.type === 'item.started') {
    out.push({ type: 'activity', verb: 'think', label: '思考中', status: 'in_progress' });
    return out;
  }
  const status =
    event.type === 'item.started'
      ? 'in_progress'
      : item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0)
        ? 'failed'
        : 'completed';
  if (event.type === 'item.started' || event.type === 'item.completed') {
    const activity = itemActivity(item, status);
    if (activity) out.push(activity);
  }
  return out;
}

export function start({ prompt, rules, sessionId, cwd, screenshotPath, timeoutMs = 600000, onEvent }) {
  const file = bin();
  if (!file) throw new Error('Codex is not installed');
  // Codex has no system-prompt flag; the page context leads the prompt and is stripped on read.
  const fullPrompt = rules ? `${rules}\n\n${prompt}` : prompt;
  const options = [
    '--json',
    '--skip-git-repo-check',
    // Writes stay inside cwd; network stays on so the agent can reach the local bridge.
    '-c',
    'sandbox_mode="workspace-write"',
    '-c',
    'sandbox_workspace_write.network_access=true',
  ];
  if (screenshotPath) options.push('-i', screenshotPath);
  const args = sessionId
    ? ['exec', 'resume', ...options, sessionId, fullPrompt]
    : ['exec', ...options, fullPrompt];
  const state = { text: '', sessionId: sessionId || null, error: null, lastError: null };
  return spawnJsonLines({
    bin: file,
    args,
    cwd,
    timeoutMs,
    label: 'codex',
    onLine: (event) => {
      for (const out of mapExecEvent(event, state)) onEvent?.(out);
    },
    finish: () => ({
      text: state.text,
      sessionId: state.sessionId,
      error: state.error,
      failureHint: state.lastError,
    }),
  });
}

/** Newest first: sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl */
function rolloutFiles(limit = Infinity) {
  const files = [];
  const walk = (dir, depth) => {
    let names = [];
    try {
      names = fs.readdirSync(dir).sort().reverse();
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= limit) return;
      const full = path.join(dir, name);
      if (depth < 3) walk(full, depth + 1);
      else if (ROLLOUT_ID_RE.test(name)) files.push(full);
    }
  };
  walk(sessionsRoot(), 0);
  return files;
}

const summarize = memoByFile((file, stat) => {
  const rows = parseLines(headLines(file, 512 * 1024), ['"session_meta"', '"user_message"']);
  const meta = rows.find((row) => row.type === 'session_meta')?.payload || {};
  const firstUser = rows.find((row) => row.payload?.type === 'user_message' && userText(row));
  if (!firstUser) return null;
  return {
    id: meta.id || file.match(ROLLOUT_ID_RE)[1],
    title: userText(firstUser).slice(0, 80),
    cwd: meta.cwd || null,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    createdAt: meta.timestamp || firstUser.timestamp || null,
  };
});

function userText(row) {
  return stripInjectedContext(String(row.payload?.message || '').trim());
}

export function listSessions({ limit = 40, cwd } = {}) {
  const wanted = cwd ? path.resolve(cwd) : null;
  const items = [];
  // Rollouts are date-ordered; scan a bounded window so a big archive stays fast.
  for (const file of rolloutFiles(cwd ? 400 : limit * 3)) {
    const item = summarize(file);
    if (!item) continue;
    if (wanted && (!item.cwd || path.resolve(item.cwd) !== wanted)) continue;
    items.push(item);
  }
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return items.slice(0, limit);
}

export function findSessionFile(sessionId) {
  if (!UUID_RE.test(sessionId)) return null;
  return rolloutFiles().find((file) => file.endsWith(`${sessionId}.jsonl`)) || null;
}

export function readMessages(file) {
  const rows = parseLines(tailLines(file, TAIL_BYTES), ['"user_message"', '"agent_message"']);
  const messages = [];
  for (const row of rows) {
    if (row.type !== 'event_msg') continue;
    const kind = row.payload?.type;
    if (kind === 'user_message') {
      const text = userText(row);
      if (text) messages.push({ role: 'user', text: text.slice(0, 8000), at: row.timestamp || null });
    } else if (kind === 'agent_message') {
      const text = String(row.payload?.message || '').trim();
      if (!text) continue;
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        last.text = `${last.text}\n\n${text}`.slice(0, 8000);
        last.at = row.timestamp || last.at;
      } else {
        messages.push({ role: 'assistant', text: text.slice(0, 8000), at: row.timestamp || null });
      }
    }
  }
  return messages;
}

export function readSession(sessionId, { messageLimit = 80 } = {}) {
  const file = findSessionFile(sessionId);
  if (!file) return null;
  const summary = summarize(file);
  return {
    id: sessionId,
    title: summary?.title || '新对话',
    cwd: summary?.cwd || null,
    updatedAt: summary?.updatedAt || null,
    messages: readMessages(file).slice(-messageLimit),
  };
}

export function deleteSession(sessionId) {
  const file = findSessionFile(sessionId);
  if (!file) return { ok: false, error: 'session not found' };
  removeUnder(sessionsRoot(), file);
  return { ok: true, id: sessionId };
}

export function terminalArgv(sessionId) {
  return [bin() || 'codex', 'resume', sessionId];
}

export function hasSession(sessionId) {
  return !!findSessionFile(sessionId);
}
