/**
 * hermes-yaml.ts — single-entry edits of a Hermes profile `config.yaml`
 * (the YAML counterpart of codex-toml.ts) for `gbrain setup hermes`.
 *
 * Hermes rewrites this file itself and users hand-edit it, so setup never
 * round-trips the document through a YAML dumper (that drops comments and
 * reformats everything). It edits TEXT: one block is inserted at the end of
 * its container (a mapping such as `mcp_servers`, or a sequence such as
 * `hooks.pre_llm_call`) and removed again by locating exactly those lines.
 * Every edit is verified by parsing: the result must parse to the old
 * document plus exactly this entry (append) or minus exactly it (remove), or
 * the file is left as it was. Ownership is decided by the caller from the
 * PARSED value (ownedEntryFingerprint), never from a comment, so a Hermes
 * rewrite that drops comments or reformats an entry is not an edit.
 *
 * Containers setup creates or converts are tagged on their header line so
 * `--remove` restores the original bytes: `# gbrain setup: created` (the
 * header did not exist; removed again once empty) and `# gbrain setup: was X`
 * (an empty `{}` / `[]` / `null` / `~` header that became a block; restored).
 * If Hermes drops those tags only byte-exactness is lost. A leading UTF-8 BOM,
 * a missing final newline and mixed LF/CRLF line endings are recorded and
 * restored too.
 *
 * Supported shapes are the block-style ones Hermes and humans write: bare or
 * empty (`{}` / `[]` / `null` / `~`) container headers (PyYAML dumps a emptied
 * mapping as `null`), sequence items at the key's indent or under it. A
 * non-empty flow collection, an anchored or quoted container header is refused
 * on write (a clear error) and `unlocatable` on remove (the entry is
 * preserved, never guessed at).
 *
 * Every edit has a pure text form (`appendHermesYamlText`,
 * `removeHermesYamlText`) so a caller can dry-run the whole planned sequence in
 * memory and refuse BEFORE any write; the file forms optionally take a guard
 * that aborts when the file changed since it was last read or written here.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dump, load } from 'js-yaml';
import { atomicWriteTextFile } from './atomic-write.ts';

export type HermesYamlRemoval = 'removed' | 'absent' | 'unlocatable';
/** What to append or remove: a mapping entry by key, or a sequence item (matched by value on remove). */
export type HermesYamlEntry = { key: string; value: unknown } | { item: unknown };
export type HermesYamlTarget = { key: string } | { match: (item: unknown) => boolean };

const CREATED = '# gbrain setup: created';
const WAS_PREFIX = '# gbrain setup: was ';
const WAS_TAG = /:\s+# gbrain setup: was (\{\}|\[\]|~|null)$/i;
const OWN_COMMENT = '# gbrain setup';
/** An inline value that means "no children yet": an empty flow collection or a YAML null. */
const EMPTYISH = /^(\{\}|\[\]|~|null)$/i;
const EMPTY_HEADER = /:\s*(\{\}|\[\]|~|null)\s*$/i;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, val) => (isObject(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;
const indentOf = (l: string): number => l.length - l.trimStart().length;
const skippable = (l: string): boolean => /^\s*(#.*)?$/.test(l);
const readText = (configPath: string): string => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Content hash of the file as last read or written through this guard (`absent` and an empty file hash alike). */
export interface HermesConfigGuard { path: string; expected: string }
export const hermesConfigGuard = (configPath: string): HermesConfigGuard => ({ path: configPath, expected: sha(readText(configPath)) });
/** The guard for a document already read (so the hash is of the very bytes the edit was planned from). */
export const hermesConfigGuardOf = (configPath: string, text: string): HermesConfigGuard => ({ path: configPath, expected: sha(text) });
/** Thrown (before any byte is written) when config.yaml changed under a running setup. */
export class HermesConfigConflict extends Error {
  readonly code = 'configuration_conflict';
  constructor(path: string) { super(`configuration_conflict: ${path} changed while gbrain setup was running (Hermes or you wrote it); nothing more was written. Run setup again.`); }
}
function checkGuard(guard: HermesConfigGuard | undefined, raw: string): void {
  if (guard && sha(raw) !== guard.expected) throw new HermesConfigConflict(guard.path);
}

/** The parsed config. `{}` when absent or empty; throws on invalid YAML or a non-mapping document. */
export function readHermesConfig(configPath: string): Record<string, unknown> {
  return parseText(configPath, readText(configPath));
}

/** The raw text of config.yaml ('' when absent). */
export const readHermesConfigText = readText;
/** The parsed value at `path` of an in-memory document (`label` names the file in errors). */
export function readHermesYamlText(label: string, text: string, path: string[]): unknown {
  return pick(label, parseText(label, text), path);
}

export function parseText(configPath: string, text: string): Record<string, unknown> {
  let doc: unknown;
  try { doc = load(text); } catch (e) {
    throw new Error(`${configPath} is not valid YAML (${(e as Error).message.split('\n')[0]}); setup never rewrites a file it cannot parse. Fix it by hand, then run setup again.`);
  }
  if (doc === undefined || doc === null) return {};
  if (!isObject(doc)) throw new Error(`${configPath} is not a YAML mapping; setup never rewrites a file it cannot parse.`);
  return doc;
}

/** The parsed value at `path` (undefined when absent or null). Throws when a parent is not a mapping. */
export function readHermesYaml(configPath: string, path: string[]): unknown {
  return pick(configPath, readHermesConfig(configPath), path);
}

function pick(configPath: string, doc: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = doc;
  for (let i = 0; i < path.length; i++) {
    if (node === undefined || node === null) return undefined;
    if (!isObject(node)) throw new Error(`${configPath}: '${path.slice(0, i).join('.')}' is not a mapping; setup leaves it untouched.`);
    node = node[path[i]!];
  }
  return node === null ? undefined : node;
}

/** Drop nulls and empty containers so a container emptied by a removal compares equal to an absent one. */
function pruned(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruned);
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    const p = pruned(val);
    if (p === null || p === undefined || (isObject(p) && !Object.keys(p).length) || (Array.isArray(p) && !p.length)) continue;
    out[k] = p;
  }
  return out;
}

/** The document as lines plus the exact terminator after each (mixed LF/CRLF survive), BOM and final-newline state. */
interface Doc { lines: string[]; eols: string[]; eol: string; bom: boolean; finalNewline: boolean }
function split(raw: string): Doc {
  const bom = raw.startsWith('\uFEFF');
  const text = bom ? raw.slice(1) : raw;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const eol = crlf > (text.match(/(?<!\r)\n/g) ?? []).length ? '\r\n' : '\n';
  if (text === '') return { lines: [], eols: [], eol, bom, finalNewline: true };
  const parts = text.split(/(\r\n|\n)/);
  const lines: string[] = [];
  const eols: string[] = [];
  for (let i = 0; i < parts.length; i += 2) { lines.push(parts[i]!); eols.push(parts[i + 1] ?? ''); }
  const finalNewline = lines[lines.length - 1] === '' && eols[eols.length - 1] === '';
  if (finalNewline) { lines.pop(); eols.pop(); } else eols[eols.length - 1] = eol;
  return { lines, eols, eol, bom, finalNewline };
}
function render(d: Doc): string {
  const n = d.lines.length;
  const body = d.lines.map((l, i) => l + (i < n - 1 || d.finalNewline ? d.eols[i]! : '')).join('');
  return (d.bom ? '\uFEFF' : '') + body;
}
/** `lines.splice` that keeps the terminator array in step; inserted lines take the document's dominant terminator. */
function spliceLines(d: Doc, at: number, remove: number, ...insert: string[]): void {
  d.lines.splice(at, remove, ...insert);
  d.eols.splice(at, remove, ...insert.map(() => d.eol));
}

interface Level { idx: number; indent: number; inline: string }

/** `key:` line among the direct children of lines[lo, hi); the child indent is that of the first content line. */
function findKey(configPath: string, lines: string[], lo: number, hi: number, key: string): Level | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^( *)(?:${k}|"${k}"|'${k}'):(?:[ \\t]+(.*))?$`);
  let child = -1;
  for (let i = lo; i < hi; i++) {
    if (skippable(lines[i]!)) continue;
    if (child < 0) child = indentOf(lines[i]!);
    if (indentOf(lines[i]!) !== child) continue;
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const raw = (m[2] ?? '').trimEnd();
    const inline = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
    if (inline && !EMPTYISH.test(inline)) {
      throw new Error(`${configPath}: '${key}' is written in a shape setup cannot edit safely (${inline.slice(0, 24)}); edit it by hand or use another --name.`);
    }
    if (EMPTYISH.test(inline) && raw !== inline) {
      throw new Error(`${configPath}: '${key}: ${inline}' carries a comment setup cannot preserve while converting it; edit it by hand or use another --name.`);
    }
    return { idx: i, indent: child, inline };
  }
  return null;
}

/** One past the last content line of the block under the header at `idx` (trailing blanks and comments excluded). */
function blockEnd(lines: string[], idx: number, headerIndent: number): number {
  let end = idx + 1;
  for (let i = idx + 1; i < lines.length; i++) {
    if (skippable(lines[i]!)) continue;
    const ind = indentOf(lines[i]!);
    if (ind > headerIndent || (ind === headerIndent && /^-(\s|$)/.test(lines[i]!.trimStart()))) end = i + 1;
    else break;
  }
  return end;
}

/** The existing prefix of `path` as header levels (stops at the first missing key). */
function walk(configPath: string, lines: string[], path: string[]): Level[] {
  const levels: Level[] = [];
  let lo = 0;
  let hi = lines.length;
  for (const key of path) {
    const f = findKey(configPath, lines, lo, hi, key);
    if (!f) break;
    levels.push(f);
    lo = f.idx + 1;
    hi = EMPTYISH.test(f.inline) ? f.idx + 1 : blockEnd(lines, f.idx, f.indent);
  }
  return levels;
}

const blockOf = (lines: string[], l: Level): [number, number] => [l.idx + 1, EMPTYISH.test(l.inline) ? l.idx + 1 : blockEnd(lines, l.idx, l.indent)];
const dumpLines = (v: unknown): string[] => dump(v, { indent: 2, lineWidth: -1, noRefs: true }).replace(/\n$/, '').split('\n');
const childIndent = (lines: string[], l: Level): number => {
  const [lo, hi] = blockOf(lines, l);
  const first = lines.slice(lo, hi).find((x) => !skippable(x));
  return first !== undefined ? indentOf(first) : l.indent + 2;
};
/** Rewrite an empty/null header to a block header, tagged with what it was so `--remove` can restore it. */
const convertHeader = (header: string, was: string): string => `${header.replace(EMPTY_HEADER, ':')}  ${WAS_PREFIX}${was}`;

function withEntry(doc: Record<string, unknown>, containerPath: string[], entry: HermesYamlEntry): Record<string, unknown> {
  const copy = clone(doc);
  let node: Record<string, unknown> = copy;
  const walkTo = containerPath.slice(0, 'item' in entry ? -1 : undefined);
  for (const seg of walkTo) { if (!isObject(node[seg])) node[seg] = {}; node = node[seg] as Record<string, unknown>; }
  if ('item' in entry) {
    const leaf = containerPath[containerPath.length - 1]!;
    node[leaf] = [...(Array.isArray(node[leaf]) ? (node[leaf] as unknown[]) : []), clone(entry.item)];
  } else node[entry.key] = clone(entry.value);
  return copy;
}

function withoutEntry(doc: Record<string, unknown>, containerPath: string[], target: HermesYamlTarget): Record<string, unknown> {
  const copy = clone(doc);
  let node: unknown = copy;
  for (const seg of containerPath) node = isObject(node) ? node[seg] : undefined;
  if ('key' in target) { if (isObject(node)) delete node[target.key]; }
  else {
    let parent: unknown = copy;
    for (const seg of containerPath.slice(0, -1)) parent = isObject(parent) ? parent[seg] : undefined;
    const leaf = containerPath[containerPath.length - 1]!;
    if (isObject(parent) && Array.isArray(parent[leaf])) {
      const arr = parent[leaf] as unknown[];
      const k = arr.findIndex(target.match);
      if (k >= 0) arr.splice(k, 1);
    }
  }
  return copy;
}

/**
 * Pure form of {@link appendHermesYamlEntry}: the new document text for `raw` (`label` names the file in errors).
 * Throws when the container's shape is unsupported or the result would not parse to the old document plus exactly this entry.
 */
export function appendHermesYamlText(label: string, raw: string, containerPath: string[], entry: HermesYamlEntry, comment: string): string {
  const before = parseText(label, raw);
  const doc = split(raw);
  const lines = doc.lines;
  const levels = walk(label, lines, containerPath);
  const payload = dumpLines('item' in entry ? [entry.item] : { [entry.key]: entry.value });
  const note = `# ${comment.startsWith('gbrain setup') ? comment : `gbrain setup: ${comment}`}`;
  if (levels.length === containerPath.length && levels.length > 0) {
    const last = levels[levels.length - 1]!;
    const flow = EMPTYISH.test(last.inline);
    const ind = flow ? last.indent + 2 : childIndent(lines, last);
    const at = blockOf(lines, last)[1];
    if (flow) lines[last.idx] = convertHeader(lines[last.idx]!, last.inline);
    spliceLines(doc, at, 0, `${' '.repeat(ind)}${note}`, ...payload.map((l) => ' '.repeat(ind) + l));
  } else {
    const parent = levels[levels.length - 1];
    const rest = containerPath.slice(levels.length);
    let wrapped: unknown = 'item' in entry ? [entry.item] : { [entry.key]: entry.value };
    for (let i = rest.length - 1; i >= 0; i--) wrapped = { [rest[i]!]: wrapped };
    const block = dumpLines(wrapped);
    for (let i = 0; i < rest.length; i++) block[i] = `${block[i]}  ${CREATED}`;
    let ind = 0;
    let at = lines.length;
    if (parent) {
      const flow = EMPTYISH.test(parent.inline);
      ind = flow ? parent.indent + 2 : childIndent(lines, parent);
      at = blockOf(lines, parent)[1];
      if (flow) lines[parent.idx] = convertHeader(lines[parent.idx]!, parent.inline);
    }
    const added = [`${' '.repeat(ind)}${note}`, ...block.map((l) => ' '.repeat(ind) + l)];
    spliceLines(doc, at, 0, ...(!parent && lines.length > 0 ? ['', ...added] : added));
  }
  const next = render(doc);
  if (canonicalJson(parseText(label, next)) !== canonicalJson(withEntry(before, containerPath, entry))) {
    throw new Error(`adding ${containerPath.join('.')} to ${label} would change other settings (an unsupported config shape); the file is left as it was. Edit it by hand or use another --name.`);
  }
  return next;
}

/**
 * Append `entry` to the container at `containerPath` (a mapping for `{key,value}`, a sequence for `{item}`),
 * creating missing containers. Throws (file untouched) when the container's shape is unsupported or the
 * result would not parse to the old document plus exactly this entry, or when `guard` no longer matches the file.
 */
export function appendHermesYamlEntry(configPath: string, containerPath: string[], entry: HermesYamlEntry, comment: string, opts: { guard?: HermesConfigGuard } = {}): void {
  const raw = readText(configPath);
  checkGuard(opts.guard, raw);
  const next = appendHermesYamlText(configPath, raw, containerPath, entry, comment);
  atomicWriteTextFile(configPath, next, { freshMode: 0o600 });
  if (opts.guard) opts.guard.expected = sha(next);
}

/**
 * Write `next` over config.yaml, but only if the file still holds `expectedRaw` (what the edit was computed from)
 * and still matches `guard`. Throws HermesConfigConflict (nothing written) otherwise.
 */
export function writeHermesConfigText(configPath: string, expectedRaw: string, next: string, guard?: HermesConfigGuard): void {
  const now = readText(configPath);
  if (now !== expectedRaw) throw new HermesConfigConflict(configPath);
  checkGuard(guard, now);
  atomicWriteTextFile(configPath, next, { freshMode: 0o600 });
  if (guard) guard.expected = sha(next);
}

/** Result of a pure removal: the new text (equal to the input unless `removed`). */
export interface HermesYamlTextRemoval { result: HermesYamlRemoval; text: string }

/**
 * Pure form of {@link removeHermesYamlEntry}. `unlocatable` (text untouched) when the entry's lines cannot be told
 * apart or the edit would change anything else.
 */
export function removeHermesYamlText(label: string, raw: string, containerPath: string[], target: HermesYamlTarget): HermesYamlTextRemoval {
  const same = (result: HermesYamlRemoval): HermesYamlTextRemoval => ({ result, text: raw });
  const before = parseText(label, raw);
  let container: unknown = before;
  for (const seg of containerPath) container = isObject(container) ? container[seg] : undefined;
  if ('key' in target ? !isObject(container) || !(target.key in container) : !Array.isArray(container) || !container.some(target.match)) return same('absent');
  const doc = split(raw);
  const lines = doc.lines;
  let levels: Level[];
  try { levels = walk(label, lines, containerPath); } catch { return same('unlocatable'); }
  if (levels.length < containerPath.length) return same('unlocatable');
  const last = levels[levels.length - 1]!;
  const [lo, hi] = blockOf(lines, last);
  let range: [number, number] | null = null;
  if ('key' in target) {
    let f: Level | null;
    try { f = findKey(label, lines, lo, hi, target.key); } catch { return same('unlocatable'); }
    if (f) range = [f.idx, blockEnd(lines, f.idx, f.indent)];
  } else if (Array.isArray(container)) {
    const ind = childIndent(lines, last);
    const starts: number[] = [];
    for (let i = lo; i < hi; i++) if (indentOf(lines[i]!) === ind && /^-(\s|$)/.test(lines[i]!.trimStart())) starts.push(i);
    const k = container.findIndex(target.match);
    if (starts.length === container.length && k >= 0) {
      let end = k + 1 < starts.length ? starts[k + 1]! : hi;
      while (end > starts[k]! + 1 && skippable(lines[end - 1]!)) end--;
      range = [starts[k]!, end];
    }
  }
  if (!range) return same('unlocatable');
  let [from, to] = range;
  if (from > 0 && lines[from - 1]!.trim().startsWith(OWN_COMMENT)) from--;
  spliceLines(doc, from, to - from);
  // Containers setup created that are now empty go too; a converted empty/null header is restored.
  for (let p = containerPath; p.length > 0; p = p.slice(0, -1)) {
    let lv: Level[];
    try { lv = walk(label, lines, p); } catch { return same('unlocatable'); }
    if (lv.length < p.length) break;
    const l = lv[lv.length - 1]!;
    if (blockOf(lines, l)[1] > l.idx + 1) break;
    const header = lines[l.idx]!;
    if (header.includes(CREATED)) {
      let start = l.idx;
      if (start > 0 && lines[start - 1]!.trim().startsWith(OWN_COMMENT)) start--;
      if (l.indent === 0 && start > 0 && lines[start - 1]!.trim() === '') start--;
      spliceLines(doc, start, l.idx + 1 - start);
    } else if (WAS_TAG.test(header)) {
      lines[l.idx] = header.replace(WAS_TAG, ': $1');
      break;
    } else break;
  }
  const next = render(doc);
  let after: Record<string, unknown>;
  try { after = parseText(label, next); } catch { return same('unlocatable'); }
  if (canonicalJson(pruned(after)) !== canonicalJson(pruned(withoutEntry(before, containerPath, target)))) return same('unlocatable');
  return { result: 'removed', text: next };
}

/**
 * Remove the entry `target` from the container at `containerPath`: its lines (and the `# gbrain setup` comment
 * directly above), then any container setup created that is now empty, restoring a converted `{}` / `[]` / `null` header.
 * `unlocatable` (file untouched) when the entry's lines cannot be told apart or the edit would change anything else.
 */
export function removeHermesYamlEntry(configPath: string, containerPath: string[], target: HermesYamlTarget, opts: { dryRun?: boolean; guard?: HermesConfigGuard } = {}): HermesYamlRemoval {
  if (!existsSync(configPath)) return 'absent';
  const raw = readText(configPath);
  checkGuard(opts.guard, raw);
  const r = removeHermesYamlText(configPath, raw, containerPath, target);
  if (r.result === 'removed' && !opts.dryRun) {
    atomicWriteTextFile(configPath, r.text, { freshMode: 0o600 });
    if (opts.guard) opts.guard.expected = sha(r.text);
  }
  return r.result;
}
