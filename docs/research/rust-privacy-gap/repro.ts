/**
 * Repro: which mirrored BrainEngine reads the REAL Rust addon refuses (engine_capability_missing) under `excludePrivate`,
 * for which caller-access record. Opens a fresh, empty Rust brain (the refusal happens in the TypeScript adapter before the
 * store is read, so no data is needed), calls each member with and without `excludePrivate` inside `withCallerAccess(<record>)`.
 *
 *   cd <gbrain worktree> && source ~/.cargo/env && bun run rust:build   # once
 *   Cell = <plain read> / <read with excludePrivate>. served, or R-option:<capability> (the option itself is not served for any caller),
 *   or R-caller:<capability> (served for the baseline caller, refused for this caller's policy text).
 *   PATH=/var/tmp/bun144/bun-home/bin:$PATH bun /code/.plans/a-evidence/rust-privacy-gap.repro.ts [--markdown]
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const imp = (p: string) => import(join(root, p));
const { loadRustAddon } = await imp('src/core/rust-engine/addon-loader.ts');
const { detectAddonTarget } = await imp('src/core/rust-engine/addon-target.ts');
const { openRustEngine } = await imp('src/core/rust-engine.ts');
const { withCallerAccess } = await imp('src/core/search/private-visibility.ts');

const path = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON ?? join(root, 'rust/target/addon', `gbrain_engine.${detectAddonTarget()}.node`);
if (!existsSync(path)) throw new Error(`no addon at ${path}; run bun run rust:build`);
const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: path } });
const dir = mkdtempSync(join(tmpdir(), 'gbrain-privacy-gap-'));
const engine = openRustEngine({ addon, databasePath: dir });
await engine.connect({ engine: 'pglite', database_path: dir } as never);

const base = { hidePrivate: true, restricted: true, applyRemoteReadPolicy: true };
const CALLERS: Array<[string, Record<string, unknown> | null]> = [
  ['no caller (local CLI)', null],
  ['local owner', { owner: true, hidePrivate: false, restricted: false }],
  ['remote, no member', { ...base }],
  ['remote, source grant only', { ...base, privateReadableSources: ['default'] }],
  ['remote owner', { ...base, identity: ['member:owner-example'], owner: true, ownerReads: true }],
  ['remote member', { ...base, identity: ['member:alice-example'] }],
  ['remote member + private grant', { ...base, identity: ['member:alice-example'], privateReadableSources: ['default'] }],
];
const emb = new Float32Array(1536).fill(0.01);
const P = (o: boolean) => (o ? { excludePrivate: true } : {});
const MEMBERS: Array<[string, (o: boolean) => unknown[]]> = [
  ['getPage', (o) => ['people/alice-example', P(o)]],
  ['listPages', (o) => [{ limit: 5, ...P(o) }]],
  ['findPages', (o) => [{ pattern: { kind: 'prefix', like: 'people/%', lead: 'people/' }, limit: 5, excludeSlugPrefixes: [], ...(o ? { untrusted: { excludePrivate: true } } : {}) }]],
  ['resolveSlugs', (o) => ['alice', P(o)]],
  ['resolveSlugWithAlias', (o) => ['people/alice-example', 'default', P(o)]],
  ['getChunks', (o) => ['people/alice-example', P(o)]],
  ['getLinks', (o) => ['people/alice-example', P(o)]],
  ['getBacklinks', (o) => ['people/alice-example', P(o)]],
  ['getTags', (o) => ['people/alice-example', P(o)]],
  ['getTimeline', (o) => ['people/alice-example', P(o)]],
  ['listFactsByEntity', (o) => ['default', 'people/alice-example', P(o)]],
  ['getStats', () => [{}]],
  ['searchKeyword', (o) => ['widget', { limit: 5, ...P(o) }]],
  ['searchKeywordChunks', (o) => ['widget', { limit: 5, ...P(o) }]],
  ['countKeywordPages', (o) => ['widget', P(o)]],
  ['searchTitles', (o) => ['widget', { limit: 5, ...P(o) }]],
  ['searchVector', (o) => [emb, { limit: 5, ...P(o) }]],
  ['findByTitleFuzzy', () => ['Alice Example']],
  ['searchTakes', (o) => ['widget', { limit: 5, ...P(o) }]],
  ['searchTakesVector', (o) => [emb, { limit: 5, ...P(o) }]],
];

async function run(member: string, args: unknown[], record: Record<string, unknown> | null): Promise<string> {
  const call = () => (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!(...args);
  try { await (record ? withCallerAccess(record as never, call) : call()); return 'served'; } catch (e) {
    const err = e as { code?: string; reason?: string; message?: string };
    if (err.code === 'engine_capability_missing') return `${/\(option /.test(String(err.message)) ? 'R-option' : /for a caller whose/.test(String(err.message)) ? 'R-caller' : 'R-other'}:${err.reason ?? '?'}`;
    return `error(${err.code ?? 'unknown'}): ${String(err.message).slice(0, 80)}`;
  }
}

const markdown = process.argv.includes('--markdown');
const out: string[] = [];
for (const [member, args] of MEMBERS) {
  const cells: string[] = [];
  for (const [, record] of CALLERS) {
    const plain = await run(member, args(false), record);
    const excl = member === 'getStats' || member === 'findByTitleFuzzy' ? '-' : await run(member, args(true), record);
    cells.push(excl === '-' ? plain : `${plain} / ${excl}`);
  }
  out.push(markdown ? `| ${member} | ${cells.join(' | ')} |` : `${member}\n${cells.map((c, i) => `  ${CALLERS[i]![0]}: ${c}`).join('\n')}`);
}
console.log(markdown ? `| member | ${CALLERS.map(([n]) => n).join(' | ')} |\n|---|${CALLERS.map(() => '---').join('|')}|\n${out.join('\n')}` : out.join('\n'));
await engine.disconnect();
rmSync(dir, { recursive: true, force: true });
