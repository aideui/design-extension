import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBin, spawnJsonLines } from './bin.js';
import { headLines, tailLines, parseLines, memoByFile, removeUnder } from './files.js';
import { stripInjectedContext, toActivityEvent } from '../sessions.js';

export const id = 'claude';
export const label = 'Claude Code';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 4 * 1024 * 1024;

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function projectsRoot() {
  return path.join(claudeHome(), 'projects');
}

export function bin() {
  return resolveBin('claude', {
    envVar: 'CLAUDE_BIN',
    candidates: [path.join(os.homedir(), '.claude', 'local', 'claude')],
  });
}

export function status() {
  const file = bin();
  if (!file) return { installed: false, ready: false, reason: '未安装 Claude Code' };
  if (process.env.ANTHROPIC_API_KEY) return { installed: true, ready: true };
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (config.oauthAccount) return { installed: true, ready: true };
  } catch {}
  return { installed: true, ready: false, reason: '未登录，终端运行 claude 登录' };
}

/** Claude Code names project dirs after the cwd with every non-alphanumeric char as '-'. */
export function projectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

const TOOL_KINDS = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  WebFetch: 'fetch',
};

function toolActivity(block, status) {
  const subagent = block.name === 'Task' || block.name === 'Agent';
  return toActivityEvent({
    type: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
    toolCallId: block.id || block.tool_use_id,
    toolName: subagent ? 'spawn_subagent' : block.name,
    kind: TOOL_KINDS[block.name],
    rawInput: block.input,
    status,
  });
}

/**
 * Map one `--output-format stream-json` line to side-panel events. Subagent
 * traffic (parent_tool_use_id) is dropped so only the main reply streams.
 */
export function mapStreamEvent(event, state) {
  const out = [];
  if (event.session_id) state.sessionId = event.session_id;
  if (event.parent_tool_use_id) return out;
  if (event.type === 'stream_event') {
    const inner = event.event || {};
    if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
      state.text += inner.delta.text;
      out.push({ type: 'text', data: inner.delta.text });
    } else if (inner.type === 'content_block_start' && inner.content_block?.type === 'thinking') {
      out.push({ type: 'activity', verb: 'think', label: '思考中', status: 'in_progress' });
    } else if (inner.type === 'message_start' && state.text && !state.text.endsWith('\n\n')) {
      // A new assistant message after tool calls: keep paragraphs apart.
      state.text += '\n\n';
      out.push({ type: 'text', data: '\n\n' });
    }
    return out;
  }
  if (event.type === 'assistant') {
    for (const block of event.message?.content || []) {
      if (block.type === 'tool_use') {
        const activity = toolActivity(block, 'in_progress');
        if (activity) out.push(activity);
        state.tools.set(block.id, block);
      }
    }
    return out;
  }
  if (event.type === 'user' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const tool = state.tools.get(block.tool_use_id);
      const activity = toolActivity(tool || block, block.is_error ? 'failed' : 'completed');
      if (activity) out.push(activity);
    }
    return out;
  }
  if (event.type === 'result') {
    if (event.is_error || (event.subtype && event.subtype !== 'success')) {
      state.error = String(event.result || event.subtype || 'Claude Code error');
    } else if (typeof event.result === 'string' && event.result) {
      state.finalText = event.result;
    }
  }
  return out;
}

export function start({ prompt, rules, sessionId, cwd, timeoutMs = 600000, onEvent }) {
  const file = bin();
  if (!file) throw new Error('Claude Code is not installed');
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Same trust level as Grok --always-approve: edit files and run the bridge CLI without asking.
    '--permission-mode',
    'bypassPermissions',
  ];
  if (rules) args.push('--append-system-prompt', rules);
  if (sessionId) args.push('--resume', sessionId);
  const state = { text: '', finalText: '', sessionId: sessionId || null, tools: new Map(), error: null };
  return spawnJsonLines({
    bin: file,
    args,
    cwd,
    timeoutMs,
    label: 'claude',
    onLine: (event) => {
      for (const out of mapStreamEvent(event, state)) onEvent?.(out);
    },
    finish: () => ({
      text: state.finalText || state.text,
      sessionId: state.sessionId,
      error: state.error,
    }),
  });
}

function textOf(content) {
  if (typeof content === 'string') return content.startsWith('<') ? '' : content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && part.text && !part.text.startsWith('<'))
    .map((part) => part.text)
    .join('\n');
}

function userText(row) {
  if (row.isMeta || row.isSidechain || row.isCompactSummary) return '';
  return stripInjectedContext(textOf(row.message?.content).trim());
}

function assistantText(row) {
  if (row.isSidechain) return '';
  return textOf(row.message?.content).trim();
}

const summarize = memoByFile((file, stat) => {
  const head = parseLines(headLines(file, 256 * 1024), ['"type":"user"']);
  const tail = parseLines(tailLines(file, 256 * 1024), ['"ai-title"', '"type":"user"']);
  const firstUser = head.find((row) => row.type === 'user' && userText(row));
  if (!firstUser) return null;
  const titleRow = [...tail].reverse().find((row) => row.type === 'ai-title' && row.aiTitle);
  const cwd = firstUser.cwd || tail.find((row) => row.cwd)?.cwd || null;
  return {
    id: path.basename(file, '.jsonl'),
    title: titleRow?.aiTitle || userText(firstUser).slice(0, 80),
    cwd,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    createdAt: firstUser.timestamp || null,
  };
});

function sessionFiles(cwd) {
  const root = projectsRoot();
  let dirs = [];
  if (cwd) {
    const slugs = new Set([projectSlug(cwd)]);
    try {
      slugs.add(projectSlug(fs.realpathSync(cwd)));
    } catch {}
    dirs = [...slugs].map((slug) => path.join(root, slug));
  } else {
    try {
      dirs = fs.readdirSync(root).map((name) => path.join(root, name));
    } catch {
      return [];
    }
  }
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.jsonl') && UUID_RE.test(name.slice(0, -6))) files.push(path.join(dir, name));
    }
  }
  return files;
}

export function listSessions({ limit = 40, cwd } = {}) {
  const items = [];
  for (const file of sessionFiles(cwd)) {
    const item = summarize(file);
    if (item) items.push(item);
  }
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return items.slice(0, limit);
}

export function findSessionFile(sessionId) {
  if (!UUID_RE.test(sessionId)) return null;
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsRoot());
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(projectsRoot(), dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function readMessages(file) {
  const rows = parseLines(tailLines(file, TAIL_BYTES), ['"type":"user"', '"type":"assistant"']);
  const messages = [];
  for (const row of rows) {
    const role = row.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = role === 'user' ? userText(row) : assistantText(row);
    if (!text) continue;
    const last = messages[messages.length - 1];
    // One reply arrives as several assistant lines around tool calls.
    if (role === 'assistant' && last?.role === 'assistant') {
      last.text = `${last.text}\n\n${text}`.slice(0, 8000);
      last.at = row.timestamp || last.at;
      continue;
    }
    messages.push({ role, text: text.slice(0, 8000), at: row.timestamp || null });
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
  removeUnder(projectsRoot(), file);
  return { ok: true, id: sessionId };
}

export function terminalArgv(sessionId) {
  return [bin() || 'claude', '--resume', sessionId];
}

export function hasSession(sessionId) {
  return !!findSessionFile(sessionId);
}
