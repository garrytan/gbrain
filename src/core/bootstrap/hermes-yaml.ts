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
 * header did not exist; removed again once empty) and `# gbrain setup: was {}`
 * / `was []` (an empty flow collection that became a block; restored). If
 * Hermes drops those tags only byte-exactness is lost.
 *
 * Supported shapes are the block-style ones Hermes and humans write: bare or
 * empty-flow (`{}` / `[]`) container headers, sequence items at the key's
 * indent or under it. A non-empty flow collection, an anchored or quoted
 * container header is refused on write (a clear error) and `unlocatable` on
 * remove (the entry is preserved, never guessed at).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dump, load } from 'js-yaml';
import { atomicWriteTextFile } from './atomic-write.ts';

export type HermesYamlRemoval = 'removed' | 'absent' | 'unlocatable';
/** What to append or remove: a mapping entry by key, or a sequence item (matched by value on remove). */
export type HermesYamlEntry = { key: string; value: unknown } | { item: unknown };
export type HermesYamlTarget = { key: string } | { match: (item: unknown) => boolean };

const CREATED = '# gbrain setup: created';
const WAS_MAP = '# gbrain setup: was {}';
const WAS_SEQ = '# gbrain setup: was []';
const OWN_COMMENT = '# gbrain setup';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, val) => (isObject(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;
const indentOf = (l: string): number => l.length - l.trimStart().length;
const skippable = (l: string): boolean => /^\s*(#.*)?$/.test(l);
const readText = (configPath: string): string => (existsSync(configPath) ? readFileSync(configPath, 'utf8') : '');

/** The parsed config. `{}` when absent or empty; throws on invalid YAML or a non-mapping document. */
export function readHermesConfig(configPath: string): Record<string, unknown> {
  return parseText(configPath, readText(configPath));
}

function parseText(configPath: string, text: string): Record<string, unknown> {
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
  let node: unknown = readHermesConfig(configPath);
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

interface Doc { lines: string[]; crlf: boolean }
function split(raw: string): Doc {
  const text = raw.replace(/\r\n/g, '\n');
  return { lines: text === '' ? [] : text.replace(/\n$/, '').split('\n'), crlf: raw.includes('\r\n') };
}
const render = (d: Doc): string => { const t = d.lines.length ? `${d.lines.join('\n')}\n` : ''; return d.crlf ? t.replace(/\n/g, '\r\n') : t; };

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
    if (inline && !/^(\{\}|\[\])$/.test(inline) && !/^(~|null)$/i.test(inline)) {
      throw new Error(`${configPath}: '${key}' is written in a shape setup cannot edit safely (${inline.slice(0, 24)}); edit it by hand or use another --name.`);
    }
    if (/^(\{\}|\[\])$/.test(inline) && raw !== inline) {
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
    hi = /^(\{\}|\[\])$/.test(f.inline) ? f.idx + 1 : blockEnd(lines, f.idx, f.indent);
  }
  return levels;
}

const blockOf = (lines: string[], l: Level): [number, number] => [l.idx + 1, /^(\{\}|\[\])$/.test(l.inline) ? l.idx + 1 : blockEnd(lines, l.idx, l.indent)];
const dumpLines = (v: unknown): string[] => dump(v, { indent: 2, lineWidth: -1, noRefs: true }).replace(/\n$/, '').split('\n');
const childIndent = (lines: string[], l: Level): number => {
  const [lo, hi] = blockOf(lines, l);
  const first = lines.slice(lo, hi).find((x) => !skippable(x));
  return first !== undefined ? indentOf(first) : l.indent + 2;
};

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
 * Append `entry` to the container at `containerPath` (a mapping for `{key,value}`, a sequence for `{item}`),
 * creating missing containers. Throws (file untouched) when the container's shape is unsupported or the
 * result would not parse to the old document plus exactly this entry.
 */
export function appendHermesYamlEntry(configPath: string, containerPath: string[], entry: HermesYamlEntry, comment: string): void {
  const raw = readText(configPath);
  const before = parseText(configPath, raw);
  const doc = split(raw);
  const lines = doc.lines;
  const levels = walk(configPath, lines, containerPath);
  const payload = dumpLines('item' in entry ? [entry.item] : { [entry.key]: entry.value });
  const note = `# ${comment.startsWith('gbrain setup') ? comment : `gbrain setup: ${comment}`}`;
  if (levels.length === containerPath.length && levels.length > 0) {
    const last = levels[levels.length - 1]!;
    const flow = /^(\{\}|\[\])$/.test(last.inline);
    const ind = flow ? last.indent + 2 : childIndent(lines, last);
    const at = blockOf(lines, last)[1];
    if (flow) lines[last.idx] = `${lines[last.idx]!.replace(/:\s*(\{\}|\[\])\s*$/, ':')}  ${last.inline === '{}' ? WAS_MAP : WAS_SEQ}`;
    lines.splice(at, 0, `${' '.repeat(ind)}${note}`, ...payload.map((l) => ' '.repeat(ind) + l));
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
      const flow = /^(\{\}|\[\])$/.test(parent.inline);
      ind = flow ? parent.indent + 2 : childIndent(lines, parent);
      at = blockOf(lines, parent)[1];
      if (flow) lines[parent.idx] = `${lines[parent.idx]!.replace(/:\s*(\{\}|\[\])\s*$/, ':')}  ${parent.inline === '{}' ? WAS_MAP : WAS_SEQ}`;
    }
    const added = [`${' '.repeat(ind)}${note}`, ...block.map((l) => ' '.repeat(ind) + l)];
    lines.splice(at, 0, ...(!parent && lines.length > 0 ? ['', ...added] : added));
  }
  const next = render(doc);
  if (canonicalJson(parseText(configPath, next.replace(/\r\n/g, '\n'))) !== canonicalJson(withEntry(before, containerPath, entry))) {
    throw new Error(`adding ${containerPath.join('.')} to ${configPath} would change other settings; the file is left as it was.`);
  }
  atomicWriteTextFile(configPath, next, { freshMode: 0o600 });
}

/**
 * Remove the entry `target` from the container at `containerPath`: its lines (and the `# gbrain setup` comment
 * directly above), then any container setup created that is now empty, restoring a converted `{}` / `[]` header.
 * `unlocatable` (file untouched) when the entry's lines cannot be told apart or the edit would change anything else.
 */
export function removeHermesYamlEntry(configPath: string, containerPath: string[], target: HermesYamlTarget, opts: { dryRun?: boolean } = {}): HermesYamlRemoval {
  if (!existsSync(configPath)) return 'absent';
  const raw = readText(configPath);
  const before = parseText(configPath, raw);
  let container: unknown = before;
  for (const seg of containerPath) container = isObject(container) ? container[seg] : undefined;
  if ('key' in target ? !isObject(container) || !(target.key in container) : !Array.isArray(container) || !container.some(target.match)) return 'absent';
  const doc = split(raw);
  const lines = doc.lines;
  let levels: Level[];
  try { levels = walk(configPath, lines, containerPath); } catch { return 'unlocatable'; }
  if (levels.length < containerPath.length) return 'unlocatable';
  const last = levels[levels.length - 1]!;
  const [lo, hi] = blockOf(lines, last);
  let range: [number, number] | null = null;
  if ('key' in target) {
    let f: Level | null;
    try { f = findKey(configPath, lines, lo, hi, target.key); } catch { return 'unlocatable'; }
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
  if (!range) return 'unlocatable';
  let [from, to] = range;
  if (from > 0 && lines[from - 1]!.trim().startsWith(OWN_COMMENT)) from--;
  lines.splice(from, to - from);
  // Containers setup created that are now empty go too; a converted flow header is restored.
  for (let p = containerPath; p.length > 0; p = p.slice(0, -1)) {
    let lv: Level[];
    try { lv = walk(configPath, lines, p); } catch { return 'unlocatable'; }
    if (lv.length < p.length) break;
    const l = lv[lv.length - 1]!;
    if (blockOf(lines, l)[1] > l.idx + 1) break;
    const header = lines[l.idx]!;
    if (header.includes(CREATED)) {
      let start = l.idx;
      if (start > 0 && lines[start - 1]!.trim().startsWith(OWN_COMMENT)) start--;
      if (l.indent === 0 && start > 0 && lines[start - 1]!.trim() === '') start--;
      lines.splice(start, l.idx + 1 - start);
    } else if (header.includes(WAS_MAP) || header.includes(WAS_SEQ)) {
      lines[l.idx] = `${header.replace(/:\s+# gbrain setup: was (\{\}|\[\])$/, ': $1')}`;
      break;
    } else break;
  }
  const next = render(doc);
  let after: Record<string, unknown>;
  try { after = parseText(configPath, next.replace(/\r\n/g, '\n')); } catch { return 'unlocatable'; }
  if (canonicalJson(pruned(after)) !== canonicalJson(pruned(withoutEntry(before, containerPath, target)))) return 'unlocatable';
  if (!opts.dryRun) atomicWriteTextFile(configPath, next, { freshMode: 0o600 });
  return 'removed';
}
