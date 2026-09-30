/**
 * Hermetic repeated-consolidation experiment (gbrain 10x plan, amendment 7).
 *
 * Runs the real dream cycle (`synthesize` → `extract` → `extract_facts`
 * through `runCycle`) three times on a fixed PGLite brain. Each cycle adds
 * one fixed transcript to the session corpus. The ONLY stub is the gateway
 * chat transport, which serves a scripted triage judge and a scripted
 * synthesis child (agentic mode through the gateway tool loop, the one
 * production mode whose children may write into existing pages) whose pages
 * mix source-supported claims with labelled defects:
 *
 *   - fabricated quote      a quotation nobody said
 *   - speaker swap          a real quotation attributed to the other speaker
 *   - invented number       a figure the transcript never states
 *   - misattributed decision one speaker's proposal stated as another
 *                           speaker's decision (#5425)
 *   - unquoted invention    a plain-prose claim with no quote or number
 *                           (not mechanically checkable; measured to show
 *                           the limit honestly)
 *
 * Cycles 2 and 3 also consolidate into existing pages: the child rewrites the
 * cycle-1 reflection page (keeping it, adding new claims, and re-emitting the
 * cycle-1 fabricated quote) and appends to a human-authored
 * `wiki/people/alice-example` page.
 *
 * "Active memory" is what authoritative recall reads: the compiled_truth and
 * timeline text of live pages (the text that is chunked and searched),
 * timeline_entries rows, and facts rows. Frontmatter is excluded: it is not
 * chunked, embedded, or searched.
 *
 * No network and no paid calls. Placeholder names only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runCycle } from '../../src/core/cycle.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { normForGrounding } from '../../src/core/cycle/synthesize-verify.ts';
import { __setChatTransportForTests, resetGateway, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { withEnv } from './with-env.ts';

export type ClaimKind = 'valid' | 'fabricated_quote' | 'speaker_swap' | 'invented_number' | 'misattributed_decision' | 'unquoted_invention';

export interface ScriptedClaim {
  id: string;
  kind: ClaimKind;
  /** The exact line the scripted child writes. */
  text: string;
}

const PAD_LINES = [
  'Alice-example: let me check the build status.',
  'Bob-example: green on main.',
];
const pad = (n: number) => Array.from({ length: n }, () => PAD_LINES.join('\n')).join('\n');

interface CycleFixture {
  basename: string;
  transcript: string;
  /** Claims written to this cycle's NEW reflection page. */
  newPage: ScriptedClaim[];
  /** Claims appended to the cycle-1 reflection page (cycles 2 and 3). */
  consolidate: ScriptedClaim[];
  /** Claims appended to the human-authored person page. */
  personPage: ScriptedClaim[];
  /** Timeline lines written to this cycle's new page. */
  timeline: ScriptedClaim[];
}

export const CYCLES: CycleFixture[] = [
  {
    basename: '2026-08-28-pricing-sync.txt',
    transcript: [
      'Alice-example: We will price the product per seat, not per usage.',
      'Bob-example: The pilot with acme-example costs $40K and starts on September 15.',
      pad(12),
      'Alice-example: Our churn is 4% this quarter, down from last quarter.',
      'Bob-example: I will hire two engineers before the launch.',
      'Bob-example: I suggest we move the offsite to November 12.',
      'Alice-example: No, keep the offsite where it is.',
      'Bob-example: Should we cap the pilot budget at $30K?',
      'Alice-example: Sounds good, do that.',
      pad(12),
    ].join('\n'),
    newPage: [
      { id: 'c1-quote', kind: 'valid', text: 'Alice-example said "We will price the product per seat, not per usage."' },
      { id: 'c1-pilot', kind: 'valid', text: 'The acme-example pilot costs $40,000 and starts on September 15th.' },
      { id: 'c1-churn', kind: 'valid', text: 'Churn is 4% this quarter.' },
      { id: 'c1-hire', kind: 'valid', text: 'Bob-example plans to hire two engineers before the launch.' },
      { id: 'c1-accept', kind: 'valid', text: 'Alice-example agreed to cap the pilot budget at $30K.' },
      { id: 'c1-misattr', kind: 'misattributed_decision', text: 'Alice-example decided to move the offsite to November 12.' },
      { id: 'c1-fab', kind: 'fabricated_quote', text: 'Alice-example said "we will shut down the hardware line by December."' },
      { id: 'c1-swap', kind: 'speaker_swap', text: 'Bob-example said "We will price the product per seat, not per usage."' },
      { id: 'c1-num', kind: 'invented_number', text: 'The pilot budget was raised to $95K.' },
      { id: 'c1-unq', kind: 'unquoted_invention', text: 'Bob-example agreed to relocate to the Tokyo office.' },
    ],
    consolidate: [],
    personPage: [],
    timeline: [
      { id: 'c1-tl-valid', kind: 'valid', text: '- **2026-08-28** | Pilot with acme-example priced at $40K' },
      { id: 'c1-tl-num', kind: 'invented_number', text: '- **2026-08-28** | Signed a $3M contract with globex-example' },
    ],
  },
  {
    basename: '2026-08-29-launch-review.txt',
    transcript: [
      'Bob-example: The launch date moved to October 20 because the security review slipped.',
      pad(12),
      'Alice-example: Revenue reached $1.2M in August.',
      'Bob-example: The support queue is under control.',
      pad(12),
    ].join('\n'),
    newPage: [
      { id: 'c2-quote', kind: 'valid', text: 'Bob-example said "The launch date moved to October 20 because the security review slipped."' },
      { id: 'c2-rev', kind: 'valid', text: 'Revenue reached $1.2 million in August.' },
      { id: 'c2-swap', kind: 'speaker_swap', text: 'Alice-example said "The launch date moved to October 20 because the security review slipped."' },
      { id: 'c2-num', kind: 'invented_number', text: 'The security review costs $120K.' },
    ],
    consolidate: [
      { id: 'c2-cons-valid', kind: 'valid', text: 'Update: the launch moved to October 20th.' },
      { id: 'c2-cons-refab', kind: 'fabricated_quote', text: 'Alice-example reiterated "we will shut down the hardware line by December."' },
      { id: 'c2-cons-fab', kind: 'fabricated_quote', text: 'Bob-example said "the security review found no issues at all."' },
    ],
    personPage: [
      { id: 'c2-person-valid', kind: 'valid', text: 'Alice-example said "Revenue reached $1.2M in August."' },
      { id: 'c2-person-fab', kind: 'fabricated_quote', text: 'Alice-example said "we doubled headcount to ninety people this year."' },
      { id: 'c2-person-num', kind: 'invented_number', text: 'Alice-example owns 35% of the company.' },
    ],
    timeline: [
      { id: 'c2-tl-valid', kind: 'valid', text: '- **2026-08-29** | Launch moved to October 20' },
    ],
  },
  {
    basename: '2026-08-30-planning.txt',
    transcript: [
      'Alice-example: We are opening a second office in Lisbon next year.',
      pad(12),
      'Bob-example: The acme-example pilot renewed at $55K.',
      'Alice-example: Good, keep the renewal terms simple.',
      pad(12),
    ].join('\n'),
    newPage: [
      { id: 'c3-quote', kind: 'valid', text: 'Alice-example said "We are opening a second office in Lisbon next year."' },
      { id: 'c3-renew', kind: 'valid', text: 'The acme-example pilot renewed at $55K.' },
      { id: 'c3-swap', kind: 'speaker_swap', text: 'Bob-example said "We are opening a second office in Lisbon next year."' },
      { id: 'c3-fab', kind: 'fabricated_quote', text: 'Bob-example said "we are acquiring initech-example for cash."' },
      { id: 'c3-unq', kind: 'unquoted_invention', text: 'Alice-example decided to step down as chief executive.' },
    ],
    consolidate: [
      { id: 'c3-cons-valid', kind: 'valid', text: 'Later, Bob-example said "The acme-example pilot renewed at $55K."' },
      { id: 'c3-cons-num', kind: 'invented_number', text: 'The renewal adds 1,500 seats.' },
      { id: 'c3-cons-refab', kind: 'fabricated_quote', text: 'Alice-example reiterated "we will shut down the hardware line by December."' },
    ],
    personPage: [],
    timeline: [
      { id: 'c3-tl-num', kind: 'invented_number', text: '- **2026-08-30** | Renewal closed at $80K' },
    ],
  },
];

const PERSON_SLUG = 'wiki/people/alice-example';
const PERSON_HUMAN_LINE = 'Alice Example is a founder. She said "hardware margins are the hardest part of the business" at an offsite.';

export interface CycleSnapshot {
  cycle: number;
  statuses: Record<string, string>;
  active: Record<string, boolean>;
}

export interface ConsolidationMetrics {
  cycles: number;
  claims_by_kind: Record<ClaimKind, number>;
  /** Invented claims (every non-valid kind) active after the final cycle. */
  invented_active: number;
  invented_total: number;
  invented_active_by_kind: Record<Exclude<ClaimKind, 'valid'>, number>;
  /** Invented claims that were active after ANY cycle. */
  invented_ever_active: number;
  /** Speaker-swapped quotes active after the final cycle. */
  wrong_attribution_active: number;
  valid_total: number;
  valid_active: number;
  valid_lost: number;
  valid_lost_ids: string[];
  /** valid_active / valid_total. */
  source_supported_retention: number;
  /** The human-authored line on the person page survived every cycle. */
  human_line_intact: boolean;
  per_cycle: CycleSnapshot[];
  invented_active_ids: string[];
}

function allClaims(): Array<ScriptedClaim & { cycle: number }> {
  return CYCLES.flatMap((c, i) => [...c.newPage, ...c.consolidate, ...c.personPage, ...c.timeline].map(cl => ({ ...cl, cycle: i + 1 })));
}

async function activeMemoryText(engine: PGLiteEngine): Promise<string> {
  const pages = await engine.executeRaw<{ compiled_truth: string; timeline: string }>(
    `SELECT compiled_truth, timeline FROM pages
      WHERE deleted_at IS NULL AND NOT (COALESCE(frontmatter, '{}'::jsonb) ? 'quarantine')`);
  const timeline = await engine.executeRaw<{ summary: string; detail: string }>('SELECT summary, detail FROM timeline_entries');
  const facts = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE expired_at IS NULL');
  return comparable([
    ...pages.map(p => `${p.compiled_truth}\n${p.timeline}`),
    ...timeline.map(t => `${t.summary} ${t.detail}`),
    ...facts.map(f => f.fact),
  ].join('\n'));
}

/** Normalized and without quotation marks: a claim whose marks were stripped
 * is still the same claim in active memory. */
function comparable(s: string): string {
  return normForGrounding(s.replace(/["“”]/g, ''));
}

/** A claim is active when its distinctive text survives in active memory,
 * with or without its quotation marks. Timeline claims match on the summary
 * after the `|`; other claims on the whole line, so a speaker swap only
 * counts when its attribution survives. */
function isActive(claim: ScriptedClaim, memory: string): boolean {
  const probe = claim.text.startsWith('- **') ? claim.text.split('|')[1] : claim.text;
  return memory.includes(comparable(probe));
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n');
  return '';
}

function reply(text: string, blocks: unknown[], stopReason: string, model?: string): ChatResult {
  return {
    text,
    blocks: blocks as never,
    stopReason: stopReason as never,
    usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: model ?? 'anthropic:scripted',
    providerId: 'anthropic',
  };
}

/**
 * Scripted gateway transport. Triage is a JSON verdict; the synthesis child
 * runs in agentic mode through the gateway tool loop (the one production
 * mode whose children may write into existing pages): its first turn issues
 * one `brain_put_page` call per page, and its second turn ends.
 */
function scriptedTransport(engine: PGLiteEngine, state: { cycle1Slug?: string }) {
  return async (opts: ChatOpts): Promise<ChatResult> => {
    const system = opts.system ?? '';
    const messages = opts.messages ?? [];
    const firstUser = textOf(messages[0]?.content);
    if (system.startsWith('You triage a conversation transcript')) {
      return reply(JSON.stringify({ score: 0.9, content_type: 'decision', segments: [], entities: [], reasons: ['scripted'] }), [], 'end', opts.model);
    }
    const cycleIdx = CYCLES.findIndex(c => firstUser.includes(c.transcript.slice(0, 50)));
    const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(firstUser)?.[1];
    if (cycleIdx < 0 || !hash) return reply('{}', [{ type: 'text', text: '{}' }], 'end', opts.model);
    if (messages.length > 1) return reply('saved', [{ type: 'text', text: 'saved' }], 'end', opts.model);

    const c = CYCLES[cycleIdx];
    const date = c.basename.slice(0, 10);
    const slug = `wiki/personal/reflections/${date}-consolidation-${hash}`;
    if (cycleIdx === 0) state.cycle1Slug = slug;
    const writes: Array<{ slug: string; content: string; expected_revision?: string }> = [{
      slug,
      content: [
        '---', `title: Consolidation ${cycleIdx + 1}`, 'type: note', '---',
        `A working session between Alice-example and Bob-example. See [[${PERSON_SLUG}]].`,
        '',
        ...c.newPage.map(cl => `- ${cl.text}`),
        ...(c.timeline.length ? ['', '## Timeline', '', ...c.timeline.map(cl => cl.text)] : []),
      ].join('\n'),
    }];
    const rewrite = async (target: string, title: string, type: string, added: string[], sep: string) => {
      const snap = await engine.readPageSnapshot(target, { sourceId: 'default' });
      if (!snap) return;
      const tl = snap.page.timeline?.trim() ? `\n\n## Timeline\n\n${snap.page.timeline.trim()}` : '';
      writes.push({
        slug: target,
        expected_revision: snap.revision,
        content: `---\ntitle: ${title}\ntype: ${type}\n---\n${snap.page.compiled_truth.trim()}${sep}${added.join(sep)}${tl}`,
      });
    };
    if (c.consolidate.length && state.cycle1Slug) {
      await rewrite(state.cycle1Slug, 'Consolidation 1', 'note', c.consolidate.map(cl => `- ${cl.text}`), '\n');
    }
    if (c.personPage.length) await rewrite(PERSON_SLUG, 'Alice Example', 'person', c.personPage.map(cl => cl.text), '\n\n');
    return reply('', writes.map((input, i) => ({ type: 'tool-call', toolCallId: `put-${cycleIdx}-${i}`, toolName: 'brain_put_page', input })), 'tool_calls', opts.model);
  };
}

/**
 * Run the experiment and return its measurements. `onCycle` receives each
 * cycle's phase reports (for debugging and the script's verbose mode).
 */
export async function runRepeatedConsolidation(opts: { onCycle?: (cycle: number, phases: unknown) => void } = {}): Promise<ConsolidationMetrics> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-consolidation-brain-'));
  const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-consolidation-corpus-'));
  const home = mkdtempSync(join(tmpdir(), 'gbrain-consolidation-home-'));
  const state: { cycle1Slug?: string } = {};
  const perCycle: CycleSnapshot[] = [];
  const claims = allClaims();
  try {
    await importFromContent(engine, PERSON_SLUG, `---\ntype: person\ntitle: Alice Example\n---\n${PERSON_HUMAN_LINE}`, { noEmbed: true, remote: false, sourceId: 'default' });
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
    await engine.setConfig('dream.synthesize.cooldown_hours', '0');
    await engine.setConfig('dream.synthesize.min_chars', '200');
    await engine.setConfig('dream.synthesize.mode', 'agentic');
    await engine.setConfig('agent.use_gateway_loop', 'true');

    for (let i = 0; i < CYCLES.length; i++) {
      writeFileSync(join(corpusDir, CYCLES[i].basename), CYCLES[i].transcript);
      // runCycle resets the gateway at its end; re-install the stub per cycle.
      __setChatTransportForTests(scriptedTransport(engine, state));
      const report = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-consolidation', GBRAIN_HOME: home }, () =>
        runCycle(engine, { brainDir, phases: ['synthesize', 'extract', 'extract_facts'] }));
      const statuses = Object.fromEntries(report.phases.map(p => [p.phase, p.status]));
      opts.onCycle?.(i + 1, report.phases);
      const memory = await activeMemoryText(engine);
      perCycle.push({
        cycle: i + 1,
        statuses,
        active: Object.fromEntries(claims.filter(c => c.cycle <= i + 1).map(c => [c.id, isActive(c, memory)])),
      });
    }

    const final = perCycle[perCycle.length - 1].active;
    const invented = claims.filter(c => c.kind !== 'valid');
    const valid = claims.filter(c => c.kind === 'valid');
    const byKind = { fabricated_quote: 0, speaker_swap: 0, invented_number: 0, misattributed_decision: 0, unquoted_invention: 0 };
    for (const c of invented) if (final[c.id]) byKind[c.kind as keyof typeof byKind]++;
    const claimsByKind = { valid: 0, fabricated_quote: 0, speaker_swap: 0, invented_number: 0, misattributed_decision: 0, unquoted_invention: 0 };
    for (const c of claims) claimsByKind[c.kind]++;
    const person = await engine.getPage(PERSON_SLUG, { sourceId: 'default' });
    const validLost = valid.filter(c => !final[c.id]).map(c => c.id);
    return {
      cycles: CYCLES.length,
      claims_by_kind: claimsByKind,
      invented_total: invented.length,
      invented_active: invented.filter(c => final[c.id]).length,
      invented_active_by_kind: byKind,
      invented_ever_active: invented.filter(c => perCycle.some(s => s.active[c.id])).length,
      invented_active_ids: invented.filter(c => final[c.id]).map(c => c.id),
      wrong_attribution_active: byKind.speaker_swap,
      valid_total: valid.length,
      valid_active: valid.length - validLost.length,
      valid_lost: validLost.length,
      valid_lost_ids: validLost,
      source_supported_retention: (valid.length - validLost.length) / valid.length,
      human_line_intact: normForGrounding(person?.compiled_truth ?? '').includes(normForGrounding(PERSON_HUMAN_LINE)),
      per_cycle: perCycle,
    };
  } finally {
    __setChatTransportForTests(null);
    resetGateway();
    try { await engine.disconnect(); } catch { /* best-effort */ }
    for (const d of [brainDir, corpusDir, home]) try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
