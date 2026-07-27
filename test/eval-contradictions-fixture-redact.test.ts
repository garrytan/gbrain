/**
 * Fixture redactor tests — T2 privacy redaction passes.
 */

import { describe, test, expect } from 'bun:test';
import {
  createRedactionSession,
  isCleanForCommit,
  redactMonetary,
  redactNames,
  redactSlug,
  redactText,
} from '../src/core/eval-contradictions/fixture-redact.ts';

describe('redactSlug', () => {
  test('people/<name> → people/alice-example (deterministic per session)', () => {
    const s = createRedactionSession();
    const out = redactSlug(s, 'people/garry-tan');
    expect(out).toMatch(/^people\/.+-example$/);
  });

  test('same raw slug maps consistently within a session', () => {
    const s = createRedactionSession();
    const a = redactSlug(s, 'people/garry-tan');
    const b = redactSlug(s, 'people/garry-tan');
    expect(a).toBe(b);
  });

  test('different raw slugs map to different placeholders', () => {
    const s = createRedactionSession();
    const a = redactSlug(s, 'people/garry-tan');
    const b = redactSlug(s, 'people/paul-graham');
    expect(a).not.toBe(b);
  });

  test('companies/, deals/, projects/ all rewrite', () => {
    const s = createRedactionSession();
    expect(redactSlug(s, 'companies/y-combinator')).toMatch(/^companies\/.+-example$/);
    expect(redactSlug(s, 'deals/y-seed')).toMatch(/^deals\/.+-example$/);
    expect(redactSlug(s, 'projects/secret')).toMatch(/^projects\/.+-example$/);
  });

  test('unrecognized prefix passes through unchanged', () => {
    const s = createRedactionSession();
    expect(redactSlug(s, 'random/page')).toBe('random/page');
    expect(redactSlug(s, 'concepts/foo')).toBe('concepts/foo');
  });

  test('audit trail records every redaction', () => {
    const s = createRedactionSession();
    redactSlug(s, 'people/garry');
    redactSlug(s, 'companies/yc');
    expect(s.audit.length).toBe(2);
    expect(s.audit[0]).toContain('garry');
    expect(s.audit[1]).toContain('yc');
  });
});

describe('redactNames', () => {
  test('Firstname Lastname → Alice Example', () => {
    const s = createRedactionSession();
    const out = redactNames(s, 'I met Mackenzie Burnett yesterday');
    expect(out).toMatch(/I met .+ Example yesterday/);
  });

  test('same name maps consistently', () => {
    const s = createRedactionSession();
    const out1 = redactNames(s, 'Garry Tan');
    const out2 = redactNames(s, 'Garry Tan');
    expect(out1).toBe(out2);
  });

  test('different names map to different placeholders', () => {
    const s = createRedactionSession();
    const out1 = redactNames(s, 'Alice Smith');
    const out2 = redactNames(s, 'Bob Jones');
    expect(out1).not.toBe(out2);
  });

  test('does not match lowercase strings (not name-shaped)', () => {
    const s = createRedactionSession();
    expect(redactNames(s, 'hello world')).toBe('hello world');
  });

  test('does not match single names', () => {
    const s = createRedactionSession();
    expect(redactNames(s, 'Alice said hi')).toBe('Alice said hi');
  });
});

describe('redactMonetary', () => {
  test('$50K → multiplied by salt', () => {
    const s = createRedactionSession();
    const out = redactMonetary(s, 'MRR is $50K');
    expect(out).not.toBe('MRR is $50K');
    expect(out).toMatch(/\$\d+(\.\d+)?K/);
  });

  test('$2M, $1.5B all rewritten', () => {
    const s = createRedactionSession();
    expect(redactMonetary(s, 'raised $2M')).not.toBe('raised $2M');
    expect(redactMonetary(s, 'valued at $1.5B')).not.toBe('valued at $1.5B');
  });

  test('non-monetary numbers pass through', () => {
    const s = createRedactionSession();
    expect(redactMonetary(s, 'we have 50 customers')).toBe('we have 50 customers');
  });
});

describe('redactText (full pass)', () => {
  test('chains PII + name + monetary', () => {
    const s = createRedactionSession();
    const out = redactText(s, 'Met Mackenzie Burnett, MRR $50K, email me at foo@bar.com');
    expect(out).not.toContain('Mackenzie Burnett');
    expect(out).not.toContain('foo@bar.com');
    expect(out).not.toContain('$50K');
  });
});

describe('isCleanForCommit', () => {
  test('clean text passes', () => {
    expect(isCleanForCommit('Alice Example met Bob Example at companies/acme-example')).toBe(true);
  });

  test('raw name shape blocks commit', () => {
    expect(isCleanForCommit('Met Mackenzie Burnett')).toBe(false);
  });

  test('raw email blocks commit', () => {
    expect(isCleanForCommit('contact me at foo@bar.com')).toBe(false);
  });

  test('empty text is clean', () => {
    expect(isCleanForCommit('')).toBe(true);
  });
});
