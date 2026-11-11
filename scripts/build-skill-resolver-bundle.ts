#!/usr/bin/env bun
/**
 * Build the skill resolver library (src/core/skills/resolver/index.ts) as
 * one dependency-free ES module for Node adapters: the release asset
 * gbrain-skill-resolver.mjs and its .sha256 (docs/guides/skill-resolver.md#library).
 * Same builder as `gbrain skills library` (src/commands/skill-resolver-library.ts).
 *
 * Usage: bun scripts/build-skill-resolver-bundle.ts --out <file.mjs> [--smoke]
 * Writes <file.mjs>.sha256 beside it (sha256sum format). --smoke imports the
 * bundle with node, builds a catalog from JSON and the bundled catalog in a
 * scratch home, resolves one turn, and exits 1 on any failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildResolverLibrary } from '../src/commands/skill-resolver-library.ts';
import { VERSION } from '../src/version.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
if (at < 0 || !args[at + 1]) { console.error('Usage: bun scripts/build-skill-resolver-bundle.ts --out <file.mjs> [--smoke]'); process.exit(2); }
const out = resolve(args[at + 1]!);
const built = await buildResolverLibrary(out);
writeFileSync(`${out}.sha256`, `${built.sha256}  ${basename(out)}\n`);
console.log(`built ${out} sha256 ${built.sha256}`);
if (args.includes('--smoke')) {
  const home = mkdtempSync(join(tmpdir(), 'skres-bundle-'));
  try {
    const probe = join(home, 'probe.mjs');
    writeFileSync(probe, [
      `const m = await import(${JSON.stringify(out)});`,
      `const home = ${JSON.stringify(join(home, 'home'))};`,
      "await m.buildSkillIndex({ catalog: 'c', fromJson: JSON.stringify([{ id: 'x:deploy', name: 'deploy', description: 'Ship a service to production' }]), fromJsonStdin: true }, { home });",
      "const b = await m.buildSkillIndex({ catalog: 'gb', bundled: true }, { home });",
      "const t = await m.resolveSkills({ message: 'deploy the service', session_id: 's1' }, { home, catalogs: ['c'] });",
      "if (t.output.suggestions[0]?.id !== 'x:deploy' || t.output.suggestions[0]?.match_strength !== 'name' || b.catalog.skill_count < 1) { console.error(JSON.stringify(t.output)); process.exit(1); }",
      "if (!(await m.commitSessionAsync(home, t.pending.key, t.pending.delta))) { console.error('commitSessionAsync did not commit'); process.exit(1); }",
      `if (m.GBRAIN_VERSION !== ${JSON.stringify(VERSION)}) { console.error('GBRAIN_VERSION ' + m.GBRAIN_VERSION); process.exit(1); }`,
      "console.log(JSON.stringify({ node: process.version, gbrain_version: m.GBRAIN_VERSION, bundled_skills: b.catalog.skill_count, top: t.output.suggestions[0].id }));",
    ].join('\n'));
    const run = Bun.spawnSync(['node', probe], { stdout: 'pipe', stderr: 'pipe', cwd: home });
    process.stdout.write(run.stdout.toString());
    if (run.exitCode !== 0) { console.error(run.stderr.toString()); process.exit(1); }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
