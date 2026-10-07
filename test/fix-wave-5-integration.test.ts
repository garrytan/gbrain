/**
 * Fix wave 5 cross-lane journeys (ENG-O14), PGLite here and PostgreSQL through
 * test/e2e/fix-wave-5-integration.test.ts. The mounted-resident journeys
 * (#5237 with #5401 and #5195; #5157 /ingest through a mounted serve) need
 * real serve children and live in test/fix-wave-5-mounted.serial.test.ts.
 * Already covered by lane suites on this branch: #5770 with #5777
 * (journey-atoms-sync-race), #5081 with #5032 (cross-lane-5081-5032) and the
 * preview-helper contract (preview-approval).
 *
 *   1. #5731 restore on an upgraded managed brain with a projection backlog:
 *      the restore publishes, `gbrain projections drain` settles every queued
 *      page, recall and search find the restored fact, and a managed
 *      writeSingleFact for an absent entity stays a separate fact.
 *   2. explicit_only with both real kinds (stale-atoms, extractor-facts) and
 *      their real doctor findings: `repair --all --apply`, the remediation
 *      plan, `doctor --remediate --include-repairs` and the post-upgrade
 *      banner list each with its preview command and never run it.
 *   3. #5558 with the stop hook and session-end: two concurrent sessions and
 *      an older binary's buffer; no hook output carries buffered text, and the
 *      sweep still ingests the captured transcript.
 *   4. #5790 with #5409: a 12,000-file source onboards as a read-only mirror
 *      with a compact manifest; its syncs import database-only and the
 *      checkout stays byte-identical.
 * Only the providers behind the chat transport are simulated; every step
 * goes through the real repair, doctor, drain, hook, sweep, lifecycle and
 * sync entry points.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { operations } from '../src/core/operations.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { extractorFactsCheck } from '../src/commands/doctor/checks/extractor-facts.ts';
import { drainProjections } from '../src/commands/projections.ts';
import { projectionBacklog } from '../src/core/page-state/projections.ts';
import { checkProjectionReadiness } from '../src/commands/doctor/checks/projection-readiness.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { postUpgradeRecoveryBanner } from '../src/commands/doctor/upgrade-banner.ts';
import { runRemediate, runRemediationPlan } from '../src/commands/doctor/remediate.ts';
import { approvedRemediateArgs } from './helpers/remediate-approval.ts';
import { AUTO_REPAIR_REGISTRY } from '../src/core/repair/registry.ts';
import { HOOK_EVENTS, runHook } from '../src/commands/hook.ts';
import { CORPUS_INGESTED_SUFFIX, runMaintenanceSweep } from '../src/core/sweep.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runSources } from '../src/commands/sources.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { worktreeManifest } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { writeLargeWorktree } from './helpers/large-worktree.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { capture } from './helpers/wave-scenarios.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const ENTITY = 'people/alice-example';
const home = mkdtempSync(join(tmpdir(), 'gbrain-fix-wave-5-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const CLAIM = 'Alice Example will send the signed contract by Friday.';
const CHAT = [
  '**Alice Example** (2024-03-15 9:00 AM): I will send the signed contract by Friday, the quokka-ledger draft.',
  '**Bob Demo** (2024-03-15 9:01 AM): Great, thanks.',
].join('\n');

/** Runs `gbrain repair <args> --json` in-process and returns its first result. */
async function repair(engine: BrainEngine, args: string[]) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, [...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as { results: Array<{ apply_command: string; outcomes?: Record<string, number>; residuals: Record<string, number> }>;
    explicit_kinds?: Array<{ kind: string; preview_command: string }> };
}

/** A page row plus its file in the claimed worktree, as a synced page has. */
async function filedPage(engine: BrainEngine, root: string, slug: string, page: { type: string; title: string; compiled_truth: string }) {
  const row = await engine.putPage(slug, page as never, { sourceId: 'default' });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${slug}.md`, row.id]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  mkdirSync(join(root, slug.split('/')[0]), { recursive: true });
  writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
}

/** A real managed write of the page, then the pre-fix projection's effect on its extractor facts in the same transaction. */
async function prefixExpire(engine: BrainEngine, ctx: OperationContext, slug: string): Promise<void> {
  const receipt = await submitPageMutation(ctx, { operation: 'add_timeline_entry',
    params: { request_id: randomUUID(), slug, date: '2026-03-01', summary: 'a pre-fix publication', source: 'operator' } }) as { request_id: string };
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw('UPDATE persistence_requests SET completed_at=now(), consumer_version=NULL WHERE request_id=$1::uuid', [receipt.request_id]);
    await tx.executeRaw(`UPDATE facts SET expired_at=now(), row_num=NULL WHERE source_id='default' AND source_markdown_slug=$1
      AND source LIKE 'cli:extract-conversation-facts%' AND expired_at IS NULL`, [slug]);
  }, TEST_WRITE_ATTRIBUTION));
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#5731 restore with managed writeSingleFact and the #5401 drain (${backend})`, () => {
    test('restore, drain, recall and search find the restored fact; an absent entity stays separate', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const slug = 'conversations/synthetic-chat';
        const extractor = async () => [{ fact: CLAIM, kind: 'commitment' as const, entity_slug: ENTITY,
          confidence: 1, notability: 'high' as const, source: 'test', visibility: 'private' as const }];
        expect((await runExtractConversationFactsCore(engine, { sourceId: 'default', overrideDisabled: true, extractor, types: ['conversation'] })).facts_inserted).toBe(1);
        const [original] = await engine.executeRaw<{ id: number }>("SELECT id::int AS id FROM facts WHERE source_markdown_slug=$1 AND fact=$2", [slug, CLAIM]);
        await prefixExpire(engine, ctx, slug);
        const recall = operations.find(op => op.name === 'recall')!;
        const recalled = async () => (await recall.handler(ctx, { entity: ENTITY }) as { facts: Array<{ fact_id: string }> }).facts.map(f => Number(f.fact_id));
        expect(await recalled()).not.toContain(original.id);

        // The upgrade across v0.51 left every page's text projection queued (the protocol activation backlog); half of it the
        // resident last failed, so it waits out the resident's 30-second retry cooldown and only the drain takes it now.
        await disposePersistenceConsumer(engine);
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
          await tx.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE source_id='default'");
          await tx.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
            SELECT s.incarnation,p.slug,p.knowledge_revision,CASE WHEN p.slug LIKE 'notes/backlog-%' AND right(p.slug,1) IN ('0','2','4','6','8') THEN 'rebuild_failed' ELSE 'protocol_activation' END
            FROM pages p JOIN sources s ON s.id=p.source_id
            WHERE p.source_id='default' AND p.deleted_at IS NULL ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason`);
        }, TEST_WRITE_ATTRIBUTION));
        const queued = (await projectionBacklog(engine)).pending;
        expect(queued).toBe(152);
        const cooling = (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM page_projection_jobs WHERE reason='rebuild_failed'"))[0].n;
        expect(cooling).toBe(75);
        const before = await checkProjectionReadiness(engine);
        expect(before.status).toBe('warn');
        expect(before.message).toContain('Run `gbrain projections drain`');

        const doctor = await extractorFactsCheck(engine);
        expect(doctor.details).toMatchObject({ evidenced: 2, ambiguous: 0 });
        const preview = await repair(engine, ['extractor-facts']);
        const applied = await repair(engine, preview.results[0].apply_command.split(' ').slice(2));
        expect(applied.results[0].outcomes).toEqual({ restored: 1 });
        // The repair CLI exits; its in-process owner may have rebuilt part of the backlog while idle. The drain takes the rest.
        await disposePersistenceConsumer(engine);
        const left = (await projectionBacklog(engine)).pending;
        expect(left).toBeGreaterThanOrEqual(cooling);
        const drained = await drainProjections(engine);
        expect(drained).toMatchObject({ failed: [], remaining: 0 });
        expect(drained.rebuilt + drained.superseded).toBe(left);
        expect(await checkProjectionReadiness(engine)).toMatchObject({ status: 'ok' });
        expect(await engine.executeRaw(`SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL
          AND text_projection_revision IS DISTINCT FROM knowledge_revision`)).toEqual([]);
        expect(await recalled()).toContain(original.id);
        const searched = await recall.handler(ctx, { query: 'quokka-ledger' }) as { results?: Array<{ slug: string }> };
        expect(searched.results?.map(r => r.slug)).toContain(slug);

        const absent = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: 'Carol Absent', kind: 'commitment' });
        expect(absent).toMatchObject({ status: 'inserted', entity_slug: 'carol-absent' });
        expect(absent.id).not.toBe(original.id);
        expect(await recalled()).toContain(original.id);
        expect((await extractorFactsCheck(engine)).status).toBe('ok');
      }, { databaseUrl, setup: async ({ engine, root }) => {
        await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
        await filedPage(engine, root, ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example' });
        await filedPage(engine, root, 'conversations/synthetic-chat', { type: 'conversation', title: 'Synthetic chat', compiled_truth: CHAT });
        for (let i = 0; i < 150; i++) await engine.putPage(`notes/backlog-${i}`, { type: 'note', title: `Backlog ${i}`, compiled_truth: `Backlog note ${i}.` }, { sourceId: 'default' });
      } });
    }, 180_000);
  });

  describe(`explicit_only across repair --all, the remediation plan, remediate and the banner (${backend})`, () => {
    test('both real kinds are listed with their preview command and never run', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        // 30 atoms of a deleted page (stale-atoms, origin_gone) and two expired extractor facts (extractor-facts, ambiguous when unmanaged).
        await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'A page that was deleted.' }, { sourceId: 'default' });
        for (let i = 0; i < 30; i++) {
          await engine.putPage(`atoms/gone/claim-${i}`, { type: 'atom', title: `Claim ${i}`, compiled_truth: `Claim ${i} body.`,
            frontmatter: { source_slug: 'notes/gone', source_hash: 'abcdef0123456789', extracted_at: '2026-09-01T00:00:00Z' } } as never, { sourceId: 'default' });
        }
        await engine.softDeletePage('notes/gone', { sourceId: 'default' });
        await engine.putPage('conversations/expired', { type: 'note', title: 'Expired', compiled_truth: 'Alice: I will send the deck.' }, { sourceId: 'default' });
        for (const fact of ['Alice sends the deck', 'Alice books the venue']) {
          await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, row_num, source_markdown_slug, expired_at)
            VALUES ('default', $1, $2, 'commitment', 'private', 'cli:extract-conversation-facts:sess', 'sess', NULL, 'conversations/expired', now())`, [ENTITY, fact]);
        }
        const liveAtoms = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE type='atom' AND deleted_at IS NULL"))[0].n;
        const activeFacts = async () => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug='conversations/expired' AND expired_at IS NULL"))[0].n;
        const untouched = async () => { expect(await liveAtoms()).toBe(30); expect(await activeFacts()).toBe(0); };
        const previews = { 'google-file-modes': 'gbrain repair google-file-modes', 'stale-atoms': 'gbrain repair stale-atoms', 'extractor-facts': 'gbrain repair extractor-facts',
          'captured-facts': 'gbrain repair captured-facts', 'loop-facts': 'gbrain repair loop-facts', 'ontology-facts': 'gbrain repair ontology-facts', 'orphan-children': 'gbrain repair orphan-children', 'failed-writes': 'gbrain repair failed-writes',
          frontmatter: 'gbrain repair frontmatter', 'timeline-comments': 'gbrain repair timeline-comments' };

        // The post-upgrade banner names both findings with the kind's read-only preview.
        const banner = await postUpgradeRecoveryBanner(engine, 'host');
        expect(banner).toContain('[AGENT]   atom_provenance_drift: 30 (explicit_kind_required; preview with: gbrain repair stale-atoms)');
        expect(banner).toContain('[AGENT]   extractor_facts_expired: 2 (explicit_kind_required; preview with: gbrain repair extractor-facts)');
        expect(banner.join('\n')).not.toMatch(/--apply|--yes/);

        // gbrain repair --all --apply runs every automatic kind, lists the explicit ones and exits 0.
        const all = await capture(() => runRepairCommand(engine, ['--all', '--apply', '--json']));
        const allBody = JSON.parse(all.out) as { results: Array<{ kind: string }>; explicit_kinds: Array<{ kind: string; code: string; preview_command: string }> };
        expect(allBody.results.map(r => r.kind)).toEqual(AUTO_REPAIR_REGISTRY.map(spec => spec.kind));
        expect(allBody.explicit_kinds.map(n => [n.kind, n.code, n.preview_command])).toEqual(Object.entries(previews).map(([kind, cmd]) => [kind, 'explicit_kind_required', cmd]));
        expect(all.exit).toBe(0);
        await untouched();

        // gbrain doctor --remediation-plan lists them apart from the repair steps, with no apply command.
        const plan = JSON.parse((await capture(() => runRemediationPlan(engine, ['--remediation-plan', '--no-embed', '--json']))).out) as {
          repair_steps: Array<{ kind: string; command: string }>; explicit_repairs: Array<{ kind: string; preview_command: string }> };
        expect(plan.repair_steps.map(step => step.kind).filter(kind => kind in previews)).toEqual([]);
        expect(plan.explicit_repairs.map(n => [n.kind, n.preview_command])).toEqual(Object.entries(previews));
        const planText = (await capture(() => runRemediationPlan(engine, ['--remediation-plan', '--no-embed']))).out;
        expect(planText).toContain('  stale-atoms: gbrain repair stale-atoms');
        expect(planText).toContain('  extractor-facts: gbrain repair extractor-facts');
        expect(planText).not.toMatch(/gbrain repair (stale-atoms|extractor-facts) --apply/);

        // gbrain doctor --remediate --include-repairs never runs them; each finding says explicit_kind_required with the preview.
        const run = JSON.parse((await capture(async () => runRemediate(engine, await approvedRemediateArgs(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '0', '--json'])))).out) as {
          repairs?: Array<{ kind: string }>; findings: Array<{ check_id: string; class: string; repair_kind?: string; command?: string }> };
        expect((run.repairs ?? []).map(r => r.kind).filter(kind => kind in previews)).toEqual([]);
        expect(run.findings.filter(f => f.class === 'explicit_kind_required').map(f => [f.check_id, f.repair_kind, f.command])).toEqual([
          ['atom_provenance_drift', 'stale-atoms', previews['stale-atoms']], ['extractor_facts_expired', 'extractor-facts', previews['extractor-facts']]]);
        await untouched();

        // Named, each previews the same set it was listed for.
        expect((await repair(engine, ['stale-atoms'])).results[0].residuals).toEqual({ origin_gone: 30, origin_changed: 0 });
        expect((await repair(engine, ['extractor-facts'])).results[0].residuals).toMatchObject({ evidenced: 0, ambiguous: 2 });
        await untouched();
      } finally { await disposePersistenceConsumer(engine); await close(); }
    }), 240_000);
  });

  describe(`#5558 with the stop hook and session-end capture (${backend})`, () => {
    test('no hook output carries buffered text, and session capture still ingests the transcript', async () => {
      const hookHome = mkdtempSync(join(home, 'hooks-'));
      const ws = join(hookHome, 'ws'), projects = join(hookHome, 'projects'), live = join(hookHome, '.gbrain', 'transcripts', 'live');
      mkdirSync(ws, { recursive: true }); mkdirSync(join(projects, 'p1'), { recursive: true }); mkdirSync(live, { recursive: true });
      const transcript = (id: string, text: string) => {
        const path = join(projects, 'p1', `${id}.jsonl`);
        writeFileSync(path, [JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } }),
          JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `Noted: ${text}` }] } })].join('\n') + '\n');
        return path;
      };
      const secrets = ['session-a-stop-marker', 'session-b-stop-marker', 'older-binary-buffer-marker'];
      // A buffer an older binary left behind for a third session.
      writeFileSync(join(live, 'older.txt'), JSON.stringify({ ts: '2026-09-30T09:00:00Z', session_id: 'older', exchange: secrets[2] }) + '\n');
      const sessions = { 'sess-a': transcript('sess-a', 'I moved the zebra-capture-marker launch to Thursday.'), 'sess-b': transcript('sess-b', 'Unrelated planning for the other agent.') };
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await withEnv({ GBRAIN_HOME: hookHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_HOOKS: undefined,
          GBRAIN_STOP_PUSH: undefined, GBRAIN_MEMORABLE: undefined, CLAUDE_CODE_REMOTE: undefined }, async () => {
          const outputs: Record<string, string> = {};
          const hook = async (event: string, sessionId: string, extra: Record<string, unknown> = {}) => {
            let out = '';
            const code = await runHook([event], { write: (s: string) => { out += s; }, cwd: ws, spawnPush: () => {}, spawnBackupCheck: () => {}, transcriptRoot: projects,
              stdin: JSON.stringify({ session_id: sessionId, cwd: ws, transcript_path: sessions[sessionId as keyof typeof sessions], source: 'resume', ...extra }) });
            expect(code).toBe(0);
            outputs[`${event}:${sessionId}`] = (outputs[`${event}:${sessionId}`] ?? '') + out;
          };
          // Both sessions run concurrently on one host; each stop carries its last assistant message.
          await Promise.all([hook('stop', 'sess-a', { last_assistant_message: secrets[0] }), hook('stop', 'sess-b', { last_assistant_message: secrets[1] })]);
          expect(readdirSync(live)).toEqual(['older.txt']);
          for (const event of HOOK_EVENTS.filter(e => e !== 'session-end')) for (const id of ['sess-b', 'sess-a']) await hook(event, id);
          await hook('session-end', 'sess-a');
          for (const [key, out] of Object.entries(outputs)) {
            for (const secret of secrets) expect(`${key}: ${out}`).not.toContain(secret);
            if (key.endsWith('sess-b')) expect(out).not.toContain('zebra-capture-marker');
          }

          // Session capture: session-end wrote A's transcript to the corpus, and the sweep ingests it.
          const corpus = join(hookHome, '.gbrain', 'transcripts', 'corpus');
          const files = readdirSync(corpus).filter(name => name.endsWith('.txt'));
          expect(files.some(name => name.startsWith('sess-a'))).toBe(true);
          for (const name of files) for (const secret of secrets) expect(readFileSync(join(corpus, name), 'utf8')).not.toContain(secret);
          await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
          const prompts: string[] = [];
          __setChatTransportForTests(async (req: unknown): Promise<ChatResult> => {
            const prompt = JSON.stringify(req);
            prompts.push(prompt);
            const facts = prompt.includes('zebra-capture-marker') ? [{ fact: 'The zebra launch moved to Thursday.', kind: 'event', entity: null, confidence: 1, notability: 'high' }] : [];
            return { text: JSON.stringify({ facts }),
              blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
              model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
          });
          const swept = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: { embeddings: { available: false },
            extraction: { available: true, provider: 'anthropic' }, search: 'keyword-only', mode: 'keyed' } });
          expect(swept.corpusIngested).toBeGreaterThanOrEqual(1);
          expect(prompts.some(prompt => prompt.includes('zebra-capture-marker'))).toBe(true);
          for (const prompt of prompts) for (const secret of secrets) expect(prompt).not.toContain(secret);
          expect(files.filter(name => name.startsWith('sess-a')).every(name => existsSync(join(corpus, name + CORPUS_INGESTED_SUFFIX)))).toBe(true);
          const facts = await engine.executeRaw<{ fact: string }>("SELECT fact FROM facts WHERE fact LIKE '%zebra launch%'");
          expect(facts.length).toBeGreaterThanOrEqual(1);
        });
      } finally { __setChatTransportForTests(null); resetGateway(); await disposePersistenceConsumer(engine); await close(); }
    }, 120_000);
  });

  describe(`#5790 with #5409: a 12k-file read-only mirror (${backend})`, () => {
    test('a 12,000-file source onboards as a read-only mirror; its syncs stay database-only', async () => {
      const mirrorHome = mkdtempSync(join(home, 'mirror-'));
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await withEnv({ GBRAIN_HOME: mirrorHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const id = 'large-mirror', root = join(mirrorHome, 'checkout');
          const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          const commit = (message: string) => { git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
          writeLargeWorktree(root, 12_000);
          writeFileSync(join(root, 'TODOS.md'), '# Todos\n\n- keep the mirror pullable\n');
          mkdirSync(join(root, 'journal'));
          for (const day of ['2026-09-29', '2026-09-30']) writeFileSync(join(root, 'journal', `${day}.md`), `# ${day}\n\nA journal entry without frontmatter.\n`);
          git('init', '-q'); git('config', 'gc.auto', '0'); git('config', 'maintenance.auto', 'false'); commit('upstream');
          const tracked = () => git('status', '--porcelain', '--untracked-files=no');

          await registerLocalWriter(engine, 'cli');
          await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
          expect(await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: id, path: root })).toMatchObject({ state: 'committed' });
          const [manifest] = await engine.executeRaw<{ manifest: Record<string, unknown> | string }>(`SELECT w.manifest FROM persistence_worktrees w
            JOIN persistence_source_bindings b ON b.worktree_id=w.id WHERE b.source_id=$1`, [id]);
          const stored = typeof manifest.manifest === 'string' ? JSON.parse(manifest.manifest) : manifest.manifest;
          expect(stored).toMatchObject({ digest: worktreeManifest(root).digest, file_count: 12_003 });
          expect(stored.files).toBeUndefined();
          const lines: string[] = [];
          const log = console.log;
          console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
          try { await runSources(engine, ['mirror-readonly', id]); } finally { console.log = log; }
          expect(lines.join('\n')).toContain(`Source "${id}" is now a read-only mirror`);

          // The full import costs ~80 ms per file on PGLite (~16 minutes at 12k), so the bulk folder is excluded from import with the
          // operator's own knob; discovery still walks the whole 12k-file tree, and the checkout stays byte-identical throughout.
          await engine.setConfig('sync.exclude', 'notes/');
          const first = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
          await disposePersistenceConsumer(engine);
          expect(first).toMatchObject({ status: 'first_sync' });
          expect(first.failureCodes ?? []).toEqual([]);
          expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [id]))[0].n).toBe(3);
          expect(tracked()).toBe('');
          expect(worktreeManifest(root).digest).toBe(stored.digest);

          // A database-only tag makes the page's canonical form differ from its bytes; an upstream edit then syncs database-only.
          await engine.transaction(tx => withCoordinatedWrite(tx, [id], () => tx.addTag('todos', 'kept-in-brain', { sourceId: id }), TEST_WRITE_ATTRIBUTION));
          writeFileSync(join(root, 'TODOS.md'), '# Todos\n\n- keep the mirror pullable\n- and syncing\n');
          commit('upstream edit');
          const next = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
          await disposePersistenceConsumer(engine);
          expect(next).toMatchObject({ filesImported: 1 });
          expect(tracked()).toBe('');
          expect(readFileSync(join(root, 'TODOS.md'), 'utf8')).not.toContain('kept-in-brain');
          const snapshot = (await engine.readPageSnapshot('todos', { sourceId: id }))!;
          expect(snapshot.page.compiled_truth).toContain('and syncing');
          expect(snapshot.tags).toContain('kept-in-brain');
          const [receipt] = await engine.executeRaw<{ outcome: Record<string, unknown> }>(
            "SELECT outcome FROM persistence_requests WHERE source_id=$1 AND slug='todos' AND state='committed' ORDER BY sequence DESC LIMIT 1", [id]);
          expect(receipt.outcome).toMatchObject({ storage: 'database_only', write_through: { written: false, skipped: 'mirror_read_only' } });
          // The checkout still matches the stored 12k-file manifest, so later lifecycle steps (rebind, transfer) keep their proof.
          git('reset', '-q', '--hard', 'HEAD~1');
          expect(worktreeManifest(root).digest).toBe(stored.digest);
        });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    }, 240_000);
  });
}
