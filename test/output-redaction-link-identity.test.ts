/**
 * Link and graph rows carry canonical page references in from_slug /
 * to_slug / origin_slug. A slug is an identity, not stored prose, yet a slug
 * such as `districts/pa-<district-name>-<id>` (20+ characters after `pa-`)
 * matches the voyage credential shape, and the output redactor rewrote it to
 * `<REDACTED:voyage>` inside get_links / get_backlinks / traverse_graph rows.
 * Identity fields stay exact; the same string inside free text (context) is
 * still scanned, and a real token never leaks from any field.
 *
 * Every credential fixture is assembled at runtime from random parts.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { redactRetrievalOutput, withOutputRedaction } from '../src/core/search/output-redaction.ts';
import type { OperationContext } from '../src/core/operations.ts';

const PA_SLUG = 'districts/pa-synthetic-example-school-district-1234';
const FROM_SLUG = 'notes/pa-synthetic-example-review-20260101';
const voyageToken = () => ['pa', randomBytes(24).toString('hex')].join('-');

const linkRow = (context: string) => ({
  from_slug: FROM_SLUG, from_source_id: 'default',
  to_slug: PA_SLUG, to_source_id: 'default',
  origin_slug: PA_SLUG, origin_source_id: 'default',
  link_type: 'mentions', link_source: 'markdown', context,
});

describe('output redaction keeps link identity fields exact', () => {
  test('a pa- slug of 20+ characters survives in from_slug / to_slug / origin_slug', () => {
    const { results } = redactRetrievalOutput([linkRow('plain context')], {});
    expect(results[0]).toEqual(linkRow('plain context'));
  });

  test('graph nodes and paths keep the same slugs exact', () => {
    const node = { slug: PA_SLUG, source_id: 'default', links: [{ to_slug: PA_SLUG, link_type: 'mentions' }] };
    const path = { from_slug: FROM_SLUG, to_slug: PA_SLUG, link_type: 'mentions', depth: 1 };
    const { results } = redactRetrievalOutput([{ nodes: [node], paths: [path] }], {});
    expect(results[0]).toEqual({ nodes: [node], paths: [path] });
  });

  test('the same shape in free text is still redacted, and a real token never leaks', () => {
    const token = voyageToken();
    const { results } = redactRetrievalOutput([{ ...linkRow(`see ${token} near ${PA_SLUG}`), note: token }], {});
    const row = results[0] as Record<string, string>;
    expect(row.to_slug).toBe(PA_SLUG);
    expect(row.context).not.toContain(token);
    expect(row.context).toContain('<REDACTED:voyage>');
    expect(row.note).not.toContain(token);
  });

  test('registered retrieval ops keep the slugs exact for remote and local callers', async () => {
    const handler = withOutputRedaction({ handler: async () => [linkRow('ctx')], outputRedaction: 'retrieval' });
    for (const remote of [true, false, undefined]) {
      const out = await handler({ remote } as OperationContext, {}) as Array<Record<string, string>>;
      expect(out[0].from_slug).toBe(FROM_SLUG);
      expect(out[0].to_slug).toBe(PA_SLUG);
      expect(out[0].origin_slug).toBe(PA_SLUG);
    }
  });
});
