#!/usr/bin/env bun
/**
 * skillify-check — Post-task audit.
 *
 * Runs after any task that produced new code/features. Checks whether
 * the work is "properly skilled" per the 10-item checklist in
 * skills/skillify/SKILL.md and returns a score + recommendation.
 *
 * Usage:
 *   bun run scripts/skillify-check.ts <path-to-code-or-feature>
 *   bun run scripts/skillify-check.ts scripts/frameio-scraper.ts
 *   bun run scripts/skillify-check.ts --recent            # check recently-modified
 *   bun run scripts/skillify-check.ts --json               # machine-readable output
 *
 * Returns JSON when --json is passed: { path, score, total, items,
 * recommendation }. Exit code is 0 when score == total, 1 otherwise.
 *
 * Ported from ~/git/your-openclaw/workspace/scripts/skillify-check.mjs
 * (genericized: paths computed from $PROJECT_ROOT + runtime test-dir
 * detection; replaces the manual `grep AGENTS.md` check with a reference
 * to `gbrain check-resolvable` which validates the resolver better).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname, resolve } from 'path';
import { spawnSync } from 'child_process';

function projectRoot(): string {
  // Walk up from cwd until we find a package.json — that's the repo root.
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const ROOT = projectRoot();
const SKILLS_DIR = join(ROOT, 'skills');
const RESOLVER_MD = join(SKILLS_DIR, 'RESOLVER.md');

// Test dir detection: prefer test/, then __tests__/, then tests/, then spec/.
function detectTestDir(): string | null {
  for (const candidate of ['test', '__tests__', 'tests', 'spec']) {
    const p = join(ROOT, candidate);
    if (existsSync(p)) return p;
  }
  return null;
}
const TESTS_DIR = detectTestDir();

interface CheckItem {
  name: string;
  passed: boolean;
  required: boolean;
  detail?: string;
}

function check(name: string, passed: boolean, detail?: string): CheckItem {
  return { name, passed, required: true, detail };
}
function checkOptional(name: string, passed: boolean, detail?: string): CheckItem {
  return { name, passed, required: false, detail };
}

/**
 * Invoke `gbrain check-resolvable --json` once and cache the result for the
 * process lifetime. Binary-missing surfaces a loud error instead of silently
 * passing — this is the critical guard the failure-mode audit flagged.
 */
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
      const count = payload.report?.issues?.length ?? 0;
      const err = payload.error ? ` (${payload.error})` : '';
      _resolverCache = { ok: false, detail: `${count} issue(s)${err} — run: gbrain check-resolvable` };
    }
    return _resolverCache;
  } catch (err) {
    console.error(`[skillify] check-resolvable parse failed: ${err}`);
    _resolverCache = { ok: false, detail: `check-resolvable parse error: ${err}` };
    return _resolverCache;
  }
}

/**
 * Guess the skill-directory name from a script path.
 *   scripts/frameio-scraper.ts → frameio-scraper
 *   src/commands/publish.ts    → publish
 *   skills/foo/something.ts    → foo
 */
function inferSkillName(scriptPath: string): string {
  // If the path is inside skills/, the second segment is the skill name.
  const abs = resolve(scriptPath);
  const inSkills = abs.match(/skills\/([^/]+)\//);
  if (inSkills) return inSkills[1];

  const base = basename(scriptPath).replace(/\.(ts|mjs|js|py)$/, '');

  // Check for an existing skill dir that matches.
  if (existsSync(SKILLS_DIR)) {
    for (const d of readdirSync(SKILLS_DIR)) {
      if (d === base) return d;
      // Fuzzy: script base stripped of common suffixes matches a dir name.
      const normalized = base.replace(/[-_]?(scraper|monitor|check|poll|sync|ingest|core)$/, '');
      if (d === normalized || d.replace(/-/g, '') === normalized.replace(/[-_]/g, '')) return d;
    }
  }

  return base;
}

function findRelatedTests(scriptPath: string): string[] {
  if (!TESTS_DIR) return [];
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
    const f = join(TESTS_DIR, p);
    if (existsSync(f)) out.push(f);
  }
  // Fuzzy partial match.
  for (const f of readdirSync(TESTS_DIR)) {
    const normalized = f.replace(/-/g, '').replace('.test.ts', '').replace('.test.mjs', '').replace('test-', '').toLowerCase();
    const nbase = base.replace(/-/g, '').toLowerCase();
    if (normalized.includes(nbase) || nbase.includes(normalized)) {
      const fp = join(TESTS_DIR, f);
      if (!out.includes(fp)) out.push(fp);
    }
  }
  return out;
}

function isInResolver(skillName: string, scriptPath: string): boolean {
  if (!existsSync(RESOLVER_MD)) return false;
  const content = readFileSync(RESOLVER_MD, 'utf-8');
  const base = basename(scriptPath).replace(/\.(ts|mjs|js|py)$/, '');
  return content.includes(`skills/${skillName}`)
    || content.includes(skillName)
    || content.includes(base);
}

function runCheck(target: string): {
  path: string;
  skillName: string;
  items: CheckItem[];
  score: number;
  total: number;
  recommendation: string;
} {
  const abs = resolve(target);
  const skillName = inferSkillName(target);
  const skillMd = join(SKILLS_DIR, skillName, 'SKILL.md');

  const items: CheckItem[] = [];

  // 1. SKILL.md exists
  items.push(check('SKILL.md exists', existsSync(skillMd), skillMd));

  // 2. Code exists at target path
  items.push(check('Code file exists', existsSync(abs), abs));

  // 3. Unit tests
  const unitTests = findRelatedTests(target);
  items.push(check('Unit tests', unitTests.length > 0, unitTests[0] ?? 'no matching *.test.ts in ' + (TESTS_DIR ?? '(no test dir)')));

  // 4. Integration tests (heuristic: has a test that lives under test/e2e/)
  const e2eDir = TESTS_DIR ? join(TESTS_DIR, 'e2e') : null;
  const hasE2E = !!e2eDir && existsSync(e2eDir) && readdirSync(e2eDir).some(f =>
    f.includes(skillName) || f.includes(basename(target).replace(/\.(ts|mjs|js|py)$/, '')),
  );
  items.push(checkOptional('Integration tests (E2E)', hasE2E, e2eDir ?? 'no e2e dir'));

  // 5. LLM evals — heuristic: a file named *eval*.test.* in test dir referencing the skill name.
  let hasEvals = false;
  if (TESTS_DIR) {
    for (const f of readdirSync(TESTS_DIR)) {
      if (/eval/i.test(f) && (f.includes(skillName) || f.includes(basename(target)))) {
        hasEvals = true;
        break;
      }
    }
  }
  items.push(checkOptional('LLM evals', hasEvals));

  // 6. Resolver entry
  items.push(check('Resolver entry', isInResolver(skillName, target)));

  // 7. Resolver trigger eval — heuristic: a resolver test that mentions skillName.
  let hasTriggerEval = false;
  if (TESTS_DIR) {
    const resolverTest = join(TESTS_DIR, 'resolver.test.ts');
    if (existsSync(resolverTest)) {
      const content = readFileSync(resolverTest, 'utf-8');
      hasTriggerEval = content.includes(skillName);
    }
  }
  items.push(checkOptional('Resolver trigger eval', hasTriggerEval));

  // 8. check-resolvable — invoke the real gate. Cached per process so
  // iterating many skills only runs the subprocess once. Binary-missing
  // is surfaced loudly so a silent false-pass can't happen.
  const resolverResult = runCheckResolvableCached();
  items.push(checkOptional('check-resolvable gate',
    resolverResult.ok,
    resolverResult.detail));

  // 9. E2E — same as item 4 but required.
  items.push(check('E2E test (either under e2e/ or integration test)', hasE2E, 'try /qa or test/e2e/'));

  // 10. Brain filing — heuristic: if script mentions `addPage`, `upsertPage`,
  // or `addBrainPage` then brain/RESOLVER.md should list a matching dir.
  let writesBrain = false;
  if (existsSync(abs)) {
    try {
      const src = readFileSync(abs, 'utf-8');
      writesBrain = /addPage|upsertPage|addBrainPage|putPage/.test(src);
    } catch { /* skip */ }
  }
  const brainResolver = join(ROOT, 'brain', 'RESOLVER.md');
  const hasBrainEntry = writesBrain && existsSync(brainResolver)
    && readFileSync(brainResolver, 'utf-8').includes(skillName);
  items.push(checkOptional('Brain filing (RESOLVER entry for brain writes)',
    !writesBrain || hasBrainEntry,
    writesBrain ? (hasBrainEntry ? 'entry present' : 'writes brain but no brain/RESOLVER.md entry') : 'n/a'));

  // Score: required items pass; optional items contribute only if they pass.
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

function recentlyModified(days: number = 7): string[] {
  const candidates: string[] = [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const roots = ['src/commands', 'src/core', 'scripts'].map(r => join(ROOT, r)).filter(existsSync);
  for (const root of roots) {
    try {
      for (const f of readdirSync(root)) {
        if (!f.match(/\.(ts|mjs|js|py)$/)) continue;
        const fp = join(root, f);
        try {
          const st = statSync(fp);
          if (st.isFile() && st.mtimeMs >= cutoff) candidates.push(fp);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return candidates;
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const recent = args.includes('--recent');
  const help = args.includes('--help') || args.includes('-h');

  if (help || (args.length === 0)) {
    console.log(`skillify-check — 10-item checklist audit for gbrain features.

Usage:
  bun run scripts/skillify-check.ts <path>
  bun run scripts/skillify-check.ts --recent   Check files modified in the last 7 days.
  bun run scripts/skillify-check.ts --json      Emit JSON.

Exit code 0 when everything required passes; 1 otherwise.
`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const targets = recent
    ? recentlyModified(7)
    : args.filter(a => !a.startsWith('--'));

  if (targets.length === 0) {
    console.error('No targets. Pass a path or --recent.');
    process.exit(1);
  }

  const results = targets.map(runCheck);
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n${r.path}  [${r.skillName}]  ${r.score}/${r.total}`);
      for (const item of r.items) {
        const mark = item.passed ? '✓' : (item.required ? '✗' : '·');
        const tag = item.required ? '' : ' (optional)';
        const detail = item.detail ? `  — ${item.detail}` : '';
        console.log(`  ${mark} ${item.name}${tag}${detail}`);
      }
      console.log(`  → ${r.recommendation}`);
    }
  }

  // Exit code: non-zero if any result has missing required items.
  const anyFailed = results.some(r => r.items.some(i => !i.passed && i.required));
  process.exit(anyFailed ? 1 : 0);
}

main();
