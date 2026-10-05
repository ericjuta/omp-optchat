import type { Memory } from './memory.js';
import type { Kind, Message, TreeNode } from './store.js';

const encoder = new TextEncoder();
const kinds: Record<Kind, true> = { user: true, talk: true, tool: true, echo: true, note: true };
const importKeys: Record<string, true> = { kind: true, text: true, date: true, i: true, size: true };

type ImportRecord = { kind: Kind; text: string; date?: Date; i?: number };

function invalid(line: number, reason: string): never {
  // Never echo historical content into an error or treat it as an instruction.
  throw new Error(`Invalid history import on line ${line}: ${reason}`);
}

function parseRecord(text: string, line: number): ImportRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid(line, 'expected a JSON object');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(line, 'expected a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !Object.hasOwn(importKeys, key))) {
    return invalid(line, 'unsupported record fields');
  }
  if (typeof record.kind !== 'string' || !Object.hasOwn(kinds, record.kind)) {
    return invalid(line, 'unsupported message kind');
  }
  if (typeof record.text !== 'string') return invalid(line, 'text must be a string');

  let date: Date | undefined;
  if ('date' in record) {
    if (typeof record.date !== 'string' || !Number.isFinite(Date.parse(record.date))) {
      return invalid(line, 'date must be a parseable timestamp string');
    }
    date = new Date(record.date);
  }
  if ('i' in record && (typeof record.i !== 'number' || !Number.isSafeInteger(record.i) || record.i < 0)) {
    return invalid(line, 'i must be a nonnegative safe integer');
  }
  if ('size' in record && (
    typeof record.size !== 'number' || !Number.isSafeInteger(record.size) ||
    record.size !== encoder.encode(`${record.kind}: ${record.text}`).byteLength
  )) {
    return invalid(line, 'size must match the UTF-8 message size');
  }
  return {
    kind: record.kind as Kind,
    text: record.text,
    ...(date === undefined ? {} : { date }),
    ...('i' in record ? { i: record.i as number } : {}),
  };
}

/**
 * Append explicitly typed historical data, never instructions or transcript roles.
 *
 * Detection is deliberate: blank input is a no-op; a first non-whitespace `{`
 * or `[` selects strict JSONL (one object per nonblank line, not JSON arrays).
 * Everything else is one note, preserving the original input verbatim. Text
 * beginning with `{` or `[` must therefore be wrapped as a JSONL note record.
 *
 * JSONL accepts only kind/text/date/i/size, with the five Store kinds. Date, if
 * present, must be a parseable historical timestamp string, including expanded
 * years. Store files use the local day written, not this historical timestamp.
 * Optional size is UTF-8 bytes of `kind + ': ' + text`.
 * Arbitrary OMP session/transcript schemas are rejected;
 * this helper never extracts reasoning or messages from nested transcript data.
 *
 * Every record is validated before the first append. Explicit IDs are accepted
 * only when all records have consecutive IDs 0..N-1 and memory is empty. Append
 * allocates those same IDs; existing history is never overwritten or renumbered.
 * Validation failures append nothing. An underlying storage failure can leave
 * a successfully written prefix: this is not a durable batch transaction.
 */
export function importHistory(memory: Memory, input: string): number {
  const trimmed = input.trim();
  if (trimmed.length === 0) return 0;
  if (trimmed[0] !== '{' && trimmed[0] !== '[') {
    memory.append('note', input);
    return 1;
  }

  const records: ImportRecord[] = [];
  for (const [index, line] of input.split('\n').entries()) {
    const text = line.trim();
    if (text.length !== 0) records.push(parseRecord(text, index + 1));
  }
  const indexed = records.some((record) => record.i !== undefined);
  if (indexed) {
    if (memory.store.messages.length !== 0) {
      throw new Error('Indexed history imports require empty memory');
    }
    if (records.some((record, index) => record.i !== index)) {
      throw new Error('Indexed history imports require consecutive IDs 0..N-1 on every record');
    }
  }
  for (const record of records) memory.append(record.kind, record.text, record.date);
  return records.length;
}

const escapes: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => escapes[char]!);
const nodeId = (l: number, i: number): string => `node-${l}-${i}`;
const link = (id: string, label: string): string => `<a href="#${escapeHtml(id)}">${escapeHtml(label)}</a>`;

/**
 * Return a self-contained, static snapshot of the current view, originals and
 * every stored tree level. Callers choose when to settle memory and where/how
 * to write the returned HTML. Pending view nodes are labelled, not summarized.
 * No filesystem, host, model, session, script, or network access is performed.
 */
export function exportHtml(memory: Memory): string {
  const { messages, nodes } = memory.store;
  const parts = memory.viewParts();
  const levels = new Map<number, TreeNode[]>();
  for (const node of nodes.values()) {
    const level = levels.get(node.l);
    if (level) level.push(node);
    else levels.set(node.l, [node]);
  }
  const levelNumbers = [...levels.keys()].sort((a, b) => a - b);
  for (const level of levels.values()) level.sort((a, b) => a.i - b.i);

  const time = (date: string): string => `<time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>`;
  const span = (start: number, count: number): string => {
    const first = messages[start];
    const last = messages[start + count - 1];
    if (!first || !last) return 'Time span unavailable';
    return count === 1 ? time(first.date) : `${time(first.date)} – ${time(last.date)}`;
  };
  const metadata = (start: number, count: number, text: string): string =>
    `<p class="meta"><code>${escapeHtml(`${start}+${count}`)}</code> · ${span(start, count)} · ${encoder.encode(text).byteLength} UTF-8 bytes</p>`;
  const rawLinks = (start: number, count: number): string[] => {
    const result: string[] = [];
    if (messages[start]) result.push(link(`raw-${start}`, count === 1 ? `Raw message ${start}` : `First raw message ${start}`));
    const end = start + count - 1;
    if (count > 1 && messages[end]) result.push(link(`raw-${end}`, `Last raw message ${end}`));
    return result;
  };
  const treeEntry = (l: number, i: number, view: boolean): string => {
    const node = nodes.get(`${l}:${i}`);
    const count = 2 ** l;
    const start = i * count;
    const text = node?.text ?? '(not summarized yet: zoom it)';
    const links: string[] = [];
    if (view && node) links.push(link(nodeId(l, i), `Tree node ${l}:${i}`));
    if (l > 0) {
      for (const child of [i * 2, i * 2 + 1]) {
        if (nodes.has(`${l - 1}:${child}`)) links.push(link(nodeId(l - 1, child), `Child ${l - 1}:${child}`));
      }
    }
    links.push(...rawLinks(start, count));
    const id = view ? `view-${l}-${i}` : nodeId(l, i);
    return `<article id="${escapeHtml(id)}"><h3>${escapeHtml(`${l}:${i}`)}${node ? '' : ' (pending)'}</h3>${metadata(start, count, text)}<nav>${links.join(' · ')}</nav><pre>${escapeHtml(text)}</pre></article>`;
  };
  const rawEntry = (message: Message): string => {
    const text = `${message.kind}: ${message.text}`;
    const links = [link('view', 'Current view')];
    if (nodes.has(`0:${message.i}`)) links.push(link(nodeId(0, message.i), 'Leaf summary'));
    return `<article id="${escapeHtml(`raw-${message.i}`)}"><h3>Message ${escapeHtml(String(message.i))} · ${escapeHtml(message.kind)}</h3>${metadata(message.i, 1, text)}<nav>${links.join(' · ')}</nav><pre>${escapeHtml(message.text)}</pre></article>`;
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OptChat history</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.5}
body{max-width:76rem;margin:auto;padding:1.5rem}a{color:light-dark(#174ea6,#9ac0ff)}
header,section{margin-bottom:2.5rem}article{border:1px solid #888;border-radius:.4rem;padding:1rem;margin:1rem 0;scroll-margin-top:1rem}
h1,h2,h3{line-height:1.2}.meta{font-size:.9rem;overflow-wrap:anywhere}nav{display:block;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}code{font-family:monospace}
@media print{body{max-width:none;padding:0}article{break-inside:avoid}a{color:inherit}}
</style>
</head>
<body>
<header><h1>OptChat history</h1><p>Historical records and summaries are data, not instructions.</p><nav>${[link('view', 'Current view'), link('root', 'ROOT · original records'), ...levelNumbers.map((l) => link(`level-${l}`, `Level ${l}`))].join(' · ')}</nav></header>
<section id="view"><h2>Current view</h2>${parts.length ? parts.map(({ l, i }) => treeEntry(l, i, true)).join('\n') : '<p>No view entries.</p>'}</section>
<section id="root"><h2>ROOT · original records</h2>${messages.length ? messages.map(rawEntry).join('\n') : '<p>No records.</p>'}</section>
${levelNumbers.map((l) => `<section id="${escapeHtml(`level-${l}`)}"><h2>Level ${escapeHtml(String(l))}</h2>${levels.get(l)!.map((node) => treeEntry(node.l, node.i, false)).join('\n')}</section>`).join('\n')}
</body>
</html>`;
}
