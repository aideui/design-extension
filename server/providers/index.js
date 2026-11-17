import * as grok from './grok.js';
import * as claude from './claude.js';
import * as codex from './codex.js';

/** Order is the auto-fallback order. */
export const PROVIDERS = [grok, claude, codex];

export function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

export function providerStatuses() {
  return PROVIDERS.map((provider) => ({ id: provider.id, label: provider.label, ...provider.status() }));
}

/**
 * Providers to try for a new conversation. An explicit choice is honoured even
 * when it looks unready, so the user sees its real error; auto skips unready ones.
 */
export function candidatesFor(preference) {
  const chosen = getProvider(preference);
  if (chosen) return [chosen];
  return PROVIDERS.filter((provider) => provider.status().ready);
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
