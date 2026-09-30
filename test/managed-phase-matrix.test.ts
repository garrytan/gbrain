/**
 * Managed-brain phase matrix (fix wave 3, CEO "Managed-brain phase matrix
 * test" / Eng E-D15). One fixture per cycle phase per engine: each runs that
 * single phase through runCycle on a managed brain (filesystem source with an
 * active local canonical owner, persistence enabled) with stub chat and
 * embedding providers and a seeded input for the phase to act on.
 *
 * - writes: the phase must commit a coordinated mutation with its intended result.
 * - no_coordinated_write: the phase must not fail or be refused by the coordinator.
 * - managed_skip: the phase result must carry the table's reason.
 *
 * Authoring gate: protects "every maintenance phase runs on a managed brain";
 * a writer that bypasses the coordinator (writer_coordinator_required,
 * owner_unavailable, a contained phase failure) or a phase that silently stops
 * writing fails its fixture, and a new phase fails until it is classified.
 * Per-writer tests cover individual writers, not every phase through runCycle.
 * No production seam: the stubs are the gateway's existing test transports.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ALL_PHASES, runCycle, type CycleOpts, type CyclePhase, type PhaseResult } from '../src/core/cycle.ts';
import { MANAGED_PHASE_TABLE } from '../src/core/cycle/phase-table.ts';
import { runPhaseGradeTakes } from '../src/core/cycle/grade-takes.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-phase-matrix-db-'));
const timings: string[] = [];
const matrixStart = Date.now();
let since = 0;
let closePostgres: (() => Promise<void>) | undefined;
const KEYS = { ANTHROPIC_API_KEY: 'sk-test-phase-matrix', OPENAI_API_KEY: 'sk-test-phase-matrix' };

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: KEYS });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) =>
    ({ embeddings: values.map(() => [1, ...Array(1535).fill(0)]), usage: { tokens: values.length } }) as never);
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); __setEmbedTransportForTests(null); __setChatTransportForTests(null); resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`[phase-matrix] ${backends.join('+')} timings (ms):\n${timings.join('\n')}\n[phase-matrix] total ${Date.now() - matrixStart} ms`);
  expect(Date.now() - matrixStart).toBeLessThan(300_000);
});

interface Ctx { engine: BrainEngine; sourceId: string; root: string; result: PhaseResult; calls: ChatOpts[]; logs: string }
interface Entry {
  seed?: (c: Pick<Ctx, 'engine' | 'sourceId' | 'root'>) => Promise<unknown>;
  config?: Record<string, string>;
  env?: Record<string, string>;
  cycle?: Partial<CycleOpts>;
  reply?: (opts: ChatOpts, call: number) => string | Partial<ChatResult>;
  assert?: (c: Ctx) => Promise<void>;
}

const logger = { info() {}, warn() {}, error() {} };
const put = (engine: BrainEngine, sourceId: string, slug: string, content: string) =>
  submitPageMutation({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger },
    { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
const page = (type: string, title: string, body: string, extra = '') => `---\ntitle: ${title}\ntype: ${type}\n${extra}---\n${body}`;
const takesFence = (rows: string[]) => ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
  '|---|-------|------|-----|--------|-------|--------|', ...rows, '<!--- gbrain:takes:end -->'].join('\n');
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const reply = (text: string, model = 'anthropic:claude-sonnet-4-6'): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model, providerId: 'anthropic' });

async function committed(engine: BrainEngine, sourceId: string, slug: string) {
  return engine.executeRaw<{ operation: string; intent: Record<string, unknown> | null; outcome: Record<string, unknown> | null }>(
    `SELECT operation,intent,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='committed' AND sequence>$3 ORDER BY sequence`,
    [sourceId, slug, since]);
}
async function seedFacts(engine: BrainEngine, sourceId: string, slug: string) {
  const vector = `[${[1, ...Array(1535).fill(0)].join(',')}]`;
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,confidence,valid_from,embedding,embedding_model,embedded_text_hash)
      VALUES($1,$2,$3,'fact','test','world',$4,$5::timestamptz,$6::vector,'openai:text-embedding-3-large',md5($3))`,
    [sourceId, slug, `Example claim ${i}`, 0.9 - i / 10, `2026-01-0${i + 1}T00:00:00Z`, vector]);
  }
}

const MATRIX: Record<CyclePhase, Entry> = {
  lint: {
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'notes/lint-example', page('note', 'Lint example', 'Body with a trailing space. \n\n\n\nToo many blank lines.')),
  },
  backlinks: {
    seed: async ({ engine, sourceId }) => {
      await put(engine, sourceId, 'people/alice-example', page('person', 'Alice', 'A person.'));
      await put(engine, sourceId, 'companies/acme-example', page('company', 'Acme', 'Hired [[people/alice-example]].'));
    },
  },
  sync: {
    seed: async ({ root }) => {
      git(root, 'init', '-q');
      mkdirSync(join(root, 'notes'));
      writeFileSync(join(root, 'notes/sync-example.md'), page('note', 'Sync example', 'A synced observation.\n'));
      git(root, 'add', '.');
      git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
    },
    assert: async ({ engine, sourceId }) => {
      expect(await committed(engine, sourceId, 'notes/sync-example')).not.toHaveLength(0);
      expect((await engine.getPage('notes/sync-example', { sourceId }))?.compiled_truth).toContain('A synced observation.');
    },
  },
  synthesize: {
    seed: async ({ engine, sourceId, root }) => {
      await put(engine, sourceId, 'people/example', page('note', 'Example', 'Example evidence.'));
      writeFileSync(join(root, '2026-09-20-session.txt'), `User: we charge for durability because reliable memories should survive every tool.\n${'Assistant: Discuss the long term roadmap.\n'.repeat(15)}`);
    },
    config: { 'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0', 'dream.synthesize.min_chars': '100',
      'dream.synthesize.link_manifest': 'false', 'dream.synthesize.mode': 'oneshot', 'models.dream.synthesize': 'anthropic:claude-sonnet-4-6',
      'models.dream.triage': 'anthropic:claude-sonnet-4-6', 'dream.synthesize.session_corpus_dir': '{root}' },
    cycle: { synthDate: '2026-09-20' },
    reply: (opts) => {
      const user = String(opts.messages?.[0]?.content ?? '');
      const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(user)?.[1] ?? 'missing';
      return (opts.system ?? '').startsWith('You triage a conversation transcript')
        ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote: 'we charge for durability because reliable memories should survive every tool', note: 'evidence' }], entities: [], reasons: ['durable insight'] })
        : JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/session-${hash}`, title: 'Session', type: 'note', body: 'A memory strategy with [[people/example]].' }], skipped: false });
    },
    assert: async ({ engine, sourceId, result }) => {
      expect(result.details.pages_written).toBe(1);
      const slug = (result.details.written_slugs as string[])[0];
      expect(await committed(engine, sourceId, slug)).not.toHaveLength(0);
      expect((await engine.getPage(slug, { sourceId }))?.compiled_truth).toContain('A memory strategy');
    },
  },
  extract: {
    config: { auto_link: 'false' },
    seed: async ({ engine, sourceId }) => {
      await put(engine, sourceId, 'companies/acme-example', page('company', 'Acme', 'A company.'));
      await put(engine, sourceId, 'people/alice-example', page('person', 'Alice', 'Works with [[companies/acme-example]].\n\n## Timeline\n\n- **2026-01-02** | test — Met Acme'));
      await engine.executeRaw("DELETE FROM timeline_entries WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug='people/alice-example')", [sourceId]);
    },
    assert: async ({ engine, sourceId }) => {
      expect((await engine.getLinks('people/alice-example', { sourceId })).map(l => l.to_slug)).toContain('companies/acme-example');
      expect(await engine.executeRaw(`SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id=t.page_id
        WHERE p.source_id=$1 AND p.slug='people/alice-example'`, [sourceId])).toEqual([{ summary: 'Met Acme' }]);
      expect(await engine.countStalePagesForExtraction({ sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
    },
  },
  extract_facts: {
    seed: async ({ engine, sourceId }) => {
      await engine.executeRaw(`INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, timeline, frontmatter)
        VALUES ('people/bob-example', $1, 'Bob', 'person', 'markdown', $2, '', '{}'::jsonb)`, [sourceId,
        '# Bob\n\nBody.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n'
        + '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
        + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
        + '| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |\n<!--- gbrain:facts:end -->\n']);
    },
    assert: async ({ engine, sourceId }) => {
      expect(await engine.executeRaw("SELECT fact FROM facts WHERE source_id=$1 AND entity_slug='people/bob-example'", [sourceId]))
        .toEqual([{ fact: 'Founded Acme' }]);
    },
  },
  extract_atoms: {
    env: { GBRAIN_SCHEMA_PACK: 'gbrain-creator' },
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'notes/atom-source', page('note', 'Atom source', 'A project record about measured progress. '.repeat(40))),
    reply: () => '[{"title":"Measured progress","atom_type":"insight","body":"Measure progress against clear exit criteria."}]',
    assert: async ({ engine, sourceId }) => {
      const atoms = await engine.executeRaw<{ slug: string; compiled_truth: string }>("SELECT slug,compiled_truth FROM pages WHERE source_id=$1 AND type='atom'", [sourceId]);
      expect(atoms).toHaveLength(1);
      expect(atoms[0].compiled_truth).toContain('Measure progress against clear exit criteria.');
      expect(await committed(engine, sourceId, atoms[0].slug)).not.toHaveLength(0);
    },
  },
  resolve_symbol_edges: {},
  patterns: {
    seed: async ({ engine, sourceId }) => {
      for (let i = 0; i < 3; i++) await put(engine, sourceId, `wiki/personal/reflections/example-${i}`, page('note', `Reflection ${i}`, `Example evidence ${i}.`));
    },
    config: { 'dream.patterns.enabled': 'true', 'models.dream.patterns': 'anthropic:claude-sonnet-4-6', 'agent.use_gateway_loop': 'true' },
    cycle: { onceForPhase: 'patterns' },
    reply: (opts, call) => call === 1
      ? { text: '', stopReason: 'tool_calls', blocks: [{ type: 'tool-call', toolCallId: 'pattern-write', toolName: 'brain_put_page', input: {
        slug: 'wiki/personal/patterns/example', content: page('note', 'Example pattern', 'A recurring theme in [[wiki/personal/reflections/example-0]].') } }] }
      : 'Saved the pattern.',
    assert: async ({ engine, sourceId, result }) => {
      expect(result.details.patterns_written).toBe(1);
      expect(await committed(engine, sourceId, 'wiki/personal/patterns/example')).not.toHaveLength(0);
      expect((await engine.getPage('wiki/personal/patterns/example', { sourceId }))?.compiled_truth).toContain('A recurring theme');
    },
  },
  synthesize_concepts: {
    env: { GBRAIN_SCHEMA_PACK: 'gbrain-creator' },
    seed: async ({ engine, sourceId }) => {
      for (const n of [1, 2]) await put(engine, sourceId, `atoms/idea-${n}`, page('atom', `Idea ${n}`, `Atom ${n} about network effects.`, 'visibility: world\nconcepts: [network-effects]\n'));
    },
    assert: async ({ engine, sourceId }) => {
      expect((await committed(engine, sourceId, 'concepts/network-effects')).map(r => r.intent?.kind)).toEqual(['managed_maintenance_page', 'managed_maintenance_page']);
      expect((await engine.getPage('concepts/network-effects', { sourceId }))?.frontmatter?.visibility).toBe('world');
    },
  },
  recompute_emotional_weight: {
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'people/weight-example', page('person', 'Weight', 'A person.', 'tags: [family]\n')),
  },
  consolidate: {
    seed: async ({ engine, sourceId }) => {
      await put(engine, sourceId, 'people/example', page('note', 'Example', 'Example evidence.'));
      await seedFacts(engine, sourceId, 'people/example');
    },
    assert: async ({ engine, sourceId, result }) => {
      expect(result.details.takes_written).toBe(1);
      expect(await committed(engine, sourceId, 'people/example')).not.toHaveLength(0);
      expect((await engine.getPage('people/example', { sourceId }))?.compiled_truth).toContain('Example claim 0');
    },
  },
  propose_takes: {
    config: { 'cycle.propose_takes.enabled': 'true' },
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'notes/propose-example', page('note', 'Propose', 'I bet the example market compresses within 18 months.')),
    reply: () => JSON.stringify([{ claim_text: 'The example market compresses within 18 months', kind: 'bet', holder: 'brain', weight: 0.7, domain: 'macro' }]),
    assert: async ({ engine, sourceId }) => {
      expect(await engine.executeRaw('SELECT id FROM take_proposals WHERE source_id=$1', [sourceId])).toHaveLength(1);
    },
  },
  grade_takes: {
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'notes/grade-example', page('note', 'Grade', `Draft.\n\n${takesFence(['| 1 | Acme will ship widgets | take | brain | 0.6 | 2025-01 | notes |'])}`)),
    reply: () => JSON.stringify({ verdict: 'correct', confidence: 0.99, reasoning: 'Acme shipped widgets.' }),
    assert: async ({ engine, sourceId, calls }) => {
      expect(calls.length).toBeGreaterThan(0);
      expect(await engine.executeRaw("SELECT verdict FROM take_grade_cache WHERE verdict='correct'")).toHaveLength(1);
      const applied = await runPhaseGradeTakes({ engine, sourceId, remote: false, config: {} as never, dryRun: false, logger } as never,
        { autoResolve: true, promptVersion: 'phase-matrix-apply' });
      expect(applied.details.auto_applied).toBe(1);
      expect((await committed(engine, sourceId, 'notes/grade-example')).at(-1)?.operation).toBe('takes_resolve');
    },
  },
  calibration_profile: {
    seed: async ({ engine, sourceId }) => {
      await put(engine, sourceId, 'notes/calibration-example', page('note', 'Calibration',
        `Draft.\n\n${takesFence([1, 2, 3, 4, 5].map(n => `| ${n} | Widget line ${n} ships | take | self | 0.7 | 2025-01 | notes |`))}`));
      await engine.executeRaw(`UPDATE takes SET resolved_at=now(), resolved_outcome=true, resolved_quality='correct', resolved_by='test'
        WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug='notes/calibration-example')`, [sourceId]);
    },
    reply: () => JSON.stringify(['You were right about widget launches in 5 of 5 calls.']),
    assert: async ({ result }) => { expect(result.details.total_resolved).toBe(5); },
  },
  drift: {
    config: { 'dream.drift.enabled': 'true' },
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'notes/drift-example', page('note', 'Drift',
      `Draft.\n\n${takesFence(['| 1 | Acme will ship widgets | take | brain | 0.6 | 2025-01 | notes |'])}\n\n## Timeline\n\n- **${daysAgo(2)}** | test — Acme cancelled the widget line`)),
    reply: () => JSON.stringify({ drifted: true, confidence: 0.9, reasoning: 'Acme cancelled the widget line.' }),
    assert: async ({ engine, result }) => {
      const slug = String(result.summary).match(/reports\/drift-[0-9-]+/)?.[0];
      expect(slug).toBeDefined();
      expect(await committed(engine, 'default', slug!)).not.toHaveLength(0);
      expect((await engine.getPage(slug!, { sourceId: 'default' }))?.compiled_truth).toContain('DRIFTED — notes/drift-example');
    },
  },
  conversation_facts_backfill: {
    config: { 'cycle.conversation_facts_backfill.enabled': 'true' },
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'conversations/2026-09-20-example', page('conversation', 'Chat',
      '**Alice** (09:00): I moved to Lisbon last month.\n\n**Bob** (09:01): Congrats on the move.')),
    reply: () => JSON.stringify({ facts: [{ fact: 'Alice moved to Lisbon', kind: 'event', entity: 'people/alice-example', confidence: 0.9, notability: 'medium' }] }),
    assert: async ({ engine, sourceId }) => {
      expect(await engine.executeRaw("SELECT fact FROM facts WHERE source_id=$1 AND fact LIKE '%Lisbon%'", [sourceId])).not.toHaveLength(0);
    },
  },
  enrich_thin: {
    config: { 'cycle.enrich_thin.enabled': 'true', 'cycle.enrich_thin.types': '["person"]' },
    seed: async ({ engine, sourceId }) => {
      await put(engine, sourceId, 'people/alice-example', page('person', 'Alice Example', 'Stub page.'));
      await put(engine, sourceId, 'meetings/m1', page('note', 'M1', 'Notes about [[people/alice-example]].'));
      for (const fact of ['Alice founded WidgetCo and leads its design system.', 'Alice previously ran platform engineering at Acme Example for six years.',
        'Alice mentors early-stage founders on hiring their first designers.', 'Alice is based in Lisbon and speaks at design conferences.']) {
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source, valid_from, visibility)
          VALUES ($1, 'people/alice-example', $2, 'test', now(), 'world')`, [sourceId, fact]);
      }
    },
    reply: () => '## Overview\nAlice founded WidgetCo. [Source: meetings/m1]',
    assert: async ({ engine, sourceId }) => {
      expect((await committed(engine, sourceId, 'people/alice-example')).at(-1)?.intent?.kind).toBe('managed_maintenance_page');
      expect((await engine.getPage('people/alice-example', { sourceId }))?.compiled_truth).toContain('Alice founded WidgetCo.');
    },
  },
  skillopt: {
    config: { 'cycle.skillopt.enabled': 'true', 'cycle.skillopt.per_skill_cap_usd': '10', 'cycle.skillopt.brain_wide_cap_usd': '10' },
    env: { GBRAIN_SKILLS_DIR: '{root}/../skills' },
    reply: () => '{"edits": []}',
    assert: async ({ result }) => { expect(result.details.no_improvement).toBe(1); },
    seed: async ({ root }) => {
      const skill = join(root, '..', 'skills', 'example-skill');
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(root, '..', 'skills', 'RESOLVER.md'), '# Resolver\n\n- example-skill: skills/example-skill/SKILL.md\n');
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: example-skill\ndescription: Answer example questions.\ntriggers: [example]\n---\nAnswer briefly.\n');
      writeFileSync(join(skill, 'skillopt-benchmark.jsonl'), Array.from({ length: 50 }, (_, i) => JSON.stringify({ task_id: `q${i}`, task: `Answer question ${i} briefly.`, judge: { kind: 'rule', checks: [{ op: 'max_chars', arg: 4000 }] } })).join('\n') + '\n');
    },
  },
  embed: {
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'notes/embed-example', page('note', 'Embed', 'A page whose chunks need vectors.')),
  },
  orphans: {
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'notes/orphan-example', page('note', 'Orphan', 'Nobody links here.')),
  },
  'schema-suggest': {
    seed: async ({ engine, sourceId }) => put(engine, sourceId, 'notes/schema-example', page('note', 'Schema', 'A plain note.')),
  },
  purge: {
    seed: async ({ engine, sourceId }) => {
      await put(engine, sourceId, 'notes/expired', page('note', 'Expired', 'Gone soon.'));
      const snapshot = await engine.readPageSnapshot('notes/expired', { sourceId });
      await submitPageMutation({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger },
        { operation: 'delete_page', params: { slug: 'notes/expired', expected_revision: snapshot!.revision, request_id: randomUUID() } });
      await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug='notes/expired'", [sourceId]);
    },
    assert: async ({ engine, sourceId, result }) => {
      expect(result.details.purged_pages_count).toBe(1);
      expect(await engine.readPageSnapshot('notes/expired', { sourceId, includeDeleted: true })).toBeNull();
      expect((await committed(engine, sourceId, 'notes/expired')).at(-1)?.outcome?.status).toBe('purged');
    },
  },
};

test('every cycle phase is classified for managed brains, with no extra keys', () => {
  expect(Object.keys(MANAGED_PHASE_TABLE).sort()).toEqual([...ALL_PHASES].sort());
  expect(Object.keys(MATRIX).sort()).toEqual([...ALL_PHASES].sort());
  for (const entry of Object.values(MANAGED_PHASE_TABLE)) expect(entry.reason.length).toBeGreaterThan(0);
});

const REFUSALS = ['writer_coordinator_required', 'owner_unavailable'];

/** Seeds one managed brain for `phase`, runs only that phase through runCycle, and hands the result (plus anything logged to stderr) to `check`. */
async function runPhase(engine: BrainEngine, phase: CyclePhase, entry: Entry, check: (c: Ctx) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-phase-matrix-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `matrix-${randomUUID().slice(0, 8)}`;
  const calls: ChatOpts[] = [];
  __setChatTransportForTests(async opts => {
    calls.push(opts);
    const out = entry.reply?.(opts, calls.length) ?? '{}';
    return typeof out === 'string' ? reply(out, opts.model) : { ...reply('', opts.model), ...out };
  });
  const expand = (values: Record<string, string> = {}) => Object.entries(values).map(([k, v]) => [k, v.replace('{root}', root)] as const);
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), ...KEYS, ...Object.fromEntries(expand(entry.env)) }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      for (const [key, value] of expand(entry.config)) await engine.setConfig(key, value);
      await claimWorktree(engine, sourceId, root);
      await entry.seed?.({ engine, sourceId, root });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      since = Number((await engine.executeRaw<{ s: string }>('SELECT COALESCE(max(sequence),0)::text AS s FROM persistence_requests'))[0].s);
      const logged: string[] = [];
      const { error, warn } = console;
      const write = process.stderr.write;
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); error(...args); };
      console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); warn(...args); };
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => { logged.push(String(chunk)); return write.call(process.stderr, chunk, ...rest); }) as typeof write;
      const started = performance.now();
      let report;
      try { report = await runCycle(engine, { brainDir: root, sourceId, phases: [phase], ...entry.cycle }); }
      finally { console.error = error; console.warn = warn; process.stderr.write = write; }
      const result = report.phases.find(p => p.phase === phase)!;
      const ms = Math.round(performance.now() - started);
      const requests = await engine.executeRaw<{ state: string; operation: string; slug: string; error_code: string | null }>(
        'SELECT state,operation,slug,error_code FROM persistence_requests WHERE sequence>$1 ORDER BY sequence', [since]);
      timings.push(`  ${phase.padEnd(28)} ${String(ms).padStart(6)}  ${result.status}, ${requests.length} coordinated request(s): ${result.summary.slice(0, 110)}`);
      expect(requests.filter(r => r.state !== 'committed')).toEqual([]);
      await check({ engine, sourceId, root, result, calls, logs: logged.join('\n') });
    });
  } finally {
    __setChatTransportForTests(null);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const key of Object.keys(entry.config ?? {})) await engine.executeRaw('DELETE FROM config WHERE key=$1', [key]);
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw("DELETE FROM pages WHERE source_id='default'");
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const phase of ALL_PHASES) {
  for (const backend of backends) {
    const klass = MANAGED_PHASE_TABLE[phase];
    test(`${phase} on a managed ${backend} brain: ${klass?.class ?? 'unclassified'}`, async () => {
      expect(klass).toBeDefined();
      const entry = MATRIX[phase];
      await runPhase(engines[backends.indexOf(backend)], phase, entry, async ctx => {
        const { result } = ctx;
        if (klass.class === 'managed_skip') {
          expect(result.status).toBe('skipped');
          expect(JSON.stringify(result)).toContain(klass.reason);
          return;
        }
        expect({ status: result.status, contained: result.details?.contained === true, error: result.error })
          .toMatchObject({ status: expect.not.stringMatching(/^fail$/), contained: false });
        for (const refusal of REFUSALS) {
          expect(JSON.stringify(result)).not.toContain(refusal);
          expect(ctx.logs).not.toContain(refusal);
        }
        if (klass.class === 'writes') expect(entry.assert).toBeDefined();
        await entry.assert?.(ctx);
      });
    }, 120_000);
  }
}
