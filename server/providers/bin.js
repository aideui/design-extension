import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const cache = new Map();

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function fromPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** nvm installs global CLIs per Node version; take the newest one that has it. */
function fromNvm(name) {
  const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
  let versions = [];
  try {
    versions = fs.readdirSync(root);
  } catch {
    return null;
  }
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const file = path.join(root, version, 'bin', name);
    if (isExecutable(file)) return file;
  }
  return null;
}

/** launchd starts the bridge with a bare PATH, so ask the user's login shell as a last resort. */
function fromLoginShell(name) {
  const shell = process.env.SHELL || '/bin/zsh';
  const result = spawnSync(shell, ['-ilc', `command -v ${name}`], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const found = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('/'));
  return found && isExecutable(found) ? found : null;
}

/**
 * Locate a CLI: env override, PATH, well-known install dirs, nvm, then the
 * login shell. Returns null when it is not installed.
 */
export function resolveBin(name, { envVar, candidates = [] } = {}) {
  if (envVar && process.env[envVar]) return process.env[envVar];
  const cached = cache.get(name);
  // A miss is retried after a minute so a fresh install shows up without a restart.
  if (cached && (cached.bin || Date.now() - cached.at < 60000)) return cached.bin;
  const home = os.homedir();
  const known = [
    ...candidates,
    path.join(home, '.local', 'bin', name),
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
  ];
  const found =
    fromPath(name) || known.find(isExecutable) || fromNvm(name) || fromLoginShell(name) || null;
  cache.set(name, { bin: found, at: Date.now() });
  return found;
}

/** Node-script CLIs (#!/usr/bin/env node) need their own bin dir on PATH. */
export function spawnEnv(bin) {
  const dirs = [path.dirname(bin), path.dirname(process.execPath)];
  return { ...process.env, PATH: [...dirs, process.env.PATH || ''].join(path.delimiter) };
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function osascriptQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Open macOS Terminal in `cwd` and run argv there. */
export function runInTerminal({ cwd, argv }) {
  const workdir = cwd || os.homedir();
  const script = `cd ${shellSingleQuote(workdir)} && exec ${argv.map(shellSingleQuote).join(' ')}`;
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', `tell application "Terminal" to do script ${osascriptQuote(script)}`]);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `osascript exited ${code}`));
      else resolve({ ok: true, cwd: workdir });
    });
  });
}

/**
 * Spawn a CLI that prints one JSON object per line. `onLine` gets each parsed
 * object; `done` resolves with whatever `finish` returns on exit 0.
 */
export function spawnJsonLines({ bin, args, cwd, timeoutMs, onLine, finish, label }) {
  const child = spawn(bin, args, {
    cwd: cwd || os.homedir(),
    env: spawnEnv(bin),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      onLine(event);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGTERM' || signal === 'SIGKILL' || code === 130 || code === 143) {
        resolve({ ...finish(), stopped: true });
        return;
      }
      const result = finish();
      if (code === 0 && !result.error) {
        resolve({ ...result, stopped: false });
        return;
      }
      reject(new Error(result.error || result.failureHint || (stderr || `${label} exited ${code}`).slice(-800)));
    });
  });
  return { child, done };
}
