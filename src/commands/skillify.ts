/**
 * gbrain skillify <scaffold|check> — v0.17 W4 CLI namespace.
 *
 * `scaffold`: creates 5 stub files for a new skill. Mechanical only.
 * `check`:    10-item audit of an existing skill. Promoted from
 *             `scripts/skillify-check.ts` (D-CX-2). The legacy script
 *             remains as a thin shim that invokes this subcommand.
 *
 * The markdown skill at `skills/skillify/SKILL.md` orchestrates the
 * full 10-step loop (essay's "skillify it!"): scaffold → fill in the
 * body → run check → run check-resolvable → run tests → commit.
 * The CLI primitives do the mechanical steps; the skill carries the
 * judgment steps.
 */

import { isAbsolute, resolve as resolvePath } from 'path';

import {
  applyScaffold,
  planScaffold,
  SkillifyScaffoldError,
  SKILL_NAME_PATTERN,
  type ScaffoldPlan,
} from '../core/skillify/generator.ts';
import { autoDetectSkillsDir } from '../core/repo-root.ts';
import { RESOLVER_FILENAMES_LABEL } from '../core/resolver-filenames.ts';

// Re-exports for tests.
export { planScaffold, applyScaffold, SkillifyScaffoldError, SKILL_NAME_PATTERN };

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

const HELP_TOP = `gbrain skillify <subcommand> [options]

Subcommands:
  scaffold <name>    Create SKILL.md, script, routing-eval, test stubs
                     and append a resolver row. Mechanical; no LLM.
  check    [path]    Run the 10-item skillify audit on a target path
                     (or --recent). Wraps the legacy scripts/skillify-check.ts
                     (D-CX-2: subcommand namespace).

Run \`gbrain skillify <subcommand> --help\` for per-subcommand options.
`;

export async function runSkillify(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP_TOP);
    process.exit(0);
  }
  if (sub === 'scaffold') {
    await runSkillifyScaffold(rest);
    return;
  }
  if (sub === 'check') {
    await runSkillifyCheck(rest);
    return;
  }
  console.error(`Unknown subcommand: ${sub}\n`);
  console.error(HELP_TOP);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// `gbrain skillify scaffold`
// ---------------------------------------------------------------------------

interface ScaffoldFlags {
  help: boolean;
  json: boolean;
  dryRun: boolean;
  force: boolean;
  name: string | null;
  description: string | null;
  triggers: string[];
  writesTo: string[];
  writesPages: boolean;
  mutating: boolean;
  skillsDir: string | null;
}

const HELP_SCAFFOLD = `gbrain skillify scaffold <name> [options]

Create 5 scaffold files for a new skill:
  1. skills/<name>/SKILL.md                 frontmatter + body template
  2. skills/<name>/scripts/<name>.mjs       deterministic-code stub
  3. skills/<name>/routing-eval.jsonl       routing fixture seed
  4. test/<name>.test.ts                    vitest skeleton
  5. (append) RESOLVER.md or AGENTS.md      trigger row under "## Uncategorized"

All generated files carry the SKILLIFY_STUB sentinel until replaced.
\`gbrain check-resolvable --strict\` fails if any skill still has the
sentinel in its committed script.

Options:
  --description "..."      one-liner for SKILL.md frontmatter (required)
  --triggers "p1,p2,p3"    trigger phrases (comma-separated; defaults to TBD)
  --writes-to "d1,d2"      brain dirs this skill will write to
  --writes-pages           mark the skill as a brain-page writer
  --mutating               mark the skill as mutating: true
  --force                  overwrite existing stubs (not resolver rows)
  --dry-run                print the plan; no writes
  --json                   machine-readable plan envelope
  --skills-dir PATH        override auto-detected skills/
  --help                   show this message

Idempotency: re-running without --force errors on any existing file.
With --force, scaffold files are regenerated BUT resolver rows are
never duplicated (D-CX-7 contract).
`;

function parseScaffoldFlags(argv: string[]): ScaffoldFlags {
  const f: ScaffoldFlags = {
    help: false,
    json: false,
    dryRun: false,
    force: false,
    name: null,
    description: null,
    triggers: [],
    writesTo: [],
    writesPages: false,
    mutating: false,
    skillsDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') f.help = true;
    else if (a === '--json') f.json = true;
    else if (a === '--dry-run') f.dryRun = true;
    else if (a === '--force') f.force = true;
    else if (a === '--writes-pages') f.writesPages = true;
    else if (a === '--mutating') f.mutating = true;
    else if (a === '--description') {
      f.description = argv[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--description=')) {
      f.description = a.slice('--description='.length) || null;
    } else if (a === '--triggers') {
      const v = argv[i + 1] ?? '';
      f.triggers = splitList(v);
      i++;
    } else if (a?.startsWith('--triggers=')) {
      f.triggers = splitList(a.slice('--triggers='.length));
    } else if (a === '--writes-to') {
      const v = argv[i + 1] ?? '';
      f.writesTo = splitList(v);
      i++;
    } else if (a?.startsWith('--writes-to=')) {
      f.writesTo = splitList(a.slice('--writes-to='.length));
    } else if (a === '--skills-dir') {
      f.skillsDir = argv[i + 1] ?? null;
      i++;
    } else if (a?.startsWith('--skills-dir=')) {
      f.skillsDir = a.slice('--skills-dir='.length) || null;
    } else if (a && !a.startsWith('--') && !f.name) {
      f.name = a;
    }
  }
  return f;
}

function splitList(v: string): string[] {
  return v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export async function runSkillifyScaffold(args: string[]): Promise<void> {
  const flags = parseScaffoldFlags(args);
  if (flags.help) {
    console.log(HELP_SCAFFOLD);
    process.exit(0);
  }
  if (!flags.name) {
    console.error('Error: skill name is required.\n');
    console.error(HELP_SCAFFOLD);
    process.exit(2);
  }
  if (!flags.description) {
    console.error('Error: --description is required.\n');
    console.error(HELP_SCAFFOLD);
    process.exit(2);
  }

  // Resolve skills directory.
  let skillsDir: string | null = null;
  if (flags.skillsDir) {
    skillsDir = isAbsolute(flags.skillsDir)
      ? flags.skillsDir
      : resolvePath(process.cwd(), flags.skillsDir);
  } else {
    const detected = autoDetectSkillsDir();
    skillsDir = detected.dir;
  }
  if (!skillsDir) {
    console.error(
      'Error: could not auto-detect skills/. Pass --skills-dir or set $OPENCLAW_WORKSPACE.',
    );
    process.exit(2);
  }

  let plan: ScaffoldPlan;
  try {
    plan = planScaffold({
      skillsDir,
      force: flags.force,
      vars: {
        name: flags.name,
        description: flags.description,
        triggers: flags.triggers,
        writesTo: flags.writesTo,
        writesPages: flags.writesPages,
        mutating: flags.mutating,
      },
    });
  } catch (err) {
    if (err instanceof SkillifyScaffoldError) {
      if (flags.json) {
        console.log(JSON.stringify({ ok: false, error: err.code, message: err.message }, null, 2));
      } else {
        console.error(`skillify scaffold: ${err.message}`);
      }
      process.exit(1);
    }
    throw err;
  }

  if (!plan.resolverFile) {
    const msg = `${RESOLVER_FILENAMES_LABEL} not found in ${skillsDir} or its parent. Create one before scaffolding skills.`;
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, error: 'no_resolver', message: msg }, null, 2));
    } else {
      console.error(msg);
    }
    process.exit(2);
  }

  if (flags.dryRun) {
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            files: plan.files.map(f => ({ path: f.path, kind: f.kind })),
            resolverFile: plan.resolverFile,
            resolverAppendBytes: plan.resolverAppend?.length ?? 0,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`skillify scaffold --dry-run (${plan.files.length} files):`);
      for (const f of plan.files) console.log(`  [${f.kind}] ${f.path}`);
      if (plan.resolverAppend !== null) {
        console.log(`  [append] ${plan.resolverFile} (+${plan.resolverAppend.length} bytes)`);
      } else {
        console.log(`  [skip] ${plan.resolverFile} (row already present — idempotent)`);
      }
    }
    process.exit(0);
  }

  applyScaffold(plan);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: false,
          files: plan.files.map(f => ({ path: f.path, kind: f.kind })),
          resolverFile: plan.resolverFile,
          resolverAppended: plan.resolverAppend !== null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`skillify scaffold: wrote ${plan.files.length} files.`);
    for (const f of plan.files) console.log(`  [${f.kind}] ${f.path}`);
    if (plan.resolverAppend !== null) {
      console.log(`  [append] ${plan.resolverFile}`);
    }
    console.log('\nNext:');
    console.log(`  1. Replace SKILLIFY_STUB sentinels in the generated files.`);
    console.log(`  2. bun test test/${flags.name}.test.ts`);
    console.log(`  3. gbrain skillify check skills/${flags.name}/scripts/${flags.name}.mjs`);
    console.log(`  4. gbrain check-resolvable`);
  }
}

// ---------------------------------------------------------------------------
// `gbrain skillify check` — delegates to scripts/skillify-check.ts via same
// internal helpers. For v0.17 we shell out to the script (kept as single
// source of truth); v0.18 may inline it further.
// ---------------------------------------------------------------------------

async function runSkillifyCheck(args: string[]): Promise<void> {
  // Late-import to avoid pulling the helpers at module init.
  const { runSkillifyCheckInline } = await import('./skillify-check.ts');
  await runSkillifyCheckInline(args);
}
