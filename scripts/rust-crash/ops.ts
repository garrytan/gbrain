/**
 * The Rust crash cell's operations (scripts/rust-crash/README.md): a seeded sequence of the write paths a Rust brain
 * serves at the swap (`put_page`, `remember`, `forget`, `sync_brain`, and the facts writes the last three make), run
 * through each operation's registered handler with a real local OperationContext, and the read projection the cell
 * compares between the reopened Rust brain and the PGLite oracle.
 *
 * Every operation is a plain descriptor, so the worker (on Rust) and the oracle (on PGLite) run the same sequence, and an
 * operation that refers to a fact names it by its place among the page's active facts, not by an id.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';

export const SYNC_SOURCE = 'notes';
const PEOPLE = ['people/alice-example', 'people/charlie-example', 'people/dana-example'];
const CLAIMS = [
  'Prefers the window seat', 'Walks to work', 'Leads the budget review', 'Moved to the Lisbon office',
  'Reads every design doc', 'Owns the release checklist', 'Speaks at the spring offsite', 'Mentors two new hires',
  'Prefers written updates', 'Runs the Friday demo', 'Joined the platform team', 'Keeps a public roadmap',
];
const NOTES = ['notes/planning', 'notes/retro', 'notes/hiring', 'notes/roadmap'];

type OpBody =
  | { kind: 'source' }
  | { kind: 'put_page'; slug: string; title: string; body: string }
  | { kind: 'remember'; entity: string; facts: string[]; validFrom: string }
  | { kind: 'forget'; entity: string; pick: number }
  | { kind: 'sync'; files: { slug: string; body: string }[] };
/** An operation with its fixed request id (`requestIdOf`), so the oracle and every run send the same one. */
export type CrashOp = OpBody & { rid: string };

/** A UUID-shaped request id fixed by seed and position. */
export function requestIdOf(seed: number, index: number): string {
  return `00000000-0000-4000-8000-${(seed * 10_000 + index).toString(16).padStart(12, '0')}`;
}

/** A small seeded PRNG (mulberry32), so a seed names the same sequence on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

/**
 * The sequence for `seed`: register the sync source, write each person's page, then `count` seeded operations. A
 * `remember` saves one to three facts in one call, `forget` is chosen only while its page has an active fact, and each
 * `sync` changes one or two files in the checkout and imports them.
 */
export function generate(seed: number, count: number): CrashOp[] {
  const rand = rng(seed);
  const ops: OpBody[] = [{ kind: 'source' }];
  const active = new Map<string, number>();
  const revision = new Map<string, number>();
  const page = (slug: string): OpBody => {
    const n = (revision.get(slug) ?? 0) + 1;
    revision.set(slug, n);
    const name = slug.split('/')[1]!.split('-')[0]!;
    const title = name[0]!.toUpperCase() + name.slice(1);
    return { kind: 'put_page', slug, title, body: `# ${title}\n\n${title} works on widgets, revision ${n} of seed ${seed}.\n\n${pick(rand, CLAIMS)}.\n` };
  };
  for (const slug of PEOPLE) { ops.push(page(slug)); active.set(slug, 0); }
  let minute = 0;
  while (ops.length < count + 1 + PEOPLE.length) {
    const roll = rand();
    const entity = pick(rand, PEOPLE);
    if (roll < 0.25) ops.push(page(entity));
    else if (roll < 0.55) {
      const n = 1 + Math.floor(rand() * 3);
      const facts = Array.from({ length: n }, (_, i) => `${pick(rand, CLAIMS)} (${ops.length}.${i})`);
      ops.push({ kind: 'remember', entity, facts, validFrom: new Date(Date.UTC(2026, 0, 1, 0, minute++)).toISOString() });
      active.set(entity, active.get(entity)! + n);
    } else if (roll < 0.75 && active.get(entity)! > 0) {
      ops.push({ kind: 'forget', entity, pick: Math.floor(rand() * active.get(entity)!) });
      active.set(entity, active.get(entity)! - 1);
    } else {
      const slugs = new Set([pick(rand, NOTES), ...(rand() < 0.5 ? [pick(rand, NOTES)] : [])]);
      ops.push({ kind: 'sync', files: [...slugs].map(slug => {
        const n = (revision.get(slug) ?? 0) + 1;
        revision.set(slug, n);
        return { slug, body: `---\ntitle: ${slug.split('/')[1]}\n---\n# ${slug.split('/')[1]}\n\nRevision ${n} of seed ${seed}: ${pick(rand, CLAIMS)}.\n` };
      }) });
    }
  }
  return ops.map((op, index) => ({ ...op, rid: requestIdOf(seed, index) }));
}

/** Every slug the sequence can write, by source. */
export function slugsOf(ops: readonly CrashOp[]): { sourceId: string; slug: string }[] {
  const out = new Map<string, { sourceId: string; slug: string }>();
  for (const op of ops) {
    if (op.kind === 'put_page') out.set(`default/${op.slug}`, { sourceId: 'default', slug: op.slug });
    if (op.kind === 'sync') for (const f of op.files) out.set(`${SYNC_SOURCE}/${f.slug}`, { sourceId: SYNC_SOURCE, slug: f.slug });
  }
  return [...out.values()].sort((a, b) => `${a.sourceId}/${a.slug}`.localeCompare(`${b.sourceId}/${b.slug}`));
}

export interface OpWorld { engine: BrainEngine; repo: string }

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function context(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind, embedding_disabled: true }, logger: quiet, dryRun: false, remote: false,
    sourceId: 'default' } as unknown as OperationContext;
}

async function call(world: OpWorld, name: string, params: Record<string, unknown>, requestId?: string): Promise<Record<string, unknown>> {
  const result = await operationsByName[name]!.handler(context(world.engine), { request_id: requestId ?? randomUUID(), ...params });
  return (result ?? {}) as Record<string, unknown>;
}

/** Git with a fixed identity and the op's own clock, so the same files give the same commit on every run. */
function git(repo: string, index: number, args: string[]): string {
  const when = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
  return execFileSync('git', ['-C', repo, '-c', 'user.name=crash-cell', '-c', 'user.email=crash-cell@example.invalid', ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: repo, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });
}

/** A new checkout for the sync source, with one committed non-page file (a source path must hold a commit). */
export function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: { PATH: process.env.PATH ?? '', HOME: repo, GIT_CONFIG_NOSYSTEM: '1' } });
  writeFileSync(join(repo, 'README.txt'), 'The crash cell\'s sync checkout.\n');
  git(repo, -1, ['add', '-A']);
  git(repo, -1, ['commit', '-q', '-m', 'checkout']);
}

/**
 * Runs operation `index` of a sequence. It throws when the operation fails or answers anything but a commit. Running a
 * `sync` again is safe: the checkout is committed only when its files changed, and the import is incremental.
 */
export async function runOp(world: OpWorld, op: CrashOp, index: number): Promise<void> {
  switch (op.kind) {
    case 'source':
      await call(world, 'sources_add', { id: SYNC_SOURCE, path: world.repo });
      return;
    case 'put_page': {
      const r = await call(world, 'put_page', { slug: op.slug, force: true, content: `---\ntitle: ${op.title}\ntype: person\n---\n${op.body}` });
      if (r.status !== 'created_or_updated') throw new Error(`put_page ${op.slug} answered ${JSON.stringify(r).slice(0, 300)}`);
      return;
    }
    case 'remember': {
      const items = op.facts.map(fact => ({ fact, entity: op.entity, provenance: 'crash cell', valid_from: op.validFrom }));
      // A batch commits each item on its own (each gets a request id derived from the call's), so a kill can leave part
      // of it; the call's fixed request id makes running it again finish the batch without repeating an item.
      const r = await call(world, 'remember', items.length === 1 ? { ...items[0] } : { items }, op.rid);
      const results = (Array.isArray(r.items) ? r.items : [r]) as Record<string, unknown>[];
      if (results.length !== op.facts.length || results.some(x => x.status !== 'inserted' && x.status !== 'duplicate')) {
        throw new Error(`remember on ${op.entity} answered ${JSON.stringify(r).slice(0, 300)}`);
      }
      return;
    }
    case 'forget': {
      const active = (await world.engine.listFactsForPage('default', op.entity))
        .filter(f => f.expired_at === null).sort((a, b) => Number(a.id) - Number(b.id));
      const target = active[op.pick % Math.max(active.length, 1)];
      if (!target) throw new Error(`forget on ${op.entity}: the page has no active fact`);
      const r = await call(world, 'forget', { id: String(target.id) });
      if (r.expired !== true) throw new Error(`forget of fact ${target.id} answered ${JSON.stringify(r).slice(0, 300)}`);
      return;
    }
    case 'sync': {
      for (const f of op.files) {
        const path = join(world.repo, `${f.slug}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.body);
      }
      git(world.repo, index, ['add', '-A']);
      if (git(world.repo, index, ['status', '--porcelain']).trim() !== '') git(world.repo, index, ['commit', '-q', '-m', `op ${index}`]);
      const r = await call(world, 'sync_brain', { source_id: SYNC_SOURCE, repo: world.repo, no_embed: true });
      if (!['first_sync', 'synced', 'up_to_date'].includes(String(r.status))) throw new Error(`sync answered ${JSON.stringify(r).slice(0, 300)}`);
      return;
    }
  }
}

/**
 * Work the brain still owes: write requests not yet final in the sequence's two sources (a dead writer's accepted
 * requests among them), and queued page projection rebuilds (the chunks a committed write rebuilds after it replies).
 */
export async function pendingWork(engine: BrainEngine): Promise<unknown[]> {
  const pending: unknown[] = (await engine.listQueuedPageProjections({ limit: 100 }))
    .map(p => ({ projection: `${(p as { source_id?: string }).source_id}/${(p as { slug?: string }).slug}` }));
  for (const sourceId of ['default', SYNC_SOURCE]) {
    const r = await call({ engine, repo: '' }, 'list_write_requests', { source_id: sourceId, limit: 100 });
    for (const row of (r.requests ?? []) as { request_id: string; state: string; operation: string; slug: string }[]) {
      if (['queued', 'running', 'recovering'].includes(row.state)) pending.push({ request: row.request_id, state: row.state, operation: row.operation, slug: row.slug });
    }
  }
  return pending;
}

const TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?/g;
const normal = (text: string | null | undefined): string | null => (text == null ? null : text.replace(TIME, '<time>'));

/**
 * What the cell compares: for every slug the sequence can write, the page (title, type, body, timeline, tags), its
 * chunks' text and its facts (claim, kind, visibility, whether expired, whether it has an end date), with times and
 * dates folded out because the two engines write their own clocks. The sync source's last imported commit is compared as it is: commits are
 * deterministic.
 */
export async function project(engine: BrainEngine, ops: readonly CrashOp[]): Promise<unknown> {
  const pages: unknown[] = [];
  for (const { sourceId, slug } of slugsOf(ops)) {
    const page = await engine.getPage(slug, { sourceId });
    if (!page) { pages.push({ sourceId, slug, page: null }); continue; }
    const chunks = (await engine.getChunks(slug, { sourceId })).map(c => normal(c.chunk_text));
    const facts = (await engine.listFactsForPage(sourceId, slug)).sort((a, b) => Number(a.id) - Number(b.id))
      .map(f => ({ fact: f.fact, kind: f.kind, visibility: f.visibility, expired: f.expired_at !== null,
        // The day a forgotten fact ends is each engine's own clock date, so a run that crosses midnight UTC would compare two
        // different days. Only whether the fact has an end date is compared.
        has_end_date: Boolean(f.valid_until) }));
    pages.push({ sourceId, slug, title: page.title, type: page.type, body: normal(page.compiled_truth), timeline: normal(page.timeline),
      tags: await engine.getTags(slug, { sourceId }), chunks, facts });
  }
  const source = await engine.getSource(SYNC_SOURCE);
  return { pages, sync: source ? { last_commit: (source as { last_commit?: string | null }).last_commit ?? null } : null };
}
