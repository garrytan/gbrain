import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');
const LOG_DIR = process.env.GBRAIN_TEST_INSTALL_LOG_DIR;

describe('isolated Bun-linked keyless installation lifecycle', () => {
  let home: string;
  let launcher: string;
  let env: Record<string, string>;
  let sequence = 0;

  function run(args: string[], command = launcher, cwd = home): string {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const log = `command: ${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nexit_status=${result.status}\nsignal=${result.signal}\nerror=${result.error?.message ?? ''}\n`;
    if (LOG_DIR) {
      mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(join(LOG_DIR, `${String(++sequence).padStart(2, '0')}-${args[0].replaceAll(/[^a-z-]/g, '')}.log`), log);
    }
    expect(result.status, log).toBe(0);
    return result.stdout;
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-install-lifecycle-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    for (const service of ['systemctl', 'launchctl', 'crontab', 'service']) {
      writeFileSync(join(bin, service), `#!/bin/sh\necho '${service}' >> "$HOME/unexpected-service.log"\nexit 91\n`, { mode: 0o755 });
    }
    const bunRoot = join(home, '.bun');
    launcher = join(bunRoot, 'bin', 'gbrain');
    env = {
      HOME: home,
      GBRAIN_HOME: home,
      BUN_INSTALL: bunRoot,
      PATH: `${bin}:${join(bunRoot, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
      GBRAIN_SELF_UPGRADE_MODE: 'off',
      GBRAIN_MODEL_DISCOVERY: 'off',
      GBRAIN_NO_AUTOPILOT_INSTALL: '1',
      GBRAIN_NO_REEMBED: '1',
      GBRAIN_SKIP_REFERENCE_SWEEP: '1',
    };
    run(['--no-env-file', 'link'], process.execPath, REPO);
    expect(realpathSync(launcher)).toBe(realpathSync(join(REPO, 'src', 'cli.ts')));
    expect(run(['--version'])).toContain(VERSION);
    run(['init', '--pglite', '--no-embedding']);
    run(['config', 'set', 'search.mode', 'conservative']);
    expect(run(['search', 'modes'])).toContain('Search mode (active): conservative');
  }, 120_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('writes, retrieves, and preserves memory across safe migrations and process restarts', () => {
    const keyword = `amberbadger${crypto.randomUUID().replaceAll('-', '')}`;
    const slug = 'concepts/install-example';
    const content = `---\ntitle: Installation Example\ntype: concept\n---\n# Installation Example\n\nThe ${keyword} retry budget is seven minutes.\n`;
    const write = JSON.parse(run(['call', 'put_page', JSON.stringify({ slug, content, source_id: 'default' })]));
    expect(write.state).toBe('committed');
    const read = JSON.parse(run(['get', slug, '--source', 'default', '--json']));
    expect(read.compiled_truth).toContain(keyword);
    const results = JSON.parse(run(['search', keyword, '--source', 'default', '--json']));
    expect(results.some((r: { slug: string; keyword_hit: boolean }) => r.slug === slug && r.keyword_hit)).toBe(true);
    const fact = `The example agent uses ${keyword} notebooks.`;
    const remembered = JSON.parse(run(['remember', fact, '--provenance', 'installation-fixture', '--entity', 'people/example', '--json']));
    expect(remembered.state).toBe('committed');
    const recalled = JSON.parse(run(['recall', 'people/example', '--json']));
    expect(recalled.facts.some((f: { fact: string; source: string }) => f.fact === fact && f.source === 'installation-fixture')).toBe(true);

    run(['apply-migrations', '--yes', '--migration', '0.11.0']);
    run(['post-upgrade', '--no-autopilot-install']);
    const ledgerPath = join(home, '.gbrain', 'migrations', 'completed.jsonl');
    const ledger = readFileSync(ledgerPath, 'utf8');
    const entries = ledger.trim().split('\n').map(line => JSON.parse(line));
    const first = entries.find(entry => entry.version === '0.11.0');
    expect(first.status).toBe('complete');
    expect(first.autopilot_installed).toBe(false);
    expect(first.phases).toContainEqual({ name: 'install', status: 'skipped', detail: '--no-autopilot-install' });
    expect(entries.every(entry => entry.status === 'complete')).toBe(true);
    run(['post-upgrade', '--no-autopilot-install']);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger);
    expect(existsSync(join(home, 'unexpected-service.log'))).toBe(false);
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'gbrain-autopilot.service'))).toBe(false);
    expect(existsSync(join(home, '.claude'))).toBe(false);
    expect(existsSync(join(home, '.codex'))).toBe(false);

    const reopened = JSON.parse(run(['get', slug, '--source', 'default', '--json']));
    expect(reopened.compiled_truth).toContain(keyword);
    const afterUpgrade = JSON.parse(run(['search', keyword, '--source', 'default', '--json']));
    expect(afterUpgrade.some((r: { slug: string; keyword_hit: boolean }) => r.slug === slug && r.keyword_hit)).toBe(true);
    expect(JSON.parse(run(['recall', 'people/example', '--json'])).facts.some((f: { fact: string }) => f.fact === fact)).toBe(true);
    const doctor = JSON.parse(run(['doctor', '--json']));
    for (const name of ['embedding_width_consistency', 'embedding_column_registry']) {
      expect(doctor.checks.find((c: { name: string }) => c.name === name)?.status, name).toBe('ok');
    }
    expect(JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).embedding_disabled).toBe(true);
  }, 180_000);
});
