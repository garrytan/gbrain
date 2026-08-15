/**
 * Codex door, end to end (GAP 3a). The Codex harness installs NO per-turn
 * hooks — the pull protocol in AGENTS.md IS the per-message seam, and the MCP
 * registration is what wires the tools. Two contracts are load-bearing and
 * were previously only spot-checked by grepping the "Per-message gates"
 * heading (a template edit could gut Gate 3's brain-first prose silently):
 *
 *  1. The RENDERED AGENTS.md carries Gate 3 ("Entity lookup (brain first)") in
 *     full — search-the-brain-before-answering with the actual brain tools —
 *     so a Codex agent with no hooks still pulls context every turn.
 *  2. `registerCodexMcp` argv pins `serve --surface full` (bootstrap needs the
 *     whole op surface, not a narrowed `verbs`) and binds GBRAIN_SOURCE so a
 *     GUI-spawned serve (which inherits no shell env) writes to the workspace
 *     source [G1, CX-P1.4].
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderWorkspace } from '../src/core/bootstrap/render.ts';
import { setAnswer } from '../src/core/bootstrap/interview.ts';
import { registerCodexMcp } from '../src/core/bootstrap/hooks.ts';

const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Codexeer',
  PRINCIPAL_NAME: 'Alice Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research lab; ships a memo every Friday.',
  VOICE_REGISTER: 'Direct. Three options, the second one wins.',
};

function answeredWs(): string {
  const ws = mkdtempSync(join(tmpdir(), 'gbrain-codex-door-'));
  for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
    const r = setAnswer(ws, key, value);
    if (!r.ok) throw new Error(`setup failed for ${key}: ${r.message}`);
  }
  return ws;
}

describe('Codex door — rendered AGENTS.md pull protocol (Gate 3)', () => {
  test('rendered AGENTS.md carries the full brain-first Entity-lookup gate, not just the heading', () => {
    const ws = answeredWs();
    renderWorkspace(ws);
    const agents = readFileSync(join(ws, 'AGENTS.md'), 'utf8');

    // The heading everyone already greps — necessary but far from sufficient.
    expect(agents).toContain('Per-message gates');

    // Gate 3 body — the actual pull-protocol prose. If a template edit guts
    // any of this, a hookless Codex agent stops pulling context and this fails.
    expect(agents).toContain('Gate 3 — Entity lookup (brain first)');
    expect(agents).toContain('search the brain before answering');
    // Names the concrete brain tools, in order (recall → query → get_page).
    expect(agents).toContain('`recall` for hot');
    expect(agents).toContain('`query` for synthesis');
    expect(agents).toContain('`get_page` for the record');
    // Push-context path: already-injected context is used rather than re-fetched.
    expect(agents).toContain('If context was already\ninjected this turn, use it.');
    // The anti-narration + no-generic-grep rule that keeps retrieval silent.
    expect(agents).toContain('never narrate retrieval');
    expect(agents).toContain('Never use generic file-grep where a brain tool');

    // The identity token resolved (this is a real render, not the template).
    expect(agents).toContain('Codexeer');
    expect(/\{\{[A-Z0-9_]+\}\}/.test(agents)).toBe(false);
  });

  test('Gate 3 sits inside the Per-message gates block, ahead of the write-back gate', () => {
    const ws = answeredWs();
    renderWorkspace(ws);
    const agents = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
    const gatesIdx = agents.indexOf('## Per-message gates');
    const gate3Idx = agents.indexOf('Gate 3 — Entity lookup (brain first)');
    const gate7Idx = agents.indexOf('Gate 7 — Write-back');
    expect(gatesIdx).toBeGreaterThanOrEqual(0);
    expect(gate3Idx).toBeGreaterThan(gatesIdx);
    expect(gate7Idx).toBeGreaterThan(gate3Idx);
  });
});

describe('Codex door — registerCodexMcp argv (--surface full + GBRAIN_SOURCE)', () => {
  const BIN = '/opt/gbrain/bin/gbrain';

  test('user-global stdio registration binds the source and pins the full op surface', () => {
    const argvs = registerCodexMcp({ gbrainBin: BIN, sourceId: 'workspace' });
    expect(argvs.length).toBe(1);
    const argv = argvs[0]!;
    // Exact shape — codex has no scope flag (user-global), env rides the add.
    expect(argv).toEqual([
      'codex', 'mcp', 'add', 'gbrain',
      '--env', 'GBRAIN_SOURCE=workspace',
      '--', BIN, 'serve', '--surface', 'full',
    ]);
    // The two contracts, asserted independently so a reshuffle can't hide a drop.
    const joined = argv.join(' ');
    expect(joined).toContain('--env GBRAIN_SOURCE=workspace');
    expect(joined).toContain('serve --surface full');
    // `serve` argv must NOT narrow to the verbs surface.
    expect(joined).not.toContain('--surface verbs');
  });

  test('isolated install also threads GBRAIN_HOME onto the registration [CX2-8]', () => {
    const argv = registerCodexMcp({ gbrainBin: BIN, sourceId: 'workspace', gbrainHome: '/home/me/agent' })[0]!;
    expect(argv).toContain('GBRAIN_HOME=/home/me/agent');
    // GBRAIN_HOME is a second --env, GBRAIN_SOURCE still present, surface intact.
    expect(argv.filter((a) => a === '--env').length).toBe(2);
    expect(argv).toContain('GBRAIN_SOURCE=workspace');
    expect(argv.join(' ')).toContain('serve --surface full');
  });

  test('a non-absolute gbrain binary is refused (GUI hosts inherit no PATH) [CX-P1.4]', () => {
    expect(() => registerCodexMcp({ gbrainBin: 'gbrain', sourceId: 'workspace' })).toThrow(/absolute path/);
  });
});
