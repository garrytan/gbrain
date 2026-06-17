/**
 * skillpack/init-scaffold.ts — `gbrain skillpack init <name>` scaffold.
 *
 * Cathedral default per codex T4 + DX-Round-2: lands a complete 10/10
 * pack tree out of the box. Publisher edits or deletes what they don't
 * need; `gbrain skillpack doctor --quick` on a freshly-init'd pack
 * passes 10/10 immediately.
 *
 * `--minimal` flag drops test/, e2e/, evals/ for power users who
 * explicitly opt out.
 *
 * Refuses to overwrite any existing file — same contract as v0.36's
 * scaffold command.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { SKILLPACK_API_VERSION, type SkillpackManifest } from './manifest-v1.ts';

export interface InitScaffoldOptions {
  /** Target directory (created if missing). Becomes the pack root. */
  targetDir: string;
  /** Pack name (lowercase kebab; becomes manifest.name). */
  name: string;
  /** Skip test/, e2e/, evals/ for power users. */
  minimal?: boolean;
  /** Optional initial skill slug (default: <pack-name>). */
  firstSkillSlug?: string;
  /** Pre-fill author + license + homepage. */
  author?: string;
  license?: string;
  homepage?: string;
  /** Dry-run: report intent without writing. */
  dryRun?: boolean;
}

export interface InitScaffoldResult {
  targetDir: string;
  filesWritten: string[];
  filesSkippedExisting: string[];
  manifest: SkillpackManifest;
}

export class InitScaffoldError extends Error {
  constructor(
    message: string,
    public code: 'invalid_name' | 'target_exists_not_empty',
  ) {
    super(message);
    this.name = 'InitScaffoldError';
  }
}

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

/** Build the cathedral scaffold tree. */
export function runInitScaffold(opts: InitScaffoldOptions): InitScaffoldResult {
  if (!NAME_RE.test(opts.name)) {
    throw new InitScaffoldError(
      `name "${opts.name}" is not lowercase kebab-case (must match ${NAME_RE.source})`,
      'invalid_name',
    );
  }

  const firstSlug = opts.firstSkillSlug ?? opts.name;
  if (!NAME_RE.test(firstSlug)) {
    throw new InitScaffoldError(
      `first-skill slug "${firstSlug}" is not lowercase kebab-case`,
      'invalid_name',
    );
  }

  const manifest: SkillpackManifest = {
    api_version: SKILLPACK_API_VERSION,
    name: opts.name,
    version: '0.1.0',
    description: `(edit me) one-line description of the ${opts.name} skillpack`,
    author: opts.author ?? 'Your Name <you@example.com>',
    license: opts.license ?? 'MIT',
    homepage: opts.homepage ?? `https://github.com/your-user/skillpack-${opts.name}`,
    gbrain_min_version: '0.36.0',
    skills: [`skills/${firstSlug}`],
    runbooks: { bootstrap: 'runbooks/bootstrap.md' },
    changelog: 'CHANGELOG.md',
  };

  if (!opts.minimal) {
    manifest.unit_tests = ['test/**/*.test.ts'];
    manifest.e2e_tests = ['e2e/**/*.test.ts'];
    manifest.llm_evals = ['evals/*.judge.json'];
    manifest.routing_evals = [`skills/${firstSlug}/routing-eval.jsonl`];
  } else {
    manifest.routing_evals = [`skills/${firstSlug}/routing-eval.jsonl`];
  }

  // Plan the writes.
  const plan: Array<{ path: string; content: string }> = [];
  const dateIso = new Date().toISOString().slice(0, 10);

  plan.push({
    path: join(opts.targetDir, 'skillpack.json'),
    content: JSON.stringify(manifest, null, 2) + '\n',
  });

  plan.push({
    path: join(opts.targetDir, `skills/${firstSlug}/SKILL.md`),
    content: [
      '---',
      `name: ${firstSlug}`,
      `description: (edit me) one-line description of what ${firstSlug} does`,
      'mutating: false',
      'triggers:',
      `  - example trigger phrase 1 for ${firstSlug}`,
      `  - example trigger phrase 2 for ${firstSlug}`,
      '---',
      '',
      `# ${firstSlug}`,
      '',
      '(edit me) Markdown body describing what the skill does, what tools it uses,',
      'and the user-facing contract. Agents read this top-to-bottom when the user',
      'phrasing matches one of the `triggers:` above.',
      '',
    ].join('\n'),
  });

  // 5 routing-eval intents to clear dimension 3.
  const intents = [
    { intent: `example phrase 1 for ${firstSlug}`, expected_skill: firstSlug },
    { intent: `example phrase 2 for ${firstSlug}`, expected_skill: firstSlug },
    { intent: `example phrase 3 for ${firstSlug}`, expected_skill: firstSlug },
    { intent: `example phrase 4 for ${firstSlug}`, expected_skill: firstSlug },
    { intent: `example phrase 5 for ${firstSlug}`, expected_skill: firstSlug },
  ];
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
      'The agent reads it and walks per-step at its own discretion.',
      '',
      `1. show user: "${opts.name} is installed. Try one of the trigger phrases from skills/${firstSlug}/SKILL.md."`,
      `2. (edit me) agent: gbrain put_page wiki/_${opts.name}-config --frontmatter type=config`,
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

  plan.push({
    path: join(opts.targetDir, 'README.md'),
    content: [
      `# ${opts.name}`,
      '',
      `${manifest.description}`,
      '',
      '## Install',
      '',
      '```bash',
      `gbrain skillpack scaffold your-user/skillpack-${opts.name}`,
      '```',
      '',
      '## What it does',
      '',
      '(edit me) Explain what the pack adds to the user\'s agent.',
      '',
      '## Skills',
      '',
      `- \`skills/${firstSlug}/\` — (edit me) one-line description`,
      '',
    ].join('\n'),
  });

  plan.push({
    path: join(opts.targetDir, 'LICENSE'),
    content: `${manifest.license} License\n\n(edit me) Replace with the full license text matching the SPDX id above.\n`,
  });

  plan.push({
    path: join(opts.targetDir, '.gitignore'),
    content: ['node_modules/', '.DS_Store', '*.tgz', ''].join('\n'),
  });

  if (!opts.minimal) {
    plan.push({
      path: join(opts.targetDir, 'test/example.test.ts'),
      content: [
        "import { describe, test, expect } from 'bun:test';",
        '',
        "describe('example unit test', () => {",
        "  test('placeholder — replace with real assertions', () => {",
        "    expect(1 + 1).toBe(2);",
        "  });",
        '});',
        '',
      ].join('\n'),
    });

    plan.push({
      path: join(opts.targetDir, 'e2e/example.e2e.test.ts'),
      content: [
        "import { describe, test, expect } from 'bun:test';",
        '',
        "describe.skipIf(!process.env.DATABASE_URL)('example E2E test', () => {",
        "  test('placeholder — replace with a real integration scenario', () => {",
        "    expect(process.env.DATABASE_URL).toBeDefined();",
        "  });",
        '});',
        '',
      ].join('\n'),
    });

    plan.push({
      path: join(opts.targetDir, `evals/${opts.name}.judge.json`),
      content:
        JSON.stringify(
          {
            task: `(edit me) Describe the task this LLM-judge eval scores ${opts.name} against.`,
            output: '{{output-from-skill}}',
            cases: [
              { name: 'happy path', criteria: 'output satisfies the task' },
              { name: 'edge case', criteria: 'output handles a corner input gracefully' },
              { name: 'failure mode', criteria: 'output refuses gracefully on ambiguous input' },
            ],
          },
          null,
          2,
        ) + '\n',
    });
  }

  // Apply plan.
  const written: string[] = [];
  const skipped: string[] = [];
  for (const p of plan) {
    if (existsSync(p.path)) {
      skipped.push(p.path);
      continue;
    }
    if (!opts.dryRun) {
      mkdirSync(join(p.path, '..'), { recursive: true });
      writeFileSync(p.path, p.content);
    }
    written.push(p.path);
  }

  return {
    targetDir: opts.targetDir,
    filesWritten: written,
    filesSkippedExisting: skipped,
    manifest,
  };
}
