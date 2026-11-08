#!/usr/bin/env bun
/**
 * Build the skill resolver library (src/core/skills/resolver/index.ts) as
 * one dependency-free ES module for Node adapters: the release asset
 * gbrain-skill-resolver.mjs (docs/guides/skill-resolver.md#library).
 *
 * Usage: bun scripts/build-skill-resolver-bundle.ts --out <file.mjs> [--smoke]
 * --smoke imports the bundle with node, builds a catalog from JSON and the
 * bundled catalog in a scratch home, resolves one turn, and exits 1 on any
 * failure.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
if (at < 0 || !args[at + 1]) { console.error('Usage: bun scripts/build-skill-resolver-bundle.ts --out <file.mjs> [--smoke]'); process.exit(2); }
const out = resolve(args[at + 1]!);
const result = await Bun.build({ entrypoints: [join(import.meta.dir, '..', 'src/core/skills/resolver/index.ts')], target: 'node', format: 'esm', outdir: dirname(out), naming: basename(out) });
if (!result.success) { for (const l of result.logs) console.error(l); process.exit(1); }
console.log(`built ${out}`);
if (args.includes('--smoke')) {
  const home = mkdtempSync(join(tmpdir(), 'skres-bundle-'));
  try {
    const probe = join(home, 'probe.mjs');
    writeFileSync(probe, [
      `const m = await import(${JSON.stringify(out)});`,
      `const home = ${JSON.stringify(join(home, 'home'))};`,
      "await m.buildSkillIndex({ catalog: 'c', fromJson: JSON.stringify([{ id: 'x:deploy', name: 'deploy', description: 'Ship a service to production' }]), fromJsonStdin: true }, { home });",
      "const b = await m.buildSkillIndex({ catalog: 'gb', bundled: true }, { home });",
      "const t = await m.resolveSkills({ message: 'deploy the service' }, { home, catalogs: ['c'] });",
      "if (t.output.suggestions[0]?.id !== 'x:deploy' || b.catalog.skill_count < 1) { console.error(JSON.stringify(t.output)); process.exit(1); }",
      "console.log(JSON.stringify({ node: process.version, bundled_skills: b.catalog.skill_count, top: t.output.suggestions[0].id }));",
    ].join('\n'));
    const run = Bun.spawnSync(['node', probe], { stdout: 'pipe', stderr: 'pipe', cwd: home });
    process.stdout.write(run.stdout.toString());
    if (run.exitCode !== 0) { console.error(run.stderr.toString()); process.exit(1); }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
