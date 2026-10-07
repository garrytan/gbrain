/**
 * #6198 — bundled skill links survive being copied out of the repo.
 *
 * Skills are copied verbatim into host workspaces (`gbrain skillpack
 * scaffold`), harness dirs and the generated plugin trees. Links that leave
 * `skills/` (64 of them to docs/protocol/AGENT_OPERATOR_v1.md) dangled in
 * every copy. D13: the protocol page ships inside the skills tree as a
 * generated copy, other repo docs use absolute URLs, and the rewrite honors
 * the LLMS_REPO_BASE fork override.
 */
import { describe, expect, it, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { runScaffold } from '../src/core/skillpack/scaffold.ts';
import {
  BUNDLED_PROTOCOL, DEFAULT_BLOB_BASE, portableLinks, renderBundledProtocol, repoBlobBase,
} from '../scripts/portable-skill-links.ts';

const ROOT = join(import.meta.dir, '..');
const tmpRoots: string[] = [];
afterAll(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); });

function markdown(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return markdown(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

/** `./` and `../` links (outside fenced code) that do not resolve inside the tree, as `file -> link`. */
function brokenLinks(skillsRoot: string): string[] {
  const broken: string[] = [];
  for (const file of markdown(skillsRoot)) {
    if (relative(skillsRoot, file).startsWith('migrations/')) continue;
    const prose = readFileSync(file, 'utf8').replace(/^\s*(`{3,}|~{3,})[\s\S]*?^\s*\1/gm, '');
    for (const m of prose.matchAll(/\]\((\.{1,2}\/[^)\s]+)\)/g)) {
      const link = m[1];
      if (/[<{$]/.test(link)) continue;
      const target = link.split('#')[0];
      const segs = target.split('/').filter(s => s && s !== '.' && s !== '..');
      if (segs.some(s => /-example(\.|$)/.test(s)) || ['people', 'companies', 'meetings', 'concepts'].includes(segs[0] ?? '')) continue;
      const abs = resolve(dirname(file), target);
      if (!abs.startsWith(`${resolve(skillsRoot)}/`) || !existsSync(abs)) broken.push(`${relative(skillsRoot, file)} -> ${link}`);
    }
  }
  return broken;
}

describe('scaffolded skills have no broken local links (#6198)', () => {
  it('skillpack scaffold --all into a fresh host workspace', () => {
    const host = mkdtempSync(join(tmpdir(), 'portable-links-host-'));
    tmpRoots.push(host);
    const result = runScaffold({ gbrainRoot: ROOT, targetWorkspace: host, skillSlug: null });
    expect(result.summary.wroteNew).toBeGreaterThan(50);
    expect(existsSync(join(host, BUNDLED_PROTOCOL))).toBe(true);
    expect(brokenLinks(join(host, 'skills'))).toEqual([]);
  });

  it('the committed plugin trees', () => {
    const trees = [join(ROOT, 'plugin', 'skills'), ...readdirSync(join(ROOT, 'plugin-variants')).map(v => join(ROOT, 'plugin-variants', v, 'skills'))];
    for (const tree of trees) {
      expect(existsSync(join(tree, 'conventions', 'agent-operator-protocol.md'))).toBe(true);
      const escaping = brokenLinks(tree).filter(b => b.includes('../../') || b.includes('docs/'));
      expect(escaping, tree).toEqual([]);
    }
  });
});

describe('portableLinks', () => {
  it('points protocol links at the bundled copy, relative to the linking file', () => {
    expect(portableLinks('[p](../../docs/protocol/AGENT_OPERATOR_v1.md#quick-contract)', 'skills/demo/SKILL.md', DEFAULT_BLOB_BASE))
      .toBe('[p](../conventions/agent-operator-protocol.md#quick-contract)');
    expect(portableLinks('[p](../docs/protocol/AGENT_OPERATOR_v1.md)', 'skills/RESOLVER.md', DEFAULT_BLOB_BASE))
      .toBe('[p](./conventions/agent-operator-protocol.md)');
  });

  it('turns other outside links into absolute URLs and keeps inside links', () => {
    const text = '[a](../../docs/mcp/ADMIN.md#tokens) [b](../conventions/quality.md) [c](./ref.md) [d](https://example.com/x) [e](../../people/<slug>.md)';
    expect(portableLinks(text, 'skills/demo/SKILL.md', DEFAULT_BLOB_BASE)).toBe(
      `[a](${DEFAULT_BLOB_BASE}/docs/mcp/ADMIN.md#tokens) [b](../conventions/quality.md) [c](./ref.md) [d](https://example.com/x) [e](../../people/<slug>.md)`,
    );
  });

  it('derives the blob base from the LLMS_REPO_BASE fork override and retargets default-base links', () => {
    const base = repoBlobBase({ LLMS_REPO_BASE: 'https://raw.githubusercontent.com/fork-org/gbrain/main/' });
    expect(base).toBe('https://github.com/fork-org/gbrain/blob/main');
    expect(repoBlobBase({})).toBe(DEFAULT_BLOB_BASE);
    expect(repoBlobBase({ LLMS_REPO_BASE: 'https://git.example.com/gbrain/raw' })).toBe('https://git.example.com/gbrain/raw');
    expect(portableLinks(`[a](${DEFAULT_BLOB_BASE}/docs/ENGINES.md) [b](../../INSTALL_FOR_AGENTS.md)`, 'skills/demo/SKILL.md', base))
      .toBe(`[a](${base}/docs/ENGINES.md) [b](${base}/INSTALL_FOR_AGENTS.md)`);
  });

  it('the bundled protocol copy carries no relative link out of the skills tree', () => {
    const protocol = readFileSync(join(ROOT, 'docs', 'protocol', 'AGENT_OPERATOR_v1.md'), 'utf8');
    const bundled = renderBundledProtocol(protocol, DEFAULT_BLOB_BASE);
    expect(bundled).toContain(`](${DEFAULT_BLOB_BASE}/docs/guides/error-codes.md)`);
    expect(bundled).toContain(`](${DEFAULT_BLOB_BASE}/docs/protocol/MEMORY_VERBS_v1.md)`);
    expect([...bundled.matchAll(/\]\((\.\.?\/[^)]*)\)/g)].map(m => m[1])).toEqual([]);
  });

  it('every skill link is already portable (bun scripts/portable-skill-links.ts --check)', () => {
    const r = Bun.spawnSync(['bun', 'scripts/portable-skill-links.ts', '--check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LLMS_REPO_BASE: '' } });
    expect(`${r.stdout}${r.stderr}`).toContain('skill links: portable');
    expect(r.exitCode).toBe(0);
  });
});
