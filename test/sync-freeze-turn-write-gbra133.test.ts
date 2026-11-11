/**
 * GBRA-133: a managed sync's freeze runs its Git reads one synchronous child after another, and takes a timer turn between
 * them once a stretch has run its budget (sync-run.ts `freezeEntryOnce`). At such a turn other code in the same process
 * runs: here, a write that commits new bytes for the entry's own path, landing after the freeze read the working-tree
 * bytes and before it re-reads them against HEAD (`headCommittedBytes`). The freeze must keep the pinned content or hold
 * the entry; it never pairs one read's hash with another read's bytes, so it never imports the bytes of the write.
 *
 * The fixture pins a first sync at the commit holding version one, then commits version two at the batch build, before
 * the freeze: the working tree holds a commit past the pin, which the freeze imports as HEAD has it (#6340). Every timer
 * turn the freeze asks for is forced, and at the first one after the working-tree read the test commits version three. The
 * last case commits it instead at the screen's turn after its filter-driver read, which the publication's byte check refuses.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import * as syncDiscovery from '../src/core/persistence/sync-discovery.ts';
import * as syncPageFault from '../src/core/persistence/sync-page-fault.ts';
import * as syncScreen from '../src/core/persistence/sync-screen.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import * as syncYield from '../src/core/persistence/sync-yield.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (version: string) => `---\ntitle: Example\n---\n\nAlpha note, version ${version}.\n`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

afterEach(() => installFaultHook(undefined));

const engines = [{ name: 'pglite', databaseUrl: undefined as string | undefined }, ...(process.env.DATABASE_URL ? [{ name: 'postgres', databaseUrl: process.env.DATABASE_URL }] : [])];

for (const { name, databaseUrl } of engines) describe(`GBRA-133: a write at a freeze's timer turn (${name})`, () => {
  /** Runs the first sync with every freeze turn forced; `interfere` commits version three at the first turn after the working-tree read
   * (`freeze`), or at the screen's turn after its filter-driver read (`screen`). */
  const run = async (interfere: false | 'freeze' | 'screen') => {
    let result: { events: string[]; requests: { content: string | null; raw_hash: string | null; state: string }[]; page: string | null } | undefined;
    await managedBrain(async ({ engine, root }) => {
    const events: string[] = [];
    let readWorking = false, readFilter = false, wrote = false;
    installFaultHook(async point => {
      if (point === 'sync:batch_entries' && !events.includes('v2')) { writeFileSync(join(root, 'a.md'), note('two')); commit(root, 'version two, past the pin'); events.push('v2'); }
    });
    const { readSyncFile } = syncDiscovery, { headCommittedBytes } = syncPageFault, { loopYield } = syncYield, { pinnedFilterDriver } = syncScreen;
    const spies = [
      spyOn(syncDiscovery, 'readSyncFile').mockImplementation(((root: string, path: string) => {
        const bytes = readSyncFile(root, path);
        if (path === 'a.md' && events.includes('v2')) { readWorking = true; events.push('read'); }
        return bytes;
      }) as typeof readSyncFile),
      spyOn(syncPageFault, 'headCommittedBytes').mockImplementation(((...args: Parameters<typeof headCommittedBytes>) => {
        if (args[1] === 'a.md') events.push('head');
        return headCommittedBytes(...args);
      }) as typeof headCommittedBytes),
      spyOn(syncScreen, 'pinnedFilterDriver').mockImplementation(((...args: Parameters<typeof pinnedFilterDriver>) => {
        if (args[1] === 'a.md' && readWorking && !wrote) { readFilter = true; events.push('filter'); }
        return pinnedFilterDriver(...args);
      }) as typeof pinnedFilterDriver),
      spyOn(syncYield, 'loopYield').mockImplementation(() => {
        const step = loopYield();
        return { ...step, over: () => true, pause: async () => {
          if (readWorking && !wrote && (interfere !== 'screen' || readFilter)) { events.push('pause'); if (interfere) { writeFileSync(join(root, 'a.md'), note('three')); commit(root, 'version three, at the freeze turn'); events.push('v3'); } wrote = true; }
          await step.pause();
        } };
      }),
    ];
    try {
      await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true }).catch(error => { events.push(`error:${error?.code ?? error}`); });
    } finally { for (const spy of spies) spy.mockRestore(); installFaultHook(undefined); }
    const requests = await engine.executeRaw<{ content: string | null; raw_hash: string | null; state: string }>(
      "SELECT intent->>'content' AS content, intent->>'rawHash' AS raw_hash, state FROM persistence_requests WHERE source_id='default' AND intent->>'path'='a.md' ORDER BY sequence");
    const page = await engine.getPage('a', { sourceId: 'default' });
    result = { events, requests, page: page?.compiled_truth ?? null };
    }, { databaseUrl, setup: ({ root }) => { git(root, 'init', '-q'); writeFileSync(join(root, 'a.md'), note('one')); commit(root, 'version one'); } });
    return result!;
  };

  test('with no write at the turn, the freeze imports the commit past the pin as HEAD has it', async () => {
    const { events, requests, page } = await run(false);
    expect(events.slice(0, 4)).toEqual(['v2', 'read', 'pause', 'head']);
    expect(requests).toEqual([{ content: note('two'), raw_hash: sha256(note('two')), state: 'committed' }]);
    expect(page).toContain('version two');
  }, 120_000);

  test('a commit of the same path at the turn keeps the pinned content, and only a later freeze imports the new bytes', async () => {
    const { events, requests, page } = await run('freeze');
    expect(events.slice(0, 5)).toEqual(['v2', 'read', 'pause', 'v3', 'head']);
    // The entry frozen across the turn carries the pinned version, never the bytes committed at the turn, and is not published.
    expect(requests[0]).toMatchObject({ content: note('one'), raw_hash: sha256(note('two')) });
    expect(requests[0]!.state).not.toBe('committed');
    // Whatever was published carries the hash of its own bytes.
    const committed = requests.filter(request => request.state === 'committed');
    expect(committed.length).toBeGreaterThan(0);
    for (const request of committed) expect(request.raw_hash).toBe(sha256(request.content!));
    expect(committed.at(-1)!.content).toBe(note('three'));
    expect(page).toContain('version three');
  }, 120_000);

  test('a commit of the same path at the screen\'s turn after its filter-driver read is never published from the frozen request', async () => {
    const { events, requests, page } = await run('screen');
    // The write lands at the turn right after the screen's filter-driver read, once the freeze has read HEAD.
    expect(events.indexOf('head')).toBeGreaterThan(events.indexOf('read'));
    expect(events.indexOf('filter')).toBeGreaterThan(events.indexOf('head'));
    expect(events.slice(events.indexOf('filter'), events.indexOf('filter') + 3)).toEqual(['filter', 'pause', 'v3']);
    // The frozen request keeps the version the freeze read before the turn, with its own hash, and publication refuses it.
    expect(requests[0]).toEqual({ content: note('two'), raw_hash: sha256(note('two')), state: 'conflict' });
    const committed = requests.filter(request => request.state === 'committed');
    expect(committed.length).toBeGreaterThan(0);
    for (const request of committed) expect(request.raw_hash).toBe(sha256(request.content!));
    expect(committed.at(-1)!.content).toBe(note('three'));
    expect(page).toContain('version three');
  }, 120_000);
});
