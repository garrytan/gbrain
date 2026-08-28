/**
 * Entity resolution — prefix expansion over the hosts/ and projects/
 * directories.
 *
 * A bare infra token ("hive") with a canonical `hosts/<token>` page used
 * to fall through to slugify because PREFIX_EXPANSION_DIRS only listed
 * people/ and companies/ — recall then queried an invented slug and
 * returned nothing while the page and its facts sat one prefix away
 * (2026-08-06 memory eval; reimplemented from community PR #3851 by
 * miroslavb).
 *
 * `infra/` stays deliberately excluded — see the PREFIX_EXPANSION_DIRS
 * comment in src/core/entities/resolve.ts — and that exclusion is pinned
 * here so it can't be "fixed" back in.
 *
 * Fixture names use placeholder-pattern slugs per CLAUDE.md privacy rule.
 * PGLite-only; no DATABASE_URL, no API keys.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { resolveEntitySlug } from '../src/core/entities/resolve.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();

  const pages = [
    // Bare child: exact `hosts/<token>` page, no suffixed siblings.
    { slug: 'hosts/hive', title: 'hive', type: 'note' },
    // Suffixed child: only `projects/<token>-…` exists.
    { slug: 'projects/apollo-lander', title: 'Apollo Lander', type: 'note' },
    // Cross-directory collision for the ambiguity gate.
    { slug: 'people/kiwi-example', title: 'Kiwi Example', type: 'person' },
    { slug: 'hosts/kiwi', title: 'kiwi', type: 'note' },
    // infra/ is a mixed namespace of analysis/runbook docs — must NOT be
    // prefix-expanded.
    { slug: 'infra/vault-runbook', title: 'Vault Runbook', type: 'note' },
  ];
  for (const p of pages) {
    await engine.putPage(p.slug, {
      type: p.type,
      title: p.title,
      compiled_truth: `# ${p.title}`,
      frontmatter: { type: p.type, title: p.title, slug: p.slug },
    }, { sourceId: 'default' });
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('resolveEntitySlug — hosts/ and projects/ prefix expansion', () => {
  it('bare token resolves to its exact hosts/<token> page', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'hive')).toBe('hosts/hive');
  });

  it('bare token resolves to its suffixed projects/<token>-… page', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'apollo')).toBe('projects/apollo-lander');
  });

  it('cross-directory collision trips the ambiguity gate (slugify fallback)', async () => {
    // people/kiwi-example and hosts/kiwi both match — expansion must
    // refuse to pick one and fall through to the deterministic slugify.
    expect(await resolveEntitySlug(engine, 'default', 'kiwi')).toBe('kiwi');
  });

  it('infra/ pages are not prefix-expanded', async () => {
    expect(await resolveEntitySlug(engine, 'default', 'vault')).toBe('vault');
  });
});
