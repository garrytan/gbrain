import { FACT_SPACE_CLASS } from '../../facts/withdrawal-schema.ts';

/**
 * The label line of `countLabelFacts` (repair/conversation-labels.ts), read into the literal labels the Rust store matches
 * (rust/crates/gbrain-store/src/facts/repair.rs `has_label_line`), so the store evaluates no regular expression.
 */
/** The fixed head and tail of the label line `countLabelFacts` matches with `~*` (repair/conversation-labels.ts). */
const LABEL_LINE_HEAD = '(^|\\n)\\*\\*(';
const LABEL_LINE_TAIL = `)${FACT_SPACE_CLASS}*:\\*\\*`;
/** The most literal labels one label line may spell; a larger alternation refuses. */
const MAX_LABELS = 4096;

/**
 * The literal labels, lower case, that the alternation of a label line spells, or null for any other pattern. An alternative
 * is ASCII letters and spaces, a bracket class of ASCII letters (`[sz]`), and `?` after either. Under `~*` an ASCII letter of
 * the pattern matches only its two ASCII cases, so the store compares with ASCII case folding.
 */
export function labelsOf(labelLine: string): string[] | null {
  if (!labelLine.startsWith(LABEL_LINE_HEAD) || !labelLine.endsWith(LABEL_LINE_TAIL)) return null;
  const body = labelLine.slice(LABEL_LINE_HEAD.length, labelLine.length - LABEL_LINE_TAIL.length);
  const out = new Set<string>();
  for (const alt of body.split('|')) {
    let forms = [''];
    for (let i = 0; i < alt.length; i++) {
      let atom: string[];
      if (/^[A-Za-z ]$/.test(alt[i]!)) {
        atom = [alt[i]!];
      } else if (alt[i] === '[') {
        const end = alt.indexOf(']', i);
        const set = end < 0 ? '' : alt.slice(i + 1, end);
        if (!/^[A-Za-z]+$/.test(set)) return null;
        atom = [...set];
        i = end;
      } else {
        return null;
      }
      const optional = alt[i + 1] === '?';
      if (optional) i++;
      forms = forms.flatMap(f => [...atom.map(a => f + a), ...(optional ? [f] : [])]);
      if (forms.length > MAX_LABELS) return null;
    }
    for (const f of forms) {
      if (f === '') return null;
      out.add(f.toLowerCase());
    }
    if (out.size > MAX_LABELS) return null;
  }
  return [...out];
}
