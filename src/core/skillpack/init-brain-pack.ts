/**
 * skillpack/init-brain-pack.ts — `gbrain skillpack init-brain-pack` scaffold.
 *
 * Writes a starter brain-resident skillpack into a brain/source repo: skills
 * co-evolved with that brain, versioned in its repo, discovered by any harness
 * that connects (Topology A `sources add` advisory + the `list_brain_skillpack`
 * MCP tool). Distinct from `runInitScaffold` (the registry-pack cathedral with
 * test/e2e/eval trees) — a brain-resident pack lives BESIDE brain content, so
 * the scaffold is lean and the README is the machine-parseable entry point a
 * connecting harness reads.
 *
 * Reuses the refuse-overwrite `applyWritePlan` contract from init-scaffold.ts.
 * Sets `brain_resident: true` and pins `gbrain_min_version` to the EXACT serving
 * version (not major.minor.0) so a pack that depends on a just-shipped op can't
 * silently install on a binary that predates it.
 */

import { applyWritePlan, type WritePlanEntry } from './init-scaffold.ts';
import { SKILLPACK_API_VERSION, type SkillpackManifest } from './manifest-v1.ts';
import { VERSION } from '../../version.ts';

import { join } from 'path';

export interface InitBrainPackOptions {
  /** Brain/source repo root — where skillpack.json + README land. */
  targetDir: string;
  /** Pack name (lowercase kebab; becomes manifest.name). */
  name: string;
  /** Schema pack these skills assume (default "gbrain-base"). */
  schemaPack?: string;
  /** Optional initial skill slug (default: <pack-name>). */
  firstSkillSlug?: string;
  /** Pre-fill author + license + homepage. */
  author?: string;
  license?: string;
  homepage?: string;
  /** Pin gbrain_min_version to this exact version (default: serving VERSION). */
  gbrainVersion?: string;
  /** Dry-run: report intent without writing. */
  dryRun?: boolean;
}

export interface InitBrainPackResult {
  targetDir: string;
  filesWritten: string[];
  filesSkippedExisting: string[];
  manifest: SkillpackManifest;
}

export class InitBrainPackError extends Error {
  constructor(
    message: string,
    public code: 'invalid_name',
  ) {
    super(message);
    this.name = 'InitBrainPackError';
  }
}

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

/** Build the brain-resident pack scaffold. */
export function runInitBrainPack(opts: InitBrainPackOptions): InitBrainPackResult {
  if (!NAME_RE.test(opts.name)) {
    throw new InitBrainPackError(
      `name "${opts.name}" is not lowercase kebab-case (must match ${NAME_RE.source})`,
      'invalid_name',
    );
  }
  const firstSlug = opts.firstSkillSlug ?? opts.name;
  if (!NAME_RE.test(firstSlug)) {
    throw new InitBrainPackError(
      `first-skill slug "${firstSlug}" is not lowercase kebab-case`,
      'invalid_name',
    );
  }
  const schemaPack = opts.schemaPack ?? 'gbrain-base';
  if (!NAME_RE.test(schemaPack)) {
    throw new InitBrainPackError(
      `schema_pack "${schemaPack}" is not lowercase kebab-case`,
      'invalid_name',
    );
  }
  // Pin to the EXACT serving version (#13) so a pack depending on a just-shipped
  // op can't install on an older binary that lacks it.
  const minVersion = opts.gbrainVersion ?? VERSION;

  const manifest: SkillpackManifest = {
    api_version: SKILLPACK_API_VERSION,
    name: opts.name,
    version: '0.1.0',
    description: `(edit me) one-line description of the ${opts.name} brain pack`,
    author: opts.author ?? 'Your Name <you@example.com>',
    license: opts.license ?? 'MIT',
    homepage: opts.homepage ?? `https://github.com/your-user/${opts.name}`,
    gbrain_min_version: minVersion,
    skills: [`skills/${firstSlug}`],
    runbooks: { bootstrap: 'runbooks/bootstrap.md' },
    changelog: 'CHANGELOG.md',
    brain_resident: true,
    schema_pack: schemaPack,
  };

  const dateIso = new Date().toISOString().slice(0, 10);
  const plan: WritePlanEntry[] = [];

  plan.push({
    path: join(opts.targetDir, 'skillpack.json'),
    content: JSON.stringify(manifest, null, 2) + '\n',
  });

  plan.push({
    path: join(opts.targetDir, `skills/${firstSlug}/SKILL.md`),
    content: [
      '---',
      `name: ${firstSlug}`,
      `description: (edit me) one-line description of what ${firstSlug} does for this brain`,
      'mutating: false',
      'triggers:',
      `  - example trigger phrase 1 for ${firstSlug}`,
      `  - example trigger phrase 2 for ${firstSlug}`,
      '# tools: list gbrain ops this skill calls (e.g. [search, put_page]); used by the',
      '# version-skew lint to fail loud if a connecting gbrain lacks them.',
      '---',
      '',
      `# ${firstSlug}`,
      '',
      '(edit me) What this skill does for THIS brain, the conventions it honors, and',
      'the user-facing contract. A harness reads this top-to-bottom when the user',
      'phrasing matches a trigger above.',
      '',
    ].join('\n'),
  });

  const intents = [1, 2, 3, 4, 5].map((n) => ({
    intent: `example phrase ${n} for ${firstSlug}`,
    expected_skill: firstSlug,
  }));
  plan.push({
    path: join(opts.targetDir, `skills/${firstSlug}/routing-eval.jsonl`),
    content: intents.map((x) => JSON.stringify(x)).join('\n') + '\n',
  });

  plan.push({
    path: join(opts.targetDir, 'runbooks/bootstrap.md'),
    content: [
      '# Bootstrap',
      '',
      'Post-scaffold steps. gbrain displays this but does NOT auto-execute.',
      'The harness reads it and walks per-step at its own discretion.',
      '',
      `1. show user: "${opts.name} is installed. Try a trigger phrase from skills/${firstSlug}/SKILL.md."`,
      `2. (edit me) agent: honor the conventions in README.md section 4 before writing.`,
      '',
    ].join('\n'),
  });

  // Machine-parseable README — the 5 stable headings a connecting harness scans.
  plan.push({
    path: join(opts.targetDir, 'README.md'),
    content: [
      `# ${opts.name} (brain-resident skillpack)`,
      '',
      '## 1. What this brain is',
      '',
      '(edit me) One paragraph describing this brain — mirrors `get_brain_identity`.',
      '',
      '## 2. Skills in this pack',
      '',
      `- \`${firstSlug}\` — (edit me) one-line description (when to use it; any schema/version assumptions)`,
      '',
      '## 3. Install',
      '',
      'Ask the user first, then:',
      '',
      '```bash',
      `gbrain skillpack scaffold <this-repo>`,
      '```',
      '',
      '## 4. Conventions this brain expects',
      '',
      '(edit me) The operating rules a connecting harness should honor (e.g. "always',
      'search before writing", "meetings propagate to all entity pages").',
      '',
      '## 5. Version compatibility',
      '',
      `- gbrain_min_version: ${minVersion}`,
      `- schema_pack: ${schemaPack}`,
      '',
    ].join('\n'),
  });

  plan.push({
    path: join(opts.targetDir, 'CHANGELOG.md'),
    content: [
      '# Changelog',
      '',
      'All notable changes documented in Keep-a-Changelog shape.',
      '',
      `## [0.1.0] - ${dateIso}`,
      '',
      '- Initial release.',
      '',
    ].join('\n'),
  });

  const { written, skipped } = applyWritePlan(plan, { dryRun: opts.dryRun });

  return {
    targetDir: opts.targetDir,
    filesWritten: written,
    filesSkippedExisting: skipped,
    manifest,
  };
}
