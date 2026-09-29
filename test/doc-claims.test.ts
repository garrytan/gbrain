/**
 * Retracted doc claims stay retracted.
 *
 * Each row is an honesty or privacy promise that shipped docs once made, the
 * product does not keep, and a fix removed. The check is negative only: no
 * shipped Markdown file (README, agent instructions, docs, skills, templates,
 * recipes and the generated plugin trees) may state it again. CHANGELOG.md is
 * history and docs/test-audit/ quotes the claims as evidence, so both are
 * excluded. Text is whitespace-flattened so a re-wrapped paragraph still
 * matches.
 *
 * Positive wording pins were dropped on purpose (docs/TESTING.md "Retiring a
 * test"): they fail on a meaning-preserving reword and pass when the behavior
 * they describe breaks. Behavior owners are named per row.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SHIPPED = /^(?:README\.md|AGENTS\.md|CLAUDE\.md|INSTALL_FOR_AGENTS\.md|(?:docs|skills|templates|recipes|plugin|plugin-variants)\/.+\.md)$/;
const EXCLUDED = /^docs\/test-audit\//;

interface Claim {
  claim: string | RegExp;
  why: string;
}

const RETRACTED: Claim[] = [
  { claim: '~/.openclaw/config.json', why: '#4842: OpenClaw reads ~/.openclaw/openclaw.json `mcp.servers`; registration goes through `openclaw mcp add`' },
  { claim: "Don't store user preferences in GBrain", why: 'durable preferences belong in shared memory (docs/guides/brain-vs-memory.md)' },
  { claim: 'it should return nothing', why: 'recall of a stored preference is expected to return it (brain-vs-memory guidance)' },
  { claim: /Every (?:future )?`put_page` (?:auto-creates|extracts)/, why: '#4679: remote put_page skips inline graph extraction (owner: test/put-page-remote-autolink-hint.test.ts)' },
  { claim: 'auto-linking on every write', why: '#4679: remote writes return `skipped: "remote"` and rely on a sweep' },
  { claim: 'MCP response includes `auto_links: { created', why: '#4679: MCP put_page responses carry no inline auto_links result' },
  { claim: 'Verify via the `auto_links` field in the put_page response (`{ created', why: '#4679: same retracted inline auto_links promise' },
  { claim: 'No manual `add_link` calls needed for ordinary page writes', why: '#4679: HTTP writers need a host sweep or explicit add_link' },
  { claim: 'nobody else ships together', why: 'exclusivity claim retracted from the primary docs' },
  { claim: 'keychain and survives', why: '#4741: the empty-dir hermetic config does not keep the macOS keychain login across logout' },
];

const files = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(path => SHIPPED.test(path) && !EXCLUDED.test(path));

describe('retracted doc claims', () => {
  test('the scan covers the shipped doc surfaces', () => {
    for (const path of ['README.md', 'docs/guides/brain-vs-memory.md', 'docs/mcp/OPENCLAW.md', 'docs/UPGRADING_DOWNSTREAM_AGENTS.md', 'skills/brain-ops/SKILL.md', 'skills/enrich/SKILL.md']) {
      expect(files).toContain(path);
    }
  });

  test('no shipped Markdown file restates a retracted claim', () => {
    const hits: string[] = [];
    for (const path of files) {
      const flat = readFileSync(join(ROOT, path), 'utf8').replace(/\s+/g, ' ');
      for (const { claim, why } of RETRACTED) {
        const found = typeof claim === 'string' ? flat.includes(claim) : claim.test(flat);
        if (found) hits.push(`${path}: restates "${claim}" — retracted: ${why}`);
      }
    }
    expect(hits, 'fix the doc (the claim is false), rerun: bun test test/doc-claims.test.ts').toEqual([]);
  });
});
