/**
 * A bounded streaming reader for hook JSON whose size the harness decides
 * (Hermes's pre_llm_call sends the whole extra.conversation_history every
 * turn): it walks the stream's bytes as they arrive, keeps only the string
 * values at the named dotted paths (each capped at `cap` characters) and
 * discards everything else without buffering it, so a payload of any size
 * yields its fields and is never refused. The objects on the way to a path
 * are parsed strictly; any other array, object or string is skipped by a
 * byte scan for brackets and native indexOf jumps between quotes and
 * backslashes (nesting and string ends checked, scalars not), and only kept
 * strings are decoded, so a 5 MB history costs about as much as JSON.parse
 * of it. Leaf module: no I/O of its own.
 */

/** The turn input's message cap (resolve.ts MESSAGE_CAP_BYTES); resolve.ts is not loaded on the lane's main thread. */
export const HOOK_FIELD_CAP = 8192;
const KEY_CAP_BYTES = 256;

type Mode = 'value' | 'key' | 'key-or-end' | 'colon' | 'after' | 'done';
type Num = 'sign' | 'zero' | 'int' | 'dot' | 'frac' | 'e' | 'esign' | 'exp';
/** A string being read: kept ones gather their raw JSON bytes (escapes included) up to `room`. */
interface Str { key: boolean; path: string | null; keep: boolean; raw: Buffer[]; room: number; over: boolean; esc: boolean }
/** A discarded array or object being skipped: its open brackets and string state. */
interface Skip { open: number[]; inStr: boolean; esc: boolean }

const QUOTE = 0x22, BACKSLASH = 0x5c, OPEN_OBJECT = 0x7b, CLOSE_OBJECT = 0x7d, OPEN_ARRAY = 0x5b, CLOSE_ARRAY = 0x5d;

/**
 * Skip a discarded array or object through `t` from `i`, in locals so the
 * byte loops stay tight: the index just past its closing bracket, -1 when
 * the chunk ran out first (state kept in `s`), -2 when malformed.
 */
function skipScan(t: Uint8Array, i: number, s: Skip): number {
  const open = s.open, n = t.length;
  let inStr = s.inStr, esc = s.esc, nb = -1;
  while (i < n) {
    if (esc) { esc = false; i++; continue; }
    if (inStr) {
      if (nb < i) { nb = t.indexOf(BACKSLASH, i); if (nb < 0) nb = n; }
      const q = t.indexOf(QUOTE, i);
      i = Math.min(q < 0 ? n : q, nb);
      if (i === n) break;
      if (t[i++] === BACKSLASH) esc = true; else inStr = false;
      continue;
    }
    let c = 0;
    for (; i < n; i++) { c = t[i]!; if (c === QUOTE || c === OPEN_OBJECT || c === CLOSE_OBJECT || c === OPEN_ARRAY || c === CLOSE_ARRAY) break; }
    if (i === n) break;
    i++;
    if (c === QUOTE) inStr = true;
    else if (c === OPEN_OBJECT || c === OPEN_ARRAY) open.push(c);
    else if (open.pop() !== (c === CLOSE_OBJECT ? OPEN_OBJECT : OPEN_ARRAY)) return -2;
    else if (open.length === 0) return i;
  }
  s.inStr = inStr;
  s.esc = esc;
  return -1;
}

/** The first quote or backslash in `t` from `i`, else t.length. */
function stringStop(t: Uint8Array, i: number): number {
  for (; i < t.length; i++) { const c = t[i]!; if (c === QUOTE || c === BACKSLASH) return i; }
  return i;
}

const NUMBER_END = new Set<Num>(['zero', 'int', 'frac', 'exp']);
const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/** The next number state after byte `c`: a state, undefined where the number may end before `c`, null where it is malformed. */
function numberStep(n: Num, c: number): Num | null | undefined {
  const digit = isDigit(c);
  const exp = c === 0x65 || c === 0x45;
  switch (n) {
    case 'sign': return c === 0x30 ? 'zero' : digit ? 'int' : null;
    case 'zero': return c === 0x2e ? 'dot' : exp ? 'e' : undefined;
    case 'int': return digit ? 'int' : c === 0x2e ? 'dot' : exp ? 'e' : undefined;
    case 'dot': return digit ? 'frac' : null;
    case 'frac': return digit ? 'frac' : exp ? 'e' : undefined;
    case 'e': return digit ? 'exp' : c === 0x2b || c === 0x2d ? 'esign' : null;
    case 'esign': return digit ? 'exp' : null;
    case 'exp': return digit ? 'exp' : undefined;
  }
}

/** A kept string's value: its raw JSON decoded and unescaped (a cut-off trailing escape dropped first); undefined when it is not valid JSON. */
function decodeKept(s: Str): string | undefined {
  let raw = Buffer.concat(s.raw).toString('utf8');
  if (s.over) {
    const m = /(\\+)(u[0-9a-fA-F]{0,3})?$/.exec(raw);
    if (m && m[1]!.length % 2 === 1) raw = raw.slice(0, m.index + m[1]!.length - 1);
  }
  try { return JSON.parse(`"${raw}"`) as string; } catch { return undefined; }
}

/**
 * The string values at `paths` (dotted object keys from the root, e.g.
 * 'extra.user_message') of the JSON object on `stream`, keyed by path; a
 * path holding no string is left out and a repeated key keeps its last
 * value, as JSON.parse does. Null for a TTY, malformed JSON or a document
 * that is not an object. The stream is always read to its end.
 */
export async function readJsonFields(stream: AsyncIterable<Uint8Array | string> & { isTTY?: boolean }, paths: readonly string[], cap: number): Promise<Record<string, string> | null> {
  if (stream.isTTY) return null;
  const wanted = new Set(paths);
  const prefixes = new Set(paths.flatMap(p => p.split('.').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('.'))));
  const out: Record<string, string> = {};
  const stack: string[] = [];
  let mode = 'value' as Mode;
  let keyPath: string | null = null;
  let str: Str | null = null;
  let skip: Skip | null = null;
  let literal = '';
  let num: Num | null = null;

  const endValue = () => { mode = stack.length ? 'after' : 'done'; };
  const endString = (s: Str): boolean => {
    str = null;
    const value = s.keep ? decodeKept(s) : '';
    if (value === undefined) return false;
    if (s.key) {
      const parent = stack.at(-1)!;
      const p = parent ? `${parent}.${value}` : value;
      keyPath = s.keep && !s.over && (wanted.has(p) || prefixes.has(p)) ? p : null;
      mode = 'colon';
      return true;
    }
    if (s.keep) out[s.path!] = value.slice(0, cap);
    endValue();
    return true;
  };

  const feed = (t: Uint8Array): boolean => {
    const gather = (s: Str, from: number, to: number) => {
      if (!s.keep || to <= from) return;
      const n = Math.min(to - from, s.room);
      if (n > 0) { s.raw.push(Buffer.from(t.subarray(from, from + n))); s.room -= n; }
      if (n < to - from) s.over = true;
    };
    let i = 0;
    while (i < t.length) {
      if (skip) {
        const end = skipScan(t, i, skip);
        if (end === -1) return true;
        if (end === -2) return false;
        skip = null;
        i = end;
        endValue();
        continue;
      }
      if (str) {
        if (str.esc) { str.esc = false; gather(str, i, i + 1); i++; continue; }
        const stop = stringStop(t, i);
        gather(str, i, stop);
        if (stop >= t.length) return true;
        i = stop + 1;
        if (t[stop] === BACKSLASH) { gather(str, stop, i); str.esc = true; continue; }
        if (!endString(str)) return false;
        continue;
      }
      const c = t[i]!;
      if (literal) {
        if (c !== literal.charCodeAt(0)) return false;
        literal = literal.slice(1);
        i++;
        if (!literal) endValue();
        continue;
      }
      if (num !== null) {
        const step = numberStep(num, c);
        if (step === null) return false;
        if (step !== undefined) { num = step; i++; continue; }
        if (!NUMBER_END.has(num)) return false;
        num = null;
        endValue();
        continue;
      }
      i++;
      if (isSpace(c)) continue;
      if (mode === 'done') return false;
      if (mode === 'colon') { if (c !== 0x3a) return false; mode = 'value'; continue; }
      if (mode === 'after') {
        if (c === 0x2c) { mode = 'key'; continue; }
        if (c !== CLOSE_OBJECT) return false;
        stack.pop();
        endValue();
        continue;
      }
      if (mode === 'key' || mode === 'key-or-end') {
        if (c === CLOSE_OBJECT && mode === 'key-or-end') { stack.pop(); endValue(); continue; }
        if (c !== QUOTE) return false;
        str = { key: true, path: null, keep: true, raw: [], room: KEY_CAP_BYTES, over: false, esc: false };
        continue;
      }
      const root = stack.length === 0;
      if (root && c !== OPEN_OBJECT) return false;
      const path = root ? '' : keyPath;
      if (c === OPEN_OBJECT && path !== null) { stack.push(path); mode = 'key-or-end'; }
      else if (c === OPEN_OBJECT || c === OPEN_ARRAY) skip = { open: [c], inStr: false, esc: false };
      else if (c === QUOTE) { const keep = path !== null && wanted.has(path); str = { key: false, path, keep, raw: [], room: keep ? cap * 6 + 12 : 0, over: false, esc: false }; }
      else if (c === 0x74) literal = 'rue';
      else if (c === 0x66) literal = 'alse';
      else if (c === 0x6e) literal = 'ull';
      else if (c === 0x2d) num = 'sign';
      else if (isDigit(c)) num = c === 0x30 ? 'zero' : 'int';
      else return false;
    }
    return true;
  };

  let bad = false;
  try {
    for await (const chunk of stream) {
      if (!bad) bad = !feed(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
  } catch { return null; }
  return bad || mode !== 'done' || str || skip || literal || num !== null ? null : out;
}
