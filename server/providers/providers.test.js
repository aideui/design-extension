import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as claude from './claude.js';
import * as codex from './codex.js';
import { tailLines } from './files.js';

function tmpFile(name, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-providers-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n'));
  return file;
}

test('claude stream: text deltas, tools, paragraph breaks, subagents dropped', () => {
  const state = { text: '', finalText: '', sessionId: null, tools: new Map(), error: null };
  const events = [
    { type: 'system', subtype: 'init', session_id: 'abc' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '先看' } } },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/app/page.tsx' } }] },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'secret file body' }] } },
    {
      type: 'stream_event',
      parent_tool_use_id: 't9',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'subagent noise' } },
    },
    { type: 'stream_event', event: { type: 'message_start', message: {} } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '改好了' } } },
    { type: 'result', subtype: 'success', result: '先看\n\n改好了', session_id: 'abc' },
  ];
  const out = events.flatMap((event) => claude.mapStreamEvent(event, state));
  assert.equal(state.sessionId, 'abc');
  assert.equal(state.text, '先看\n\n改好了');
  assert.equal(state.finalText, '先看\n\n改好了');
  const tools = out.filter((event) => event.type === 'activity');
  assert.deepEqual(
    tools.map((event) => [event.verb, event.label, event.status]),
    [
      ['read', '读取 page.tsx', 'in_progress'],
      ['read', '读取 page.tsx', 'completed'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(out), /secret file body|subagent noise/);
});

test('claude stream: error result becomes the turn error', () => {
  const state = { text: '', finalText: '', sessionId: null, tools: new Map(), error: null };
  claude.mapStreamEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }, state);
  assert.equal(state.error, 'boom');
});

test('claude history: user text without reminders, assistant turns merged, tool results skipped', () => {
  const file = tmpFile('11111111-2222-3333-4444-555555555555.jsonl', [
    { type: 'user', message: { content: '把按钮改成主色' }, timestamp: '2026-11-17T01:00:00Z', cwd: '/repo' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '我先看看。' }] }, timestamp: 't1' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Edit', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '改好了。' }] }, timestamp: 't2' },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: '谢谢' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } },
    { type: 'ai-title', aiTitle: '按钮主色' },
  ]);
  assert.deepEqual(
    claude.readMessages(file).map((message) => [message.role, message.text]),
    [
      ['user', '把按钮改成主色'],
      ['assistant', '我先看看。\n\n改好了。'],
      ['user', '谢谢'],
    ],
  );
});

test('claude project slug matches Claude Code dir names', () => {
  assert.equal(claude.projectSlug('/Users/me/my app.v2'), '-Users-me-my-app-v2');
});

test('codex exec: whole messages, commands, config warnings are not fatal', () => {
  const state = { text: '', sessionId: null, error: null, lastError: null };
  const events = [
    { type: 'thread.started', thread_id: 'th-1' },
    { type: 'item.completed', item: { id: 'i0', type: 'error', message: 'Model metadata not found' } },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '我先看看。' } },
    { type: 'item.started', item: { id: 'i2', type: 'command_execution', command: 'ls', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'ls', exit_code: 1 } },
    { type: 'item.completed', item: { id: 'i3', type: 'file_change', changes: [{ path: '/repo/a.tsx' }] } },
    { type: 'error', message: 'Reconnecting... 1/5' },
    { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'ok' } },
  ];
  const out = events.flatMap((event) => codex.mapExecEvent(event, state));
  assert.equal(state.sessionId, 'th-1');
  assert.equal(state.text, '我先看看。\n\nok');
  assert.equal(state.error, null);
  assert.equal(state.lastError, 'Reconnecting... 1/5');
  assert.deepEqual(
    out.filter((event) => event.type === 'activity').map((event) => [event.verb, event.label, event.status]),
    [
      ['run', '运行命令', 'in_progress'],
      ['run', '运行命令', 'failed'],
      ['edit', '编辑 a.tsx', 'completed'],
    ],
  );
  codex.mapExecEvent({ type: 'turn.failed', error: { message: 'quota' } }, state);
  assert.equal(state.error, 'quota');
});

test('codex history strips the page context Codex got in the prompt', () => {
  const file = tmpFile('rollout-2026-11-17T09-52-24-01a1e734-9152-7b21-a71e-0579c26f57de.jsonl', [
    { type: 'session_meta', payload: { id: '01a1e734-9152-7b21-a71e-0579c26f57de', cwd: '/repo' } },
    {
      type: 'event_msg',
      timestamp: 'a',
      payload: {
        type: 'user_message',
        message: '用户当前正在看这个 Chrome 页面：\nurl: http://x\n读取或操作用户的 Chrome 页面用本机桥：node cli.js\n\n把按钮改成主色',
      },
    },
    { type: 'event_msg', timestamp: 'b', payload: { type: 'agent_message', message: '我先看看。' } },
    { type: 'event_msg', timestamp: 'c', payload: { type: 'agent_message', message: '改好了。' } },
  ]);
  assert.deepEqual(
    codex.readMessages(file).map((message) => [message.role, message.text]),
    [
      ['user', '把按钮改成主色'],
      ['assistant', '我先看看。\n\n改好了。'],
    ],
  );
});

test('tailLines drops the partial first line', () => {
  const file = tmpFile('x.jsonl', ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.deepEqual(tailLines(file, 12), ['{"c":3}']);
  assert.deepEqual(tailLines(file, 16), ['{"b":2}', '{"c":3}']);
});
