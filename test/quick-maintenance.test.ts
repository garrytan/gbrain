/**
 * Quick Maintenance regressions (PMBrain).
 *
 * TEST 1–2: failed files must not empty successful pagesAffected / extract.
 * TEST 3–4: by-mention builds deterministic relations + historical catch-up.
 * TEST 5: embed resume leaves completed embeddings (stale query).
 * TEST 6–7: Full / Meeting phase order unchanged; Quick uses thin entry.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import JSZip from 'jszip';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import { resolveDreamPresetPhases, runDream } from '../src/commands/dream.ts';
import {
  resolveQuickMaintenancePhases,
  runQuickMaintenance,
} from '../src/core/quick-maintenance.ts';
import { ALL_PHASES, DEFAULT_PHASES } from '../src/core/cycle.ts';
import { runByMentionCore } from '../src/commands/extract.ts';
import { withEnv } from './helpers/with-env.ts';

/** Isolate sync-failure JSONL and config home per suite via withEnv. */
function withTestHome<T>(home: string, fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ PMBRAIN_HOME: home, GBRAIN_HOME: home }, fn);
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pmbrain-quick-maint-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email t@t.co', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name t', { cwd: dir, stdio: 'pipe' });
  mkdirSync(join(dir, 'people'), { recursive: true });
  mkdirSync(join(dir, 'companies'), { recursive: true });
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function commitAll(repo: string, message: string): void {
  execSync('git add -A', { cwd: repo, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: repo, stdio: 'pipe' });
}

async function writeDocx(path: string, text: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`,
  );
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
}

function writePdf(path: string, text: string): void {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${escaped.length + 44} >>\nstream\nBT /F1 24 Tf 72 720 Td (${escaped}) Tj ET\nendstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  writeFileSync(path, pdf);
}

function goodPerson(title: string, body = 'body'): string {
  return ['---', `type: person`, `title: ${title}`, '---', '', body, ''].join('\n');
}

function goodNote(title: string, body: string): string {
  return ['---', 'type: note', `title: ${title}`, '---', '', body, ''].join('\n');
}

function badSlugPerson(title: string): string {
  return [
    '---',
    'type: person',
    `title: ${title}`,
    'slug: totally-wrong-slug',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
}

describe('Quick Maintenance phase contracts (TEST 6–7)', () => {
  test('Quick phase order matches legacy preset and stays a subset of ALL_PHASES', () => {
    const quick = resolveQuickMaintenancePhases();
    expect(quick).toEqual(resolveDreamPresetPhases('quick'));
    expect(quick).toEqual([
      'lint',
      'backlinks',
      'sync',
      'extract',
      'extract_facts',
      'resolve_symbol_edges',
      'embed',
      'orphans',
    ]);
    // Ordering source remains ALL_PHASES
    let lastIdx = -1;
    for (const p of quick) {
      const idx = ALL_PHASES.indexOf(p);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  test('Full Dream still uses full ALL_PHASES set', () => {
    expect(resolveDreamPresetPhases('full')).toEqual([...DEFAULT_PHASES]);
  });

  test('Meeting preset phase order unchanged', () => {
    expect(resolveDreamPresetPhases('meeting')).toEqual([
      'synthesize',
      'extract',
      'extract_facts',
      'extract_atoms',
      'resolve_symbol_edges',
      'embed',
    ]);
  });

  test('dream quick entry wires runQuickMaintenance', async () => {
    const source = await Bun.file(new URL('../src/commands/dream.ts', import.meta.url)).text();
    expect(source).toContain("opts.preset === 'quick'");
    expect(source).toContain('runQuickMaintenance');
    expect(source).toContain('../core/quick-maintenance.ts');
  });

  test('Quick leaves deterministic relation catch-up unbounded instead of applying a page or time cap', async () => {
    const quickSource = await Bun.file(new URL('../src/core/quick-maintenance.ts', import.meta.url)).text();
    const cycleSource = await Bun.file(new URL('../src/core/cycle.ts', import.meta.url)).text();
    expect(quickSource).not.toContain('QUICK_BY_MENTION_HISTORICAL_DEFAULT');
    expect(quickSource).not.toContain('QUICK_BY_MENTION_TIME_BUDGET_MS');
    expect(cycleSource).not.toContain('opts.byMentionMaxHistorical ?? 500');
  });
});

describe('sync failure isolation (TEST 1–2)', () => {
  let repo: string;
  let engine: PGLiteEngine;
  let failuresPath: string | null = null;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pmbrain-quick-home-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  beforeEach(async () => {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    repo = makeGitRepo();
    await engine.executeRaw('DELETE FROM links');
    await engine.executeRaw('DELETE FROM timeline_entries');
    await engine.executeRaw('DELETE FROM content_chunks');
    await engine.executeRaw('DELETE FROM pages');
    // Clear sync anchors between cases
    try {
      await engine.setConfig('sync.last_commit', '');
      await engine.setConfig('sync.repo_path', '');
    } catch { /* ignore */ }
  });

  test('TEST 1: historical bad file B + new good file A → pagesAffected includes A', async () => {
    await withTestHome(home, async () => {
      const { performSync } = await import('../src/commands/sync.ts');

      // Baseline first sync
      writeFileSync(join(repo, 'people/alice.md'), goodPerson('Alice Example'));
      commitAll(repo, 'add alice');
      let result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });
      expect(['first_sync', 'synced']).toContain(result.status);
      const anchor = await engine.getConfig('sync.last_commit');
      expect(anchor).toBeTruthy();

      // Bad B blocks; good A still lands in pagesAffected
      writeFileSync(join(repo, 'people/bad-bob.md'), badSlugPerson('Bad Bob'));
      writeFileSync(join(repo, 'notes/good-a.md'), goodNote('Good A', 'Today I researched things.'));
      commitAll(repo, 'add bad B and good A');

      result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });
      expect(result.status).toBe('blocked_by_failures');
      expect(result.failedFiles).toBeGreaterThan(0);
      const affected = result.pagesAffected ?? [];
      expect(affected.some(s => s.includes('good-a') || s.includes('notes/good-a'))).toBe(true);
      expect(await engine.getConfig('sync.last_commit')).toBe(anchor);
      const page = await engine.getPage('notes/good-a')
        ?? await engine.getPage(affected.find(s => s.includes('good')) ?? '');
      expect(page).not.toBeNull();
    });
  }, 60_000);

  test('TEST 2: 20 good + 1 bad → pagesAffected non-empty (not [])', async () => {
    await withTestHome(home, async () => {
      const { performSync } = await import('../src/commands/sync.ts');

      writeFileSync(join(repo, 'people/seed.md'), goodPerson('Seed Person'));
      commitAll(repo, 'seed');
      await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });

      // 20 is enough to prove non-empty isolation without slow imports
      for (let i = 0; i < 20; i++) {
        writeFileSync(
          join(repo, `notes/n${String(i).padStart(3, '0')}.md`),
          goodNote(`Note ${i}`, `Body of note ${i}`),
        );
      }
      writeFileSync(join(repo, 'people/broken.md'), badSlugPerson('Broken'));
      commitAll(repo, '20 good + 1 bad');

      const result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });
      expect(result.status).toBe('blocked_by_failures');
      expect(result.pagesAffected.length).toBeGreaterThan(0);
      expect(result.pagesAffected.length).toBeGreaterThanOrEqual(15);
      expect(result.failedFiles).toBeGreaterThanOrEqual(1);
    });
  }, 60_000);

  test('full sync blocked still returns importedSlugs as pagesAffected', async () => {
    await withTestHome(home, async () => {
      writeFileSync(join(repo, 'people/ok.md'), goodPerson('Ok Person'));
      writeFileSync(join(repo, 'people/bad.md'), badSlugPerson('Bad Person'));
      commitAll(repo, 'mixed first tree');

      await engine.setConfig('sync.last_commit', '');
      await engine.setConfig('sync.repo_path', '');

      const { performSync } = await import('../src/commands/sync.ts');
      const result = await performSync(engine, { repoPath: repo, noPull: true, noEmbed: true, skipLock: true });
      expect(result.status).toBe('blocked_by_failures');
      expect(result.pagesAffected.length).toBeGreaterThan(0);
      expect(result.failedFiles).toBeGreaterThanOrEqual(1);
    });
  }, 60_000);
});

describe('by-mention relations (TEST 3–4)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM links');
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw('DELETE FROM op_checkpoints').catch(() => {});
  });

  test('TEST 3: body mention of existing entities creates mentions links', async () => {
    await engine.putPage('companies/openai', {
      type: 'company',
      title: 'OpenAI',
      compiled_truth: 'AI lab',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('entities/codex', {
      type: 'entity',
      title: 'Codex',
      compiled_truth: 'coding agent',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('notes/today', {
      type: 'note',
      title: 'Today',
      compiled_truth: '今天研究了 OpenAI 的 Codex。',
      timeline: '',
      frontmatter: {},
    });

    const r = await runByMentionCore(engine, { quiet: true });
    expect(r.created).toBeGreaterThanOrEqual(2);
    expect(r.pages).toBeGreaterThan(0);

    const rows = await engine.executeRaw<{ from_slug: string; to_slug: string; ls: string }>(
      `SELECT fp.slug AS from_slug, tp.slug AS to_slug, l.link_source AS ls
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       JOIN pages tp ON tp.id = l.to_page_id
       WHERE l.link_source = 'mentions'`,
    );
    const targets = new Set(rows.map(r => r.to_slug));
    expect(targets.has('companies/openai')).toBe(true);
    expect(targets.has('entities/codex')).toBe(true);
    expect(rows.every(r => r.from_slug === 'notes/today')).toBe(true);
  });

  test('TEST 4: historical catch-up with maxHistoricalPages processes backlog gradually', async () => {
    await engine.putPage('companies/acme-corp', {
      type: 'company',
      title: 'Acme Corp',
      compiled_truth: 'corp',
      timeline: '',
      frontmatter: {},
    });
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`notes/hist-${i}`, {
        type: 'note',
        title: `Hist ${i}`,
        compiled_truth: `We met Acme Corp number ${i}.`,
        timeline: '',
        frontmatter: {},
      });
    }

    const first = await runByMentionCore(engine, {
      quiet: true,
      maxHistoricalPages: 2,
    });
    expect(first.pages).toBeLessThanOrEqual(2);
    expect(first.historicalRemaining).toBeGreaterThan(0);

    const second = await runByMentionCore(engine, {
      quiet: true,
      maxHistoricalPages: 10,
    });
    // Remaining historical should drain (or shrink)
    expect(second.historicalRemaining).toBeLessThan(first.historicalRemaining);

    const links = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM links WHERE link_source = 'mentions'`,
    );
    expect(Number(links[0]?.c ?? 0)).toBeGreaterThan(0);
  });

  test('prioritySlugs re-scan even when already checkpointed', async () => {
    await engine.putPage('companies/acme-corp', {
      type: 'company',
      title: 'Acme Corp',
      compiled_truth: 'corp',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('notes/p1', {
      type: 'note',
      title: 'P1',
      compiled_truth: 'No entity here.',
      timeline: '',
      frontmatter: {},
    });

    await runByMentionCore(engine, { quiet: true, maxHistoricalPages: 100 });
    // Update body to mention entity after first scan
    await engine.putPage('notes/p1', {
      type: 'note',
      title: 'P1',
      compiled_truth: 'Now mentions Acme Corp clearly.',
      timeline: '',
      frontmatter: {},
    });

    const r = await runByMentionCore(engine, {
      quiet: true,
      prioritySlugs: ['notes/p1'],
      maxHistoricalPages: 0,
    });
    expect(r.pages).toBeGreaterThanOrEqual(1);
    const links = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM links WHERE link_source = 'mentions'`,
    );
    expect(Number(links[0]?.c ?? 0)).toBeGreaterThan(0);
  });

  test('Quick time budget always scans priority pages before checkpointing historical backlog', async () => {
    await engine.putPage('companies/acme-corp', {
      type: 'company',
      title: 'Acme Corp',
      compiled_truth: 'corp',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('notes/priority', {
      type: 'note',
      title: 'Priority',
      compiled_truth: 'This changed page mentions Acme Corp.',
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('notes/history', {
      type: 'note',
      title: 'History',
      compiled_truth: 'This historical page also mentions Acme Corp.',
      timeline: '',
      frontmatter: {},
    });

    const result = await runByMentionCore(engine, {
      quiet: true,
      prioritySlugs: ['notes/priority'],
      historicalTimeBudgetMs: 0,
    });

    expect(result.priorityPages).toBe(1);
    expect(result.historicalPages).toBe(0);
    expect(result.historicalRemaining).toBeGreaterThan(0);
    expect(result.timeBudgetReached).toBe(true);
    const checkpointRows = await engine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM page_mention_state s JOIN pages p ON p.id=s.page_id WHERE s.mention_revision=p.knowledge_revision`,
    );
    expect(Number(checkpointRows[0]?.c ?? 0)).toBeGreaterThan(0);
    const links = await engine.executeRaw<{ from_slug: string }>(
      `SELECT fp.slug AS from_slug
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       WHERE l.link_source = 'mentions'`,
    );
    expect(links.some(link => link.from_slug === 'notes/priority')).toBe(true);
    expect(links.some(link => link.from_slug === 'notes/history')).toBe(false);

    const resumed = await runByMentionCore(engine, {
      quiet: true,
      historicalTimeBudgetMs: 30_000,
    });
    expect(resumed.historicalRemaining).toBe(0);
    expect(resumed.historicalPages).toBeGreaterThan(0);
    const resumedLinks = await engine.executeRaw<{ from_slug: string }>(
      `SELECT fp.slug AS from_slug
       FROM links l
       JOIN pages fp ON fp.id = l.from_page_id
       WHERE l.link_source = 'mentions'`,
    );
    expect(resumedLinks.some(link => link.from_slug === 'notes/history')).toBe(true);
  });
});

describe('embed resume semantics (TEST 5)', () => {
  test('embed --stale selects embedding IS NULL (resume-safe, no full restart)', async () => {
    // Contract-level: completed vectors stay written; next Quick only
    // walks NULL embeddings. Full re-embed is not the default path.
    const embedSrc = await Bun.file(new URL('../src/commands/embed.ts', import.meta.url)).text();
    expect(embedSrc).toContain('embedding IS NULL');
    expect(embedSrc).toContain('countStaleChunks');
    expect(embedSrc).toContain('listStaleChunks');
    // Wall-clock budget exits cleanly so partial progress is kept
    expect(embedSrc).toMatch(/wall-clock budget|budgetController|budgetMs/);
    // catch-up removes the cap for full drain when explicitly requested
    expect(embedSrc).toContain('catchUp');
  });
});

describe('runQuickMaintenance orchestration smoke', () => {
  let repo: string;
  let engine: PGLiteEngine;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pmbrain-quick-orch-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('quick run includes extract with by_mention details and keeps full phase list', async () => {
    await withTestHome(home, async () => {
      repo = makeGitRepo();
      writeFileSync(join(repo, 'companies/openai.md'), [
        '---', 'type: company', 'title: OpenAI', '---', '', 'AI company.', '',
      ].join('\n'));
      writeFileSync(join(repo, 'notes/research.md'), goodNote(
        'Research',
        'Today I studied OpenAI carefully.',
      ));
      commitAll(repo, 'seed for quick');

      const report = await runQuickMaintenance(engine, {
        brainDir: repo,
        dryRun: false,
        pull: false,
        byMentionMaxHistorical: 50,
      });

      expect(report.phases.map(p => p.phase)).toEqual([
        'lint',
        'backlinks',
        'sync',
        'extract',
        'extract_facts',
        'resolve_symbol_edges',
        'embed',
        'orphans',
      ]);
      const extract = report.phases.find(p => p.phase === 'extract');
      expect(extract).toBeTruthy();
      expect(extract!.details.by_mention).toBe(true);
      expect(extract!.details.historical_markdown_catch_up).toBe(true);
      // Full Dream phases like synthesize/patterns must not appear
      expect(report.phases.some(p => p.phase === 'synthesize')).toBe(false);
      expect(report.phases.some(p => p.phase === 'patterns')).toBe(false);
    });
  }, 120_000);

  test('quick maintenance leaves deterministic relation catch-up unbounded by default', async () => {
    const quickSource = await Bun.file(new URL('../src/core/quick-maintenance.ts', import.meta.url)).text();
    expect(quickSource).toContain('markdownCatchUpMaxHistorical: opts.markdownCatchUpMaxHistorical');
    expect(quickSource).toContain('byMentionTimeBudgetMs: opts.byMentionTimeBudgetMs');
    expect(quickSource).not.toContain('QUICK_MARKDOWN_CATCH_UP_MAX_HISTORICAL');
    expect(quickSource).not.toContain('QUICK_BY_MENTION_TIME_BUDGET_MS');
  });

  test('quick maintenance syncs committed Office and PDF files for the selected Source', async () => {
    await withTestHome(home, async () => {
      repo = makeGitRepo();
      mkdirSync(join(repo, 'docs'), { recursive: true });
      await writeDocx(join(repo, 'docs', 'proposal.docx'), 'Outputs proposal milestone');
      writePdf(join(repo, 'docs', 'report.pdf'), 'Outputs PDF risk report');
      commitAll(repo, 'add committed documents');

      const sourceId = 'outputs-office-sync';
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, created_at)
         VALUES ($1, 'Outputs', $2, '{}'::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, archived = false`,
        [sourceId, repo],
      );
      const headCommit = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
      // Reproduce the user's screenshot: an older Quick run filtered the
      // documents but still bookmarked HEAD and last_sync_at, leaving 0 pages.
      await engine.executeRaw(
        `UPDATE sources
         SET last_commit = $1, last_sync_at = NOW(), chunker_version = $2
         WHERE id = $3`,
        [headCommit, String(CHUNKER_VERSION), sourceId],
      );

      const report = await runQuickMaintenance(engine, {
        brainDir: repo,
        sourceId,
        dryRun: false,
        pull: false,
      });

      const sync = report.phases.find(phase => phase.phase === 'sync');
      expect(sync?.status).toBe('ok');
      expect(sync?.details.added).toBe(2);

      const docx = await engine.getPage('docs/proposal.docx', { sourceId });
      const pdf = await engine.getPage('docs/report.pdf', { sourceId });
      expect(docx?.frontmatter.source_format).toBe('docx');
      expect(docx?.compiled_truth).toContain('Outputs proposal milestone');
      expect(pdf?.frontmatter.source_format).toBe('pdf');
      expect(pdf?.compiled_truth).toContain('Outputs PDF risk report');

      const secondReport = await runQuickMaintenance(engine, {
        brainDir: repo,
        sourceId,
        dryRun: false,
        pull: false,
      });
      const secondSync = secondReport.phases.find(phase => phase.phase === 'sync');
      expect(secondSync?.details.added).toBe(0);
      expect(secondSync?.details.modified).toBe(0);
    });
  }, 120_000);

  test('quick run keeps database maintenance working when the selected source local_path is stale', async () => {
    await withTestHome(home, async () => {
      const missingPath = join(home, 'moved-away-source');
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, created_at)
         VALUES ('moved-source', 'Moved Source', $1, '{}'::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, archived = false`,
        [missingPath],
      );
      await engine.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, updated_at, created_at)
         VALUES
           ('moved-source', 'notes/kept', 'note', 'Kept', 'Database content remains available.', '', '{}'::jsonb, NOW(), NOW()),
           ('default', 'notes/other', 'note', 'Other', 'A different source page.', '', '{}'::jsonb, NOW(), NOW())
         ON CONFLICT (source_id, slug) DO NOTHING`,
      );

      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`unexpected exit ${code}`);
      }) as never);
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const report = await runDream(engine, [
          '--preset', 'quick', '--source', 'moved-source', '--json',
        ]);
        expect(report).toBeTruthy();
        if (!report) return;

        expect(report.brain_dir).toBeNull();
        expect(report.status).not.toBe('failed');
        for (const phaseName of ['lint', 'backlinks', 'sync'] as const) {
          const phase = report.phases.find(item => item.phase === phaseName);
          expect(phase?.status).toBe('skipped');
          expect(phase?.details?.reason).toBe('no_brain_dir');
        }

        const extract = report.phases.find(item => item.phase === 'extract');
        expect(extract?.details?.filesystem_skipped).toBe(true);
        expect(extract?.details?.by_mention).toBe(true);

        const facts = report.phases.find(item => item.phase === 'extract_facts');
        expect(facts?.status).not.toBe('fail');

        const symbols = report.phases.find(item => item.phase === 'resolve_symbol_edges');
        expect(symbols?.details?.sources_walked).toBe(1);

        const orphans = report.phases.find(item => item.phase === 'orphans');
        expect(orphans?.details?.total_pages).toBe(1);
      } finally {
        exitSpy.mockRestore();
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  }, 120_000);
});

describe('Admin all-Source Quick Maintenance', () => {
  let engine: PGLiteEngine;
  let home: string;
  const repos: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'pmbrain-quick-all-home-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    for (const dir of repos) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('quick --all-sources syncs committed Office/PDF files from every registered Source', async () => {
    await withTestHome(home, async () => {
      const officeRepo = makeGitRepo();
      const pdfRepo = makeGitRepo();
      repos.push(officeRepo, pdfRepo);

      mkdirSync(join(officeRepo, 'docs'), { recursive: true });
      mkdirSync(join(pdfRepo, 'docs'), { recursive: true });
      await writeDocx(join(officeRepo, 'docs', 'proposal.docx'), 'All Source Office milestone');
      writePdf(join(pdfRepo, 'docs', 'report.pdf'), 'All Source PDF risk');
      commitAll(officeRepo, 'add office document');
      commitAll(pdfRepo, 'add pdf document');

      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, created_at)
         VALUES
           ('quick-office', 'Quick Office', $1, '{"federated":true}'::jsonb, NOW()),
           ('quick-pdf', 'Quick PDF', $2, '{"federated":true}'::jsonb, NOW())`,
        [officeRepo, pdfRepo],
      );

      const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`unexpected exit ${code}`);
      }) as never);
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const report = await runDream(engine, ['--preset', 'quick', '--all-sources', '--json']);
        expect(report).toBeTruthy();
        if (!report) return;

        expect(report.status).not.toBe('failed');
        expect(report.totals.pages_synced).toBe(2);
        expect(await engine.getPage('docs/proposal.docx', { sourceId: 'quick-office' })).toBeTruthy();
        expect(await engine.getPage('docs/report.pdf', { sourceId: 'quick-pdf' })).toBeTruthy();
        expect(existsSync(join(officeRepo, 'skills'))).toBe(false);
        expect(existsSync(join(pdfRepo, 'skills'))).toBe(false);
        const sync = report.phases.find(phase => phase.phase === 'sync');
        expect(sync?.details.sources_processed).toBe(3);
      } finally {
        exitSpy.mockRestore();
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  }, 180_000);
});
