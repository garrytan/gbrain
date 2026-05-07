/**
 * cross-modal-eval/json-repair — best-effort JSON parser for LLM output.
 *
 * Frontier models routinely return:
 *   - Plain JSON
 *   - JSON wrapped in ```json fences
 *   - JSON with trailing commas before } or ]
 *   - JSON with embedded newlines inside strings
 *   - JSON with single quotes used as string delimiters
 *
 * Four-strategy fallback chain. The "nuclear option" extracts scores via
 * regex when none of the above parses succeed; if even that fails to find
 * any dimension scores, we throw rather than fabricate.
 *
 * The aggregator (aggregate.ts) treats a throw here as "this model
 * contributed nothing this cycle" — the model is excluded from the verdict
 * but the gate can still PASS at >=2/3 successes.
 */

export interface ParsedScore {
  score: number;
  feedback?: string;
}

export interface ParsedModelResult {
  scores: Record<string, ParsedScore>;
  overall?: number;
  improvements: string[];
  /** True when the result was reconstructed via the regex nuclear option. */
  _repaired?: boolean;
}

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/i;

export function parseModelJSON(raw: string): ParsedModelResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('parseModelJSON: empty or non-string input');
  }

  // Strategy 1: strip markdown fences if present, then JSON.parse.
  const cleaned = stripFences(raw).trim();
  const direct = tryParse(cleaned);
  if (direct) return shape(direct);

  // Strategy 2: extract the first {...} object substring.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('parseModelJSON: no JSON object found in input');
  }
  const obj = match[0];

  const second = tryParse(obj);
  if (second) return shape(second);

  // Strategy 3: repair common LLM-JSON mistakes.
  const fixed = repairJson(obj);
  const third = tryParse(fixed);
  if (third) return shape(third);

  // Strategy 4: nuclear option — regex-extract scores + improvements.
  const reconstructed = regexNuclearOption(obj);
  if (reconstructed) return reconstructed;

  throw new Error('parseModelJSON: all repair strategies failed');
}

function stripFences(s: string): string {
  const m = s.match(FENCE_RE);
  return m ? m[1]! : s;
}

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function repairJson(s: string): string {
  return (
    s
      // Trailing commas before } or ]
      .replace(/,(\s*[}\]])/g, '$1')
      // Single-quoted string values used as delimiters around keys/values
      // (only between structural punctuation, to avoid touching apostrophes
      // inside legitimate double-quoted strings).
      .replace(/(?<=[:{,\[]\s*)'([^']*?)'(?=\s*[,}\]:])/g, '"$1"')
      // Unescaped newlines inside double-quoted strings — replace with \n.
      .replace(/("(?:[^"\\]|\\.)*?)\n((?:[^"\\]|\\.)*?")/g, '$1\\n$2')
  );
}

/**
 * Last-resort: scan for `"<dim>": { ... "score": N }` patterns and any
 * numbered `"N. ..."` improvement strings. Throws if zero scores are
 * recoverable (better than fabricating a fake PASS).
 */
function regexNuclearOption(obj: string): ParsedModelResult | null {
  const scores: Record<string, ParsedScore> = {};
  const scoreRe = /["']?(\w[\w_-]*)["']?\s*:\s*\{[^}]*?["']?score["']?\s*:\s*(\d+(?:\.\d+)?)/g;
  for (const m of obj.matchAll(scoreRe)) {
    const dim = m[1]!;
    const num = Number(m[2]);
    if (Number.isFinite(num)) scores[dim] = { score: num };
  }

  if (Object.keys(scores).length === 0) return null;

  const improvements: string[] = [];
  const impRe = /"(\d+\.\s[^"]{10,})"/g;
  for (const m of obj.matchAll(impRe)) {
    improvements.push(m[1]!);
  }

  const overallMatch = obj.match(/["']?overall["']?\s*:\s*(\d+(?:\.\d+)?)/);
  return {
    scores,
    overall: overallMatch ? Number(overallMatch[1]) : undefined,
    improvements:
      improvements.length > 0
        ? improvements
        : ['(could not parse improvements from malformed JSON)'],
    _repaired: true,
  };
}

function shape(parsed: unknown): ParsedModelResult {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('parseModelJSON: parsed value is not an object');
  }
  const p = parsed as Record<string, unknown>;
  const scoresRaw = (p.scores as Record<string, unknown>) ?? {};
  const scores: Record<string, ParsedScore> = {};
  for (const [dim, v] of Object.entries(scoresRaw)) {
    if (typeof v === 'number') {
      scores[dim] = { score: v };
    } else if (v && typeof v === 'object') {
      const vv = v as Record<string, unknown>;
      const score = typeof vv.score === 'number' ? vv.score : Number(vv.score);
      if (!Number.isFinite(score)) continue;
      const feedback = typeof vv.feedback === 'string' ? vv.feedback : undefined;
      scores[dim] = { score, feedback };
    }
  }

  const improvements = Array.isArray(p.improvements)
    ? (p.improvements as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  const overall = typeof p.overall === 'number' ? p.overall : undefined;

  if (Object.keys(scores).length === 0) {
    throw new Error('parseModelJSON: parsed object has no usable scores');
  }

  return { scores, overall, improvements };
}
