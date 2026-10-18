/**
 * #6712 PR 3 (L6): one whole managed import of a YC-shaped page, counted.
 *
 * The fixture is a Git checkout bound to a managed source whose first sync
 * imports the code pages half of the page's code references point at (the
 * other half stay missing, as for a guide imported before its code); the
 * measured sync then imports the page through preparation, the publication
 * transaction and its effect queueing. The caller supplies the statement
 * records of the measured sync (PGLite: `countPgliteStatements`; Postgres: the
 * `GBRAIN_SQL_TRACE` file), and `publicationOf` picks out the page's
 * publication transaction (begin..commit on one connection, the one that
 * inserts the page).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { slugifyCodePath } from '../../src/core/sync.ts';
import type { SyncResult } from '../../src/commands/sync.ts';
import { ycCodePath, ycShapedPage, type YcShapedPage } from './yc-shaped-page.ts';
import type { StatementRecord } from './statement-counter.ts';

export const PAGE_SLUG = 'companies/acme-example';
/** Statements whose count grows with the page's rows by design: bounded chunks of a set-based write. */
export const CHUNKED: Array<{ name: string; pattern: RegExp; rowsPerChunk: number; rows: (page: YcShapedPage) => number }> = [
  { name: 'timeline insert', pattern: /^INSERT INTO timeline_entries \(page_id,date,source,summary,detail\) SELECT/, rowsPerChunk: 500, rows: page => page.timeline },
  { name: 'facts insert', pattern: /^INSERT INTO facts \(/, rowsPerChunk: 500, rows: page => page.facts },
];

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
export const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** Builds the checkout and source, imports the code pages, and commits the page; returns the measured sync. */
export async function prepareManagedImport(engine: BrainEngine, home: string, sourceId: string, scale: number): Promise<{ page: YcShapedPage; root: string; run: () => Promise<SyncResult> }> {
  const root = join(home, sourceId);
  mkdirSync(join(root, 'companies'), { recursive: true });
  git(root, 'init', '-q');
  const page = ycShapedPage(scale);
  for (let i = 0; i < page.codeRefs.length; i += 2) {
    writeFileSync(join(root, `${slugifyCodePath(ycCodePath(i))}.md`), `---\ntitle: Module ${i}\n---\nWidget module source notes.\n`);
  }
  commit(root, 'code pages');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const first = await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true });
  if (first.status !== 'first_sync') throw new Error(`code page import ended ${first.status}`);
  writeFileSync(join(root, `${PAGE_SLUG}.md`), page.text);
  commit(root, 'page');
  return { page, root, run: () => performManagedSync(engine, { sourceId, noPull: true, noEmbed: true }) };
}

const isStatement = (record: StatementRecord) => record.kind === 'execute' || record.kind === 'simple';

/** The transaction that inserted the page: its statements in order (begin and commit included). */
export function publicationOf(records: StatementRecord[]): StatementRecord[] {
  const open = new Map<number, StatementRecord[]>();
  for (const record of [...records].sort((a, b) => a.t - b.t)) {
    if (!isStatement(record)) continue;
    const text = flat(record.sql).toLowerCase();
    if (text === 'begin') { open.set(record.conn, [record]); continue; }
    const group = open.get(record.conn);
    if (!group) continue;
    group.push(record);
    if (text !== 'commit' && text !== 'rollback') continue;
    open.delete(record.conn);
    if (text === 'commit' && group.some(r => /^INSERT INTO pages \(/.test(flat(r.sql)))) return group;
  }
  throw new Error('no committed transaction inserted the page');
}

/** Statement counts by normalized text. */
export function byText(records: StatementRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) if (isStatement(record)) counts.set(flat(record.sql), (counts.get(flat(record.sql)) ?? 0) + 1);
  return counts;
}

export const chunkOf = (sql: string) => CHUNKED.find(chunk => chunk.pattern.test(sql));
