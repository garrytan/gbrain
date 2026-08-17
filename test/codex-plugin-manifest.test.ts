/**
 * Codex + Claude Code plugin lane manifests — the packaging contract.
 *
 * Mirrors test/openclaw-plugin-manifest.test.ts for the two new lanes:
 * version lockstep across every plugin manifest, exact MCP declarations
 * (starter surface + --source-guard), launcher static AND behavioral
 * invariants (every resolver branch), marketplace content-equivalence
 * (codex reads BOTH marketplace formats — divergence would fork the
 * install), curated-tree membership algebra, and the derived env_vars
 * contract (the manifest chases the code, not a hand-list).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const ROOT = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));

const pkg = json('package.json');
const codexPlugin = json('.codex-plugin/plugin.json');
const codexMcp = json('.codex-plugin/mcp.json');
const claudePlugin = json('.claude-plugin/plugin.json');
const codexMarketplace = json('.agents/plugins/marketplace.json');
const claudeMarketplace = json('.claude-plugin/marketplace.json');
const openclawPlugin = json('openclaw.plugin.json');
const lanes = json('skills/plugin-lanes.json');

const LAUNCHER = './.agents/gbrain-launcher';
const EXPECTED_ARGS = ['serve', '--surface', 'starter', '--source-guard'];

describe('version lockstep (the merge-drift catcher)', () => {
  test('every plugin manifest ships at the repo version', () => {
    expect(codexPlugin.version).toBe(pkg.version);
    expect(claudePlugin.version).toBe(pkg.version);
    expect(openclawPlugin.version).toBe(pkg.version);
  });
});

describe('codex plugin.json', () => {
  test('skill tree and mcp pointers', () => {
    expect(codexPlugin.name).toBe('gbrain');
    expect(codexPlugin.skills).toBe('./plugin/skills/');
    expect(codexPlugin.mcpServers).toBe('./.codex-plugin/mcp.json');
  });

  test('interface block is complete and non-trivial', () => {
    const i = codexPlugin.interface;
    for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category'] as const) {
      expect(typeof i[field]).toBe('string');
      expect(i[field].length).toBeGreaterThan(3);
    }
    expect(i.longDescription.length).toBeGreaterThan(100);
    // The longDescription is the recovery path's storefront: it must carry
    // the pinned install ref and the init requirement.
    expect(i.longDescription).toContain('github:garrytan/gbrain#latest-stable');
    expect(i.longDescription).toContain('gbrain init');
  });
});

describe('codex mcp.json', () => {
  const server = codexMcp.mcpServers?.gbrain;

  test('exactly one server, exact command/args/cwd', () => {
    expect(Object.keys(codexMcp.mcpServers)).toEqual(['gbrain']);
    expect(server.command).toBe(LAUNCHER);
    expect(server.args).toEqual(EXPECTED_ARGS);
    expect(server.cwd).toBe('.');
  });

  test('deny-unknown-fields: only observed codex keys', () => {
    expect(Object.keys(server).sort()).toEqual(['args', 'command', 'cwd', 'env_vars']);
    expect(Object.keys(codexMcp)).toEqual(['mcpServers']);
  });

  test('env_vars ⊇ the derived env contract (manifest chases the code)', () => {
    // Derivation scope: the config plane + gateway construction + the
    // capability/recipe modules that read provider keys from the merged
    // gateway env. Three patterns: process.env.X literals, quoted
    // *_API_KEY/*_BASE_URL string literals, and bare *_API_KEY/*_BASE_URL
    // property tokens (the GEMINI_API_KEY alias is read as a property).
    const modules = [
      'src/core/config.ts',
      'src/core/ai/build-gateway-config.ts',
      'src/core/ai/gateway.ts',
      'src/core/capability.ts',
      'src/core/transcription.ts',
      ...readdirSync(join(ROOT, 'src/core/ai/recipes'))
        .filter(f => f.endsWith('.ts'))
        .map(f => `src/core/ai/recipes/${f}`),
    ];
    const derived = new Set<string>();
    for (const m of modules) {
      const text = read(m);
      for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) derived.add(match[1]);
      for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]*_(?:API_KEY|BASE_URL))\b/g)) derived.add(match[1]);
    }
    // Routing + launcher names the plugin lane depends on.
    for (const extra of ['GBRAIN_BIN', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID', 'GBRAIN_SURFACE', 'GBRAIN_MCP_FORCE_SURFACE', 'PATH', 'HOME']) {
      derived.add(extra);
    }
    // Bare-token false positives: ALL-CAPS identifiers that match the env
    // shape but are not env vars. Each entry names its real role.
    derived.delete('NO_ANTHROPIC_API_KEY'); // gateway error CODE, not an env name
    const declared = new Set<string>(server.env_vars);
    const missing = [...derived].filter(name => !declared.has(name)).sort();
    expect(missing).toEqual([]);
    // And the list stays sorted so diffs are reviewable.
    expect(server.env_vars).toEqual([...server.env_vars].sort());
  });
});

describe('claude plugin.json', () => {
  test('inline mcpServers with the shared launcher via ${CLAUDE_PLUGIN_ROOT}', () => {
    const server = claudePlugin.mcpServers?.gbrain;
    expect(Object.keys(claudePlugin.mcpServers)).toEqual(['gbrain']);
    expect(server.command).toBe('${CLAUDE_PLUGIN_ROOT}/.agents/gbrain-launcher');
    expect(server.args).toEqual(EXPECTED_ARGS);
    // cwd pinned to the plugin root for guard-premise parity with codex —
    // both lanes' serve cwd is the (source-routing-meaningless) snapshot dir,
    // so --source-guard's "cwd is meaningless" premise holds identically.
    expect(server.cwd).toBe('${CLAUDE_PLUGIN_ROOT}');
  });

  test('skill tree pointer matches the codex lane', () => {
    expect(claudePlugin.skills).toBe('./plugin/skills/');
    expect(claudePlugin.name).toBe('gbrain');
  });
});

describe('marketplace shape (deliberately asymmetric — prove-before-publish)', () => {
  test('claude marketplace: full plugin + the two persona variants', () => {
    expect(claudeMarketplace.name).toBe('gbrain');
    expect(claudeMarketplace.plugins).toHaveLength(3);
    const byName = Object.fromEntries(claudeMarketplace.plugins.map((p: { name: string }) => [p.name, p]));
    expect(byName['gbrain'].source).toBe('./');
    expect(byName['gbrain-coding'].source).toBe('./plugin-variants/gbrain-coding');
    expect(byName['gbrain-daily'].source).toBe('./plugin-variants/gbrain-daily');
  });

  test('codex marketplace stays at ONE plugin until its multi-plugin observation run', () => {
    // Codex's installer handling of multi-entry marketplaces is unverified —
    // a doc "provisional" flag gates nothing once an entry is installable, so
    // the entries themselves wait for the observation-run follow-up.
    expect(codexMarketplace.name).toBe('gbrain');
    expect(codexMarketplace.plugins).toHaveLength(1);
    expect(codexMarketplace.plugins[0].name).toBe('gbrain');
    expect(codexMarketplace.plugins[0].source).toEqual({ source: 'local', path: './' });
  });

  test('marketplace variant entries match the personas block exactly', () => {
    const personaPluginNames = Object.values(
      (lanes.personas ?? {}) as Record<string, { plugin_name: string }>,
    )
      .map(p => p.plugin_name)
      .sort();
    const claudeVariantNames = claudeMarketplace.plugins
      .map((p: { name: string }) => p.name)
      .filter((n: string) => n !== 'gbrain')
      .sort();
    expect(claudeVariantNames).toEqual(personaPluginNames);
  });
});

describe('persona variant trees (committed, generated, self-contained)', () => {
  const personas: Record<string, { plugin_name: string; skills: Record<string, string> }> = lanes.personas ?? {};

  test('personas block exists with the two launch personas', () => {
    expect(Object.keys(personas).sort()).toEqual(['coding-agent', 'daily-driver']);
  });

  for (const [personaName, def] of Object.entries(personas)) {
    describe(`variant ${def.plugin_name} (persona ${personaName})`, () => {
      const root = join('plugin-variants', def.plugin_name);

      test('version lockstep + retargeted manifests', () => {
        const claudeVariant = json(`${root}/.claude-plugin/plugin.json`);
        const codexVariant = json(`${root}/.codex-plugin/plugin.json`);
        expect(claudeVariant.version).toBe(pkg.version);
        expect(codexVariant.version).toBe(pkg.version);
        expect(claudeVariant.name).toBe(def.plugin_name);
        expect(codexVariant.name).toBe(def.plugin_name);
        expect(claudeVariant.skills).toBe('./skills/');
        expect(codexVariant.skills).toBe('./skills/');
        // Same MCP server name as the full plugin (tool names stay
        // mcp__gbrain__*) — docs say install exactly one gbrain plugin.
        expect(Object.keys(claudeVariant.mcpServers)).toEqual(['gbrain']);
        expect(claudeVariant.mcpServers.gbrain.command).toBe('${CLAUDE_PLUGIN_ROOT}/.agents/gbrain-launcher');
        expect(claudeVariant.mcpServers.gbrain.args).toEqual(EXPECTED_ARGS);
      });

      test('mcp.json is byte-identical to the root lane manifest', () => {
        expect(read(`${root}/.codex-plugin/mcp.json`)).toBe(read('.codex-plugin/mcp.json'));
      });

      test('self-contained launcher, executable', () => {
        const p = join(ROOT, root, '.agents', 'gbrain-launcher');
        expect(statSync(p).mode & 0o111).toBeGreaterThan(0);
        expect(readFileSync(p, 'utf8')).toBe(read('.agents/gbrain-launcher'));
      });

      test('skills dirs == persona slugs + shared conventions', () => {
        const entries = readdirSync(join(ROOT, root, 'skills'), { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
        expect(dirs).toEqual([...Object.keys(def.skills), 'conventions'].sort());
        const files = entries.filter(e => e.isFile()).map(e => e.name);
        expect(files).toContain('_output-rules.md');
        expect(files).toContain('_brain-filing-rules.md');
      });

      test('README carries the version stamp and the one-plugin rule', () => {
        const readme = read(`${root}/README.md`);
        expect(readme).toContain(`<!-- gbrain-plugin-tree-stamp: ${pkg.version} -->`);
        expect(readme).toContain('exactly ONE gbrain plugin');
      });
    });
  }
});

describe('launcher (static)', () => {
  const launcherPath = join(ROOT, '.agents/gbrain-launcher');
  const text = readFileSync(launcherPath, 'utf8');

  test('exists, executable, /bin/sh', () => {
    expect(statSync(launcherPath).mode & 0o111).toBeGreaterThan(0);
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
  });

  test('carries the sanctioned install ref, never the squatted npm name', () => {
    expect(text).toContain('github:garrytan/gbrain#latest-stable');
    expect(text).not.toMatch(/npm install -g gbrain(?!['\w-])(?![^\n]*unrelated)/);
  });

  test('the two NEW manifests reference the same launcher path (openclaw intentionally differs)', () => {
    expect(codexMcp.mcpServers.gbrain.command).toBe(LAUNCHER);
    expect(claudePlugin.mcpServers.gbrain.command).toBe('${CLAUDE_PLUGIN_ROOT}/.agents/gbrain-launcher');
    expect(openclawPlugin.mcpServers.gbrain.command).toBe('./bin/gbrain');
  });
});

describe('launcher (behavioral — every resolver branch, hermetic HOME)', () => {
  const launcher = join(ROOT, '.agents/gbrain-launcher');

  // HOME is pinned to a tempdir in EVERY case: without it the ~/.bun/bin
  // fallback would exec the dev machine's real gbrain against their brain.
  function run(env: Record<string, string>, args: string[], home: string) {
    return spawnSync(launcher, args, {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin', ...env },
      timeout: 10_000,
    });
  }

  function stubDir(): { dir: string; stub: string } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-launcher-test-'));
    const stub = join(dir, 'gbrain');
    writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
    chmodSync(stub, 0o755);
    return { dir, stub };
  }

  test('(a) miss → exit 127 with the recovery copy', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-launcher-home-'));
    try {
      const r = run({}, ['serve'], home);
      expect(r.status).toBe(127);
      expect(r.stderr).toContain('bun install -g github:garrytan/gbrain#latest-stable');
      expect(r.stderr).toContain('setup');
      expect(r.stderr).toContain('GBRAIN_BIN');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('(b) GBRAIN_BIN → exec with the manifest argv + resolution line', () => {
    const { dir, stub } = stubDir();
    try {
      const r = run({ GBRAIN_BIN: stub }, EXPECTED_ARGS, dir);
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(EXPECTED_ARGS);
      expect(r.stderr).toContain(`using ${stub}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(c) non-executable GBRAIN_BIN → exit 127 named error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-launcher-test-'));
    try {
      const notExec = join(dir, 'notexec');
      writeFileSync(notExec, '');
      const r = run({ GBRAIN_BIN: notExec }, ['serve'], dir);
      expect(r.status).toBe(127);
      expect(r.stderr).toContain('not an executable file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(d) GBRAIN_SURFACE substitutes an existing --surface value', () => {
    const { dir, stub } = stubDir();
    try {
      const r = run({ GBRAIN_BIN: stub, GBRAIN_SURFACE: 'full' }, EXPECTED_ARGS, dir);
      expect(r.stdout.trim().split('\n')).toEqual(['serve', '--surface', 'full', '--source-guard']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(e) GBRAIN_SURFACE appends when argv lacks --surface', () => {
    const { dir, stub } = stubDir();
    try {
      const r = run({ GBRAIN_BIN: stub, GBRAIN_SURFACE: 'verbs' }, ['serve'], dir);
      expect(r.stdout.trim().split('\n')).toEqual(['serve', '--surface', 'verbs']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(f) PATH resolution (no GBRAIN_BIN)', () => {
    const { dir, stub } = stubDir();
    try {
      const r = spawnSync(launcher, ['serve'], {
        encoding: 'utf8',
        env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin` },
        timeout: 10_000,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`using ${stub}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(g) ~/.bun/bin fallback via temp HOME (empty PATH hit)', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-launcher-home-'));
    try {
      const bunBin = join(home, '.bun', 'bin');
      spawnSync('mkdir', ['-p', bunBin]);
      const stub = join(bunBin, 'gbrain');
      writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
      chmodSync(stub, 0o755);
      const r = run({}, ['serve'], home);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`using ${stub}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('curated tree membership + scanner guard', () => {
  const base: string[] = openclawPlugin.skills.map((s: string) => s.replace(/^skills\//, ''));
  const laneSet = new Set([
    ...base.filter(s => !(s in lanes.base_exclusions)),
    ...Object.keys(lanes.additions),
  ]);

  test('plugin/skills dirs == lane set + shared conventions', () => {
    const entries = readdirSync(join(ROOT, 'plugin/skills'), { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    expect(dirs).toEqual([...laneSet, 'conventions'].sort());
    // Shared top-level deps ship alongside (mirrors openclaw shared_deps).
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    expect(files).toContain('_output-rules.md');
    expect(files).toContain('_brain-filing-rules.md');
  });

  test('every bundled SKILL.md has frontmatter name === dir + a real description', () => {
    for (const slug of laneSet) {
      const text = read(`plugin/skills/${slug}/SKILL.md`);
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      expect(fm, `${slug}: missing frontmatter`).toBeTruthy();
      const name = fm![1].match(/^name:\s*(\S+)\s*$/m);
      expect(name?.[1], `${slug}: frontmatter name mismatch`).toBe(slug);
      expect(/^description:/m.test(fm![1]), `${slug}: missing description`).toBe(true);
    }
  });

  test('non-skill dirs carry no SKILL.md (the scanner never grows a surprise skill)', () => {
    expect(existsSync(join(ROOT, 'plugin/skills/conventions/SKILL.md'))).toBe(false);
    expect(existsSync(join(ROOT, 'skills/conventions/SKILL.md'))).toBe(false);
    expect(existsSync(join(ROOT, 'skills/migrations/SKILL.md'))).toBe(false);
  });

  test('every source skills/<dir>/SKILL.md is frontmatter-valid and manifest-listed', () => {
    const manifest = json('skills/manifest.json');
    const manifestNames = new Set(manifest.skills.map((s: { name: string }) => s.name));
    for (const entry of readdirSync(join(ROOT, 'skills'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(ROOT, 'skills', entry.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue; // conventions/, migrations/, recipes …
      const fm = readFileSync(skillMd, 'utf8').match(/^---\n([\s\S]*?)\n---/);
      expect(fm, `skills/${entry.name}: frontmatterless SKILL.md breaks plugin scanners`).toBeTruthy();
      expect(manifestNames.has(entry.name), `skills/${entry.name}: SKILL.md exists but not in manifest.json`).toBe(true);
    }
  });

  test('generator round-trip: curation record valid + starter_gaps snapshot fresh', () => {
    const out = mkdtempSync(join(tmpdir(), 'gbrain-plugin-tree-'));
    try {
      const r = spawnSync('bun', ['run', join(ROOT, 'scripts/generate-plugin-tree.ts'), '--out', join(out, 'plugin')], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('generator negative fixtures (a guard that cannot fail is not coverage)', () => {
  function fixtureRoot(lanes: Record<string, unknown>, betaTools: string[] = []): string {
    const root = mkdtempSync(join(tmpdir(), 'gb-lanes-fixture-'));
    writeFileSync(join(root, 'VERSION'), '0.0.0.0\n');
    // name/version present so loadBundleManifest (persona validation path)
    // accepts the fixture; the generator's own read only uses .skills.
    writeFileSync(
      join(root, 'openclaw.plugin.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0.0', skills: ['skills/alpha'], shared_deps: [] }),
    );
    mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(root, 'skills', 'beta'), { recursive: true });
    mkdirSync(join(root, 'skills', 'conventions'), { recursive: true });
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: fixture skill\n---\n# alpha\n');
    const toolsBlock = betaTools.length ? `tools:\n${betaTools.map(t => `  - ${t}`).join('\n')}\n` : '';
    writeFileSync(join(root, 'skills', 'beta', 'SKILL.md'), `---\nname: beta\ndescription: fixture skill\n${toolsBlock}---\n# beta\n`);
    writeFileSync(join(root, 'skills', 'manifest.json'), JSON.stringify({ skills: [{ name: 'alpha' }, { name: 'beta' }] }));
    writeFileSync(
      join(root, 'skills', 'plugin-lanes.json'),
      JSON.stringify({ starter_policy: 'x', additions: {}, base_exclusions: {}, not_added: {}, starter_gaps: {}, ...lanes }),
    );
    return root;
  }

  function runGenerator(root: string) {
    const out = join(root, 'out');
    return spawnSync('bun', ['run', join(ROOT, 'scripts/generate-plugin-tree.ts'), '--out', out], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, GBRAIN_PLUGIN_TREE_ROOT: root },
    });
  }

  test('a sub-10-char curation reason fails', () => {
    const root = fixtureRoot({ additions: { beta: 'short' } });
    try {
      const r = runGenerator(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('needs a real reason');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an addition already in the openclaw base fails', () => {
    const root = fixtureRoot({ additions: { alpha: 'a reason long enough to pass the length check' } });
    try {
      const r = runGenerator(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('already in the openclaw base');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a stale starter_gaps snapshot fails with the refresh instruction', () => {
    // beta declares a beyond-starter MCP op but the recorded snapshot is empty.
    const root = fixtureRoot(
      { additions: { beta: 'a reason long enough to pass the length check' } },
      ['add_link'],
    );
    try {
      const r = runGenerator(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('starter_gaps snapshot');
      expect(r.stderr).toContain('--write-gaps');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Persona negative fixtures (validation shared with the CLI) ──────────
  const validPersona = {
    description: 'a fixture persona description long enough',
    plugin_name: 'gbrain-fixture',
    skills: { alpha: 'a fixture reason long enough to pass' },
  };

  test('a persona slug outside the lane set fails', () => {
    const root = fixtureRoot({
      personas: { fixture: { ...validPersona, skills: { beta: 'a fixture reason long enough to pass' } } },
    });
    try {
      const r = runGenerator(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('not in the plugin lane set');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the reserved persona name 'all' fails", () => {
    const root = fixtureRoot({ personas: { all: validPersona } });
    try {
      const r = runGenerator(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('reserved name');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a duplicate plugin_name across personas fails', () => {
    const root = fixtureRoot({
      personas: { one: validPersona, two: { ...validPersona, description: 'another fixture persona description' } },
    });
    try {
      const r = runGenerator(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('already used by persona');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a sub-10-char persona skill reason fails', () => {
    const root = fixtureRoot({
      personas: { fixture: { ...validPersona, skills: { alpha: 'short' } } },
    });
    try {
      const r = runGenerator(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('recorded reason of at least');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--write-gaps spread-preserves the personas block byte-for-byte [OV8]', () => {
    const root = fixtureRoot({ personas: { fixture: validPersona } });
    try {
      const before = JSON.stringify(
        (JSON.parse(readFileSync(join(root, 'skills', 'plugin-lanes.json'), 'utf8')) as { personas: unknown }).personas,
      );
      const out = join(root, 'out');
      const r = spawnSync(
        'bun',
        ['run', join(ROOT, 'scripts/generate-plugin-tree.ts'), '--out', out, '--write-gaps'],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GBRAIN_PLUGIN_TREE_ROOT: root } },
      );
      expect(r.status, r.stderr).toBe(0);
      const after = JSON.stringify(
        (JSON.parse(readFileSync(join(root, 'skills', 'plugin-lanes.json'), 'utf8')) as { personas: unknown }).personas,
      );
      expect(after).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--variants-out refuses to delete a non-generated non-empty directory (rmSync guard)', () => {
    const root = fixtureRoot({ personas: { fixture: validPersona } });
    try {
      const precious = join(root, 'precious');
      mkdirSync(precious, { recursive: true });
      writeFileSync(join(precious, 'important.txt'), 'do not delete');
      const r = spawnSync(
        'bun',
        ['run', join(ROOT, 'scripts/generate-plugin-tree.ts'), '--out', join(root, 'out'), '--variants-out', precious],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, GBRAIN_PLUGIN_TREE_ROOT: root } },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('refusing --variants-out');
      expect(readFileSync(join(precious, 'important.txt'), 'utf8')).toBe('do not delete');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
