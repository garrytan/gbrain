/**
 * Fixtures for the Rust backup tests: a managed Rust home with state a restore must act on, and a forged archive (a
 * snapshot taken straight from the store, with metadata a test may change) for the restore refusals that `backup create`
 * itself would never write.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeInstallReceipt, privateWrite } from '../../src/core/agent-install/state.ts';
import { writeBackupArchive } from '../../src/core/backup/archive.ts';
import { openRustStore, type StoreSnapshotManifest } from '../../src/core/rust-engine/store.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';

export const WRITER = '0b0b0b0b-0000-4000-8000-000000000001';
export const QUEUED_REQUEST = '0a0a0a0a-0000-4000-8000-0000000000a1';
export const CONNECTOR = { kind: 'api', remote_url: 'https://example.invalid/x', credential_cmd: 'pass show x', federated: true, strategy: 'latest' };

export const brainDir = (root: string): string => join(root, '.gbrain', 'brain.rust');

/** A managed home: config, one managed folder with a note, an install receipt. The brain is not opened. */
export function makeHome(root: string): void {
  mkdirSync(join(root, '.gbrain'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'note.md'), '# Private memory\nPreserve this file.\n');
  privateWrite(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: brainDir(root), embedding_disabled: true }));
  writeInstallReceipt({ format_version: 1, installation_id: randomUUID(), root, harness: 'grok-bot', source_id: 'managed',
    database_path: brainDir(root), state: 'ready', initialized: true, adopted: false, managed_paths: ['memory'], owned_files: {},
    native: { skill_id: 'old-skill', routine_id: 'old-routine', verification: 'unverified' }, search_mode_confirmation_required: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
}

/** Seeds the brain at `<root>/.gbrain/brain.rust`: sources, pages with origins, settings, a live job, a local writer, an OAuth client. */
export async function seedBrain(addon: RustAddon, root: string, extra?: (brain: any) => Promise<unknown>): Promise<void> {
  const store = await openRustStore(addon, brainDir(root));
  const b = store.brain;
  try {
    await b.upsertSource({ id: 'managed', name: 'managed', local_path: join(root, 'memory'), config: { federated: false } });
    await b.upsertSource({ id: 'ext', name: 'ext', local_path: '/somewhere/else', config: CONNECTOR });
    await b.putPage('notes/a', { type: 'note', title: 'Alpha note', compiled_truth: 'zebra crossing text', source_path: join(root, 'memory', 'note.md') }, { sourceId: 'managed' });
    await b.putPage('notes/b', { type: 'note', title: 'Beta note', compiled_truth: 'plain text', source_path: '/elsewhere/b.md' }, { sourceId: 'ext' });
    await b.setConfig('autopilot.dream.enabled', 'true');
    await b.admitJob({ maxSpawnDepth: 5, insert: { name: 'work', queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'fixed',
      backoff_delay: 1000, backoff_jitter: 0, on_child_fail: 'fail_parent', remove_on_complete: false, remove_on_fail: false, submission_authority: { version: 1, kind: 'application' } } });
    await b.registerLocalWriter({ id: WRITER, lane: 'cli', credentialHash: 'ab'.repeat(32), grantCeiling: null });
    await b.insertOauthClient({ client_id: 'c1', client_name: 'one', scope: 'read' });
    await extra?.(b);
  } finally { await store.close(); }
}

/** One queued write request, left unfinished: what a busy brain's snapshot often holds. */
export const queueWrite = (b: any): Promise<unknown> =>
  b.admitWrite({ principal: { kind: 'local_cli', id: 'writer-1' }, operation: 'put_page', requestId: QUEUED_REQUEST, slug: 'queued/x', callerIntent: {} });

/**
 * An archive built straight from the store (`snapshotTo`, no census), so a test can hold what `backup create` refuses to
 * write: unfinished requests, a changed store identity. `change` edits the metadata before it is written.
 */
export async function forgeArchive(addon: RustAddon, root: string, output: string, change?: (metadata: Record<string, any>) => void): Promise<StoreSnapshotManifest> {
  const store = await openRustStore(addon, brainDir(root));
  const snapshot = join(root, `.forged-${randomUUID()}`);
  try {
    const manifest = await store.snapshotTo(snapshot, { opId: `forge-${randomUUID()}` });
    const sources = (await store.brain.listAllSources({ includeArchived: true }) as any[]).map(s => ({ id: s.id, incarnation: s.incarnation, local_path: s.local_path,
      managed_relative_path: s.local_path === join(root, 'memory') ? 'memory' : null }));
    const metadata: Record<string, any> = { kind: 'gbrain-rust', created_at: new Date().toISOString(), gbrain_version: 'test', schema_version: manifest.schema_version,
      original_root: root, classification: 'sensitive-full-database-state',
      store: { engine_format_version: manifest.engine_format_version, generation: manifest.generation, brain_id: manifest.brain_id, schema_version: manifest.schema_version,
        snapshot_manifest_sha256: createHash('sha256').update(readFileSync(join(snapshot, 'SNAPSHOT.json'))).digest('hex') },
      sources, managed_paths: ['memory'], installation: null, credential_references: [], omitted: [] };
    change?.(metadata);
    const config = join(snapshot, 'config.json');
    writeFileSync(config, readFileSync(join(root, '.gbrain', 'config.json')));
    await writeBackupArchive(output, metadata, [
      ...['records.redb', 'FORMAT', 'SNAPSHOT.json'].map(name => ({ path: `store/${name}`, file: join(snapshot, name) })),
      { path: 'config.json', file: config }, { path: 'files/memory/note.md', file: join(root, 'memory', 'note.md') },
    ]);
    return manifest;
  } finally { await store.close(); }
}
