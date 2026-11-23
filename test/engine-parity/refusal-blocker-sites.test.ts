/**
 * BrainEngine parity: command and core sites that read through `executeRaw` inside a try/catch and carried on with a
 * quiet default when a Rust brain refused the statement (the silent-read-catches guard's `capability_refusal_swallowed`
 * rule). Each case runs the real caller on every arm: a Rust brain must answer what PGLite answers, not the default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain eval whoknows` loads its replay rows (loadReplayRows) as the newest 200 captured `query` calls,
 *    newest first, and a Rust brain returns the same rows. `gbrain sync --source <id>` (syncOutOfSearchNotice) says the
 *    source is out of default search only when it holds live pages, its federated setting is unset and it was not added
 *    by a remote caller; a Rust brain gives the same answer. A committed managed `sources add` (addOutcome) reads the
 *    stored federated setting back when its result carries none, and reports what the add means for default search.
 *    `gbrain sources add --kind google` (findDuplicateGoogleSource) warns about an active source that already syncs the
 *    same account for an overlapping slice of services and calendar. `gbrain sources add --url` (addSource, unmanaged
 *    brain) removes the source row it inserted when the clone cannot be moved into place, so a failed add leaves no row.
 *    A segmented page's read-view digests (markdownDigest, readViewLines: page-window/segmented.ts) are the same on every
 *    arm, computed once and read from the cache after on an engine that keeps one.
 *  - Regression: a caller that swallows the Rust refusal returns its quiet default (no rows, no notice), so the
 *    regression gate reports "skipped: 0 replay-eligible rows" for a brain that has them, a sync never mentions that
 *    a source's pages are out of default search, an add never says its source stays out of default search and the
 *    duplicate-Google-account warning is never given a failed clone move leaves a half-added source row and a segmented page's digest read stops on a typed refusal.
 *  - Why existing coverage misses it: the caller's catch turns the refusal into the default, which no engine-level case
 *    reads.
 *  - Seam: none. Rows come from logEvalCandidate, sources from createSource and pages from putPage; ids and timestamps
 *    are never returned. The clone case puts a `git` stand-in first on PATH that only makes the destination directory
 *    for `git clone` (no network); every other git call goes to the real git.
 */
import { describe, expect } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalCandidateInput } from '../../src/core/types.ts';
import { loadReplayRows } from '../../src/commands/eval-whoknows.ts';
import { syncOutOfSearchNotice } from '../../src/commands/sources-add-next.ts';
import { addOutcome } from '../../src/commands/sources-lifecycle.ts';
import type { ParsedSourceLifecycle } from '../../src/commands/sources-lifecycle-args.ts';
import { findDuplicateGoogleSource } from '../../src/commands/sources.ts';
import { DEFAULT_CALENDAR_ID } from '../../src/core/google/types.ts';
import { addSource, SourceOpError } from '../../src/core/sources-ops.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { openSegmentedBody } from '../../src/core/page-body/read-range.ts';
import { markdownDigest, readViewLines, segmentedMarkdownDocument, segmentedReadDocument } from '../../src/core/page-window/segmented.ts';
import { flipInput, manifestRow, pageMeta, segmentText, stagingInput } from '../helpers/page-body-fixtures.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { withEnv } from '../helpers/with-env.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const CANDIDATE: EvalCandidateInput = {
  tool_name: 'query',
  query: 'who runs acme',
  retrieved_slugs: ['people/alice', 'companies/acme'],
  retrieved_chunk_ids: [],
  source_ids: ['default'],
  expand_enabled: true,
  detail: 'medium',
  detail_resolved: 'high',
  vector_enabled: true,
  expansion_applied: false,
  latency_ms: 42,
  remote: false,
  job_id: null,
  subagent_id: null,
  embedding_column: 'embedding',
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('engine parity: refusal-swallow sites', () => {
  parityTest(
    'eval whoknows replay rows are the newest captured query calls, a search call is not replayed',
    { methods: ['logEvalCandidate'] },
    async (engine) => {
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'first query', retrieved_slugs: ['people/alice'] });
      await delay(20);
      await engine.logEvalCandidate({ ...CANDIDATE, tool_name: 'search', query: 'a search call' });
      await delay(20);
      await engine.logEvalCandidate({ ...CANDIDATE, query: 'second query', retrieved_slugs: [] });
      const rows = await loadReplayRows(engine);
      expect(rows.map((r) => r.query)).toEqual(['second query', 'first query']);
      return rows;
    },
  );

  parityTest(
    'sync names a source with live pages and no federated setting as out of default search; an empty, federated, opted-out or remote-added source gets no notice',
    { methods: ['putPage'] },
    async (engine, backend) => {
      const page = { type: 'note' as never, title: 'A page', compiled_truth: 'Body text.', timeline: '', frontmatter: {} };
      await createSource(engine, backend, 'notes');
      await createSource(engine, backend, 'empty');
      await createSource(engine, backend, 'shared', { federated: true });
      await createSource(engine, backend, 'opted-out', { federated: false });
      await createSource(engine, backend, 'remote-added', { added_by_remote_caller: true });
      for (const id of ['notes', 'shared', 'opted-out', 'remote-added']) await engine.putPage('notes/a-page', page, { sourceId: id });
      const codes: Record<string, string | null> = {};
      for (const id of ['notes', 'empty', 'shared', 'opted-out', 'remote-added', 'unknown']) {
        codes[id] = (await syncOutOfSearchNotice(engine, ['--source', id]))?.code ?? null;
      }
      expect(codes.notes).toBe('source_not_in_default_search');
      return codes;
    },
  );

  parityTest(
    'a committed source add reads the stored federated setting back: an unfederated source gets the out-of-default-search notice, a federated one none',
    { methods: ['putPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'unset-src');
      await createSource(engine, backend, 'fed-src', { federated: true });
      await createSource(engine, backend, 'unfed-src', { federated: false });
      await engine.putPage('notes/a-page', { type: 'note' as never, title: 'A page', compiled_truth: 'Body.', timeline: '', frontmatter: {} }, { sourceId: 'unset-src' });
      const said: string[] = [];
      const quiet = console.error;
      const quietWrite = process.stderr.write;
      console.error = (...line: unknown[]) => { said.push(line.join(' ')); };
      // The notice itself is written on stderr; keep it out of the test log.
      process.stderr.write = (() => true) as typeof process.stderr.write;
      const outcome: Record<string, unknown> = {};
      try {
        for (const id of ['unset-src', 'fed-src', 'unfed-src', 'no-such-src']) {
          const parsed = { operation: 'source_add', params: { options: { id } }, legacyOnly: false, json: true } as ParsedSourceLifecycle;
          const result = await addOutcome({ state: 'committed' }, parsed, engine);
          outcome[id] = ((result.notices as Array<{ code: string }> | undefined) ?? []).map((n) => n.code);
        }
      } finally {
        console.error = quiet;
        process.stderr.write = quietWrite;
      }
      expect(outcome['unfed-src']).toEqual(['source_not_in_default_search']);
      return { outcome, said };
    },
  );

  parityTest(
    'the duplicate Google account preflight finds an active source with the same account and an overlapping service and calendar',
    { methods: ['getSource'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'g-mail', { kind: 'google', g_account: 'ann@example.com', g_services: 'gmail' });
      await createSource(engine, backend, 'g-work-cal', { kind: 'google', g_account: 'ann@example.com', g_services: 'calendar', g_calendar_id: 'work' });
      await createSource(engine, backend, 'g-bob', { kind: 'google', g_account: 'bob@example.com' });
      await createSource(engine, backend, 'g-old', { kind: 'google', g_account: 'cy@example.com' });
      await archiveSource(engine, backend, 'g-old');
      await createSource(engine, backend, 'plain', {});
      expect((await engine.getSource('g-mail'))?.config.kind).toBe('google');
      const find = (account: string, services: string[], calendar = DEFAULT_CALENDAR_ID) => findDuplicateGoogleSource(engine, account, services, calendar);
      const found = {
        gmail: await find('ann@example.com', ['gmail']),
        calendarDefault: await find('ann@example.com', ['calendar']),
        calendarWork: await find('ann@example.com', ['calendar'], 'work'),
        contacts: await find('ann@example.com', ['contacts']),
        allServices: await find('ann@example.com', ['gmail', 'calendar', 'contacts'], 'work'),
        otherAccount: await find('bob@example.com', ['gmail']),
        archived: await find('cy@example.com', ['gmail']),
        nobody: await find('dee@example.com', ['gmail']),
      };
      expect(found.gmail).toEqual({ id: 'g-mail', overlap: 'gmail' });
      return found;
    },
  );

  parityTest(
    'a source add whose clone cannot be moved into place rolls back its source row',
    { methods: ['insertSource', 'getSource'] },
    async (engine) => {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-add-rollback-'));
      const realGit = Bun.which('git') ?? 'git';
      const bin = join(root, 'bin');
      writeFileSync(join(root, 'not-a-directory'), 'a file where the clone parent should be\n');
      Bun.spawnSync(['mkdir', '-p', bin]);
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" clone "*) for last; do :; done; mkdir -p "$last"; exit 0;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
      chmodSync(join(bin, 'git'), 0o755);
      try {
        return await withEnv({ PATH: `${bin}:${process.env.PATH ?? ''}` }, async () => {
          const failure = await addSource(engine, {
            id: 'cloned-src', remoteUrl: 'https://example.test/notes.git', cloneDir: join(root, 'not-a-directory', 'clone'),
          } as never).then(() => null, (e: unknown) => e);
          expect(failure).toBeInstanceOf(SourceOpError);
          const rowAfter = await engine.getSource('cloned-src');
          expect({ code: (failure as SourceOpError).code, rowLeft: rowAfter !== null }).toEqual({ code: 'rename_failed', rowLeft: false });
          return { code: (failure as SourceOpError).code, rowLeft: rowAfter !== null };
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  parityTest(
    'a segmented page answers the same read-view digests the first time and from the cache after',
    { methods: ['createSegmentedPageShell', 'flipBodyGeneration', 'readPageViewDigest', 'writePageViewDigest'] },
    async (engine, backend) => {
      const texts = [segmentText('# Intro\nfirst segment about quillwort\n'), segmentText('## Middle\nsecond segment about heron\n')];
      const pageId = await publishSegmented(engine, texts);
      const body = await openSegmentedBody(engine, { pageId });
      const head = '---\ntitle: Big page\n---\n';
      const digestOf = async () => {
        const doc = await segmentedMarkdownDocument(engine, body, head, 'trusted');
        return markdownDigest(doc, 'rev-1', 'trusted');
      };
      const linesOf = async () => readViewLines(await segmentedReadDocument(engine, body), 'rev-1');
      const first = { digest: await digestOf(), lines: await linesOf() };
      const again = { digest: await digestOf(), lines: await linesOf() };
      expect(again).toEqual(first);
      expect(first.lines).toBeGreaterThan(0);
      // A SQL brain kept the markdown view the first read computed and drops other revisions on a write; the Rust store
      // keeps no cache, so it answers a miss and stores nothing. None of this reaches the answer returned below.
      const markdownKey = { pageId, revision: 'rev-1', view: 'markdown', audience: 'trusted' } as const;
      const cached = await engine.readPageViewDigest(markdownKey);
      await engine.writePageViewDigest({ pageId, revision: 'rev-2', view: 'read', audience: 'remote' }, { total_bytes: 1, total_lines: 1, sha256: null });
      const afterNewRevision = await engine.readPageViewDigest(markdownKey);
      if (backend === 'rust') {
        expect({ cached, afterNewRevision }).toEqual({ cached: null, afterNewRevision: null });
      } else {
        expect({ cached: cached && { ...cached, sha256: cached.sha256 === first.digest.sha256 }, afterNewRevision })
          .toEqual({ cached: { total_bytes: first.digest.total_bytes, total_lines: first.digest.total_lines, sha256: true }, afterNewRevision: null });
      }
      return first;
    },
  );
});

/** Publishes `texts` as generation 1 of notes/big, one manifest row each, and returns the page id. */
async function publishSegmented(engine: BrainEngine, texts: ReturnType<typeof segmentText>[]): Promise<number> {
  const { id: pageId } = await engine.createSegmentedPageShell('notes/big', pageMeta('Big page'), { sourceId: 'default' });
  const occ = await engine.allocateBodyOccurrenceIds(texts.length);
  const staging = stagingInput({ slug: 'notes/big', pageId, mode: 'create' });
  await engine.openBodyStaging(staging);
  await engine.stageSegmentTexts('default', texts, { stagingId: staging.id });
  let byteStart = 0;
  await engine.stageManifestRows(texts.map((text, seq) => {
    const row = manifestRow({ pageId, occurrenceId: occ[seq]!, genFrom: 1, seq, text, byteStart, stagingId: staging.id });
    byteStart += text.body.byteLength;
    return row;
  }));
  await engine.flipBodyGeneration(flipInput(pageId, 0, staging.id, texts));
  await engine.setBodyStagingState(staging.id, 'committed');
  await engine.sealSegmentedPage(pageId);
  return pageId;
}
