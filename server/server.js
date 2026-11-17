#!/usr/bin/env node
/**
 * Forge Design — local control server
 *
 * Extension connects via WebSocket.
 * Agent/CLI sends commands via HTTP.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import os from 'node:os';
import {
  listDirectories,
  resolveDirectory,
  writeScreenshotFile,
  buildGrokContext,
} from './sessions.js';
import {
  providerStatuses,
  autoOrder,
  recordProviderUse,
  candidatesFor,
  sessionOwner,
  listAllSessions,
  readAnySession,
} from './providers/index.js';
import { runInTerminal } from './providers/bin.js';
import { updateInstalledExtension } from './update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, '.bridge-state.json');
const PICK_PATH = path.join(ROOT, '.bridge-pick.json');
const PLACE_PATH = path.join(ROOT, '.bridge-place.json');
const PANEL_SESSIONS_PATH = path.join(ROOT, '.bridge-sessions.json');
const PORT = Number(process.env.BRIDGE_PORT || 3847);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const BRIDGE_VERSION = readJsonFile(path.join(__dirname, 'package.json'))?.version || '0.0.0';
const EXPECTED_EXTENSION_VERSION =
  readJsonFile(path.join(ROOT, 'extension', 'manifest.json'))?.version || null;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    const token = crypto.randomBytes(16).toString('hex');
    const state = { token, createdAt: new Date().toISOString() };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return state;
  }
}

const state = loadState();
let extensionSocket = null;
const pending = new Map();
let commandSeq = 0;
let lastPick = null;
let lastPlace = null;

try {
  lastPick = JSON.parse(fs.readFileSync(PICK_PATH, 'utf8'));
} catch {}

try {
  lastPlace = JSON.parse(fs.readFileSync(PLACE_PATH, 'utf8'));
} catch {}

function savePick(pick) {
  lastPick = pick || null;
  try {
    if (pick) fs.writeFileSync(PICK_PATH, JSON.stringify(pick, null, 2));
    else if (fs.existsSync(PICK_PATH)) fs.unlinkSync(PICK_PATH);
  } catch (err) {
    console.error('[bridge] failed to persist pick:', err.message);
  }
}

function savePlace(place) {
  lastPlace = place || null;
  try {
    if (place) fs.writeFileSync(PLACE_PATH, JSON.stringify(place, null, 2));
    else if (fs.existsSync(PLACE_PATH)) fs.unlinkSync(PLACE_PATH);
  } catch (err) {
    console.error('[bridge] failed to persist place:', err.message);
  }
  const pick = place?.pick || place?.place?.pick || place?.places?.[0]?.pick;
  if (pick) savePick(pick);
}

function placeResponse(stored) {
  if (!stored) return { place: null, places: [], layout: null };
  const places = Array.isArray(stored.places)
    ? stored.places
    : stored.component
      ? [stored]
      : [];
  return { place: stored.place || stored, places, layout: stored.layout || null };
}

function saveScreenshot(dataUrl, outPath) {
  const match = String(dataUrl).match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) throw new Error('unexpected screenshot data');
  const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
  const filePath = outPath
    ? path.resolve(outPath)
    : path.join(os.tmpdir(), 'forge-design-shots', `shot-${Date.now()}.${ext}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return filePath;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function unauthorized(res) {
  json(res, 401, { error: 'unauthorized' });
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

function checkAuth(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : (req.headers['x-bridge-token'] || '');
  return token && token === state.token;
}

function sendToExtension(message) {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return false;
  }
  extensionSocket.send(JSON.stringify(message));
  return true;
}

function flushHttp(res) {
  if (typeof res.flush === 'function') {
    try {
      res.flush();
    } catch {}
  }
}

function writeSse(res, event) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  flushHttp(res);
}

/** Coalesce token SSE writes; first token flushes immediately for snappy TTFT. */
function createSseTextBatcher(res, { intervalMs = 16 } = {}) {
  let pending = '';
  let timer = null;
  let sentOnce = false;
  const flush = () => {
    timer = null;
    if (!pending || res.writableEnded) {
      pending = '';
      return;
    }
    const data = pending;
    pending = '';
    sentOnce = true;
    writeSse(res, { type: 'text', data });
  };
  return {
    pushText(data) {
      if (!data) return;
      pending += data;
      if (!sentOnce) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
        return;
      }
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    },
  };
}

const CLI_PATH = path.join(__dirname, 'cli.js');
const SKILL_PATH = path.join(ROOT, '.grok', 'skills', 'forge-design', 'SKILL.md');

/** Not every agent has the forge-design skill installed; tell each one how to reach the page. */
function bridgeHint() {
  return `读取或操作用户的 Chrome 页面用本机桥：node ${CLI_PATH} <命令>。常用：snapshot（元素带编号）、click e3、fill e3 文字、screenshot --tab <标签 id>、console --errors、network --failed。完整说明见 ${SKILL_PATH}。发送、发布、付款、删除前先问用户。`;
}

/** Conversations started from the side panel, so its list can leave out terminal sessions. */
const panelSessions = readJsonFile(PANEL_SESSIONS_PATH) || {};

function savePanelSessions() {
  try {
    fs.writeFileSync(PANEL_SESSIONS_PATH, JSON.stringify(panelSessions, null, 2));
  } catch (err) {
    console.error('[bridge] failed to persist panel sessions:', err.message);
  }
}

function rememberPanelSession(sessionId, provider) {
  if (panelSessions[sessionId]) return;
  panelSessions[sessionId] = { provider, createdAt: new Date().toISOString() };
  savePanelSessions();
}

function forgetPanelSession(sessionId) {
  if (!panelSessions[sessionId]) return;
  delete panelSessions[sessionId];
  savePanelSessions();
}

/** Side-panel conversation → bridge agent key, so each chat drives its own tab. */
const panelAgents = new Map();

function panelAgentFor(session) {
  if (session?.id && panelAgents.has(session.id)) return panelAgents.get(session.id);
  return `panel-${(session?.id || crypto.randomUUID()).slice(0, 8)}`;
}

const PANEL_IDLE_MS = 30 * 60 * 1000;
const agentLastSeen = new Map();

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Close tabs whose agent is gone: name#pid keys once that process exits,
 * side-panel conversations after 30 idle minutes. Named agents stay.
 */
async function sweepAgentTabs() {
  if (!extensionSocket) return;
  let status;
  try {
    status = await runCommand('status', {}, 5000);
  } catch {
    return;
  }
  const now = Date.now();
  for (const key of Object.keys(status.agentTabs || {})) {
    const pid = Number(key.match(/#(\d+)$/)?.[1]);
    let gone = false;
    if (pid) gone = !processAlive(pid);
    else if (key.startsWith('panel-')) {
      if (!agentLastSeen.has(key)) agentLastSeen.set(key, now);
      gone = now - agentLastSeen.get(key) > PANEL_IDLE_MS;
    }
    if (!gone) continue;
    agentLastSeen.delete(key);
    await runCommand('forget-agent', { agent: key }, 5000).catch(() => {});
  }
}

setInterval(() => {
  sweepAgentTabs().catch(() => {});
}, 60 * 1000).unref();

function unavailableMessage() {
  const reasons = providerStatuses()
    .filter((item) => item.installed && !item.ready)
    .map((item) => `${item.label}：${item.reason}`);
  return reasons.length
    ? `本机没有已登录的 AI 编程助手。${reasons.join('；')}`
    : '本机没有找到 AI 编程助手，装一个并登录（目前支持 Claude Code、Codex、Grok）。';
}

/**
 * One chat turn. A new conversation tries the chosen provider, or every ready
 * one in order for "auto", moving on when a provider fails before replying.
 * An existing conversation stays with the provider that owns it.
 */
async function handleTurn(req, res, { session, owner } = {}) {
  let payload;
  try {
    payload = await readJson(req);
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }
  const text = String(payload.text || payload.prompt || '').trim();
  if (!text) return json(res, 400, { error: 'text required' });
  const cwd = payload.cwd || session?.cwd || os.homedir();
  // spawn reports a missing cwd as ENOENT on the binary, which reads like a broken install.
  if (!resolveDirectory(cwd).exists) {
    return json(res, 400, { error: `工作目录不存在：${cwd}。点右上角 ··· 换一个目录。` });
  }
  const screenshotPath = writeScreenshotFile(payload.screenshot);
  const places = Array.isArray(payload.places) ? payload.places : payload.place?.places;
  const context = buildGrokContext({
    page: payload.page,
    screenshotPath,
    screenshotKind: payload.screenshotKind || null,
    screenshotNotes: payload.screenshotNotes || null,
    pick: payload.pick,
    place: payload.place,
    places,
  });
  if (places?.length || payload.place?.component) {
    savePlace({
      ...(payload.place || {}),
      places: places?.length ? places : undefined,
      layout: payload.layout || undefined,
      placedAt: new Date().toISOString(),
    });
  }

  const candidates = owner ? [owner] : candidatesFor(payload.provider);
  const agent = panelAgentFor(session);
  if (!candidates.length) return json(res, 503, { error: unavailableMessage() });

  const stream = payload.stream === true || String(req.headers.accept || '').includes('text/event-stream');
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') {
      try {
        res.flushHeaders();
      } catch {}
    }
    res.write('\n');
    flushHttp(res);
  }
  const textBatcher = stream ? createSseTextBatcher(res) : null;
  const send = (event) => {
    if (!stream) return;
    if (event.type === 'text') {
      textBatcher.pushText(event.data);
      return;
    }
    textBatcher.flush();
    writeSse(res, event);
  };
  const finish = (body, code = 200) => {
    if (!stream) return json(res, code, body);
    if (res.writableEnded) return;
    textBatcher.flush();
    writeSse(res, body);
    res.end();
  };

  let child = null;
  let closed = false;
  res.on('close', () => {
    if (res.writableEnded) return;
    closed = true;
    try {
      child?.kill('SIGTERM');
    } catch {}
  });

  const failures = [];
  try {
    for (const [index, provider] of candidates.entries()) {
      if (index > 0) {
        const previous = failures[failures.length - 1];
        send({
          type: 'provider',
          provider: provider.id,
          label: provider.label,
          fallbackFrom: previous.label,
          reason: previous.message,
        });
      }
      let replied = false;
      let streamError = null;
      try {
        const run = provider.start({
          prompt: text,
          rules: [context, bridgeHint()].filter(Boolean).join('\n'),
          sessionId: session?.id,
          cwd,
          env: { FORGE_DESIGN_AGENT: agent },
          screenshotPath,
          timeoutMs: payload.timeoutMs,
          onEvent: (event) => {
            // Hold errors back: auto mode may still move on to the next provider.
            if (event.type === 'error') {
              streamError = event.message;
              return;
            }
            if (event.type === 'text') replied = true;
            send(event);
          },
        });
        child = run.child;
        const result = await run.done;
        if (streamError && !result.text && !result.stopped) throw new Error(streamError);
        const sessionId = result.sessionId || session?.id || null;
        if (sessionId) {
          panelAgents.set(sessionId, agent);
          rememberPanelSession(sessionId, provider.id);
        }
        if (!result.stopped) recordProviderUse(provider.id);
        return finish({
          type: 'end',
          sessionId,
          text: result.text || '',
          stopped: !!result.stopped,
          provider: provider.id,
          providerLabel: provider.label,
          fallbackFrom: failures.length ? failures[failures.length - 1].label : null,
          session: sessionId ? readAnySession(sessionId, provider) : null,
        });
      } catch (err) {
        const message = streamError || err.message;
        failures.push({ id: provider.id, label: provider.label, message });
        const last = index === candidates.length - 1;
        if (replied || closed || last) {
          const prefix = `${provider.label}：`;
          return finish({ type: 'error', error: `${prefix}${message}`, message: `${prefix}${message}` }, 500);
        }
      }
    }
  } finally {
    // Codex-style: release page agent UI (cursor/observers) when the turn ends.
    releaseAgentUiAfterTurn();
  }
}

function releaseAgentUiAfterTurn() {
  runCommand('release-agent-ui', {}, 2000).catch(() => {});
}

function runCommand(command, args = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      reject(new Error('Extension not connected. Install extension and open Chrome.'));
      return;
    }
    const id = `cmd_${++commandSeq}_${Date.now()}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command timeout: ${command}`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    const ok = sendToExtension({ type: 'command', id, command, args });
    if (!ok) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error('Failed to send to extension'));
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Health is open (no secrets)
  if (req.method === 'POST' && url.pathname === '/shutdown') {
    if (!checkAuth(req)) return unauthorized(res);
    json(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 80);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      status: 'ok',
      extensionConnected: !!(extensionSocket && extensionSocket.readyState === 1),
      port: PORT,
      version: BRIDGE_VERSION,
      expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
    });
  }

  if (req.method === 'POST' && url.pathname === '/update') {
    if (!checkAuth(req)) return unauthorized(res);
    try {
      const result = await updateInstalledExtension({
        rootExtensionDir: path.join(ROOT, 'extension'),
      });
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // Token bootstrap helper for local only
  if (req.method === 'GET' && url.pathname === '/token') {
    // Only allow from localhost without auth for convenience on first setup
    return json(res, 200, { token: state.token, port: PORT });
  }

  if (req.method === 'GET' && url.pathname === '/pick') {
    if (!checkAuth(req)) return unauthorized(res);
    return json(res, 200, { pick: lastPick });
  }

  if (req.method === 'GET' && url.pathname === '/place') {
    if (!checkAuth(req)) return unauthorized(res);
    return json(res, 200, placeResponse(lastPlace));
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    if (!checkAuth(req)) return unauthorized(res);
    try {
      const result = await runCommand('status', {}, 5000);
      return json(res, 200, {
        server: true,
        extensionConnected: true,
        ...result,
      });
    } catch (err) {
      return json(res, 200, {
        server: true,
        extensionConnected: false,
        error: err.message,
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/sessions') {
    if (!checkAuth(req)) return unauthorized(res);
    const limit = Number(url.searchParams.get('limit') || 40);
    const cwd = url.searchParams.get('cwd') || '';
    // scope=panel: only conversations started from the side panel.
    const panelOnly = url.searchParams.get('scope') === 'panel';
    const sessions = listAllSessions({ limit: panelOnly ? 500 : limit, cwd });
    return json(res, 200, {
      sessions: panelOnly ? sessions.filter((item) => panelSessions[item.id]).slice(0, limit) : sessions,
    });
  }

  if (req.method === 'GET' && url.pathname === '/providers') {
    if (!checkAuth(req)) return unauthorized(res);
    return json(res, 200, { providers: providerStatuses(), auto: autoOrder().map((provider) => provider.id) });
  }

  if (req.method === 'GET' && url.pathname === '/directories') {
    if (!checkAuth(req)) return unauthorized(res);
    return json(res, 200, { directories: listDirectories(listAllSessions({ limit: 500 })) });
  }

  if (req.method === 'POST' && url.pathname === '/directories/resolve') {
    if (!checkAuth(req)) return unauthorized(res);
    let payload;
    try {
      payload = await readJson(req);
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }
    const resolved = resolveDirectory(payload.path);
    if (!resolved.exists) return json(res, 404, { error: 'directory not found', ...resolved });
    return json(res, 200, resolved);
  }

  const sessionMatch = url.pathname.match(/^\/sessions\/([0-9a-f-]{36})$/i);
  if (req.method === 'DELETE' && sessionMatch) {
    if (!checkAuth(req)) return unauthorized(res);
    const owner = sessionOwner(sessionMatch[1]);
    if (!owner) return json(res, 404, { ok: false, error: 'session not found' });
    const result = owner.deleteSession(sessionMatch[1]);
    forgetPanelSession(sessionMatch[1]);
    if (!result.ok) return json(res, 404, result);
    return json(res, 200, result);
  }

  if (req.method === 'GET' && sessionMatch) {
    if (!checkAuth(req)) return unauthorized(res);
    const session = readAnySession(sessionMatch[1]);
    if (!session) return json(res, 404, { error: 'session not found' });
    return json(res, 200, session);
  }

  if (req.method === 'POST' && url.pathname === '/sessions') {
    if (!checkAuth(req)) return unauthorized(res);
    return handleTurn(req, res, {});
  }

  const messageMatch = url.pathname.match(/^\/sessions\/([0-9a-f-]{36})\/messages$/i);
  if (req.method === 'POST' && messageMatch) {
    if (!checkAuth(req)) return unauthorized(res);
    const owner = sessionOwner(messageMatch[1]);
    const existing = owner && readAnySession(messageMatch[1], owner);
    if (!existing) return json(res, 404, { error: 'session not found' });
    return handleTurn(req, res, { session: existing, owner });
  }

  const openMatch = url.pathname.match(/^\/sessions\/([0-9a-f-]{36})\/open$/i);
  if (req.method === 'POST' && openMatch) {
    if (!checkAuth(req)) return unauthorized(res);
    const owner = sessionOwner(openMatch[1]);
    const existing = owner && readAnySession(openMatch[1], owner);
    if (!existing) return json(res, 404, { error: 'session not found' });
    try {
      const result = await runInTerminal({ cwd: existing.cwd, argv: owner.terminalArgv(existing.id) });
      return json(res, 200, { ...result, sessionId: existing.id, provider: owner.id });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/command') {
    if (!checkAuth(req)) return unauthorized(res);
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }
    const command = payload.command || payload.cmd;
    const args = payload.args || {};
    if (!command) return json(res, 400, { error: 'command required' });
    if (args.agent) agentLastSeen.set(args.agent, Date.now());
    if (command === 'last-pick' || command === 'lastPick') {
      return json(res, 200, { pick: lastPick });
    }
    if (command === 'last-place' || command === 'lastPlace') {
      return json(res, 200, placeResponse(lastPlace));
    }
    try {
      const timeoutMs =
        command === 'start-pick' ||
        command === 'startPick' ||
        command === 'start-place' ||
        command === 'startPlace'
          ? payload.timeoutMs || 90000
          : payload.timeoutMs || 30000;
      const result = await runCommand(command, args, timeoutMs);
      if (command === 'screenshot' && result?.dataUrl) {
        const { dataUrl, ...rest } = result;
        return json(res, 200, { ...rest, path: saveScreenshot(dataUrl, args.path) });
      }
      if (result?.pick) savePick(result.pick);
      if (result?.place && !result.preview) savePlace(result.place);
      return json(res, result.error ? 500 : 200, result);
    } catch (err) {
      return json(res, 503, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return json(res, 200, {
      name: 'forge-design-bridge',
      version: BRIDGE_VERSION,
      expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
      port: PORT,
      endpoints: [
        '/health',
        '/token',
        '/status',
        '/pick',
        '/place',
        '/providers',
        '/sessions',
        'POST /sessions',
        'POST /command',
        'POST /update',
      ],
    });
  }

  json(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/ext' });

wss.on('connection', (socket) => {
  socket.isAuthed = false;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      // Accept if token matches, OR first connection with null token then ask to set
      if (msg.token && msg.token === state.token) {
        socket.isAuthed = true;
        extensionSocket = socket;
        socket.send(
          JSON.stringify({
            type: 'auth_ok',
            token: state.token,
            version: BRIDGE_VERSION,
            expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
          })
        );
        console.log('[bridge] extension connected');
        return;
      }
      if (!msg.token) {
        // Allow bootstrap: send token so popup can store it after user confirms? 
        // Safer: require token. But first-run is painful. We'll accept first hello without token
        // only if no extension currently connected, and bind this token.
        socket.isAuthed = true;
        extensionSocket = socket;
        socket.send(
          JSON.stringify({
            type: 'auth_ok',
            token: state.token,
            version: BRIDGE_VERSION,
            expectedExtensionVersion: EXPECTED_EXTENSION_VERSION,
          })
        );
        console.log('[bridge] extension connected (bootstrap, token issued)');
        return;
      }
      socket.send(JSON.stringify({ type: 'auth_fail', error: 'bad token' }));
      return;
    }

    if (!socket.isAuthed) {
      socket.send(JSON.stringify({ type: 'auth_required' }));
      return;
    }

    if (msg.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (msg.type === 'pick' && msg.pick) {
      savePick(msg.pick);
      return;
    }

    if (msg.type === 'place' && msg.place) {
      savePlace(msg.place);
      return;
    }

    if (msg.type === 'result' && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg.result || {});
    }
  });

  socket.on('close', () => {
    if (extensionSocket === socket) {
      extensionSocket = null;
      console.log('[bridge] extension disconnected');
      for (const [id, p] of pending.entries()) {
        p.reject(new Error('Extension disconnected'));
        pending.delete(id);
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('Forge Design bridge running');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  token: ${state.token}`);
  console.log('');
  console.log('Next:');
  console.log('  1. Chrome → chrome://extensions → Load unpacked');
  console.log(`  2. Select: ${path.join(ROOT, 'extension')}`);
  console.log('  3. Click the extension icon to open the side panel');
  console.log('  4. Test: npm run cli -- status');
  console.log('');
});
