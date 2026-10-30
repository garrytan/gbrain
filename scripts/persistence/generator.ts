/**
 * Seeded generator of op-descriptor sequences for the crash robot. A
 * sequence mixes the real write ops across two sources whose slugs overlap,
 * a local CLI principal and one authenticated remote agent per source, stale
 * revisions (competing writers), caller-bound replays and concurrent groups.
 * The irreducible cross-boundary sequences are always present
 * (`crossBoundarySequences`); random sequences add breadth around them.
 */
import { createHash } from 'node:crypto';
import { random } from './harness.ts';
import { CONNECTOR_SLUG, descriptor, type OpArg, type OpDescriptor, type OpKind } from './ops.ts';

export interface GeneratorTopology { sources: string[]; remotes: { name: string; sourceId: string }[]; connector?: string }
/** A schedule: descriptors plus the concurrent groups among them (ids that run together). */
export interface Schedule { seed: number; ops: OpDescriptor[]; groups: string[][]; label: string }

export const SLUGS = ['notes/alpha', 'notes/beta', 'people/pat-example', 'meetings/standup'] as const;

export function requestUuid(seed: number, n: number, salt = ''): string {
  const h = createHash('sha256').update(`${salt}:${seed}:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function pageBody(slug: string, marker: string): string {
  const type = slug.startsWith('people/') ? 'person' : slug.startsWith('meetings/') ? 'meeting' : 'note';
  return `---\ntype: ${type}\ntitle: ${slug}\n---\n\nPage ${slug}.\n\nMarker: ${marker}\n`;
}

class Builder {
  ops: OpDescriptor[] = [];
  groups: string[][] = [];
  private n = 0;
  constructor(readonly seed: number, readonly salt: string) {}
  next(kind: OpKind, actor: string, source: string, args: Record<string, OpArg>, deps: string[] = [], requestId?: string, replayOf?: string): OpDescriptor {
    const id = `${this.salt}${this.n}`;
    const d = descriptor(id, kind, actor, source, args, { requestId: requestId ?? requestUuid(this.seed, this.n, this.salt), deps, replayOf });
    this.n++; this.ops.push(d); return d;
  }
  marker(): string { return `mk-${this.salt}${this.n}`; }
  put(actor: string, source: string, slug: string, revision: OpArg | null = null, deps: string[] = []) {
    return this.next('put_page', actor, source, { slug, content: pageBody(slug, this.marker()), ...(revision === null ? {} : { expected_revision: revision }) }, deps);
  }
  edit(actor: string, source: string, slug: string, revision: OpArg = '$current', deps: string[] = []) {
    return this.next('edit_page', actor, source, { slug, expected_revision: revision, edits: [{ old_text: 'Marker: ', new_text: `Marker: ${this.marker()} ` }] }, deps);
  }
}

/**
 * The irreducible cross-boundary sequences (never cut): withdrawal followed
 * by a stale publication; two sources with overlapping slugs; competing
 * writers on one page; an authority change while effects are pending
 * (writer revoked mid-sequence); sync and connector publish racing a direct
 * write; a full overwrite that drops a page's Facts and takes sections, then
 * the parsed fences coming back. Caller-bound replay runs beside them as its
 * own sequence.
 */
export function crossBoundarySequences(topology: GeneratorTopology, seed = 1): Schedule[] {
  const [a, b] = topology.sources;
  const remoteA = topology.remotes.find(r => r.sourceId === a)!.name;
  const remoteB = topology.remotes.find(r => r.sourceId === b)!.name;
  const out: Schedule[] = [];
  {
    const s = new Builder(seed, 'wd'); const slug = 'people/pat-example';
    const put = s.put('local', a, slug);
    const fact = s.next('remember', 'local', a, { fact: `Pat prefers ${s.marker()}`, entity: slug }, [put.id]);
    s.next('forget', 'local', a, { fact_id: { $ref: fact.id, field: 'fact_id' } }, [fact.id]);
    // Republish the page bytes read before the withdrawal, then delete/restore and re-remember.
    s.next('put_page', 'local', a, { slug, content: '$stale_content', stale_of: fact.id, expected_revision: '$current' }, [fact.id]);
    s.next('put_page', remoteA, a, { slug, content: '$stale_content', stale_of: fact.id, expected_revision: '$current' }, [fact.id]);
    s.next('delete_page', 'local', a, { slug, expected_revision: '$current' }, [put.id]);
    s.next('restore_page', 'local', a, { slug, expected_revision: '$current' }, [put.id]);
    s.next('remember', remoteA, a, { fact: fact.args.fact, entity: slug }, [put.id]);
    out.push({ seed, ops: s.ops, groups: s.groups, label: 'withdrawal_then_stale_publication' });
  }
  {
    const s = new Builder(seed, 'ov');
    const pa = s.put('local', a, 'notes/alpha'); const pb = s.put('local', b, 'notes/alpha');
    s.edit(remoteA, a, 'notes/alpha', '$current', [pa.id]); s.edit(remoteB, b, 'notes/alpha', '$current', [pb.id]);
    // A remote agent naming the other source is refused and writes nothing there.
    s.next('put_page', remoteA, b, { slug: 'notes/alpha', content: pageBody('notes/alpha', s.marker()), expected_revision: '$current' }, [pb.id]);
    const fa = s.next('remember', 'local', a, { fact: `Alpha fact ${s.marker()}`, entity: 'notes/alpha' }, [pa.id]);
    s.next('forget', remoteB, b, { fact_id: { $ref: fa.id, field: 'fact_id' } }, [fa.id]);
    s.next('delete_page', 'local', b, { slug: 'notes/alpha', expected_revision: '$current' }, [pb.id]);
    out.push({ seed, ops: s.ops, groups: s.groups, label: 'overlapping_slugs_two_sources' });
  }
  {
    const s = new Builder(seed, 'cw');
    const p = s.put('local', a, 'notes/beta');
    const e1 = s.edit('local', a, 'notes/beta', { $ref: p.id, field: 'revision' }, [p.id]);
    const e2 = s.edit(remoteA, a, 'notes/beta', { $ref: p.id, field: 'revision' }, [p.id]);
    const e3 = s.put('local', a, 'notes/beta', { $ref: p.id, field: 'revision' }, [p.id]);
    s.groups.push([e1.id, e2.id, e3.id]);
    const t = s.next('takes_add', 'local', a, { slug: 'notes/beta', claim: `Beta claim ${s.marker()}`, kind: 'take', holder: 'world' }, [p.id]);
    const t1 = s.next('takes_supersede', 'local', a, { slug: 'notes/beta', row_num: { $ref: t.id, field: 'row_num' }, claim: `Beta revised ${s.marker()}` }, [t.id]);
    const t2 = s.next('takes_supersede', 'local', a, { slug: 'notes/beta', row_num: { $ref: t.id, field: 'row_num' }, claim: `Beta rival ${s.marker()}` }, [t.id]);
    s.groups.push([t1.id, t2.id]);
    out.push({ seed, ops: s.ops, groups: s.groups, label: 'competing_writers_one_page' });
  }
  {
    const s = new Builder(seed, 'rp');
    const p = s.put(remoteA, a, 'notes/alpha');
    // Same principal, same intent: the same receipt. Same principal, changed intent: idempotency conflict.
    s.next('put_page', remoteA, a, p.args, [p.id], p.requestId, p.id);
    s.next('put_page', remoteA, a, { slug: 'notes/alpha', content: pageBody('notes/alpha', s.marker()) }, [p.id], p.requestId, p.id);
    // Another principal reusing the UUID commits its own request and never sees the original receipt.
    s.next('put_page', remoteB, b, { slug: 'notes/alpha', content: pageBody('notes/alpha', s.marker()) }, [p.id], p.requestId, p.id);
    s.next('put_page', 'local', a, { slug: 'notes/gamma', content: pageBody('notes/gamma', s.marker()) }, [p.id], p.requestId, p.id);
    out.push({ seed, ops: s.ops, groups: s.groups, label: 'caller_bound_replay' });
  }
  {
    const s = new Builder(seed, 'au');
    const p = s.put(remoteA, a, 'meetings/standup');
    s.next('add_timeline_entry', remoteA, a, { slug: 'meetings/standup', date: '2026-09-30', summary: `Standup ${s.marker()}` }, [p.id]);
    s.next('revoke_access', 'local', a, { actor: remoteA }, []);
    s.edit(remoteA, a, 'meetings/standup', '$current', [p.id]);
    s.edit('local', a, 'meetings/standup', '$current', [p.id]);
    out.push({ seed, ops: s.ops, groups: s.groups, label: 'authority_change_pending_effects' });
  }
  if (topology.connector) {
    const s = new Builder(seed, 'sy'); const gh = topology.connector;
    const p = s.put('local', a, 'notes/alpha');
    // A user commits an edit of the page file and syncs while an agent writes the same page.
    const synced = s.next('sync', 'local', a, { slug: 'notes/alpha', content: pageBody('notes/alpha', s.marker()), extra: 24 }, [p.id]);
    const direct = s.edit(remoteA, a, 'notes/alpha', '$current', [p.id]);
    s.groups.push([synced.id, direct.id]);
    s.next('sync', 'local', a, { slug: 'notes/beta', content: pageBody('notes/beta', s.marker()) });
    s.edit('local', a, 'notes/beta', '$current');
    // The connector imports an item, then republishes it while a direct write targets the same page.
    const first = s.next('connector_publish', 'local', gh, { body: `Issue body ${s.marker()}`, updated_at: '2026-09-02T00:00:00Z' });
    const again = s.next('connector_publish', 'local', gh, { body: `Issue body ${s.marker()}`, updated_at: '2026-09-03T00:00:00Z' }, [first.id]);
    const racing = s.next('put_page', 'local', gh, { slug: CONNECTOR_SLUG, content: pageBody(CONNECTOR_SLUG, s.marker()), expected_revision: '$current' }, [first.id]);
    s.groups.push([again.id, racing.id]);
    out.push({ seed, ops: s.ops, groups: s.groups, label: 'sync_and_connector_race_direct_write' });
  }
  {
    const s = new Builder(seed, 'fd'); const slug = 'notes/alpha';
    const p = s.put('local', a, slug);
    s.next('remember', 'local', a, { fact: `Alpha holds ${s.marker()}`, entity: slug }, [p.id]);
    const take = s.next('takes_add', 'local', a, { slug, claim: `Alpha claim ${s.marker()}`, kind: 'take', holder: 'world' }, [p.id]);
    // A full overwrite without the Facts and takes sections holds both fences and keeps their rows (GBRA-161 PR 2, B-5);
    // republishing the bytes read after the take puts the parsed fences back, and the rows must match them again.
    const dropped = s.put('local', a, slug, '$current', [take.id]);
    s.next('takes_supersede', 'local', a, { slug, row_num: { $ref: take.id, field: 'row_num' }, claim: `Alpha revised ${s.marker()}` }, [dropped.id]);
    s.next('put_page', 'local', a, { slug, content: '$stale_content', stale_of: take.id, expected_revision: '$current' }, [dropped.id]);
    out.push({ seed, ops: s.ops, groups: s.groups, label: 'fence_dropped_then_restored' });
  }
  return out;
}

/** A random sequence of `length` ops for `seed`, with concurrent groups of 2-3 ops. */
export function randomSchedule(topology: GeneratorTopology, seed: number, length = 24): Schedule {
  const rand = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const s = new Builder(seed, 'r');
  const created: OpDescriptor[] = []; const facts: OpDescriptor[] = []; const takes: OpDescriptor[] = [];
  const actorFor = (source: string) => rand() < 0.35 ? topology.remotes.find(r => r.sourceId === source)!.name : 'local';
  while (s.ops.length < length) {
    const source = pick(topology.sources); const slug = pick(SLUGS); const actor = actorFor(source);
    const page = created.filter(d => d.source === source && d.args.slug === slug).at(-1);
    const roll = rand();
    if (!page || roll < 0.18) { created.push(s.put(actor, source, slug, page ? '$current' : null)); continue; }
    if (roll < 0.32) { s.edit(actor, source, slug, rand() < 0.25 ? { $ref: page.id, field: 'revision' } : '$current', [page.id]); continue; }
    if (roll < 0.44) { facts.push(s.next('remember', actor, source, { fact: `Fact ${s.marker()} about ${slug}`, entity: slug }, [page.id])); continue; }
    if (roll < 0.52 && facts.length) { const f = pick(facts); s.next('forget', rand() < 0.2 ? actorFor(pick(topology.sources)) : f.actor, f.source, { fact_id: { $ref: f.id, field: 'fact_id' } }, [f.id]); continue; }
    if (roll < 0.60) { takes.push(s.next('takes_add', 'local', source, { slug, claim: `Claim ${s.marker()}`, kind: 'take', holder: 'world' }, [page.id])); continue; }
    if (roll < 0.66 && takes.length) { const t = pick(takes); s.next('takes_supersede', 'local', t.source, { slug: String(t.args.slug), row_num: { $ref: t.id, field: 'row_num' }, claim: `Revised ${s.marker()}` }, [t.id]); continue; }
    if (roll < 0.74) { s.next('add_timeline_entry', actor, source, { slug, date: `2026-09-${String(10 + Math.floor(rand() * 18))}`, summary: `Event ${s.marker()}` }, [page.id]); continue; }
    if (roll < 0.80) { s.next('delete_page', 'local', source, { slug, expected_revision: '$current' }, [page.id]); continue; }
    if (roll < 0.85) { s.next('restore_page', 'local', source, { slug, expected_revision: '$current' }, [page.id]); continue; }
    if (roll < 0.93 && s.ops.length) {
      const prior = pick(s.ops.filter(d => !d.replayOf && !d.kind.startsWith('$')));
      const mode = rand();
      if (mode < 0.4) s.next(prior.kind, prior.actor, prior.source, prior.args, [prior.id], prior.requestId, prior.id);
      else {
        const other = mode < 0.7 ? pick(['local', ...topology.remotes.map(r => r.name)].filter(a => a !== prior.actor)) : prior.actor;
        const otherSource = other === 'local' ? prior.source : topology.remotes.find(r => r.name === other)!.sourceId;
        s.next('put_page', other, otherSource, { slug: 'notes/beta', content: pageBody('notes/beta', s.marker()), expected_revision: '$current' }, [prior.id], prior.requestId, prior.id);
      }
      continue;
    }
    // A concurrent group: two or three writers on one page from the same base revision.
    const width = 2 + Math.floor(rand() * 2); const ids: string[] = [];
    for (let i = 0; i < width && s.ops.length < length; i++) {
      const d = rand() < 0.5 ? s.edit(actorFor(source), source, slug, { $ref: page.id, field: 'revision' }, [page.id])
        : s.next('remember', actorFor(source), source, { fact: `Concurrent ${s.marker()}`, entity: slug }, [page.id]);
      ids.push(d.id);
    }
    if (ids.length > 1) s.groups.push(ids);
  }
  return { seed, ops: s.ops, groups: s.groups, label: `random-${seed}` };
}
