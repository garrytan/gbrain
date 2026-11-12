/**
 * GST-2519 test helpers: a label repair through the CLI entry (preview, then apply its hash), effect draining that leaves
 * parked effects parked, and what an unbound read key gets of a page over remote MCP dispatch.
 */
import { execFileSync } from 'node:child_process';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runRepairCommand } from '../../src/commands/repair.ts';
import { _resetCliExitVerdictForTests } from '../../src/core/cli-force-exit.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { addMember } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';
import { withEnv } from './with-env.ts';

export const OWNER = 'owner-example';
export const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const commitFiles = (root: string, paths: string[], message: string) => {
  git(root, 'add', '-f', '--', ...paths);
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
};
export const page = (slug: string, canary: string, extra: string[] = []) => ['---', `title: Example ${slug}`, 'type: note', ...extra, 'owner_note: kept', '---', '',
  `Body of ${slug} ${canary}.`, ''].join('\n');

/** `gbrain repair <argv> --json`, previewed and then applied with the preview's hash; the applied result. */
export async function repairApply(engine: BrainEngine, argv: string[]): Promise<{ applied: number; outcome_items?: Array<{ item: string; outcome: string }> }> {
  const run = async (args: string[]) => {
    let out = '';
    const log = console.log;
    console.log = (...parts: unknown[]) => { out += parts.map(String).join(' ') + '\n'; };
    try { await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => runRepairCommand(engine, [...args, '--json'])); } finally { console.log = log; _resetCliExitVerdictForTests(); }
    const parsed = JSON.parse(out);
    return parsed.results?.[0] ?? parsed;
  };
  const preview = await run(argv);
  return run([...argv, '--apply', '--expect', preview.preview_hash]);
}

/** Runs effect passes until no effect of the source is queued or running (parked and failed ones stay as they are). */
export async function drainEffects(engine: BrainEngine, sourceId = 'default'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: localHostId(), limit: 20 });
    if (!(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id=$1 AND state IN ('queued','running')", [sourceId])).length) return;
    await Bun.sleep(50);
  }
  throw new Error('effects still open after 200 passes');
}

export async function labels(engine: BrainEngine, slug: string) {
  const [row] = await engine.executeRaw<{ visibility: string | null; readable_by: unknown; deleted: boolean; content_hash: string }>(`SELECT frontmatter->>'visibility' AS visibility,
    frontmatter->'readable_by' AS readable_by, deleted_at IS NOT NULL AS deleted, content_hash FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
  return row ?? null;
}

/** The brain owner and the named members exist; the readers setter refuses unknown members and lists without the owner. */
export async function seedMembers(engine: BrainEngine, others: string[] = []): Promise<void> {
  for (const id of [OWNER, ...others]) await addMember(engine, id);
  await setOwner(engine, OWNER);
}

/** Whether a read key bound to no member reads `canary` on get_page of `slug` through remote MCP dispatch. */
export async function unboundReads(engine: BrainEngine, slug: string, canary: string): Promise<boolean> {
  __resetPrivateVisibilityCacheForTests();
  const minted = await mintLegacyToken(engine, { name: `unbound-${crypto.randomUUID()}`, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default',
    takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'] });
  return out.content.map(c => c.text).join('\n').includes(canary);
}
