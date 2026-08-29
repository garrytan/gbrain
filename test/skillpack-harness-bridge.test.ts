/**
 * harness-bridge.ts — plan/apply core for the cathedral-7 skill bridge.
 *
 * Hermetic synthetic gbrain root (the skillpack-scaffold.test.ts fixture
 * pattern): every path — persona filtering through the manifest universe,
 * the frontmatter fail-loud gate (the codex session-brick guard), stub
 * rendering with shared-dep closure, mode-conflict ground truth from the
 * file marker, target confinement (traversal + symlinked parents),
 * written-only ownership, and ledger-scoped remove.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import {
  BridgeError,
  STUB_MARKER,
  applyHarnessBridge,
  assertDestNotSymlink,
  assertTargetsConfined,
  bridgeTargetPath,
  planHarnessBridge,
  removeHarnessBridge,
  renderSkillStub,
  sha256Hex,
  verifySlugsServable,
} from '../src/core/skillpack/harness-bridge.ts';
import { loadBridgeState, findBridgeEntry } from '../src/core/skillpack/bridge-state.ts';
import { STARTER_OPS } from '../src/mcp/surface.ts';
import { getSkillDetail } from '../src/core/skill-catalog.ts';
import type { OperationContext } from '../src/core/operations.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

const SKILL_MD = (name: string) =>
  `---\nname: ${name}\ndescription: fixture skill ${name}\ntriggers:\n  - ${name} things\n---\n# ${name}\n\nBody of ${name}. See ../conventions/style.md.\n`;

/** Synthetic gbrain root: lane = ({alpha, gamma} ∖ {gamma}) ∪ {beta}. */
function fixtureRoot(): string {
  const root = tmp('gb-bridge-root-');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub (findGbrainRoot pairs this with openclaw.plugin.json)');
  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify({
      name: 'fixture',
      version: '0.0.0.0',
      skills: ['skills/alpha', 'skills/gamma'],
      shared_deps: ['skills/conventions', 'skills/_rules.md'],
    }),
  );
  for (const slug of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(root, 'skills', slug), { recursive: true });
    writeFileSync(join(root, 'skills', slug, 'SKILL.md'), SKILL_MD(slug));
  }
  writeFileSync(join(root, 'skills', 'alpha', 'aux.md'), 'aux content for alpha\n');
  mkdirSync(join(root, 'skills', 'nofm'), { recursive: true });
  writeFileSync(join(root, 'skills', 'nofm', 'SKILL.md'), '# no frontmatter here\n');
  mkdirSync(join(root, 'skills', 'conventions'), { recursive: true });
  writeFileSync(join(root, 'skills', 'conventions', 'style.md'), 'convention content\n');
  writeFileSync(join(root, 'skills', '_rules.md'), 'shared rules\n');
  writeFileSync(
    join(root, 'skills', 'manifest.json'),
    JSON.stringify({
      skills: ['alpha', 'beta', 'gamma', 'nofm'].map(name => ({ name, path: `${name}/SKILL.md`, description: 'fixture' })),
    }),
  );
  writeFileSync(
    join(root, 'skills', 'plugin-lanes.json'),
    JSON.stringify({
      starter_policy: 'fixture',
      additions: { beta: 'a fixture reason long enough to pass' },
      base_exclusions: { gamma: 'a fixture exclusion reason long enough' },
      not_added: {},
      starter_gaps: {},
    }),
  );
  return root;
}

const APPLY = (dest: string, statePath: string, overrides: Record<string, unknown> = {}) => ({
  harness: 'claude-code',
  scope: 'user' as const,
  persona: 'tester',
  gbrainVersion: '0.0.0-test',
  statePath,
  nowIso: '2026-08-16T00:00:00Z',
  ...overrides,
});

describe('plan', () => {
  test('manifest universe: a lane addition absent from openclaw#skills enumerates fine', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const plan = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha', 'beta'], mode: 'full' });
    const rels = plan.items.map(i => i.relTarget).sort();
    expect(rels).toEqual(['_rules.md', 'alpha/SKILL.md', 'alpha/aux.md', 'beta/SKILL.md', 'conventions/style.md']);
    expect(plan.modeConflicts).toEqual([]);
  });

  test('unknown slug fails naming skills/manifest.json', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    expect(() => planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['zzz'], mode: 'full' })).toThrow(
      /skills\/manifest\.json/,
    );
  });

  test('frontmatter fail-loud BEFORE any write (the codex session-brick guard)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    try {
      planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha', 'nofm'], mode: 'full' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe('frontmatter_missing');
      expect((err as Error).message).toContain('nofm');
    }
    expect(readdirSync(dest)).toEqual([]); // nothing written
  });
});

describe('apply', () => {
  test('full install → idempotent re-run → local edit preserved', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    const plan = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha', 'beta'], mode: 'full' });
    const r1 = applyHarnessBridge(plan, APPLY(dest, statePath));
    expect(r1.summary.wroteNew).toBe(5);
    expect(r1.summary.skippedExisting).toBe(0);

    // Local edit, then re-run: never clobbered, counted as skipped.
    const edited = join(dest, 'alpha', 'SKILL.md');
    writeFileSync(edited, readFileSync(edited, 'utf-8') + '\nLOCAL EDIT\n');
    const plan2 = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha', 'beta'], mode: 'full' });
    const r2 = applyHarnessBridge(plan2, APPLY(dest, statePath));
    expect(r2.summary.wroteNew).toBe(0);
    expect(r2.summary.skippedExisting).toBe(5);
    expect(readFileSync(edited, 'utf-8')).toContain('LOCAL EDIT');
  });

  test('dry-run writes nothing and records no state', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    const plan = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode: 'full' });
    const r = applyHarnessBridge(plan, APPLY(dest, statePath, { dryRun: true }));
    expect(r.summary.wroteNew).toBeGreaterThan(0);
    expect(readdirSync(dest)).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
  });

  test('written-only ownership: a pre-existing user file is never recorded [CX7]', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    mkdirSync(join(dest, 'alpha'), { recursive: true });
    writeFileSync(join(dest, 'alpha', 'SKILL.md'), SKILL_MD('alpha') + 'USER OWNED\n');
    const plan = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode: 'full' });
    applyHarnessBridge(plan, APPLY(dest, statePath));
    const entry = findBridgeEntry(loadBridgeState({ statePath }), { harness: 'claude-code', dest })!;
    expect(entry.written.alpha.files['alpha/SKILL.md']).toBeUndefined(); // skipped_existing ≠ owned
    expect(entry.written.alpha.files['alpha/aux.md']).toBeDefined(); // the file we DID write
  });

  test('install-time sha256 is the hash of what landed [OV3]', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    const plan = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['beta'], mode: 'full' });
    applyHarnessBridge(plan, APPLY(dest, statePath));
    const entry = findBridgeEntry(loadBridgeState({ statePath }), { harness: 'claude-code', dest })!;
    const onDisk = readFileSync(join(dest, 'beta', 'SKILL.md'));
    expect(entry.written.beta.files['beta/SKILL.md']).toBe(sha256Hex(onDisk));
  });
});

describe('stub mode', () => {
  test('marker + verbatim frontmatter + shared-dep AND aux closure shipped [CX4]', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    const plan = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode: 'stub' });
    applyHarnessBridge(plan, APPLY(dest, statePath));

    const stub = readFileSync(join(dest, 'alpha', 'SKILL.md'), 'utf-8');
    expect(stub).toContain(STUB_MARKER);
    expect(stub.startsWith('---\nname: alpha\n')).toBe(true); // frontmatter verbatim
    expect(stub).toContain('get_skill');
    expect(stub).toContain('gbrain skill alpha'); // CLI fallback (a real generated command)
    expect(stub).not.toContain('Body of alpha'); // cold invariant: no source body
    // Shared deps AND aux files ship even in stub mode — cold-pulled bodies
    // reference both (../conventions/… and sibling files); get_skill serves
    // only the body itself.
    expect(existsSync(join(dest, 'conventions', 'style.md'))).toBe(true);
    expect(existsSync(join(dest, '_rules.md'))).toBe(true);
    expect(readFileSync(join(dest, 'alpha', 'aux.md'), 'utf-8')).toBe('aux content for alpha\n');
  });

  test('mode conflict: file marker is ground truth, conflicted slugs are DROPPED from the plan [CX8/CEO-F5]', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    // full install, then a stub plan → conflict; the slug's items are gone.
    applyHarnessBridge(planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode: 'full' }), APPLY(dest, statePath));
    const stubPlan = planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode: 'stub' });
    expect(stubPlan.modeConflicts).toEqual(['alpha']);
    expect(stubPlan.items.every(i => i.slug !== 'alpha')).toBe(true);
    // stub install elsewhere, then a full plan → conflict (state absent —
    // the marker alone is ground truth).
    const dest2 = tmp('gb-bridge-dest2-');
    applyHarnessBridge(planHarnessBridge({ gbrainRoot: root, destDir: dest2, slugs: ['beta'], mode: 'stub' }), APPLY(dest2, statePath));
    const fullPlan = planHarnessBridge({ gbrainRoot: root, destDir: dest2, slugs: ['beta'], mode: 'full' });
    expect(fullPlan.modeConflicts).toEqual(['beta']);
    expect(fullPlan.items.every(i => i.slug !== 'beta')).toBe(true);
    // Applying the conflicted plan never converts the stub and never flips
    // the ledger mode (nothing of beta's is written).
    const r = applyHarnessBridge(fullPlan, APPLY(dest2, statePath));
    expect(readFileSync(join(dest2, 'beta', 'SKILL.md'), 'utf-8')).toContain(STUB_MARKER);
    expect(r.summary.modeConflicts).toEqual(['beta']);
    const entry2 = findBridgeEntry(loadBridgeState({ statePath }), { harness: 'claude-code', dest: dest2 })!;
    expect(entry2.written.beta.mode).toBe('stub');
  });

  test('renderSkillStub refuses a frontmatterless source', () => {
    expect(() => renderSkillStub('# no fm\n', 'x')).toThrow(BridgeError);
  });
});

describe('confinement', () => {
  test('logical traversal out of dest is rejected', () => {
    const dest = tmp('gb-bridge-dest-');
    expect(() => assertTargetsConfined(dest, [join(dest, '..', 'escape.md')])).toThrow(BridgeError);
  });

  test('a symlinked parent pointing outside dest is rejected', () => {
    const dest = tmp('gb-bridge-dest-');
    const outside = tmp('gb-bridge-outside-');
    symlinkSync(outside, join(dest, 'link'));
    try {
      assertTargetsConfined(dest, [join(dest, 'link', 'f.md')]);
      expect.unreachable();
    } catch (err) {
      expect((err as BridgeError).code).toBe('target_escape');
    }
  });

  test('a symlink AS the dest is refused', () => {
    const real = tmp('gb-bridge-real-');
    const holder = tmp('gb-bridge-holder-');
    const link = join(holder, 'dest-link');
    symlinkSync(real, link);
    expect(() => assertDestNotSymlink(link)).toThrow(BridgeError);
    expect(() => assertDestNotSymlink(real)).not.toThrow();
  });
});

describe('remove', () => {
  test('removes ledger-owned files only; user files and shared deps survive', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    // Pre-existing user file inside a slug dir the bridge also writes to.
    mkdirSync(join(dest, 'alpha'), { recursive: true });
    writeFileSync(join(dest, 'alpha', 'user-note.md'), 'mine\n');
    applyHarnessBridge(planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha', 'beta'], mode: 'full' }), APPLY(dest, statePath));

    const r = removeHarnessBridge({
      harness: 'claude-code',
      destDir: dest,
      slugs: ['alpha', 'ghost'],
      statePath,
      nowIso: '2026-08-16T00:00:00Z',
    });
    expect(r.notOwned).toEqual(['ghost']);
    expect(existsSync(join(dest, 'alpha', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(dest, 'alpha', 'aux.md'))).toBe(false);
    expect(existsSync(join(dest, 'alpha', 'user-note.md'))).toBe(true); // never ours
    expect(existsSync(join(dest, 'beta', 'SKILL.md'))).toBe(true); // not requested
    expect(existsSync(join(dest, 'conventions', 'style.md'))).toBe(true); // shared, hash-tracked but never slug-removed
    const entry = findBridgeEntry(loadBridgeState({ statePath }), { harness: 'claude-code', dest })!;
    expect(Object.keys(entry.written).sort()).toEqual(['_shared', 'beta']);
  });

  test('a user-edited owned file is KEPT on remove (it became yours)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    applyHarnessBridge(planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode: 'full' }), APPLY(dest, statePath));
    const edited = join(dest, 'alpha', 'SKILL.md');
    writeFileSync(edited, readFileSync(edited, 'utf-8') + '\nMY EDIT\n');

    const r = removeHarnessBridge({
      harness: 'claude-code',
      destDir: dest,
      slugs: ['alpha'],
      statePath,
      nowIso: '2026-08-16T00:00:00Z',
    });
    expect(r.keptEdited).toEqual([edited]);
    expect(readFileSync(edited, 'utf-8')).toContain('MY EDIT'); // survives
    expect(existsSync(join(dest, 'alpha', 'aux.md'))).toBe(false); // unedited sibling removed
    // The slug leaves the ledger either way — the kept file is user-owned now.
    const entry = findBridgeEntry(loadBridgeState({ statePath }), { harness: 'claude-code', dest });
    expect(entry?.written.alpha).toBeUndefined();
  });
});

describe('surface + servability contracts', () => {
  test('get_skill is NOT in STARTER_OPS (the stub preflight warning premise) — if this ever flips, update the harness CLI warn text', () => {
    expect(STARTER_OPS.has('get_skill')).toBe(false);
    expect(STARTER_OPS.has('list_skills')).toBe(false);
    expect(STARTER_OPS.has('request_tools')).toBe(true);
  });

  test('verifySlugsServable names exactly the unservable slugs', () => {
    const root = fixtureRoot();
    expect(verifySlugsServable(join(root, 'skills'), ['alpha', 'zzz'])).toEqual(['zzz']);
  });

  test('invoke leg: getSkillDetail serves the FULL body for a stub-installed name', () => {
    // Install a stub of the real repo's `query` skill, then ask the catalog
    // (what the MCP get_skill op serves) for the same name: the full body
    // comes back — install → discover → cold-invoke, complete.
    const dest = tmp('gb-bridge-invoke-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    const plan = planHarnessBridge({ gbrainRoot: REPO_ROOT, destDir: dest, slugs: ['query'], mode: 'stub' });
    applyHarnessBridge(plan, APPLY(dest, statePath));
    expect(readFileSync(join(dest, 'query', 'SKILL.md'), 'utf-8')).toContain(STUB_MARKER);

    const detail = getSkillDetail({ remote: false } as unknown as OperationContext, join(REPO_ROOT, 'skills'), 'query');
    expect(detail.name).toBe('query');
    expect(detail.body).not.toContain(STUB_MARKER);
    expect(detail.body.length).toBeGreaterThan(500);
  });
});

describe('bridgeTargetPath', () => {
  test('strips the skills/ prefix without dirname arithmetic', () => {
    expect(bridgeTargetPath('/x/dest', 'skills/alpha/SKILL.md')).toBe(resolve('/x/dest/alpha/SKILL.md'));
    expect(bridgeTargetPath('/x/dest', 'skills/_rules.md')).toBe(resolve('/x/dest/_rules.md'));
  });
});

describe('review-driven hardening (ship pre-landing findings)', () => {
  test('remove refuses a tampered ledger relpath that escapes dest (canary survives)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const stateDir = tmp('gb-bridge-st-');
    const statePath = join(stateDir, 'state.json');
    applyHarnessBridge(planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode: 'full' }), APPLY(dest, statePath));
    // Canary outside dest + a tampered ledger relpath pointing at it.
    const canary = join(stateDir, 'canary.txt');
    writeFileSync(canary, 'precious');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.entries[0].written.alpha.files['../' + '../' + stateDir.split('/').pop() + '/canary.txt'] = 'h';
    writeFileSync(statePath, JSON.stringify(state));
    expect(() =>
      removeHarnessBridge({ harness: 'claude-code', destDir: dest, slugs: ['alpha'], statePath, nowIso: '2026-08-16T00:00:00Z' }),
    ).toThrow(BridgeError);
    expect(readFileSync(canary, 'utf-8')).toBe('precious');
  });

  test('confinement holds when destDir does not exist yet (lexical branch)', () => {
    const holder = tmp('gb-bridge-holder-');
    const dest = join(holder, 'not-created-yet');
    expect(() => assertTargetsConfined(dest, [join(dest, 'alpha', 'SKILL.md')])).not.toThrow();
    expect(() => assertTargetsConfined(dest, [join(dest, '..', 'escape.md')])).toThrow(BridgeError);
  });

  test('a dangling symlink AT a planned target is refused (write-through guard)', () => {
    const dest = tmp('gb-bridge-dest-');
    const link = join(dest, 'SKILL.md');
    symlinkSync(join(dest, 'nowhere-target'), link); // dangling: existsSync=false
    expect(existsSync(link)).toBe(false);
    try {
      assertTargetsConfined(dest, [link]);
      expect.unreachable();
    } catch (err) {
      expect((err as BridgeError).code).toBe('target_escape');
    }
  });

  test('apply-clean-hunks refuses local edits (your change wins) while applying upstream drift', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const statePath = join(tmp('gb-bridge-st-'), 'state.json');
    applyHarnessBridge(planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha', 'beta'], mode: 'full' }), APPLY(dest, statePath));
    // alpha: LOCAL edit; beta: UPSTREAM drift.
    const alphaPath = join(dest, 'alpha', 'SKILL.md');
    const localContent = readFileSync(alphaPath, 'utf-8') + '\nMY LOCAL EDIT\n';
    writeFileSync(alphaPath, localContent);
    writeFileSync(join(root, 'skills', 'beta', 'SKILL.md'), SKILL_MD('beta').replace('Body of beta', 'Body of beta MOVED'));
    const { runHarnessReferenceApply } = require('../src/core/skillpack/harness-bridge.ts') as typeof import('../src/core/skillpack/harness-bridge.ts');
    const r = runHarnessReferenceApply({ gbrainRoot: root, destDir: dest, slugs: ['alpha', 'beta'], harness: 'claude-code', statePath });
    expect(r.summary.refusedLocalEdit).toBe(1);
    expect(r.summary.totalHunksApplied).toBeGreaterThan(0);
    expect(readFileSync(alphaPath, 'utf-8')).toBe(localContent); // edit kept
    expect(readFileSync(join(dest, 'beta', 'SKILL.md'), 'utf-8')).toContain('MOVED'); // drift aligned
  });

  test('stub install with aux: state loss does not report aux missing (marker-derived slug mode)', () => {
    const root = fixtureRoot();
    const dest = tmp('gb-bridge-dest-');
    const stateDir = tmp('gb-bridge-st-');
    const statePath = join(stateDir, 'state.json');
    applyHarnessBridge(planHarnessBridge({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], mode: 'stub' }), APPLY(dest, statePath));
    rmSync(statePath);
    const { runHarnessReference } = require('../src/core/skillpack/harness-bridge.ts') as typeof import('../src/core/skillpack/harness-bridge.ts');
    const ref = runHarnessReference({ gbrainRoot: root, destDir: dest, slugs: ['alpha'], harness: 'claude-code', statePath });
    expect(ref.summary.missing).toBe(0); // alpha/aux.md expected-absent, judged by the file marker
    expect(ref.summary.differs).toBe(0);
  });
});
