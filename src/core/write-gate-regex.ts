/**
 * #5575 (ENG-16) static analysis of a write gate regex source: its longest
 * possible match and every safety violation (unbounded or oversized
 * quantifiers, nested quantifiers, backreferences). The regex-safety lint
 * (scripts/check-write-gate-regex.ts) enforces the limits; the detector uses
 * each pattern's longest match to bound where around an anchor a match can lie.
 */
export const MAX_QUANTIFIER_BOUND = 200;

interface Node { max: number; repeats: boolean }

/** Static analysis of one regex source: its longest match and every safety violation. */
export function analyzeRegexSource(source: string): { maxLength: number; errors: string[] } {
  const errors: string[] = [];
  let pos = 0;

  const atomWidth = (): Node & { group: boolean } => {
    const ch = source[pos]!;
    if (ch === '\\') {
      const next = source[pos + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') errors.push(`backreference at ${pos}`);
      if (next === 'u' && source[pos + 2] === '{') { pos = source.indexOf('}', pos) + 1; return { max: 1, repeats: false, group: false }; }
      const len = next === 'u' ? 6 : next === 'x' ? 4 : next === 'c' ? 3 : 2;
      pos += len;
      return { max: next === 'b' || next === 'B' ? 0 : 1, repeats: false, group: false };
    }
    if (ch === '[') {
      pos++;
      while (pos < source.length && source[pos] !== ']') pos += source[pos] === '\\' ? 2 : 1;
      pos++;
      return { max: 1, repeats: false, group: false };
    }
    if (ch === '(') {
      pos++;
      let lookaround = false;
      if (source[pos] === '?') {
        const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(source.slice(pos));
        if (!m) { errors.push(`unsupported group syntax at ${pos}`); return { max: 0, repeats: false, group: true }; }
        lookaround = ['?=', '?!', '?<=', '?<!'].includes(m[0]);
        pos += m[0].length;
      }
      const inner = alternation();
      if (source[pos] !== ')') errors.push(`unclosed group at ${pos}`);
      pos++;
      return { max: lookaround ? 0 : inner.max, repeats: inner.repeats, group: true };
    }
    if (ch === '^' || ch === '$') { pos++; return { max: 0, repeats: false, group: false }; }
    pos++;
    return { max: 1, repeats: false, group: false };
  };

  const quantifier = (): { lo: number; hi: number } | null => {
    const ch = source[pos];
    let q: { lo: number; hi: number } | null = null;
    if (ch === '?') { q = { lo: 0, hi: 1 }; pos++; }
    else if (ch === '*') { q = { lo: 0, hi: Infinity }; pos++; }
    else if (ch === '+') { q = { lo: 1, hi: Infinity }; pos++; }
    else if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(pos));
      if (!m) return null;
      q = { lo: Number(m[1]), hi: m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]) };
      pos += m[0].length;
    }
    if (q && source[pos] === '?') pos++;
    return q;
  };

  const sequence = (): Node => {
    let max = 0;
    let repeats = false;
    while (pos < source.length && source[pos] !== '|' && source[pos] !== ')') {
      const start = pos;
      const atom = atomWidth();
      const q = quantifier();
      if (!q) { max += atom.max; repeats ||= atom.repeats; continue; }
      if (q.hi === Infinity) errors.push(`unbounded quantifier after "${source.slice(start, pos)}"`);
      else if (q.hi > MAX_QUANTIFIER_BOUND) errors.push(`quantifier bound ${q.hi} over ${MAX_QUANTIFIER_BOUND} after "${source.slice(start, pos)}"`);
      if (atom.group && atom.repeats && q.hi > 1) errors.push(`nested quantifier in "${source.slice(start, pos)}"`);
      const hi = Number.isFinite(q.hi) ? q.hi : MAX_QUANTIFIER_BOUND;
      max += atom.max * hi;
      repeats ||= atom.repeats || q.hi > 1;
    }
    return { max, repeats };
  };

  function alternation(): Node {
    let node = sequence();
    while (source[pos] === '|') {
      pos++;
      const next = sequence();
      node = { max: Math.max(node.max, next.max), repeats: node.repeats || next.repeats };
    }
    return node;
  }

  const root = alternation();
  if (pos < source.length) errors.push(`unbalanced ")" at ${pos}`);
  return { maxLength: root.max, errors };
}
