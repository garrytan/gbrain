/**
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
 * Test fixtures in test/think-sanitize.test.ts pin 30+ known attack strings.
 */

const INJECTION_PATTERNS: Array<{ name: string; rx: RegExp; replacement: string }> = [
  // System / instruction overrides
  { name: 'ignore-prior',     rx: /ignore\s+(?:all\s+)?(?:prior|previous|above|earlier)\s+(?:instructions?|prompts?|messages?)/gi, replacement: '[redacted]' },
  { name: 'forget-everything', rx: /forget\s+(?:everything|all\s+(?:of\s+)?the\s+above)/gi, replacement: '[redacted]' },
  { name: 'disregard',        rx: /disregard\s+(?:all\s+)?(?:prior|previous|above|earlier)\s+(?:instructions?|prompts?)/gi, replacement: '[redacted]' },
  { name: 'new-instructions', rx: /(?:new|updated|revised)\s+instructions?:/gi, replacement: '[redacted]:' },
  { name: 'system-prompt',    rx: /system\s*:\s*(?:you\s+are|you\s+must|never|always)/gi, replacement: '[redacted]' },
  { name: 'role-jailbreak',   rx: /you\s+are\s+(?:now|actually|really)\s+(?:a|an)\s+\w+/gi, replacement: '[redacted]' },
  { name: 'do-anything-now',  rx: /\b(?:DAN|do\s+anything\s+now|developer\s+mode\s+enabled?)\b/gi, replacement: '[redacted]' },
  // Tag injection — try to close the structural <take> wrapper
  { name: 'close-take',       rx: /<\s*\/\s*take\s*>/gi, replacement: '&lt;/take&gt;' },
  { name: 'open-system',      rx: /<\s*system\s*>/gi, replacement: '&lt;system&gt;' },
  { name: 'open-instructions', rx: /<\s*instructions?\s*>/gi, replacement: '&lt;instructions&gt;' },
  // Output exfiltration
  { name: 'print-system',     rx: /(?:print|output|reveal|show)\s+(?:your\s+)?(?:system\s+prompt|instructions?|hidden)/gi, replacement: '[redacted]' },
  { name: 'verbatim',         rx: /(?:repeat|echo)\s+(?:back|verbatim)/gi, replacement: '[redacted]' },
  // Code-execution-style hooks
  { name: 'eval-shell',       rx: /\b(?:eval|exec|system|shell)\s*\(/gi, replacement: '[redacted](' },
];

/**
 * Sanitize a single take claim before embedding into a model prompt.
 * Returns the cleaned text + a list of patterns that matched (for telemetry).
 */
export function sanitizeTakeForPrompt(claim: string): { text: string; matched: string[] } {
  let text = claim;
  const matched: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.rx.test(text)) {
      matched.push(p.name);
      text = text.replace(p.rx, p.replacement);
    }
  }
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
  source?: string | null;
  since_date?: string | null;
}

export function renderTakesBlock(takes: TakeForPrompt[]): { rendered: string; sanitizedCount: number } {
  const lines: string[] = [];
  let sanitizedCount = 0;
  for (const t of takes) {
    const { text, matched } = sanitizeTakeForPrompt(t.claim);
    if (matched.length > 0) sanitizedCount++;
    const meta = [`kind=${t.kind}`, `who=${t.holder}`, `weight=${t.weight.toFixed(2)}`];
    if (t.since_date) meta.push(`since=${t.since_date}`);
    if (t.source) meta.push(`source="${String(t.source).replace(/"/g, '\\"').slice(0, 80)}"`);
    lines.push(
      `<take id="${t.page_slug}#${t.row_num}" ${meta.join(' ')}>\n${text}\n</take>`,
    );
  }
  return { rendered: lines.join('\n\n'), sanitizedCount };
}
