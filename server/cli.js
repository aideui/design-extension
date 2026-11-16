#!/usr/bin/env node
/**
 * CLI for the Forge Design local bridge
 *
 * Usage:
 *   node cli.js status
 *   node cli.js goto http://localhost:3000
 *   node cli.js snapshot
 *   node cli.js click "button[data-testid=save]"
 *   node cli.js fill "input[name=title]" "hello"
 *   node cli.js type "hello world"
 *   node cli.js press Enter
 *   node cli.js text
 *   node cli.js tabs
 *   node cli.js raw '{"command":"snapshot","args":{"limit":30}}'
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(ROOT, '.bridge-state.json');
const PORT = Number(process.env.BRIDGE_PORT || 3847);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';

// Ask the running bridge first: a CLI from another checkout (e.g. an old
// ~/.forge-design clone) has its own stale .bridge-state.json.
async function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
  try {
    const res = await fetch(`http://${HOST}:${PORT}/token`);
    if (res.ok) {
      const data = await res.json();
      if (data.token) return data.token;
    }
  } catch {}
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).token;
  } catch {
    throw new Error('No token. Start server first (npm start).');
  }
}

async function request(pathname, { method = 'GET', body } = {}) {
  const token = await loadToken();
  const res = await fetch(`http://${HOST}:${PORT}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function readUploadFiles(paths) {
  if (!paths.length) throw new Error('usage: upload <selector> <file...>');
  let total = 0;
  return paths.map((filePath) => {
    const data = fs.readFileSync(filePath);
    total += data.length;
    if (total > UPLOAD_LIMIT_BYTES) throw new Error('upload is over 50 MB');
    return {
      name: path.basename(filePath),
      type: MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      data: data.toString('base64'),
    };
  });
}

function parseMonitorArgs(rest) {
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--clear') args.clear = true;
    else if (flag === '--failed') args.failed = true;
    else if (flag === '--errors') args.level = 'error';
    else if (flag === '--limit') args.limit = Number(rest[++i]);
    else throw new Error(`unknown flag: ${flag}`);
  }
  return args;
}

function parseScreenshotArgs(rest) {
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--full') args.fullPage = true;
    else if (flag === '--jpeg') args.format = 'jpeg';
    else if (flag === '--foreground') args.foreground = true;
    else if (flag === '--selector') args.selector = rest[++i];
    else if (flag === '--out') args.path = path.resolve(rest[++i]);
    else throw new Error(`unknown screenshot flag: ${flag}`);
  }
  return args;
}

function usage() {
  console.log(`forge-design CLI

Commands:
  status
  health
  tabs
  url
  goto <url>
  newtab [url]
  activate <tabId>
  reload
  text
  snapshot [limit]
  click <selector>
  fill <selector> <text...>
  upload <selector> <file...>
  type <text...>
  press <key>
  wait <selector>
  exists <selector>
  scroll [y]
  eval <expression>
  reload-extension
  frames
  console [--errors] [--clear] [--limit n]
  network [--failed] [--clear] [--limit n]
  screenshot [--full] [--selector <css|ref>] [--out <file>] [--jpeg] [--foreground]
  last-pick
  start-pick
  last-place
  start-place
  raw <json>

Any command takes --tab <id> (an open tab) and --frame <id> (an iframe from frames).
Snapshot refs (e12, f3e12) work wherever a selector does.

Examples:
  node cli.js goto https://x.com/home
  node cli.js snapshot
  node cli.js fill 'div[role=textbox]' 'hello'
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(0);
  }

  if (cmd === 'health') {
    const res = await fetch(`http://${HOST}:${PORT}/health`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  // --tab / --frame work on any command: target a specific tab or iframe.
  const target = {};
  for (const flag of ['--tab', '--frame']) {
    const at = rest.indexOf(flag);
    if (at === -1) continue;
    target[flag === '--tab' ? 'tabId' : 'frameId'] = Number(rest[at + 1]);
    rest.splice(at, 2);
  }

  let command = cmd;
  let args = {};

  switch (cmd) {
    case 'status':
    case 'frames':
    case 'tabs':
    case 'url':
    case 'title':
    case 'reload':
    case 'reload-extension':
    case 'text':
      break;
    case 'snapshot':
      args = { limit: Number(rest[0] || 80) };
      break;
    case 'goto':
      args = { url: rest[0] };
      if (!args.url) throw new Error('url required');
      break;
    case 'newtab':
      args = { url: rest[0] };
      break;
    case 'activate':
      args = { tabId: Number(rest[0]) };
      break;
    case 'click':
    case 'wait':
    case 'exists':
    case 'focus':
      args = { selector: rest[0] };
      if (!args.selector) throw new Error('selector required');
      break;
    case 'fill':
      args = { selector: rest[0], text: rest.slice(1).join(' ') };
      if (!args.selector) throw new Error('selector required');
      break;
    case 'upload':
      args = { selector: rest[0], files: readUploadFiles(rest.slice(1)) };
      if (!args.selector) throw new Error('selector required');
      break;
    case 'type':
      args = { text: rest.join(' ') };
      break;
    case 'press':
      args = { key: rest[0] || 'Enter' };
      break;
    case 'scroll':
      args = { y: Number(rest[0] || 600) };
      break;
    case 'eval':
      args = { expression: rest.join(' ') };
      break;
    case 'screenshot':
      args = parseScreenshotArgs(rest);
      break;
    case 'console':
    case 'network':
      args = parseMonitorArgs(rest);
      break;
    case 'last-pick':
    case 'lastPick':
      command = 'last-pick';
      break;
    case 'start-pick':
    case 'startPick':
      command = 'start-pick';
      break;
    case 'last-place':
    case 'lastPlace':
      command = 'last-place';
      break;
    case 'start-place':
    case 'startPlace':
      command = 'start-place';
      args = rest[0] ? { component: { name: rest.join(' ') } } : {};
      break;
    case 'raw': {
      const payload = JSON.parse(rest.join(' ') || '{}');
      command = payload.command || payload.cmd;
      args = payload.args || {};
      break;
    }
    default:
      // allow: node cli.js command -- as generic
      args = rest[0] ? JSON.parse(rest.join(' ')) : {};
      break;
  }

  const result = await request('/command', {
    method: 'POST',
    body: { command, args: { ...args, ...target } },
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.data ? JSON.stringify(err.data, null, 2) : err.message);
  process.exit(1);
});
