/**
 * Contract pin between .github/workflows/release.yml and
 * src/core/binary-self-update.ts (#3521).
 *
 * Binary installs download upgrade assets from the release `latest-stable` names, by the exact
 * names expectedAssetName() returns. If the workflow's build matrix or the
 * release `files:` list drifts from those names, self-update silently degrades
 * to notify-only (`no_asset`) for everyone — this test is the guard.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { EXPECTED_BUILDER_IDS, expectedAssetName } from '../src/core/binary-self-update.ts';
import { RELEASE_ADDON_TARGETS, RUST_ADDON_MANIFEST_ASSET, rustAddonAssetName } from '../src/core/rust-engine/addon-manifest.ts';

const ROOT = join(import.meta.dir, '..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');

/** Every platform/arch the self-updater can request an asset for. */
const EXPECTED_ASSETS = (
  [
    ['darwin', 'arm64'],
    ['linux', 'x64'],
  ] as const
).map(([p, a]) => expectedAssetName(p, a) as string);

/** The Rust engine addon files `gbrain engine install rust` downloads from a release (addon-install.ts). */
const RUST_ADDON_ASSETS = [...RELEASE_ADDON_TARGETS.map(rustAddonAssetName), RUST_ADDON_MANIFEST_ASSET];

describe('release.yml ↔ binary-self-update asset contract', () => {
  test('release compiler is covered by the required native runtime matrix', () => {
    const build = WORKFLOW.slice(WORKFLOW.indexOf('  build:'), WORKFLOW.indexOf('  release:'));
    const compiler = build.match(/bun-version:\s*(\S+)/)?.[1];
    expect(compiler).toBe('1.4.4');
    const native = readFileSync(join(ROOT, '.github/workflows/native-locks.yml'), 'utf8');
    const matrices = [...native.matchAll(/bun:\s*\[([^\]]+)\]/g)];
    expect(matrices).toHaveLength(4);
    for (const matrix of matrices) {
      expect(matrix[1]).toContain(`'${compiler}'`);
    }
    expect(native).toContain('scripts/native/cli-persistence-smoke.ts');
    expect(native).toContain('GBRAIN_TEST_OPENCLAW_BIN:');
    expect(native).toContain("job.services.postgres.ports['5432']");
    expect(native).toContain('openclaw@2026.9.4');
    expect(native).toContain('bun test --timeout=60000 test/openclaw-context-engine-native.serial.test.ts');
    expect(build).toContain('codesign --verify --strict --verbose=2');
    expect(build.indexOf('codesign --verify')).toBeLessThan(build.indexOf('Smoke-test the compiled binary'));
    expect(build).toContain('bun scripts/native/compiled-admin-smoke.ts --binary bin/${{ matrix.artifact }}');
    expect(native).toContain('bun scripts/native/compiled-admin-smoke.ts --binary bin/gbrain-native-validation');
  });

  test('the compiled admin smoke makes a fresh bootstrap token each run instead of committing one', () => {
    const smoke = readFileSync(join(ROOT, 'scripts/native/compiled-admin-smoke.ts'), 'utf8');
    expect(smoke).not.toMatch(/GBRAIN_ADMIN_BOOTSTRAP_TOKEN:\s*['"`]/);
    expect(smoke).toMatch(/const bootstrapToken = randomBytes\(\d+\)\.toString\('hex'\);/);
    expect(smoke).toContain('GBRAIN_ADMIN_BOOTSTRAP_TOKEN: bootstrapToken,');
  });

  test('workflow build matrix produces exactly the assets the updater requests', () => {
    const artifacts = [...WORKFLOW.matchAll(/artifact:\s*(\S+)/g)].map((m) => m[1]).sort();
    expect(artifacts).toEqual([...EXPECTED_ASSETS].sort());
  });

  test('every expected asset is attached to the release', () => {
    for (const name of EXPECTED_ASSETS) {
      // download-artifact unpacks to artifacts/<name>/<name>
      expect(WORKFLOW).toContain(`artifacts/${name}/${name}`);
    }
  });

  test('idempotency completeness check names every expected asset', () => {
    // The version job only skips when the existing release carries ALL assets;
    // its sorted-join comparison string must stay in sync with the matrix and
    // with the Rust engine addon files `gbrain engine install rust` downloads.
    const all = [...EXPECTED_ASSETS, ...RUST_ADDON_ASSETS, 'gbrain-skill-resolver.mjs', 'gbrain-skill-resolver.mjs.sha256'];
    // The check is a subset check (the eval-gates pin workflow attaches one more asset later), so the sorted-join string is
    // the `expected` list; test/eval-gates-pin.test.ts runs the check against each missing name.
    expect(WORKFLOW).toContain(`expected="${all.sort().join(',')}"`);
    expect(WORKFLOW).toContain('complete=true');
  });

  test('release tag derives from the VERSION file, v-prefixed', () => {
    expect(WORKFLOW).toContain('< VERSION');
    expect(WORKFLOW).toMatch(/tag_name: v\$\{\{ needs\.version\.outputs\.version \}\}/);
  });

  test('missing binaries fail the release instead of publishing assetless', () => {
    expect(WORKFLOW).toContain('fail_on_unmatched_files: true');
  });

  test('contents:write is scoped to the release job, not the whole workflow', () => {
    const topLevel = WORKFLOW.slice(0, WORKFLOW.indexOf('jobs:'));
    expect(topLevel).toContain('contents: read');
    expect(topLevel).not.toContain('contents: write');
  });

  test('build attests provenance for the compiled binary (self-update integrity depends on it)', () => {
    // binary-self-update verifies the downloaded asset against this attestation
    // (verifyIntegrity). Removing the attest step would fail-close every fleet
    // self-update (integrity_unavailable) with CI still green — this is the pin.
    expect(WORKFLOW).toContain('attest-build-provenance');
    expect(WORKFLOW).toMatch(/subject-path:\s*bin\/\$\{\{ matrix\.artifact \}\}/);
  });

  test('expected builder ids name this workflow file on a trusted ref', () => {
    // verifyIntegrity accepts only attestations whose builder id is exactly
    // release.yml@<trusted ref>. If the workflow file is renamed or the ref
    // scheme changes, this test forces the constant to move in lockstep.
    for (const id of EXPECTED_BUILDER_IDS) {
      expect(id).toContain('/.github/workflows/release.yml@');
      const ref = id.split('@')[1]!;
      expect(ref.startsWith('refs/')).toBe(true);
    }
    // The workflow this repo actually ships from is the one the ids name.
    expect(EXPECTED_BUILDER_IDS.some((id) => id.endsWith('@refs/heads/master'))).toBe(true);
  });

  test('release builds the admin UI fresh from source before compiling', () => {
    // Supply-chain pin: the distributed binary's admin bundle must come from
    // admin/src (built in the release job), never from committed admin/dist
    // bytes. Deleting this step would silently re-trust the committed bundle.
    expect(WORKFLOW).toContain('bun run build:admin');
    expect(WORKFLOW).toMatch(/cd admin && bun install --frozen-lockfile/);
    // Cache key covers the admin lockfile so the fresh build is reproducible.
    expect(WORKFLOW).toContain("hashFiles('bun.lock', 'admin/bun.lock')");
    // Ordering: the admin build must run BEFORE the compile that embeds it.
    const adminIdx = WORKFLOW.indexOf('bun run build:admin');
    const compileIdx = WORKFLOW.indexOf('bun build --compile');
    expect(adminIdx).toBeGreaterThan(-1);
    expect(compileIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeLessThan(compileIdx);
  });

  test('template-repo push keeps the PAT out of argv (askpass, not URL-embedded)', () => {
    // The token must never ride the git command line: no
    // `https://x-access-token:${TEMPLATE_REPO_PAT}@...` remote URLs.
    expect(WORKFLOW).not.toContain('x-access-token:${TEMPLATE_REPO_PAT}@');
    expect(WORKFLOW).not.toMatch(/git push[^\n]*TEMPLATE_REPO_PAT/);
    // Credential travels out-of-band via a one-shot askpass reading env.
    expect(WORKFLOW).toContain('GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0');
    // Force-push semantics preserved (history-less template publish).
    expect(WORKFLOW).toMatch(/git push --force "https:\/\/github\.com\/\$\{TEMPLATE_REPO\}\.git" HEAD:main/);
  });
});

describe('release.yml ↔ gbrain engine install rust', () => {
  const job = (name: string) => {
    const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(-1);
    const next = WORKFLOW.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
    return WORKFLOW.slice(start, next < 0 ? undefined : start + 1 + next);
  };

  test('every release target is built on a native runner from the gated commit, with no build cache', () => {
    const build = job('rust-addon');
    for (const target of RELEASE_ADDON_TARGETS) expect(build).toContain(`addon_target: ${target}`);
    // The gated release commit; a dry run (ci-gate skipped) builds the dispatched commit.
    expect(build).toContain('ref: ${{ needs.ci-gate.outputs.sha || github.sha }}');
    expect(build).toContain('bun run rust:build');
    expect(build).toContain('bun rust/scripts/release-addon.ts stage --target "${{ matrix.addon_target }}"');
    expect(build).not.toContain('actions/cache');
  });

  test('the addons and their manifest are attested by this workflow and attached to the release', () => {
    const pkg = job('rust-addon-package');
    expect(pkg).toContain('attest-build-provenance');
    for (const asset of RUST_ADDON_ASSETS) {
      expect(pkg).toContain(`rust-addon/${asset}`);
      expect(job('release')).toContain(`artifacts/gbrain-engine-rust/${asset}`);
    }
    // Carried-forward bytes must come from this workflow on master, the only builder gbrain trusts (EXPECTED_BUILDER_IDS).
    expect(pkg).toContain('--source-ref refs/heads/master');
    expect(pkg).toContain('--cert-identity "https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@refs/heads/master"');
    expect(pkg).not.toContain('--signer-workflow');
    // A failed addon build blocks publication: the release job waits on the package job, which waits on every build.
    expect(job('release')).toMatch(/needs: \[[^\]]*rust-addon-package[^\]]*\]/);
    expect(pkg).toMatch(/needs: \[[^\]]*rust-addon[,\]]/);
  });

  test('after publication the released executable installs the addon and opens a Rust brain with no override', () => {
    const smoke = job('rust-addon-smoke');
    expect(smoke).toMatch(/needs: \[[^\]]*release[^\]]*\]/);
    for (const asset of EXPECTED_ASSETS) expect(smoke).toContain(`executable: ${asset}`);
    expect(smoke).toContain('unset GBRAIN_RUST_ENGINE_ADDON');
    expect(smoke).toContain('engine install rust --json');
    expect(smoke).toContain('.rust_addon.installed == true and .rust_addon.override == false and .probe.ok == true');
    expect(smoke).toContain('"$gbrain" stats --json');
    // The attestation read sends the job's read-only token: keyless calls share 60 an hour per runner IP.
    expect(smoke).toContain('GH_TOKEN: ${{ github.token }}');
    expect(smoke).toMatch(/permissions:\n\s+contents: read\n\s+attestations: read\n/);
  });
});

describe('release.yml addon_dry_run publishes nothing', () => {
  const doc = load(WORKFLOW) as any;
  const jobs = doc.jobs as Record<string, any>;
  /** The jobs a dry run may run: they read, build and test, and publish nothing. */
  const DRY_RUN_JOBS = ['version', 'build', 'rust-addon', 'rust-addon-package', 'rust-addon-dry-run-check'];
  /** Dry-run jobs that hold attestation permissions; their attest step is gated on !inputs.addon_dry_run. */
  const ATTESTING = ['build', 'rust-addon-package'];
  const publishes = (job: any) => {
    const perms = job.permissions ?? {};
    const text = JSON.stringify(job.steps ?? []);
    return perms.contents === 'write' || perms['id-token'] === 'write' || perms.attestations === 'write'
      || /action-gh-release|gh release (upload|create|edit)|git push|attest-build-provenance|npm publish|gh workflow run/.test(text);
  };

  test('the input defaults to false, and a dry run has its own concurrency group', () => {
    expect(doc.on.workflow_dispatch.inputs.addon_dry_run).toMatchObject({ type: 'boolean', default: false });
    expect(doc.concurrency.group).toBe("${{ inputs.addon_dry_run && 'release-addon-dry-run' || 'release' }}");
  });

  test('ci-gate is skipped on a dry run, and every other job needs publish true and no dry run', () => {
    expect(jobs['ci-gate'].if).toContain('!inputs.addon_dry_run');
    for (const [name, job] of Object.entries(jobs)) {
      if (DRY_RUN_JOBS.includes(name) || name === 'ci-gate') continue;
      expect({ name, gated: String(job.if).includes("needs.ci-gate.outputs.publish == 'true'") && String(job.if).includes('!inputs.addon_dry_run') }).toEqual({ name, gated: true });
    }
  });

  test('a job a dry run may run publishes only behind !inputs.addon_dry_run', () => {
    for (const name of DRY_RUN_JOBS) {
      for (const step of jobs[name].steps ?? []) {
        if (/attest-build-provenance|action-gh-release|gh release (upload|create)|git push/.test(JSON.stringify(step))) {
          expect({ name, step: step.name, if: step.if }).toEqual({ name, step: step.name, if: '${{ !inputs.addon_dry_run }}' });
        }
      }
      if (!ATTESTING.includes(name)) expect({ name, publishes: publishes(jobs[name]) }).toEqual({ name, publishes: false });
    }
    expect(jobs['rust-addon-dry-run-check'].if).toContain('inputs.addon_dry_run');
    expect(jobs['rust-addon-dry-run-check'].permissions).toEqual({ contents: 'read' });
  });

  test('a dry run builds and smoke-tests every platform binary, then runs it as a fresh install', () => {
    const build = jobs.build;
    expect(build.if).toContain('inputs.addon_dry_run ||');
    expect(build.if).toContain("needs.version.result == 'success'");
    expect(build.steps[0].with.ref).toBe('${{ inputs.addon_dry_run && github.sha || needs.ci-gate.outputs.sha }}');
    const names = (build.steps as any[]).map(s => String(s.name ?? s.uses));
    for (const smoke of ['Verify embedded native writer locks and compiled process exclusion', 'Verify the admin UI with the actual release executable', 'Smoke-test the compiled binary']) {
      expect({ smoke, gated: build.steps.find((s: any) => s.name === smoke)?.if }).toEqual({ smoke, gated: undefined });
    }
    const install = build.steps.find((s: any) => s.name === 'Run the binary as an install from an empty directory (dry run)');
    expect(install.if).toBe('${{ inputs.addon_dry_run }}');
    expect(install.run).toContain('--version');
    expect(install.run).toContain('doctor --json');
    expect(names.indexOf(install.name)).toBeLessThan(names.findIndex(n => n.includes('upload-artifact')));
    expect(jobs.release.if).toContain('!inputs.addon_dry_run');
  });
});

describe('scripts/changelog-entry.sh', () => {
  const FIXTURE = `# Changelog

## [0.42.67.0] - 2026-07-28

Release summary line.

### Fixed
- top entry fix

## [0.42.6] - 2026-07-27

### Added
- historical 3-segment entry
`;

  function run(version: string): { out: string; code: number } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-chlog-'));
    const file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, FIXTURE);
    try {
      const out = execFileSync('bash', [join(ROOT, 'scripts/changelog-entry.sh'), version, file], {
        encoding: 'utf-8',
      });
      return { out, code: 0 };
    } catch (e: any) {
      return { out: String(e.stdout ?? ''), code: e.status ?? 1 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('extracts exactly the requested entry, header excluded', () => {
    const { out, code } = run('0.42.67.0');
    expect(code).toBe(0);
    expect(out).toContain('top entry fix');
    expect(out).not.toContain('## [0.42.67.0]');
    expect(out).not.toContain('historical 3-segment entry');
  });

  test('extracts a non-top (historical 3-segment) entry', () => {
    const { out, code } = run('0.42.6');
    expect(code).toBe(0);
    expect(out).toContain('historical 3-segment entry');
    expect(out).not.toContain('top entry fix');
  });

  test('exits non-zero for a version with no entry', () => {
    expect(run('9.9.9.9').code).not.toBe(0);
  });

  test('a version that is a string prefix of another does not false-match', () => {
    // "0.42.67" is a prefix of "0.42.67.0" but has no entry of its own.
    expect(run('0.42.67').code).not.toBe(0);
  });
});

describe('scripts/changelog-entry.sh --pr-list', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' });
  }
  function commit(repo: string, subject: string, files: Record<string, string | null>): void {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git(repo, 'rm', '-q', path);
      else {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), text);
        git(repo, 'add', path);
      }
    }
    git(repo, 'commit', '-q', '-m', subject);
  }
  const section = (v: string, body: string) => `# Changelog\n\n## [${v}] - 2026-11-15\n\n${body}\n`;
  function fixture(): string {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-prlist-'));
    git(repo, 'init', '-q', '-b', 'master');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    commit(repo, 'v0.1.0.0 release (#1)', { VERSION: '0.1.0.0\n', 'CHANGELOG.md': section('0.1.0.0', 'First.'), 'changelog.d/README.md': 'How fragments work.\n' });
    git(repo, 'tag', 'v0.1.0.0');
    commit(repo, 'Sync is faster (#11)', { 'changelog.d/b-beta.md': '**Sync is faster.**\n\n### Changed\n- beta\n' });
    commit(repo, 'Search finds old pages again (#12)', { 'changelog.d/a-alpha.md': '---\nimportant: regression\n---\n**Search finds old pages again (#12).**\n\n### Fixed\n- alpha\n' });
    return repo;
  }
  function run(repo: string, ...args: string[]): string {
    return execFileSync('bash', [join(ROOT, 'scripts/changelog-entry.sh'), ...args], { cwd: repo, encoding: 'utf-8' });
  }

  test('opens the body with one line per folded fragment, in fold order, each with the PR that added it', () => {
    const repo = fixture();
    try {
      commit(repo, 'v0.1.1.0 release (#13)', { VERSION: '0.1.1.0\n', 'CHANGELOG.md': section('0.1.1.0', 'Folded text.'), 'changelog.d/a-alpha.md': null, 'changelog.d/b-beta.md': null });
      expect(run(repo, '--pr-list', '0.1.1.0')).toBe('- Search finds old pages again (#12)\n- Sync is faster (#11)\n\n\nFolded text.\n');
      expect(run(repo, '0.1.1.0')).toBe('\nFolded text.\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a release that never published is listed in the next one, a commit with no PR number gets a bare line, and a headline that cites another PR prints every number once in one bracket', () => {
    const repo = fixture();
    try {
      commit(repo, 'v0.1.1.0 release (#13)', { VERSION: '0.1.1.0\n', 'CHANGELOG.md': section('0.1.1.0', 'Unpublished.'), 'changelog.d/a-alpha.md': null, 'changelog.d/b-beta.md': null });
      commit(repo, 'Direct fix', { 'changelog.d/c-gamma.md': '**The test passes after a release.**\n' });
      commit(repo, 'Note the test fix (#14)', { 'changelog.d/d-delta.md': '**The notice test keeps passing after a release (#9).**\n' });
      commit(repo, 'v0.1.2.0 release (#15)', { VERSION: '0.1.2.0\n', 'CHANGELOG.md': section('0.1.2.0', 'Second.'), 'changelog.d/c-gamma.md': null, 'changelog.d/d-delta.md': null });
      expect(run(repo, '--pr-list', '0.1.2.0')).toBe('- Search finds old pages again (#12)\n- Sync is faster (#11)\n- The test passes after a release\n- The notice test keeps passing after a release (#9, #14)\n\n\nSecond.\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a headline that ends in an internal issue code drops the code and keeps the pull request bracket', () => {
    const repo = fixture();
    try {
      commit(repo, 'Doctor names the fix (GST-2731) (#21)', { 'changelog.d/e-eps.md': '**Doctor names the fix (GST-2731).**\n' });
      commit(repo, 'Direct note', { 'changelog.d/f-zeta.md': '**Import keeps calls apart (ABC-7)**\n' });
      commit(repo, 'Release notes cite issues (#22)', { 'changelog.d/g-eta.md': '**Release notes keep the (ENG-5) code they quote, and PROJECT-9 codes too (TOOLONG-3).**\n' });
      commit(repo, 'v0.1.1.0 release (#23)', { VERSION: '0.1.1.0\n', 'CHANGELOG.md': section('0.1.1.0', 'Folded.'), 'changelog.d/a-alpha.md': null, 'changelog.d/b-beta.md': null,
        'changelog.d/e-eps.md': null, 'changelog.d/f-zeta.md': null, 'changelog.d/g-eta.md': null });
      expect(run(repo, '--pr-list', '0.1.1.0')).toBe('- Search finds old pages again (#12)\n- Sync is faster (#11)\n- Doctor names the fix (#21)\n- Import keeps calls apart\n'
        + '- Release notes keep the (ENG-5) code they quote, and PROJECT-9 codes too (TOOLONG-3) (#22)\n\n\nFolded.\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a headline with body text after its closing ** on the same line prints the headline alone', () => {
    const repo = fixture();
    try {
      commit(repo, 'Purged pages stay purged (#31)', { 'changelog.d/h-theta.md': '---\nimportant: security\n---\n**A purged page stays purged after a restore.** When an owner purges a page, more text follows **here**.\n' });
      commit(repo, 'v0.1.1.0 release (#32)', { VERSION: '0.1.1.0\n', 'CHANGELOG.md': section('0.1.1.0', 'Folded.'), 'changelog.d/a-alpha.md': null, 'changelog.d/b-beta.md': null, 'changelog.d/h-theta.md': null });
      expect(run(repo, '--pr-list', '0.1.1.0')).toBe('- Search finds old pages again (#12)\n- Sync is faster (#11)\n- A purged page stays purged after a restore (#31)\n\n\nFolded.\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('with no earlier release tag the body is the plain entry', () => {
    const repo = fixture();
    try {
      git(repo, 'tag', '-d', 'v0.1.0.0');
      commit(repo, 'v0.1.1.0 release (#13)', { VERSION: '0.1.1.0\n', 'CHANGELOG.md': section('0.1.1.0', 'Folded text.'), 'changelog.d/a-alpha.md': null, 'changelog.d/b-beta.md': null });
      expect(run(repo, '--pr-list', '0.1.1.0')).toBe('\nFolded text.\n');
      expect(() => run(repo, '--pr-list', '9.9.9.9')).toThrow();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('release.yml publish-template skip is visible (D-10)', () => {
  test('an empty TEMPLATE_REPO_PAT warns with the owner-only fix and writes a step summary', async () => {
    const { load } = await import('js-yaml');
    const wf = load(WORKFLOW) as { jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }> };
    const gate = wf.jobs['publish-template']!.steps.find(s => s.id === 'gate')!.run!;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-publish-template-gate-'));
    try {
      const output = join(dir, 'output');
      const summary = join(dir, 'summary');
      writeFileSync(output, '');
      const stdout = execFileSync('bash', ['-euo', 'pipefail', '-c', gate], {
        cwd: ROOT, encoding: 'utf8',
        env: { PATH: process.env.PATH, TEMPLATE_REPO_PAT: '', TEMPLATE_REPO: 'owner/template-example', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      });
      expect(readFileSync(output, 'utf8')).toContain('publish=false');
      expect(stdout).toContain('::warning::Agent template NOT published to owner/template-example');
      expect(stdout).toContain('Fix (owner-only): gh secret set TEMPLATE_REPO_PAT');
      expect(readFileSync(summary, 'utf8')).toContain('## Agent template not published');
      expect(stdout).not.toContain('SKIP:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('which release GitHub calls Latest', () => {
  test('release.yml publishes every batch release as a pre-release that never becomes Latest', () => {
    const step = WORKFLOW.slice(WORKFLOW.indexOf('- name: Create release'), WORKFLOW.indexOf('- name: Advance latest-stable'));
    expect(step).toMatch(/^\s+prerelease: true$/m);
    expect(step).toMatch(/^\s+make_latest: 'false'$/m);
  });

  test('a hand re-run that repairs the current stable release refuses instead of turning it back into a pre-release', () => {
    const job = WORKFLOW.slice(WORKFLOW.indexOf('\n  release:\n'));
    const start = job.indexOf('- name: Refuse to republish the current stable release');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(job.indexOf('- name: Create release'));
    const step = job.slice(start, job.indexOf('- name: Create release'));
    expect(step).toContain('RELEASE_SHA: ${{ needs.ci-gate.outputs.sha }}');
    const script = step.slice(step.indexOf('run: |') + 'run: |'.length).split('\n').map(l => l.replace(/^ {10}/, '')).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'release-stable-guard-'));
    try {
      writeFileSync(join(dir, 'git'), '#!/bin/sh\n[ "$1 $2 $3" = "ls-remote origin refs/tags/stable^{}" ] || exit 9\nprintf "%s\\trefs/tags/stable^{}\\n" "$STABLE_SHA"\n', { mode: 0o755 });
      const runWith = (stable: string) => {
        try {
          return { code: 0, out: execFileSync('bash', ['-c', script], { env: { PATH: `${dir}:/usr/bin:/bin`, RELEASE_SHA: 'a'.repeat(40), RELEASE_VERSION: '0.60.722.0', STABLE_SHA: stable }, encoding: 'utf8', stdio: 'pipe' }) };
        } catch (e) {
          const err = e as { status: number; stdout: string; stderr: string };
          return { code: err.status, out: err.stdout + err.stderr };
        }
      };
      const stable = runWith('a'.repeat(40));
      expect(stable.code).toBe(1);
      expect(stable.out).toContain('v0.60.722.0 is the current stable release');
      expect(runWith('b'.repeat(40))).toEqual({ code: 0, out: '' });
      expect(runWith('')).toEqual({ code: 0, out: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no workflow reads releases/latest, and the macOS signature check takes its tag from latest-stable', () => {
    const dir = join(ROOT, '.github/workflows');
    for (const file of readdirSync(dir)) {
      const body = readFileSync(join(dir, file), 'utf8').split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
      expect({ file, reads: body.includes('releases/latest') }).toEqual({ file, reads: false });
    }
    const mac = readFileSync(join(dir, 'macos-validation.yml'), 'utf8');
    expect(mac).toContain('https://raw.githubusercontent.com/garrytan/gbrain/latest-stable/VERSION');
  });
});
