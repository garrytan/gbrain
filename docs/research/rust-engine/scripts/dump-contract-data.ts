// Regenerates docs/research/rust-engine/data/ from a TypeScript gbrain checkout.
// It lives under docs/ on purpose: it is research tooling, not part of the build,
// and tsconfig does not include docs/.
//
// Usage (from any directory, with the gbrain checkout's deps installed):
//   bun docs/research/rust-engine/scripts/dump-contract-data.ts <path-to-gbrain> docs/research/rust-engine/data
//
// It only imports handler-free modules (operation manifest, tool-defs, surface,
// callable). It never opens a brain and never writes inside the gbrain checkout.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const out = resolve(process.argv[3] ?? 'docs/research/rust-engine/data');
if (!process.argv[2]) throw new Error('usage: dump-contract-data.ts <gbrain-root> [out-dir]');
mkdirSync(out, { recursive: true });

const { OPERATION_MANIFEST } = await import(root + '/src/core/operation-manifest.generated.ts');
const { buildToolDefs } = await import(root + '/src/mcp/tool-defs.ts');
const { filterOpsForSurface, STARTER_OPS, isReadOnlyOperation } = await import(root + '/src/mcp/surface.ts');
const ops = OPERATION_MANIFEST as any[];
const w = (name: string, body: string) => writeFileSync(`${out}/${name}`, body.endsWith('\n') ? body : body + '\n');

// 1. Full handler-free operation metadata, registry order (= tools/list order).
w('operation-manifest.json', JSON.stringify(ops, null, 2));

// 2. tools/list ceiling for the HTTP transports (not cliOnly, not localOnly), per surface,
//    non-strict and strict (mcp.strict_params = reject).
const httpBase = ops.filter(o => !o.cliOnly && !o.localOnly);
for (const s of ['verbs', 'starter', 'full']) {
  const surfaceOps = filterOpsForSurface(httpBase, s);
  w(`tools-list-${s}.json`, JSON.stringify(buildToolDefs(surfaceOps), null, 2));
  w(`tools-list-${s}-strict.json`, JSON.stringify(buildToolDefs(surfaceOps, { strictParams: true }), null, 2));
  console.log('tools-list-%s', s, surfaceOps.length);
}

// 3. One row per operation.
const cols = ['name', 'cli', 'aliases', 'scope', 'mutating', 'localOnly', 'cliOnly', 'verb', 'starter', 'publishGate', 'area', 'hidden', 'readonly'];
const rows = ops.map(o => [
  o.name, o.cliHints?.name ?? '', (o.cliHints?.aliases ?? []).join(','), o.scope ?? '',
  o.mutating ? 'mut' : '', o.localOnly ? 'localOnly' : '', o.cliOnly ? 'cliOnly' : '',
  o.verb ? 'verb' : '', STARTER_OPS.has(o.name) ? 'starter' : '', o.publishGateKey ?? '',
  o.area ?? '', o.cliHints?.hidden ? 'hidden' : '', isReadOnlyOperation(o) ? 'ro' : 'rw',
].join('\t'));
w('ops-summary.tsv', cols.join('\t') + '\n' + rows.join('\n'));

// 4. Flattened views of the CI-enforced public surface manifest.
const ps = JSON.parse(readFileSync(root + '/docs/contracts/public-surface.json', 'utf8'));
const flags = new Map<string, string[]>();
for (const f of ps['cli-flag'] as string[]) {
  const p = f.split(' ');
  const k = p.slice(1, -1).join(' ');
  flags.set(k, [...(flags.get(k) ?? []), p[p.length - 1]!]);
}
w('cli-commands-and-flags.txt', (ps['cli-command'] as string[]).map(c => {
  const k = c.replace(/^gbrain /, '');
  return `${k}: ${(flags.get(k) ?? []).join(' ')}`;
}).join('\n'));
const params = new Map<string, string[]>();
for (const p of ps['mcp-param'] as string[]) {
  const i = p.indexOf('.');
  params.set(p.slice(0, i), [...(params.get(p.slice(0, i)) ?? []), p.slice(i + 1)]);
}
w('mcp-tools-and-params.txt', (ps['mcp-tool'] as string[]).map(t => `${t}: ${(params.get(t) ?? []).join(' ')}`).join('\n'));
w('exit-codes.txt', Object.entries(ps['exit-code'] as Record<string, number>).map(([k, v]) => `${k} ${v}`).join('\n'));
w('config-keys.txt', (ps['config-key'] as string[]).join('\n'));
console.log('operations', ops.length, 'cli-commands', ps['cli-command'].length, 'mcp-tools', ps['mcp-tool'].length);
