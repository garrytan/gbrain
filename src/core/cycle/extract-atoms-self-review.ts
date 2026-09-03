import { stripReasoningBlocks } from '../llm-json.ts';
import type { ChatOpts, ChatResult } from '../ai/gateway.ts';

const CRITIC_PROMPT = `Audit candidate atoms against the supplied source. Do not rewrite them.

For every candidate return exactly one object:
{index, verdict (pass|repair|drop), issues (array of specific strings)}.

Look for unsupported additions and scope lost from titles, headings, and nearby
prose: named course, client, project, study, timeframe, decision status,
uncertainty, conditions, and negation. A locally true statement rewritten as
universal advice MUST be marked repair. Mark drop only when the source cannot
support the atom at all. Treat the source title and first H1 as governing
context: if either names a course, client, project, study, or dated incident,
the atom body and lesson must retain that scope unless the source explicitly
states the claim is universal. Output ONLY the JSON array, no prose.`;

const REPAIR_PROMPT = `Rewrite candidate atoms using the critic findings.

Return a corrected JSON array using the exact same atom schema. Apply every
critic issue literally. Preserve material course, client, project, study,
timeframe, decision status, uncertainty, conditions, and negation in the body
and lesson. Never add a claim the source does not support. Each source_quote
must be a verbatim, uniquely identifiable substring of at most 200 characters.
Drop anything that cannot be repaired without invention.
Output ONLY the JSON array, no prose.`;

interface AtomCritique {
  index: number;
  verdict: 'pass' | 'repair' | 'drop';
  issues: string[];
}

type CritiqueParseOutcome =
  | { ok: true; critiques: AtomCritique[] }
  | { ok: false; reason: string };

export type SelfReviewOutcome<T> =
  | { ok: true; atoms: T[]; rejectedUnverified: number; rejectedByCritic: number }
  | { ok: false; stage: 'critic' | 'repair'; reason: string };

function parseCritiques(raw: string, expectedCount: number): CritiqueParseOutcome {
  const stripped = stripReasoningBlocks(raw).trim();
  const cleaned = stripped.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, reason: 'unparseable JSON array' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'JSON value is not an array' };

  const critiques: AtomCritique[] = [];
  const seen = new Set<number>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'critique is not an object' };
    const obj = item as Record<string, unknown>;
    const index = obj.index;
    const verdict = obj.verdict;
    if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= expectedCount) {
      return { ok: false, reason: 'critique index is invalid' };
    }
    if (seen.has(Number(index))) return { ok: false, reason: 'critique index is duplicated' };
    if (verdict !== 'pass' && verdict !== 'repair' && verdict !== 'drop') {
      return { ok: false, reason: 'critique verdict is invalid' };
    }
    if (!Array.isArray(obj.issues) || !obj.issues.every((v) => typeof v === 'string')) {
      return { ok: false, reason: 'critique issues are invalid' };
    }
    seen.add(Number(index));
    critiques.push({ index: Number(index), verdict, issues: obj.issues as string[] });
  }
  if (critiques.length !== expectedCount) {
    return { ok: false, reason: 'critique count does not match candidate count' };
  }
  critiques.sort((a, b) => a.index - b.index);
  return { ok: true, critiques };
}

function input<T>(origin: string, source: string, atoms: T[], critiques?: AtomCritique[]): string {
  const sections = [
    `Source: ${origin}`,
    '',
    '--- SOURCE ---',
    source,
    '',
    '--- CANDIDATE ATOMS ---',
    JSON.stringify(atoms),
  ];
  if (critiques) sections.push('', '--- CRITIC FINDINGS ---', JSON.stringify(critiques));
  return sections.join('\n');
}

export async function selfReviewAtoms<T extends { source_quote?: string }>(opts: {
  atoms: T[];
  origin: string;
  source: string;
  model: string;
  maxTokens: number;
  chat: (opts: ChatOpts) => Promise<ChatResult>;
  parseAtoms: (raw: string) => { ok: true; atoms: T[] } | { ok: false; reason: string };
  quoteIsVerified: (quote: string) => boolean;
  beforeCall: () => void;
  afterCall: () => Promise<void>;
}): Promise<SelfReviewOutcome<T>> {
  opts.beforeCall();
  const criticResult = await opts.chat({
    model: opts.model,
    system: CRITIC_PROMPT,
    messages: [{ role: 'user', content: input(opts.origin, opts.source, opts.atoms) }],
    maxTokens: opts.maxTokens,
  });
  await opts.afterCall();
  const parsed = parseCritiques(criticResult.text, opts.atoms.length);
  if (!parsed.ok) return { ok: false, stage: 'critic', reason: parsed.reason };

  const pass: T[] = [];
  const repair: T[] = [];
  const repairCritiques: AtomCritique[] = [];
  let rejectedByCritic = 0;
  for (const critique of parsed.critiques) {
    if (critique.verdict === 'pass') pass.push(opts.atoms[critique.index]!);
    if (critique.verdict === 'repair') {
      repair.push(opts.atoms[critique.index]!);
      repairCritiques.push({ ...critique, index: repair.length - 1 });
    }
    if (critique.verdict === 'drop') rejectedByCritic++;
  }

  let repaired: T[] = [];
  if (repair.length > 0) {
    opts.beforeCall();
    const repairResult = await opts.chat({
      model: opts.model,
      system: REPAIR_PROMPT,
      messages: [{ role: 'user', content: input(opts.origin, opts.source, repair, repairCritiques) }],
      maxTokens: opts.maxTokens,
    });
    await opts.afterCall();
    const parsedRepair = opts.parseAtoms(repairResult.text);
    if (!parsedRepair.ok) return { ok: false, stage: 'repair', reason: parsedRepair.reason };
    repaired = parsedRepair.atoms;
  }

  const reviewed = [...pass, ...repaired];
  const atoms = reviewed.filter((atom) => opts.quoteIsVerified(atom.source_quote ?? ''));
  return {
    ok: true,
    atoms,
    rejectedUnverified: reviewed.length - atoms.length,
    rejectedByCritic,
  };
}
