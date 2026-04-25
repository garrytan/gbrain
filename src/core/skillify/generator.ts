/**
 * skillify/generator.ts — pure file-tree generator for `gbrain skillify scaffold`.
 *
 * Takes a scaffold spec + target skillsDir and returns the list of
 * files that would be written (dry-run) or writes them (apply).
 *
 * Idempotency contract (D-CX-7): `--force` regenerates STUB files
 * but NEVER re-appends resolver rows if a row for this skill path
 * already exists. The resolver row append is idempotent by content.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import {
  resolverRow,
  routingEvalTemplate,
  scriptTemplate,
  skillMdTemplate,
  testTemplate,
  type ScaffoldVars,
} from './templates.ts';
import { findResolverFile, RESOLVER_FILENAMES_LABEL } from '../resolver-filenames.ts';

export interface ScaffoldPlan {
  files: Array<{ path: string; kind: 'new' | 'overwrite' | 'append'; content: string }>;
  resolverFile: string | null;
  resolverAppend: string | null; // null when row already present (idempotent)
}

export interface ScaffoldOptions {
  /** Absolute path to the target `skills/` dir. */
  skillsDir: string;
  /** Scaffold variables (name, description, triggers, etc.). */
  vars: ScaffoldVars;
  /**
   * Repo root for the `test/` and `scripts/` directories. Falls back
   * to `dirname(skillsDir)` when unset. Tests pass explicit values.
   */
  repoRoot?: string;
  /** When true, overwrite existing skill files. Per-file (D-CX-7). */
  force?: boolean;
}

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class SkillifyScaffoldError extends Error {
  constructor(
    message: string,
    public code:
      | 'invalid_name'
      | 'exists'
      | 'no_resolver'
      | 'write_failed',
  ) {
    super(message);
    this.name = 'SkillifyScaffoldError';
  }
}

/**
 * Build the list of files + the resolver-append string without doing
 * any I/O that writes. Callers can preview via dry-run, then pass the
 * same inputs to `applyScaffold`.
 */
export function planScaffold(opts: ScaffoldOptions): ScaffoldPlan {
  const { vars, skillsDir } = opts;
  if (!SKILL_NAME_PATTERN.test(vars.name)) {
    throw new SkillifyScaffoldError(
      `'${vars.name}' is not a valid skill name. Must be lowercase-kebab-case (examples: webhook-verify, context-now).`,
      'invalid_name',
    );
  }

  const repoRoot = opts.repoRoot ?? dirname(skillsDir);
  const skillDir = join(skillsDir, vars.name);
  const skillMdPath = join(skillDir, 'SKILL.md');
  const scriptPath = join(skillDir, 'scripts', `${vars.name}.mjs`);
  const routingEvalPath = join(skillDir, 'routing-eval.jsonl');
  const testPath = join(repoRoot, 'test', `${vars.name}.test.ts`);

  const files: ScaffoldPlan['files'] = [];

  const want = (path: string, content: string) => {
    if (existsSync(path)) {
      if (!opts.force) {
        throw new SkillifyScaffoldError(
          `'${path}' already exists. Pass --force to regenerate stubs (destructive to any local edits), or edit the file directly.`,
          'exists',
        );
      }
      files.push({ path, kind: 'overwrite', content });
    } else {
      files.push({ path, kind: 'new', content });
    }
  };

  want(skillMdPath, skillMdTemplate(vars));
  want(scriptPath, scriptTemplate(vars));
  want(routingEvalPath, routingEvalTemplate(vars));
  want(testPath, testTemplate(vars));

  // Resolver row — append to whichever file exists; `null` both fields
  // if no resolver exists (caller handles setup error).
  const resolverFile =
    findResolverFile(skillsDir) ?? findResolverFile(dirname(skillsDir));
  let resolverAppend: string | null = null;
  if (resolverFile) {
    const existingRow = detectExistingResolverRow(resolverFile, vars.name);
    if (!existingRow) {
      resolverAppend = buildResolverAppend(resolverFile, vars);
    }
  }

  return { files, resolverFile, resolverAppend };
}

/**
 * Check whether the resolver already has a backtick-wrapped reference
 * to `skills/<name>/SKILL.md`. Idempotency contract (D-CX-7) — if
 * present, we never re-append a row for this skill, even with --force.
 */
function detectExistingResolverRow(resolverFile: string, name: string): boolean {
  let content: string;
  try {
    content = readFileSync(resolverFile, 'utf-8');
  } catch {
    return false;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\`skills\\/${escaped}\\/SKILL\\.md\``);
  return re.test(content);
}

function buildResolverAppend(resolverFile: string, vars: ScaffoldVars): string {
  // Append under a `## Uncategorized` section. If the section already
  // exists, just add the row; otherwise create the section.
  let content: string;
  try {
    content = readFileSync(resolverFile, 'utf-8');
  } catch {
    content = '';
  }

  const row = resolverRow(vars);
  const hasUncategorized = /^## Uncategorized\s*$/m.test(content);
  if (hasUncategorized) {
    return '\n' + row + '\n';
  }
  const needsLeadingNewline = content.endsWith('\n') ? '' : '\n';
  return (
    needsLeadingNewline +
    '\n## Uncategorized\n\n| Trigger | Skill |\n|---------|-------|\n' +
    row +
    '\n'
  );
}

/**
 * Apply a previously-computed ScaffoldPlan. I/O only — no planning.
 * Callers that want dry-run behavior should skip this call entirely
 * and just render the plan.
 */
export function applyScaffold(plan: ScaffoldPlan): void {
  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
  }
  if (plan.resolverFile && plan.resolverAppend !== null) {
    const current = existsSync(plan.resolverFile)
      ? readFileSync(plan.resolverFile, 'utf-8')
      : '';
    writeFileSync(plan.resolverFile, current + plan.resolverAppend);
  }
}

export { SKILL_NAME_PATTERN };
