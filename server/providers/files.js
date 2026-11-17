import fs from 'node:fs';

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Whole lines from the first `bytes` of a JSONL file. */
export function headLines(file, bytes) {
  const size = fs.statSync(file).size;
  const text = readRange(file, 0, Math.min(size, bytes));
  const lines = text.split('\n');
  if (size > bytes) lines.pop();
  return lines;
}

/**
 * Whole lines from the last `bytes` of a JSONL file. Session logs reach
 * hundreds of MB; the visible thread only needs the end.
 */
export function tailLines(file, bytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const lines = readRange(file, start, size - start).split('\n');
  if (start > 0) lines.shift();
  return lines;
}

export function parseLines(lines, mustInclude) {
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (mustInclude && !mustInclude.some((needle) => line.includes(needle))) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {}
  }
  return rows;
}

/** Memoize per file on (mtime, size): the side panel polls the open session. */
export function memoByFile(fn) {
  const cache = new Map();
  return (file) => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      cache.delete(file);
      return null;
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    const hit = cache.get(file);
    if (hit?.key === key) return hit.value;
    const value = fn(file, stat);
    cache.set(file, { key, value });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return value;
  };
}

/** Delete `file` only if it really sits under `root`. */
export function removeUnder(root, file) {
  const base = fs.realpathSync(root);
  const target = fs.realpathSync(file);
  if (!target.startsWith(`${base}/`)) throw new Error('invalid session path');
  fs.rmSync(target, { force: true });
}
