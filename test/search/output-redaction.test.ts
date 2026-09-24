import { describe, expect, test } from 'bun:test';
import {
  redactRetrievalOutput, OUTPUT_REDACTION_MAX_FIELD_CHARS,
  OUTPUT_REDACTION_MAX_TOTAL_CHARS, OUTPUT_REDACTION_LIMIT,
} from '../../src/core/search/output-redaction.ts';
import { encodeDeepResearchId } from '../../src/core/deep-research-id.ts';

const key = 'sk-proj-' + 'syntheticfixture19'.repeat(3);
const bearer = 'syntheticbareecho19'.repeat(3);

describe('bounded retrieval display redaction', () => {
  test('copies nested text and arrays, preserves scores and opaque identities, and is idempotent', () => {
    const slug = `notes/${key}`;
    const source = 'sk-' + 'a'.repeat(24);
    const id = encodeDeepResearchId(source, slug);
    const rows = [{ id, slug, source_id: source, score: 0.123, stale: false,
      relational_seed: slug, relational_path: [slug], superseded_by: slug,
      title: key, chunk_text: bearer, content_flag: { detail: key }, source_subject: key,
    }];
    const meta = { crag: { think: { answer: `Bearer ${bearer}` } }, nested: [key, { detail: key }], returned_count: 1 };
    const original = structuredClone({ results: rows, meta });
    const output = redactRetrievalOutput(rows, meta);
    expect(output.results[0]).toMatchObject({ id, slug, source_id: source, score: 0.123, stale: false,
      relational_seed: slug, relational_path: [slug], superseded_by: slug,
      title: '<REDACTED:openai>', chunk_text: '<REDACTED:bearer>',
      content_flag: { detail: '<REDACTED:openai>' }, source_subject: '<REDACTED:openai>',
    });
    expect(output.meta.nested).toEqual(['<REDACTED:openai>', { detail: '<REDACTED:openai>' }]);
    expect(output.results[0].relational_path).not.toBe(rows[0].relational_path);
    expect({ results: rows, meta }).toEqual(original);
    expect(redactRetrievalOutput(output.results, output.meta)).toEqual(output);
  });

  test('shares canonical scanner coverage for punctuation, long lines, PEM and supported truncated shapes', () => {
    const url = ['postgresql', '://synthetic:punctuation!$&()*+,;=:/{}<>|^`\\@example.invalid/db'].join('');
    const keyType = ['PRIVATE', 'KEY'].join(' ');
    const material = Buffer.from('SyntheticOnly').toString('base64');
    const pem = [`-----BEGIN ${keyType}-----`, material, `-----END ${keyType}-----`].join('\n');
    const rows = [{ chunk_text: `prefix ${'x'.repeat(20_000)} (${key.slice(0, -5)}), ${url}\n${pem}` }];
    const text = redactRetrievalOutput(rows, {}).results[0].chunk_text;
    expect(text.includes(key.slice(0, -5))).toBe(false);
    expect(text.includes('punctuation!')).toBe(false);
    expect(text.includes(material)).toBe(false);
    expect(text).toContain('<REDACTED:openai>');
    expect(text).toContain('<REDACTED:db_url_credentials>example.invalid/db');
    expect(text).toContain('<REDACTED:private_key_pem>');
  });

  test('benign prose, public identifiers and short or unsupported fragments are not a secrecy guarantee', () => {
    const text = 'discuss bearer authentication; risk-assessment; task-deadline; sk-proj-short; ordinary password words';
    expect(redactRetrievalOutput([{ chunk_text: text }], {}).results[0].chunk_text).toBe(text);
  });

  test('oversized fields are wholly withheld, never left as an unscanned tail', () => {
    const text = 'x'.repeat(OUTPUT_REDACTION_MAX_FIELD_CHARS) + key;
    const rows = [{ chunk_text: text, title: 'useful title', score: 0.7 }];
    expect(redactRetrievalOutput(rows, {}).results[0]).toEqual({
      chunk_text: OUTPUT_REDACTION_LIMIT, title: 'useful title', score: 0.7,
    });
    expect(rows[0].chunk_text).toBe(text);
  });

  test('response scan budget withholds later text while retaining row count and numeric scores', () => {
    const count = OUTPUT_REDACTION_MAX_TOTAL_CHARS / OUTPUT_REDACTION_MAX_FIELD_CHARS + 2;
    const rows = Array.from({ length: count }, (_, i) => ({ chunk_text: 'a'.repeat(OUTPUT_REDACTION_MAX_FIELD_CHARS), score: i }));
    const output = redactRetrievalOutput(rows, { answer: key });
    expect(output.results).toHaveLength(count);
    expect(output.results.at(-1)).toEqual({ chunk_text: OUTPUT_REDACTION_LIMIT, score: count - 1 });
    expect(output.meta.answer).toBe(OUTPUT_REDACTION_LIMIT);
  });

  test('scan exhaustion retains only validated retrieval metadata codes at their exact paths', () => {
    const rows: Array<{ chunk_text: string; status?: string; stage?: string }> = Array.from({
      length: OUTPUT_REDACTION_MAX_TOTAL_CHARS / OUTPUT_REDACTION_MAX_FIELD_CHARS,
    }, () => ({ chunk_text: 'a'.repeat(OUTPUT_REDACTION_MAX_FIELD_CHARS) }));
    rows.push({ chunk_text: '', status: 'projection_pending', stage: 'projection_pending' });
    const metadata = {
      degraded: [{ stage: 'projection_pending', reason: 'no_provider', detail: key }, { stage: key, reason: key }],
      projection_readiness: { status: 'projection_pending', ready: false, hint: key },
      nested: { degraded: [{ stage: 'projection_pending' }], projection_readiness: { status: 'ready' } },
    };
    const output = redactRetrievalOutput(rows, metadata);
    expect(output.meta.degraded[0]).toEqual({ stage: 'projection_pending', reason: 'no_provider', detail: OUTPUT_REDACTION_LIMIT });
    expect(output.meta.degraded[1]).toEqual({ stage: OUTPUT_REDACTION_LIMIT, reason: OUTPUT_REDACTION_LIMIT });
    expect(output.meta.projection_readiness).toEqual({ status: 'projection_pending', ready: false, hint: OUTPUT_REDACTION_LIMIT });
    expect(output.meta.nested.degraded[0].stage).toBe(OUTPUT_REDACTION_LIMIT);
    expect(output.meta.nested.projection_readiness.status).toBe(OUTPUT_REDACTION_LIMIT);
    expect(output.results.at(-1)!.stage).toBe(OUTPUT_REDACTION_LIMIT);
    expect(output.results.at(-1)!.status).toBe(OUTPUT_REDACTION_LIMIT);
    expect(metadata.degraded[0].detail).toBe(key);
  });

  test('many fields cannot exhaust the budget by erasing result identities or numeric ranking', () => {
    const rows = Array.from({ length: 9000 }, (_, i) => ({ slug: `notes/synthetic-${i}`, chunk_text: key, score: i }));
    const output = redactRetrievalOutput(rows, {});
    expect(output.results).toHaveLength(rows.length);
    expect(output.results.at(-1)).toEqual({ slug: 'notes/synthetic-8999', chunk_text: OUTPUT_REDACTION_LIMIT, score: 8999 });
  });

  test('hostile prefix-sharing, repeated schemes and deep metadata finish within a bounded budget', () => {
    const text = ('redis://:-eyJ-'.repeat(2000) + '@ ' + 'Bearer ' + 'A'.repeat(4000));
    let deep: unknown = { text: key };
    for (let i = 0; i < 1000; i++) deep = { nested: deep };
    const start = performance.now();
    const output = redactRetrievalOutput([{ chunk_text: text }], { deep });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(JSON.stringify(output.meta)).toContain(OUTPUT_REDACTION_LIMIT);
    expect(output.results[0].chunk_text.includes('A'.repeat(4000))).toBe(false);
  });

  test('untrusted metadata keys do not mutate object prototypes', () => {
    const meta = JSON.parse(`{"__proto__":{"text":"${key}"}}`);
    const output = redactRetrievalOutput([], meta);
    expect(Object.getPrototypeOf(output.meta)).toBe(Object.prototype);
    expect(Object.hasOwn(output.meta, '__proto__')).toBe(true);
    expect(output.meta.__proto__.text).toBe('<REDACTED:openai>');
  });
});
