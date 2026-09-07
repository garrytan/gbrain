import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, '../../scripts/ci-local.sh'), 'utf8');
const templateStart = source.indexOf("INNER_CMD=$(cat <<'EOF'");
const templateEnd = source.indexOf('\n# Conductor / git-worktree support:', templateStart);

describe('ci-local command rendering', () => {
  const cases = [
    { phaseExit: 0, missingTool: '' },
    { phaseExit: 7, missingTool: '' },
    ...['git', 'python3', 'ps', 'psql'].map(missingTool => ({ phaseExit: 0, missingTool })),
  ];
  for (const { phaseExit, missingTool } of cases) {
    test(`preserves stderr and exit ${phaseExit}; missing prerequisite ${missingTool || 'none'}`, () => {
      expect(templateStart).toBeGreaterThanOrEqual(0);
      expect(templateEnd).toBeGreaterThan(templateStart);
      const home = mkdtempSync(join(tmpdir(), 'gbrain-ci-render-'));
      try {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        // Execute the actual runner template, with installation/configuration
        // commands stubbed so this regression needs neither Docker nor root.
        for (const name of ['bun', 'git', 'python3', 'ps', 'psql']) {
          writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        }
        writeFileSync(join(bin, 'apt-get'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INSTALL_LOG"\n', { mode: 0o755 });
        const phaseLog = join(home, 'phase.log');
        const installLog = join(home, 'install.log');
        const phases = [
          'printf "%s\\n" "literal & marker"',
          'sh -c \'printf "%s\\n" "phase stdout"; printf "%s\\n" "phase stderr" >&2; exit "$1"\' _ "$PHASE_EXIT" >> "$PHASE_LOG" 2>&1',
          'printf "%s\\n" "phase completed"',
        ].join('\n');
        const script = [
          // Exercise Bash 5.2's replacement semantics when available; older
          // macOS Bash still runs the same rendering and redirection checks.
          'shopt -s patsub_replacement 2>/dev/null || true',
          // Hide exactly one prerequisite, even on a fully provisioned host.
          'command() { if [ "$1" = "-v" ] && [ "${2:-}" = "$FIXTURE_MISSING_TOOL" ]; then return 1; fi; builtin command "$@"; }',
          'export -f command',
          source.slice(templateStart, templateEnd),
          'bash -c "$INNER_CMD"',
        ].join('\n');
        const result = spawnSync('bash', ['-c', script], {
          cwd: home, encoding: 'utf8', timeout: 5_000,
          env: {
            ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
            RUN_PHASES_CMD: phases, PHASE_LOG: phaseLog, PHASE_EXIT: String(phaseExit),
            FIXTURE_MISSING_TOOL: missingTool, INSTALL_LOG: installLog,
          },
        });
        expect(result.status, result.stderr).toBe(phaseExit);
        expect(readFileSync(phaseLog, 'utf8')).toBe('phase stdout\nphase stderr\n');
        expect(result.stdout).toContain('literal & marker');
        expect(result.stdout.includes('phase completed')).toBe(phaseExit === 0);
        expect(existsSync(join(home, '__RUN_PHASES__1'))).toBe(false);
        if (missingTool) {
          expect(readFileSync(installLog, 'utf8')).toBe('update -qq\ninstall -y -qq git ca-certificates python3 procps postgresql-client\n');
        } else {
          expect(existsSync(installLog)).toBe(false);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

function runPhases(noShard: boolean, diff: boolean, failStage = '') {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-ci-phases-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    mkdirSync(join(home, 'scripts'));
    const trace = join(home, 'trace');
    const put = (path: string, body: string) => writeFileSync(join(home, path), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    for (const name of ['git', 'python3', 'ps', 'psql', 'apt-get']) put(`bin/${name}`, 'exit 0');
    put('bin/bun', `
case "$*" in
  "run scripts/select-e2e.ts") printf '%s\\n' test/e2e/one.test.ts test/e2e/two.test.ts; exit 0 ;;
  "run typecheck") stage=verify ;;
  "run test:serial") stage=serial ;;
  "run test:slow") stage=slow ;;
  *) exit 0 ;;
esac
printf '%s:%s\\n' "$stage" "\${DATABASE_URL-unset}" >> "$TRACE"
[ "$FAIL_STAGE" != "$stage" ] || exit 7
`);
    for (const script of ['check-jsonb-pattern.sh', 'check-progress-to-stdout.sh', 'check-trailing-newline.sh', 'check-wasm-embedded.sh']) {
      put(`scripts/${script}`, 'exit 0');
    }
    put('scripts/run-unit-shard.sh', `
printf 'unit:%s:%s\\n' "\${SHARD-all}" "\${DATABASE_URL-unset}" >> "$TRACE"
printf '%s\\n' 'early diagnostic retained beyond summary tail' >&2
for line in {1..35}; do printf 'fixture progress %s\\n' "$line"; done
[ -z "\${DATABASE_URL:-}" ] || exit 41
[ "$FAIL_STAGE" != unit ] || exit 7
`);
    put('scripts/run-e2e.sh', `
set -eu
case "$DATABASE_URL" in postgresql://postgres:postgres@postgres-*:5432/gbrain_test) ;; *) exit 42 ;; esac
[ "$GBRAIN_PGBOUNCER_URL" = postgresql://postgres:postgres@pgbouncer:5432/gbrain_pgbouncer ] || exit 43
[ "$GBRAIN_PGBOUNCER_DIRECT_URL" = postgresql://postgres:postgres@postgres-1:5432/gbrain_test ] || exit 44
[ "$GBRAIN_CI_REQUIRE_PGBOUNCER" = 1 ] || exit 45
[ "$GBRAIN_TEST_DB" = 1 ] || exit 46
printf 'e2e:%s:%s\\n' "\${SHARD-all}" "$*" >> "$TRACE"
[ "$FAIL_STAGE" != e2e ] || exit 7
`);
    const start = source.indexOf('# Step 4: build the runner-side command.');
    expect(start).toBeGreaterThanOrEqual(0);
    const script = source.slice(start, templateEnd)
      .replaceAll('/tmp/shard-logs', join(home, 'shard-logs'))
      .replaceAll('/tmp/e2e-selected.txt', join(home, 'selected.txt'));
    const result = spawnSync('bash', ['-c', `${script}\nbash -c "$INNER_CMD"`], {
      cwd: home, encoding: 'utf8', timeout: 5_000,
      env: {
        ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, TRACE: trace,
        NO_SHARD: noShard ? '1' : '0', DIFF: diff ? '1' : '0', FAIL_STAGE: failStage,
        DATABASE_URL: 'ambient-fixture', GBRAIN_DATABASE_URL: 'ambient-fixture',
        GBRAIN_TEST_DB: 'ambient-must-be-overridden',
      },
    });
    const archivedLogs = [1, 2, 3, 4].map(shard => {
      const path = join(home, '.context/ci-local-shards', `shard-${shard}.log`);
      return existsSync(path) ? readFileSync(path, 'utf8') : '';
    });
    return { ...result, archivedLogs, trace: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [] };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('ci-local execution coverage', () => {
  for (const noShard of [false, true]) {
    for (const diff of [false, true]) {
      test(`serial and slow precede unit/E2E with live target forwarding (no-shard=${noShard}, diff=${diff})`, () => {
        const result = runPhases(noShard, diff);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.trace.slice(0, 3)).toEqual(['verify:ambient-fixture', 'serial:unset', 'slow:unset']);
        const units = result.trace.filter(line => line.startsWith('unit:'));
        const e2e = result.trace.filter(line => line.startsWith('e2e:'));
        expect(units).toHaveLength(noShard ? 1 : 4);
        expect(units.every(line => line.endsWith(':unset'))).toBe(true);
        expect(e2e).toHaveLength(noShard ? 1 : 4);
        if (diff) expect(e2e.every(line => line.endsWith('test/e2e/one.test.ts test/e2e/two.test.ts'))).toBe(true);
        if (!noShard) {
          expect(result.stdout).toContain('Complete shard logs saved to .context/ci-local-shards/');
          for (const log of result.archivedLogs) {
            expect(log).toContain('early diagnostic retained beyond summary tail');
            expect(log).toContain('DONE');
          }
        }
      });
    }
  }

  for (const failStage of ['verify', 'serial', 'slow', 'unit', 'e2e']) {
    test(`a failed ${failStage} stage cannot produce a green local CI result`, () => {
      const result = runPhases(false, false, failStage);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('All 4 shards passed');
      if (failStage !== 'e2e') expect(result.trace.some(line => line.startsWith('e2e:'))).toBe(false);
      if (['verify', 'serial', 'slow'].includes(failStage)) {
        expect(result.status).toBe(7);
        expect(result.trace.some(line => line.startsWith('unit:'))).toBe(false);
      } else {
        for (const log of result.archivedLogs) {
          expect(log).toContain('early diagnostic retained beyond summary tail');
          expect(log).toContain(`${failStage.toUpperCase()} FAILED`);
        }
      }
    });
  }

  for (const gitleaks of ['missing', 'success', 'failure']) {
    test(`doc-only diff requires a successful gitleaks scan (${gitleaks})`, () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-ci-docs-'));
      try {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        mkdirSync(join(home, 'scripts'));
        writeFileSync(join(bin, 'bun'), '#!/bin/sh\necho DOC_ONLY\n', { mode: 0o755 });
        writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SCAN_LOG"\n[ "$SCAN_MODE" != failure ]\n', { mode: 0o755 });
        const end = source.indexOf('# Pre-flight: postgres host ports');
        const script = `command() { if [ "$1" = -v ] && [ "\${2:-}" = gitleaks ] && [ "$SCAN_MODE" = missing ]; then return 1; fi; builtin command "$@"; }\n${source.slice(0, end)}`;
        const log = join(home, 'scans');
        const result = spawnSync('bash', ['-c', script, join(home, 'scripts/ci-local.sh'), '--diff'], {
          encoding: 'utf8', timeout: 5_000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SCAN_MODE: gitleaks, SCAN_LOG: log },
        });
        expect(result.status, result.stderr).toBe(gitleaks === 'success' ? 0 : 1);
        const scans = existsSync(log) ? readFileSync(log, 'utf8') : '';
        expect(scans).toBe(gitleaks === 'success' ? 'dir\ngit\n' : gitleaks === 'failure' ? 'dir\n' : '');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe('required PgBouncer execution through run-e2e', () => {
  for (const [required, passes, testExit, expectedExit, parentCoverageExists] of [
    [true, 2, 0, 0, false],
    [true, 0, 0, 1, false],
    [true, 0, 3, 1, false],
    [false, 0, 0, 0, false],
    [true, 2, 0, 0, true],
  ] as const) {
    test(`required=${required}, executed=${passes}, Bun exit=${testExit}, parent coverage exists=${parentCoverageExists}`, () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-ci-pooler-'));
      try {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        mkdirSync(join(home, 'scripts/lib'), { recursive: true });
        const script = readFileSync(join(import.meta.dir, '../../scripts/run-e2e.sh'), 'utf8');
        writeFileSync(join(home, 'scripts/run-e2e.sh'), script);
        writeFileSync(join(home, 'scripts/lib/test-env.sh'), 'ensure_pglite_snapshot() { :; }\n');
        writeFileSync(join(bin, 'psql'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'bun'), `#!/bin/sh
printf '%s\\n' "$GBRAIN_PGBOUNCER_URL" "$GBRAIN_PGBOUNCER_DIRECT_URL" "$GBRAIN_CI_REQUIRE_PGBOUNCER" "$GBRAIN_TEST_DB" "\${GBRAIN_SOURCE-unset}" "\${COVERAGE_DIR:-disabled}" > "$ENV_REPORT"
printf ' %s pass\\n 0 fail\\n' "$FAKE_PASSES"
exit "$FAKE_EXIT"
`, { mode: 0o755 });
        const report = join(home, 'environment');
        const pooled = 'postgresql://localhost:6543/gbrain_pgbouncer';
        const direct = 'postgresql://localhost:5434/gbrain_test';
        const parentCoverage = join(home, 'parent-coverage');
        const parentManifest = join(parentCoverage, 'lane-manifest.json');
        const manifestBefore = '{"lane":"shard-1","complete":true}\n';
        if (parentCoverageExists) {
          mkdirSync(parentCoverage);
          writeFileSync(parentManifest, manifestBefore);
        }
        // Model hosted CI even when this test runs locally: nested fake Bun
        // must neither collect into nor overwrite the outer unit lane.
        const inheritedEnv = { ...process.env, COVERAGE_DIR: parentCoverage };
        const result = spawnSync('bash', [join(home, 'scripts/run-e2e.sh'), 'test/e2e/pgbouncer-teardown.test.ts'], {
          cwd: home, encoding: 'utf8', timeout: 5_000,
          env: {
            ...inheritedEnv, HOME: home, PATH: `${bin}:${process.env.PATH}`,
            // This child intentionally exercises one selected file. The outer
            // unit shard must not repartition it into an empty E2E selection.
            SHARD: '',
            COVERAGE_DIR: '',
            DATABASE_URL: direct, GBRAIN_PGBOUNCER_URL: pooled, GBRAIN_PGBOUNCER_DIRECT_URL: direct,
            GBRAIN_CI_REQUIRE_PGBOUNCER: required ? '1' : '0', GBRAIN_SOURCE: 'ambient-must-be-removed',
            GBRAIN_TEST_DB: '1',
            ENV_REPORT: report, FAKE_PASSES: String(passes), FAKE_EXIT: String(testExit),
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(expectedExit);
        expect(readFileSync(report, 'utf8')).toBe(`${pooled}\n${direct}\n${required ? '1' : '0'}\n1\nunset\ndisabled\n`);
        if (parentCoverageExists) expect(readFileSync(parentManifest, 'utf8')).toBe(manifestBefore);
        else expect(existsSync(parentCoverage)).toBe(false);
        if (required && passes === 0 && testExit === 0) expect(result.stdout).toContain('required PgBouncer tests did not execute');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
