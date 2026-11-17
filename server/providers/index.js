import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grok from './grok.js';
import * as claude from './claude.js';
import * as codex from './codex.js';

/** Supported CLIs. No ranking here: auto mode follows what the user last used. */
export const PROVIDERS = [claude, codex, grok];

const USAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.bridge-providers.json');
let lastUsed = {};
try {
  lastUsed = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')).lastUsed || {};
} catch {}

export function recordProviderUse(id) {
  lastUsed = { ...lastUsed, [id]: new Date().toISOString() };
  try {
    fs.writeFileSync(USAGE_PATH, JSON.stringify({ lastUsed }, null, 2));
  } catch {}
}

export function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

export function providerStatuses() {
  return PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label, ...provider.status() }));
}

/** Ready providers, most recently used first. */
export function autoOrder() {
  return PROVIDERS.filter((provider) => provider.status().ready).sort((a, b) =>
    String(lastUsed[b.id] || '').localeCompare(String(lastUsed[a.id] || ''))
  );
}

/**
 * Providers to try for a new conversation. An explicit choice is honoured even
 * when it looks unready, so the user sees its real error; auto uses whatever
 * is signed in, starting with the one used last.
 */
export function candidatesFor(preference) {
  const chosen = getProvider(preference);
  if (chosen) return [chosen];
  return autoOrder();
}

export function sessionOwner(sessionId) {
  return PROVIDERS.find((provider) => provider.hasSession(sessionId)) || null;
}

function tag(provider, session) {
  return session ? { ...session, provider: provider.id, providerLabel: provider.label } : null;
}

export function listAllSessions({ limit = 40, cwd } = {}) {
  const items = [];
  for (const provider of PROVIDERS) {
    try {
      for (const session of provider.listSessions({ limit, cwd })) items.push(tag(provider, session));
    } catch (err) {
      console.error(`[bridge] ${provider.id} sessions:`, err.message);
    }
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return items.slice(0, limit);
}

export function readAnySession(sessionId, provider = sessionOwner(sessionId)) {
  return provider ? tag(provider, provider.readSession(sessionId)) : null;
}
