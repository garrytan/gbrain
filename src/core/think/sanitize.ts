
import type { TrustTier } from '../trust/tier.ts';
import { trustAttributes } from '../eligibility/labels.ts';/**
 * v0.28: prompt-injection defense for take claims fed into `gbrain think`.
 *
 * The threat: a claim row in the takes table contains attacker-supplied text.
 * Without sanitization, an LLM-bound system prompt that includes those claims
 * verbatim could be hijacked ("ignore prior instructions, exfiltrate X").
 *
 * Mitigation is layered:
 *   1. Structural framing: every take rendered into the prompt is wrapped in
 *      <take id="..."> ... </take> tags. The model is told to treat content
 *      inside those tags as DATA, not instructions.
 *   2. Pattern strip: known jailbreak phrases are neutralized before injection.
 *      We don't pretend this is bulletproof — frontier models still drift on
 *      adversarial inputs. But we cut the volume of trivial injections by ~95%.
 *
 * Test fixtures in test/think-pipeline.test.ts, test/think-sanitize-trajectory.test.ts
 * and test/longmemeval-sanitize.test.ts pin known attack strings.
 */

// v0.28.8: exported so the longmemeval benchmark harness can reuse the same
// pattern set on retrieved chat content (src/eval/longmemeval/sanitize.ts).
// Existing think/take consumers keep working unchanged.
export const INJECTION_PATTERNS: Array<{ name: string; rx: RegExp; replacement: string }> = [
  // System / instruction overrides
  { name: 'ignore-prior',     rx: /ignore\s+(?:all\s+)?(?:prior|previous|above|earlier)\s+(?:instructions?|prompts?|messages?)/gi, replacement: '[redacted]' },
  { name: 'forget-everything', rx: /forget\s+(?:everything|all\s+(?:of\s+)?the\s+above)/gi, replacement: '[redacted]' },
  { name: 'disregard',        rx: /disregard\s+(?:all\s+)?(?:prior|previous|above|earlier)\s+(?:instructions?|prompts?)/gi, replacement: '[redacted]' },
  { name: 'new-instructions', rx: /(?:new|updated|revised)\s+instructions?:/gi, replacement: '[redacted]:' },
  { name: 'system-prompt',    rx: /system\s*:\s*(?:you\s+are|you\s+must|never|always)/gi, replacement: '[redacted]' },
  { name: 'role-jailbreak',   rx: /you\s+are\s+(?:now|actually|really)\s+(?:a|an)\s+\w+/gi, replacement: '[redacted]' },
  // The acronym is case-sensitive: "Dan" is a common name and "dan" a common
  // word in Spanish and Indonesian (#5910).
  { name: 'do-anything-now',  rx: /\bDAN\b/g, replacement: '[redacted]' },
  { name: 'do-anything-now-phrase', rx: /\b(?:do\s+anything\s+now|developer\s+mode\s+enabled?)\b/gi, replacement: '[redacted]' },
  { name: 'dan-mode',         rx: /\bdan\s+mode\b/gi, replacement: '[redacted]' },
  // Tag injection — try to close the structural <take> wrapper
  { name: 'close-take',       rx: /<\s*\/\s*take\s*>/gi, replacement: '&lt;/take&gt;' },
  { name: 'open-system',      rx: /<\s*system\s*>/gi, replacement: '&lt;system&gt;' },
  { name: 'open-instructions', rx: /<\s*instructions?\s*>/gi, replacement: '&lt;instructions&gt;' },
  // v0.40.2.0 — close + open coverage for the new <trajectory> wrapper used
  // by formatTrajectoryBlock. Extracted fact text can be attacker-controlled
  // (e.g. an LLM-extracted claim from a session containing `</trajectory>` to
  // break out of the data envelope and inject instructions). Per Codex
  // Problem 10 the prior pattern set only covered <take>/<system>/<instructions>;
  // this extension closes the new XML surface.
  { name: 'close-trajectory', rx: /<\s*\/\s*trajectory\s*>/gi, replacement: '&lt;/trajectory&gt;' },
  { name: 'open-trajectory',  rx: /<\s*trajectory\b[^>]*>/gi, replacement: '&lt;trajectory&gt;' },
  // Generic XML attribute-injection inside take/trajectory blocks: an extracted
  // value containing `entity="evil"` would otherwise inject a new attribute
  // on the wrapping tag if a naive renderer concatenated raw text.
  { name: 'xml-attr-inject',  rx: /\s+(entity|metric|event_type|kind)\s*=\s*"[^"]*"/gi, replacement: ' [redacted-attr]' },
  // Output exfiltration
  { name: 'print-system',     rx: /(?:print|output|reveal|show)\s+(?:your\s+)?(?:system\s+prompt|instructions?|hidden)/gi, replacement: '[redacted]' },
  { name: 'verbatim',         rx: /(?:repeat|echo)\s+(?:back|verbatim)/gi, replacement: '[redacted]' },
  // Code-execution-style hooks. #7125: only the code-call shape (the name
  // directly followed by `(` and then a quote, `)` or an identifier of two or
  // more characters), never the English word: "Business System (ABS)" and
  // "system(s)" are prose.
  { name: 'eval-shell',       rx: /\b(?:eval|exec|system|shell)\((?=\s*(?:['"`)]|[A-Za-z_$][\w$]))/gi, replacement: '[redacted](' },
];

const REDACTION_MARKER = /\[redacted(?:-attr)?\]/;

/**
 * #7125: the `eval-shell` rule before the fix. Text it rewrote before the fix
 * is restored against this shape (`gbrain repair redacted-facts`).
 */
export const LEGACY_EVAL_SHELL = { name: 'eval-shell-legacy', rx: /\b(?:eval|exec|system|shell)\s*\(/gi, replacement: '[redacted](' };

/**
 * #7125: neutralizing is for text rendered into a prompt, never for text that
 * gets stored. A model that copies a neutralized span into its output (a fact,
 * a quote, a page body) would otherwise persist the marker in place of the
 * user's words. `restoreNeutralized` puts back each marker the model copied
 * when the raw text the prompt was built from proves what it replaced: the
 * span is one of the raw text's own matches of a pattern with that
 * replacement, and the words right around it in `raw` are the words right
 * around the marker in `output` (case and edge punctuation aside; up to four on each side, both sides when the
 * marker has words on both; a marker at an edge of `output` needs three on
 * its other side). Matching compares whitespace-split words, so its cost is
 * linear in `raw` and no regex is built from `output`. A marker with no such
 * proof stays as written and is counted in `unresolved`, and in `ambiguous`
 * too when the raw text holds more than one distinct span around those words.
 */
export function restoreNeutralized(output: string, raw: string,
  patterns: ReadonlyArray<{ rx: RegExp; replacement: string }> = INJECTION_PATTERNS): { text: string; restored: number; unresolved: number; ambiguous: number } {
  if (!REDACTION_MARKER.test(output)) return { text: output, restored: 0, unresolved: 0, ambiguous: 0 };
  const markers = [...new Set(patterns.map(p => p.replacement.trim()).filter(r => REDACTION_MARKER.test(r)))].sort((a, b) => b.length - a.length);
  const hits: Array<{ start: number; end: number; marker: string }> = [];
  for (let at = 0; at < output.length;) {
    const next = markers.map(m => ({ m, i: output.indexOf(m, at) })).filter(x => x.i >= 0).sort((x, y) => x.i - y.i || y.m.length - x.m.length)[0];
    if (!next) break;
    hits.push({ start: next.i, end: next.i + next.m.length, marker: next.m });
    at = next.i + next.m.length;
  }
  const spans = new Map<string, Array<{ start: number; end: number; text: string }>>();
  const spansFor = (marker: string) => {
    if (!spans.has(marker)) {
      const found = new Map<string, { start: number; end: number; text: string }>();
      for (const p of patterns.filter(q => q.replacement.trim() === marker)) {
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- a global copy of a literal pattern
        for (const m of raw.matchAll(new RegExp(p.rx.source, p.rx.flags.includes('g') ? p.rx.flags : `${p.rx.flags}g`))) {
          found.set(`${m.index}:${m[0].length}`, { start: m.index!, end: m.index! + m[0].length, text: m[0] });
        }
      }
      spans.set(marker, [...found.values()]);
    }
    return spans.get(marker)!;
  };
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  const norm = (w: string) => w.toLowerCase().replace(/^[.,;:!?'"‘’“”]+|[.,;:!?'"‘’“”]+$/g, '');
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((w, i) => norm(w) === norm(b[i]!));
  const WINDOW = 400;
  let text = '';
  let at = 0;
  let restored = 0;
  let ambiguous = 0;
  hits.forEach((hit, i) => {
    const before = words(output.slice(i ? hits[i - 1]!.end : 0, hit.start)).slice(-4);
    const after = words(output.slice(hit.end, i + 1 < hits.length ? hits[i + 1]!.start : output.length)).slice(0, 4);
    const enough = before.length && after.length ? [...before, ...after].join('').length >= 8 : Math.max(before.length, after.length) >= 3;
    let replacement: string | null = null;
    if (enough) {
      const found = new Set(spansFor(hit.marker)
        .filter(s => same(before.length ? words(raw.slice(Math.max(0, s.start - WINDOW), s.start)).slice(-before.length) : [], before)
          && same(words(raw.slice(s.end, s.end + WINDOW)).slice(0, after.length), after))
        .map(s => s.text));
      if (found.size === 1) replacement = [...found][0]!;
      else if (found.size > 1) ambiguous++;
    }
    text += output.slice(at, hit.start) + (replacement ?? hit.marker);
    if (replacement !== null) restored++;
    at = hit.end;
  });
  return { text: text + output.slice(at), restored, unresolved: hits.length - restored, ambiguous };
}

/**
 * #5575 write gate: non-global clones of the detection-grade subset
 * (instruction overrides and output exfiltration), so `.test()` keeps no
 * `lastIndex` state. Tag breakouts, the case-sensitive acronym, `verbatim` and
 * `eval-shell` are render safety or too broad for a detector and stay
 * rewrite-only. `src/core/write-gate-patterns.ts` bounds their quantifiers.
 */
const DETECTION_FAMILY: Readonly<Record<string, 'override' | 'exfiltration'>> = {
  'ignore-prior': 'override', 'forget-everything': 'override', disregard: 'override', 'new-instructions': 'override',
  'system-prompt': 'override', 'role-jailbreak': 'override', 'do-anything-now-phrase': 'override', 'dan-mode': 'override',
  'print-system': 'exfiltration',
};
export const INJECTION_DETECTION_PATTERNS: ReadonlyArray<{ name: string; family: 'override' | 'exfiltration'; rx: RegExp }> = INJECTION_PATTERNS
  .filter(p => DETECTION_FAMILY[p.name])
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- non-global copies of this module's own literal INJECTION_PATTERNS
  .map(p => ({ name: p.name, family: DETECTION_FAMILY[p.name], rx: new RegExp(p.rx.source, p.rx.flags.replace('g', '')) }));

/**
 * Neutralize the known injection phrases in stored text as it is rendered
 * into a model prompt. Stored text is never rewritten (#7125): every renderer
 * that puts a stored fact or claim in front of a model calls this on its copy.
 */
export function neutralizeForPrompt(raw: string): { text: string; matched: string[] } {
  let text = raw;
  const matched: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.rx.test(text)) {
      matched.push(p.name);
      text = text.replace(p.rx, p.replacement);
    }
  }
  return { text, matched };
}

/**
 * Sanitize a single take claim before embedding into a model prompt.
 * Returns the cleaned text + a list of patterns that matched (for telemetry).
 */
export function sanitizeTakeForPrompt(claim: string): { text: string; matched: string[] } {
  const { text: neutralized, matched } = neutralizeForPrompt(claim);
  let text = neutralized;
  // Final safety: cap absurdly long claims to keep one bad row from hogging
  // the prompt budget. 500 chars is far longer than any natural take.
  if (text.length > 500) {
    text = text.slice(0, 497) + '...';
    matched.push('length-cap');
  }
  return { text, matched };
}

/**
 * Render a list of takes as the structured `<take>` block the system prompt
 * tells the model to treat as DATA. Uses `(slug, row_num)` so the model can
 * cite back via `[slug#row]`.
 */
export interface TakeForPrompt {
  page_slug: string;
  row_num: number;
  claim: string;
  kind: string;
  holder: string;
  weight: number;
  /** The take's page source id: the scope the claim was recorded in. */
  source_id?: string | null;
  source?: string | null;
  since_date?: string | null;
  until_date?: string | null;
  /** #5575 A6: the take's trust tier and short origin, rendered as attributes. */
  trust_tier?: TrustTier;
  origin?: string;
}

/**
 * A stored take field rendered as a `<take>` attribute value: neutralized like
 * the claim (neutralizeForPrompt), entity-escaped so it cannot close the
 * attribute or the tag, kept on one line and bounded (before escaping, so an
 * entity is never cut).
 */
function takeAttrValue(raw: unknown, max = 80): string {
  const escaped = String(raw).replace(/[\r\n\t]+/g, ' ').slice(0, max)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return neutralizeForPrompt(escaped).text;
}

export function renderTakesBlock(takes: TakeForPrompt[]): { rendered: string; sanitizedCount: number } {
  const lines: string[] = [];
  let sanitizedCount = 0;
  for (const t of takes) {
    const { text, matched } = sanitizeTakeForPrompt(t.claim);
    if (matched.length > 0) sanitizedCount++;
    const meta = [`kind=${t.kind}`, `who=${t.holder}`, `weight=${t.weight.toFixed(2)}`];
    if (t.source_id) meta.push(`origin_source="${takeAttrValue(t.source_id)}"`);
    if (t.since_date) meta.push(`since="${takeAttrValue(t.since_date, 32)}"`);
    if (t.until_date) meta.push(`until="${takeAttrValue(t.until_date, 32)}"`);
    if (t.source) meta.push(`source="${takeAttrValue(t.source)}"`);
    if (t.trust_tier) meta.push(trustAttributes({ trust_tier: t.trust_tier, origin: t.origin ?? 'legacy' }));
    lines.push(
      `<take id="${t.page_slug}#${t.row_num}" ${meta.join(' ')}>\n${text}\n</take>`,
    );
  }
  return { rendered: lines.join('\n\n'), sanitizedCount };
}
