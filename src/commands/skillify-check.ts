/**
 * gbrain skillify check — 10-item post-task audit.
 *
 * Promoted from `scripts/skillify-check.ts` (D-CX-2). The legacy
 * script stays as a thin shim so existing callers keep working, but
 * the CLI entry point is now `gbrain skillify check`.
 *
 * 10-item checklist (essay Step 3-10):
 *   1. SKILL.md exists
 *   2. Code file exists at target path
 *   3. Unit tests exist
 *   4. E2E tests (optional — tracked but not required)
 *   5. LLM evals (optional)
 *   6. Resolver entry
 *   7. Resolver trigger eval (heuristic via `test/resolver.test.ts`)
 *   8. check-resolvable gate (runs `gbrain check-resolvable --json`)
 *   9. E2E smoke (required copy of #4 for required-gate semantics)
 *  10. Brain filing (only when the script writes pages)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';

interface CheckItem {
  name: string;
  passed: boolean;
  required: boolean;
  detail?: string;
}

interface CheckResult {
  path: string;
  skillName: string;
  items: CheckItem[];
  score: number;
  total: number;
  recommendation: string;
}

function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function detectTestDir(root: string): string | null {
  for (const candidate of ['test', '__tests__', 'tests', 'spec']) {
    const p = join(root, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}

function check(name: string, passed: boolean, detail?: string): CheckItem {
  return { name, passed, required: true, detail };
}

function checkOptional(name: string, passed: boolean, detail?: string): CheckItem {
  return { name, passed, required: false, detail };
}

interface ResolverResult {
  ok: boolean;
  detail: string;
}

let _resolverCache: ResolverResult | null = null;

function runCheckResolvableCached(): ResolverResult {
  if (_resolverCache) return _resolverCache;
  try {
    const res = spawnSync('gbrain', ['check-resolvable', '--json'], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.error || res.status === null) {
      const reason = res.error?.message ?? 'spawn returned null status';
      console.error(`[skillify] gbrain check-resolvable not runnable: ${reason}`);
      _resolverCache = { ok: false, detail: `check-resolvable unavailable: ${reason}` };
      return _resolverCache;
    }
    const payload = JSON.parse(res.stdout);
    if (payload.ok === true) {
      _resolverCache = { ok: true, detail: 'all skill-tree checks pass' };
    } else {
      const count = (payload.report?.errors?.length ?? 0) + (payload.report?.warnings?.length ?? 0);
      const err = payload.error ? ` (${payload.error})` : '';
      _resolverCache = {
        ok: false,
        detail: `${count} issue(s)${err} — run: gbrain check-resolvable`,
      };
    }
    return _resolverCache;
  } catch (err) {
    console.error(`[skillify] check-resolvable parse failed: ${err}`);
    _resolverCache = { ok: false, detail: `check-resolvable parse error: ${err}` };
    return _resolverCache;
  }
}

function inferSkillName(scriptPath: string, skillsDir: string): string {
  const abs = resolve(scriptPath);
  const inSkills = abs.match(/skills\/([^/]+)\//);
  if (inSkills) return inSkills[1];

  const base = basename(scriptPath).replace(/\.(ts|mjs|js|py)$/, '');
  if (existsSync(skillsDir)) {
    for (const d of readdirSync(skillsDir)) {
      if (d === base) return d;
      const normalized = base.replace(
        /[-_]?(scraper|monitor|check|poll|sync|ingest|core)$/,
        '',
      );
      if (d === normalized || d.replace(/-/g, '') === normalized.replace(/[-_]/g, '')) {
        return d;
      }
    }
  }
  return base;
}

function findRelatedTests(scriptPath: string, testDir: string | null): string[] {
  if (!testDir) return [];
  const base = basename(scriptPath).replace(/\.(ts|mjs|js|py)$/, '');
  const patterns = [
    `${base}.test.ts`,
    `${base}.test.mjs`,
    `${base}.test.js`,
    `test-${base}.ts`,
    `${base.replace(/-/g, '_')}.test.ts`,
  ];
  const out: string[] = [];
  for (const p of patterns) {
    const f = join(testDir, p);
    if (existsSync(f)) out.push(f);
  }
  for (const f of readdirSync(testDir)) {
    const normalized = f
      .replace(/-/g, '')
      .replace('.test.ts', '')
      .replace('.test.mjs', '')
      .replace('test-', '')
      .toLowerCase();
    const nbase = base.replace(/-/g, '').toLowerCase();
    if (normalized.includes(nbase) || nbase.includes(normalized)) {
      const fp = join(testDir, f);
      if (!out.includes(fp)) out.push(fp);
    }
  }
  return out;
}

function isInResolver(skillName: string, scriptPath: string, skillsDir: string): boolean {
  const resolverPaths = [
    join(skillsDir, 'RESOLVER.md'),
    join(skillsDir, 'AGENTS.md'),
    join(dirname(skillsDir), 'AGENTS.md'),
  ];
  const present = resolverPaths.find(p => existsSync(p));
  if (!present) return false;
  const content = readFileSync(present, 'utf-8');
  const base = basename(scriptPath).replace(/\.(ts|mjs|js|py)$/, '');
  return (
    content.includes(`skills/${skillName}`) ||
    content.includes(skillName) ||
    content.includes(base)
  );
}

function runSkillifyCheckTarget(target: string, root: string): CheckResult {
  const skillsDir = join(root, 'skills');
  const testDir = detectTestDir(root);
  const abs = resolve(target);
  const skillName = inferSkillName(target, skillsDir);
  const skillMd = join(skillsDir, skillName, 'SKILL.md');

  const items: CheckItem[] = [];

  items.push(check('SKILL.md exists', existsSync(skillMd), skillMd));
  items.push(check('Code file exists', existsSync(abs), abs));

  const unitTests = findRelatedTests(target, testDir);
  items.push(
    check(
      'Unit tests',
      unitTests.length > 0,
      unitTests[0] ?? 'no matching *.test.ts in ' + (testDir ?? '(no test dir)'),
    ),
  );

  const e2eDir = testDir ? join(testDir, 'e2e') : null;
  const hasE2E =
    !!e2eDir &&
    existsSync(e2eDir) &&
    readdirSync(e2eDir).some(
      f =>
        f.includes(skillName) ||
        f.includes(basename(target).replace(/\.(ts|mjs|js|py)$/, '')),
    );
  items.push(checkOptional('Integration tests (E2E)', hasE2E, e2eDir ?? 'no e2e dir'));

  let hasEvals = false;
  if (testDir) {
    for (const f of readdirSync(testDir)) {
      if (/eval/i.test(f) && (f.includes(skillName) || f.includes(basename(target)))) {
        hasEvals = true;
        break;
      }
    }
  }
  items.push(checkOptional('LLM evals', hasEvals));

  items.push(check('Resolver entry', isInResolver(skillName, target, skillsDir)));

  let hasTriggerEval = false;
  if (testDir) {
    const resolverTest = join(testDir, 'resolver.test.ts');
    if (existsSync(resolverTest)) {
      const content = readFileSync(resolverTest, 'utf-8');
      hasTriggerEval = content.includes(skillName);
    }
    const routingFixture = join(skillsDir, skillName, 'routing-eval.jsonl');
    if (existsSync(routingFixture)) hasTriggerEval = true;
  }
  items.push(checkOptional('Resolver trigger eval', hasTriggerEval));

  const resolverResult = runCheckResolvableCached();
  items.push(
    checkOptional('check-resolvable gate', resolverResult.ok, resolverResult.detail),
  );

  items.push(check('E2E test (either under e2e/ or integration test)', hasE2E, 'try /qa or test/e2e/'));

  let writesBrain = false;
  if (existsSync(abs)) {
    try {
      const src = readFileSync(abs, 'utf-8');
      writesBrain = /addPage|upsertPage|addBrainPage|putPage/.test(src);
    } catch {
      /* skip */
    }
  }
  const brainResolver = join(root, 'brain', 'RESOLVER.md');
  const hasBrainEntry =
    writesBrain &&
    existsSync(brainResolver) &&
    readFileSync(brainResolver, 'utf-8').includes(skillName);
  items.push(
    checkOptional(
      'Brain filing (RESOLVER entry for brain writes)',
      !writesBrain || hasBrainEntry,
      writesBrain ? (hasBrainEntry ? 'entry present' : 'writes brain but no brain/RESOLVER.md entry') : 'n/a',
    ),
  );

  const passed = items.filter(i => i.passed).length;
  const total = items.length;
  const missing = items.filter(i => !i.passed && i.required).map(i => i.name);

  let recommendation: string;
  if (missing.length === 0) {
    recommendation = 'properly skilled';
  } else if (missing.length <= 2) {
    recommendation = `close — create: ${missing.join(', ')}`;
  } else {
    recommendation = `needs skillify — run /skillify on ${target}; missing: ${missing.join(', ')}`;
  }

  return { path: target, skillName, items, score: passed, total, recommendation };
}

function recentlyModified(root: string, days: number = 7): string[] {
  const candidates: string[] = [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const roots = ['src/commands', 'src/core', 'scripts']
    .map(r => join(root, r))
    .filter(existsSync);
  for (const r of roots) {
    try {
      for (const f of readdirSync(r)) {
        if (!f.match(/\.(ts|mjs|js|py)$/)) continue;
        const fp = join(r, f);
        try {
          const st = statSync(fp);
          if (st.isFile() && st.mtimeMs >= cutoff) candidates.push(fp);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  }
  return candidates;
}

const HELP = `gbrain skillify check [path] [--recent] [--json]

Run the 10-item skillify audit (post-task). Reports whether each item
passes and what to create next.

Arguments:
  path            Path to the script/file to audit.
  --recent        Audit all files modified in the last 7 days.
  --json          Emit JSON.
  --help          Show this message.

Exit code 0 when all REQUIRED items pass; 1 otherwise.
`;

/**
 * Entry point invoked by `gbrain skillify check`. The outer
 * dispatcher passes args with the subcommand already stripped.
 */
export async function runSkillifyCheckInline(args: string[]): Promise<void> {
  const help = args.includes('--help') || args.includes('-h');
  const json = args.includes('--json');
  const recent = args.includes('--recent');
  if (help || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const root = projectRoot();
  const targets = recent
    ? recentlyModified(root, 7)
    : args.filter(a => !a.startsWith('--'));

  if (targets.length === 0) {
    console.error('No targets. Pass a path or --recent.');
    process.exit(1);
  }

  const results: CheckResult[] = targets.map(t => runSkillifyCheckTarget(t, root));
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n${r.path}  [${r.skillName}]  ${r.score}/${r.total}`);
      for (const item of r.items) {
        const mark = item.passed ? '✓' : item.required ? '✗' : '·';
        const tag = item.required ? '' : ' (optional)';
        const detail = item.detail ? `  — ${item.detail}` : '';
        console.log(`  ${mark} ${item.name}${tag}${detail}`);
      }
      console.log(`  → ${r.recommendation}`);
    }
  }

  const anyFailed = results.some(r => r.items.some(i => !i.passed && i.required));
  process.exit(anyFailed ? 1 : 0);
}

export { runSkillifyCheckTarget, type CheckItem, type CheckResult };
