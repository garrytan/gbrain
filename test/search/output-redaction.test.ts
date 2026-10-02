import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  redactRetrievalOutput, withOutputRedaction, OUTPUT_REDACTION_MAX_FIELD_CHARS,
  OUTPUT_REDACTION_MAX_TOTAL_CHARS, OUTPUT_REDACTION_LIMIT,
} from '../../src/core/search/output-redaction.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
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

// ── #5348 shape port (B2, CEO-15) ───────────────────────────────────────────
// Every credential-shaped fixture is assembled at runtime from random parts
// (CEO-10): no literal token, key body or userinfo URL lives in this file.

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function rand(n: number, alphabet = ALNUM): string {
  let out = '';
  for (const b of randomBytes(n)) out += alphabet[b % alphabet.length];
  return out;
}
/** Random alnum with at least one digit (the assignment rule's entropy gate). */
const secretValue = (n: number) => rand(n - 1) + String(randomBytes(1)[0]! % 10);
const hex = (n: number) => rand(n, '0123456789abcdef');
const b64Line = (n: number) => randomBytes(n).toString('base64').slice(0, n);
const fence = '-'.repeat(5);
const keyLabel = ['PRIVATE', 'KEY'].join(' ');
const begin = (label = keyLabel) => `${fence}BEGIN ${label}${fence}`;
const end = (label = keyLabel) => `${fence}END ${label}${fence}`;
const redact = (text: string) => redactRetrievalOutput([{ chunk_text: text }], {}).results[0]!.chunk_text;

describe('retrieval output: assignment rule and #5348 shapes (B1/B2)', () => {
  test('KEY=value assignments reach the caller redacted, with no fragment of the value', () => {
    for (const keyName of ['GITHUB_TOKEN=', 'API_KEY=', 'client_secret: ', 'password = ', 'DB_PASSWORD="']) {
      const value = secretValue(32);
      const out = redact(`config ${keyName}${value}${keyName.endsWith('"') ? '"' : ''} end`);
      expect(out, keyName).not.toContain(value.slice(0, 12));
      expect(out, keyName).not.toContain(value.slice(-12));
      expect(out, keyName).toContain('<REDACTED:high_entropy_assignment>');
    }
  });

  test('an assigned value echoed bare in another field is scrubbed there too, trailing period included', () => {
    const value = secretValue(28);
    const [row] = redactRetrievalOutput([{ chunk_text: `set TOKEN=${value}. then retry`, title: `rotate ${value} today` }], {}).results;
    expect(JSON.stringify(row)).not.toContain(value);
    expect(row!.chunk_text).toBe('set TOKEN=<REDACTED:high_entropy_assignment>. then retry');
    expect(row!.title).toBe('rotate <REDACTED:high_entropy_assignment> today');
  });

  test('values longer than any old cap are redacted with no surviving tail', () => {
    const longAssigned = secretValue(300);
    expect(redact(`API_KEY=${longAssigned}`)).not.toContain(longAssigned.slice(-40));
    const longBearer = rand(300);
    expect(redact(`Authorization: Bearer ${longBearer}`)).not.toContain(longBearer.slice(-40));
    const longGithub = ['gh', 'p_'].join('') + rand(300);
    expect(redact(longGithub)).not.toContain(longGithub.slice(-40));
  });

  test('vendor-prefixed tokens, JWTs, bearer headers and complete private keys are redacted', () => {
    const pemBody = Array.from({ length: 6 }, () => b64Line(64)).join('\n');
    const shapes = [
      ['gh', 'p_'].join('') + rand(36),
      ['github', 'pat', rand(22), rand(59)].join('_'),
      ['sk', 'proj', rand(48)].join('-'),
      ['sk', 'ant', 'api03', rand(48)].join('-'),
      ['xoxb', String(100000000000 + (randomBytes(4).readUInt32BE() % 1e9)), rand(24)].join('-'),
      ['AK', 'IA'].join('') + rand(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
      ['AI', 'za'].join('') + rand(35),
      ['sk', 'live', rand(32)].join('_'),
      ['SG', rand(22), rand(43)].join('.'),
      ['eyJ' + rand(18), 'eyJ' + rand(24), rand(32)].join('.'),
      `Authorization: Bearer ${rand(40)}`,
      [begin(), pemBody, end()].join('\n'),
    ];
    for (const credential of shapes) {
      const out = redact(`prefix ${credential} suffix`);
      expect(out).toContain('<REDACTED:');
      expect(out.startsWith('prefix ')).toBe(true);
      expect(out.endsWith(' suffix')).toBe(true);
      for (const part of credential.split(/[\s\n]+/).filter(p => p.length >= 16)) expect(out).not.toContain(part);
    }
  });

  test('every occurrence in one field is redacted, and redaction is idempotent', () => {
    const token = ['gh', 'p_'].join('') + rand(36);
    const assigned = `password=${secretValue(24)}`;
    const once = redactRetrievalOutput([{ chunk_text: `${token} and ${token}; ${assigned}` }], {});
    expect(once.results[0]!.chunk_text.match(/<REDACTED:github_token>/g)).toHaveLength(2);
    expect(redactRetrievalOutput(once.results, once.meta)).toEqual(once);
    for (const marked of ['password="<REDACTED:high_entropy_assignment>"', 'x <REDACTED:high_entropy_assignment> y <REDACTED:google_api_key> z']) {
      expect(redact(marked)).toBe(marked);
    }
  });

  test('prose, placeholders, hashes, ids, public keys and non-credential URLs stay byte-identical', () => {
    const guards = [
      'see Basic concepts in the docs',
      'Basic responsibilities include on-call',
      'basic internationalization support',
      'Authorization: Basic auth is deprecated',
      'Bearer of bad news',
      'the SG. prefix is SendGrid',
      'export GITHUB_TOKEN=',
      'password: ****',
      'api_key = TODO',
      'set SECRET to whatever the vault returns',
      'the token is stored in the keychain, not in the repo',
      'rotate the api key quarterly and record the date',
      ['gh', 'p_test_fixture'].join(''),
      hex(40),
      '550e8400-e29b-41d4-a716-446655440000',
      `ssh-ed25519 ${b64Line(68)} me@host`,
      'token_url: "https://accounts.example/o/oauth2/token"',
      'credentials_path: "/home/alice-example/.config/gcloud/creds.json"',
      'https://user@host.example/path',
      'https://host.example/a@b',
      'http://localhost:5173/@vite/client',
      'https://registry.example/@scope/pkg',
      'https://host.example:443/@user',
      `id: dop_v1_${hex(65)}`,
      `To find leaks, search for ${end()} in your repo, then rotate.`,
    ];
    for (const safe of guards) expect(redact(safe), safe).toBe(safe);
  });

  test('a document that quotes the BEGIN marker keeps its surrounding prose', () => {
    const out = redact(`To find leaks, search for the string ${begin()} in your repo, then rotate.`);
    expect(out.startsWith('To find leaks, search for the string ')).toBe(true);
    expect(out.endsWith(' in your repo, then rotate.')).toBe(true);
  });

  test('a base64 run longer than 128 chars after a header stays the documented accepted miss', () => {
    const run = b64Line(200);
    const out = redact(`${begin()}\n${run}`);
    expect(out).toContain('<REDACTED:private_key_pem>');
    expect(out).toContain(run);
  });

  test('20k unterminated fences and END-only fences scan in linear time when uncapped', () => {
    for (const input of [`${begin('PUBLIC KEY')}\n`.repeat(20_000), `${begin()}\n`.repeat(20_000), `${end()}\n`.repeat(20_000)]) {
      const t0 = performance.now();
      redactRetrievalOutput([{ chunk_text: input }], {}, { uncapped: true });
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });
});

// Expected RED until lane S1 (src/core/secret-scan.ts A1-A5) merges: these
// shapes need the new url_credentials / basic_auth / digitalocean patterns,
// truncated/split private-key body claims and punctuated assignment values.
describe('retrieval output: shapes that need the S1 scanner patterns', () => {
  test('assigned passwords may start with or contain punctuation', () => {
    for (const value of [`!${rand(20)}9`, `$${rand(20)}7`, `${rand(10)}!#%${rand(20)}3`]) {
      const out = redact(`password=${value} tail`);
      expect(out).not.toContain(value.slice(-12));
      expect(out).toContain('<REDACTED:high_entropy_assignment>');
      expect(out.endsWith(' tail')).toBe(true);
    }
    const quoted = `ab!#%${rand(16)}<${rand(12)}5`;
    expect(redact(`DB_PASSWORD="${quoted}"`)).not.toContain(quoted.slice(-12));
  });

  test('http(s) userinfo credentials are redacted while host and path stay', () => {
    const pass = rand(24);
    const url = ['https', '://user:', pass, '@example.invalid/path'].join('');
    expect(redact(`clone ${url} now`)).toBe('clone <REDACTED:url_credentials>example.invalid/path now');
    const tok = ['gh', 'p_'].join('') + rand(36);
    const clone = ['https', '://x-access-token:', tok, '@github.com/acme-example/repo.git'].join('');
    expect(redact(clone)).not.toContain(tok);
  });

  test('Authorization: Basic is redacted in header and bare forms, any case, short values included', () => {
    const cred = Buffer.from(`${rand(8)}:${rand(16)}`).toString('base64');
    for (const header of [`Authorization: Basic ${cred}`, `authorization: basic ${cred}`, `AUTHORIZATION: BASIC ${cred}`, `Basic ${cred}`]) {
      const out = redact(header);
      expect(out, header).not.toContain(cred);
      expect(out, header).toContain('<REDACTED:basic_auth>');
    }
    const short = Buffer.from('u:p').toString('base64');
    expect(redact(`Authorization: Basic ${short}`)).not.toContain(short);
  });

  test('DigitalOcean tokens are redacted', () => {
    for (const kind of ['dop', 'doo', 'dor']) {
      const token = `${kind}_v1_${hex(64)}`;
      const out = redact(`token ${token} end`);
      expect(out).not.toContain(token);
      expect(out).toContain('<REDACTED:digitalocean>');
    }
  });

  test('a private key cut before its END fence loses its body, and preceding prose survives', () => {
    const lines = [b64Line(64), b64Line(64), b64Line(40)];
    const out = redact(`deploy notes:\n${begin('RSA PRIVATE KEY')}\n${lines.join('\n')}`);
    expect(out.startsWith('deploy notes:\n')).toBe(true);
    for (const l of lines) expect(out).not.toContain(l);
  });

  test('a chunk that starts mid-key loses the body before its END fence', () => {
    const lines = [b64Line(30), b64Line(64), b64Line(64)];
    const out = redact(`${lines.join('\n')}\n${end()}\nafter the key`);
    for (const l of lines) expect(out).not.toContain(l);
    expect(out.endsWith('after the key')).toBe(true);
  });

  test('JSON-escaped, indented, CRLF and RFC 1421 key bodies are redacted', () => {
    const body = [b64Line(64), b64Line(64)];
    const cases = [
      `{"private_key":"${begin()}\\n${body.join('\\n')}\\n${end()}\\n"}`,
      `key: |\n    ${begin()}\n    ${body.join('\n    ')}`,
      `${begin()}\r\n${body.join('\r\n')}`,
      [begin('RSA PRIVATE KEY'), 'Proc-Type: 4,ENCRYPTED', `DEK-Info: AES-128-CBC,${hex(32).toUpperCase()}`, '', ...body].join('\n'),
    ];
    for (const text of cases) {
      const out = redact(`notes\n${text}`);
      for (const l of body) expect(out, text.slice(0, 40)).not.toContain(l);
      expect(out.startsWith('notes\n')).toBe(true);
    }
  });
});

describe('retrieval output: identity fields, dates and options', () => {
  test('fact_id and entity_slug stay byte-identical; dates survive the copy', () => {
    const value = secretValue(30);
    const when = new Date('2026-08-01T00:00:00Z');
    const [row] = redactRetrievalOutput([{ fact_id: `password=${value}`, entity_slug: `people/password=${value}`, fact: `password=${value}`, valid_from: when }], {}).results;
    expect(row!.fact_id).toBe(`password=${value}`);
    expect(row!.entity_slug).toBe(`people/password=${value}`);
    expect(row!.fact).toBe('password=<REDACTED:high_entropy_assignment>');
    expect(row!.valid_from).toBeInstanceOf(Date);
    expect(row!.valid_from.getTime()).toBe(when.getTime());
  });

  test('uncapped scans an oversized field whole instead of withholding it', () => {
    const token = ['gh', 'p_'].join('') + rand(36);
    const text = 'x'.repeat(OUTPUT_REDACTION_MAX_FIELD_CHARS) + ` ${token} tail`;
    const [row] = redactRetrievalOutput([{ text }], {}, { uncapped: true }).results;
    expect(row!.text.endsWith(' <REDACTED:github_token> tail')).toBe(true);
    expect(row!.text.length).toBeGreaterThan(OUTPUT_REDACTION_MAX_FIELD_CHARS);
  });

  test('verbatim keys of each top-level result are returned unscanned, nested keys are not', () => {
    const token = ['gh', 'p_'].join('') + rand(36);
    const [row] = redactRetrievalOutput([{ facts: [{ fact: token }], text: token, nested: { facts: token } }], {}, { verbatim: ['facts'] }).results;
    expect(row!.facts[0]!.fact).toBe(token);
    expect(row!.text).toBe('<REDACTED:github_token>');
    expect(row!.nested.facts).toBe('<REDACTED:github_token>');
  });
});

describe('withOutputRedaction (ENG-4 registration wrapper)', () => {
  const token = () => ['gh', 'p_'].join('') + rand(36);
  const ctx = (remote: boolean) => ({ remote }) as unknown as OperationContext;

  test('a retrieval op is redacted on every return path, including an early return', async () => {
    const secret = token();
    const handler = async (_ctx: OperationContext, p: Record<string, unknown>) =>
      p.early ? { text: `early ${secret}` } : { results: [{ chunk: secret, slug: 'notes/a' }] };
    const wrapped = withOutputRedaction({ handler, outputRedaction: 'retrieval' });
    expect(await wrapped(ctx(false), { early: true })).toEqual({ text: 'early <REDACTED:github_token>' });
    expect(await wrapped(ctx(true), {})).toEqual({ results: [{ chunk: '<REDACTED:github_token>', slug: 'notes/a' }] });
  });

  test('localVerbatim keys stay raw only for the trusted local caller', async () => {
    const secret = token();
    const handler = async () => ({ facts: [{ fact: secret }], text: secret });
    const wrapped = withOutputRedaction({ handler, outputRedaction: { retrieval: { localVerbatim: ['facts'] } } });
    expect(await wrapped(ctx(false), {})).toEqual({ facts: [{ fact: secret }], text: '<REDACTED:github_token>' });
    expect(await wrapped(ctx(true), {})).toEqual({ facts: [{ fact: '<REDACTED:github_token>' }], text: '<REDACTED:github_token>' });
    expect(await wrapped({ remote: undefined } as unknown as OperationContext, {})).toEqual({ facts: [{ fact: '<REDACTED:github_token>' }], text: '<REDACTED:github_token>' });
  });

  test('exempt and no_stored_text ops keep their handler untouched', () => {
    const handler = async () => ({});
    expect(withOutputRedaction({ handler, outputRedaction: { exempt: 'page read' } })).toBe(handler);
    expect(withOutputRedaction({ handler, outputRedaction: 'no_stored_text' })).toBe(handler);
  });
});
