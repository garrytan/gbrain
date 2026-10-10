/**
 * Random strings drawn from a regex source, for property tests over the
 * write gate pattern table. Handles the syntax the regex-safety lint accepts:
 * alternation, groups, classes, escapes and bounded quantifiers. Zero-width
 * assertions (`\b`, lookarounds, `^`, `$`) emit nothing, so callers re-check a
 * sample with the real regex before using it.
 */
type Atom =
  | { kind: 'char'; src: string }
  | { kind: 'empty' }
  | { kind: 'group'; alts: Seq[] };
type Seq = Array<{ atom: Atom; lo: number; hi: number }>;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzAEIKOSTZ0123456789_ \n\t.,!?:;-\'"@/()[]{}<>|%$&=#*+~`\u2019';

function parse(source: string): Seq[] {
  let pos = 0;
  const atom = (): Atom => {
    const ch = source[pos]!;
    if (ch === '\\') {
      const next = source[pos + 1]!;
      pos += 2;
      return next === 'b' || next === 'B' ? { kind: 'empty' } : { kind: 'char', src: `\\${next}` };
    }
    if (ch === '[') {
      const start = pos;
      pos++;
      while (source[pos] !== ']') pos += source[pos] === '\\' ? 2 : 1;
      pos++;
      return { kind: 'char', src: source.slice(start, pos) };
    }
    if (ch === '(') {
      pos++;
      let lookaround = false;
      if (source[pos] === '?') {
        const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(source.slice(pos))!;
        lookaround = ['?=', '?!', '?<=', '?<!'].includes(m[0]);
        pos += m[0].length;
      }
      const alts = alternation();
      pos++;
      return lookaround ? { kind: 'empty' } : { kind: 'group', alts };
    }
    pos++;
    if (ch === '^' || ch === '$') return { kind: 'empty' };
    return { kind: 'char', src: ch === '.' ? '.' : ch.replace(/[/\\^$*+?()[\]{}|-]/g, '\\$&') };
  };
  const sequence = (): Seq => {
    const out: Seq = [];
    while (pos < source.length && source[pos] !== '|' && source[pos] !== ')') {
      const a = atom();
      let lo = 1;
      let hi = 1;
      const q = /^(?:\?|\{(\d+)(?:,(\d+))?\})/.exec(source.slice(pos));
      if (q) {
        if (q[0] === '?') { lo = 0; hi = 1; } else { lo = Number(q[1]); hi = q[2] === undefined ? lo : Number(q[2]); }
        pos += q[0].length;
        if (source[pos] === '?') pos++;
      }
      out.push({ atom: a, lo, hi });
    }
    return out;
  };
  function alternation(): Seq[] {
    const alts = [sequence()];
    while (source[pos] === '|') { pos++; alts.push(sequence()); }
    return alts;
  }
  return alternation();
}

/** A sampler for `source` (compiled with `flags`); each call returns one candidate match. */
export function regexSampler(source: string, flags: string, random: () => number): () => string {
  const tree = parse(source);
  const choices = new Map<string, string[]>();
  const charsFor = (src: string): string[] => {
    let c = choices.get(src);
    if (!c) {
      const rx = new RegExp(`^${src}$`, flags.replace(/[gy]/g, ''));
      c = [...ALPHABET].filter(ch => rx.test(ch));
      if (!c.length) throw new Error(`regexSampler: no sample character for ${src}`);
      choices.set(src, c);
    }
    return c;
  };
  const count = (lo: number, hi: number): number =>
    random() < 0.8 ? lo + Math.floor(random() * (Math.min(hi, lo + 3) - lo + 1)) : lo + Math.floor(random() * (hi - lo + 1));
  const emitAlts = (alts: Seq[]): string => emitSeq(alts[Math.floor(random() * alts.length)]!);
  const emitSeq = (seq: Seq): string => {
    let out = '';
    for (const { atom, lo, hi } of seq) {
      for (let n = count(lo, hi); n > 0; n--) {
        if (atom.kind === 'char') { const c = charsFor(atom.src); out += c[Math.floor(random() * c.length)]; }
        else if (atom.kind === 'group') out += emitAlts(atom.alts);
      }
    }
    return out;
  };
  return () => emitAlts(tree);
}
