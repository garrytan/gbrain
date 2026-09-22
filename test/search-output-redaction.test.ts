import { describe, expect, test } from 'bun:test';

import { formatResult } from '../src/cli.ts';
import { operationsByName } from '../src/core/operations.ts';
import {
  redactCredentialLikeText,
  redactSearchResults,
} from '../src/core/search/output-redaction.ts';
import type { SearchResult } from '../src/core/types.ts';

const classicGithubToken = ['ghp', 'A'.repeat(36)].join('_');
const fineGrainedGithubToken = ['github', 'pat', 'B'.repeat(30), 'C'.repeat(30)].join('_');
const openAiToken = ['sk', 'proj', 'D'.repeat(48)].join('-');
const anthropicToken = ['sk', 'ant', 'api03', 'E'.repeat(48)].join('-');
const slackToken = ['xoxb', '123456789012', 'F'.repeat(28)].join('-');
const awsAccessKey = `AKIA${'G'.repeat(16)}`;
const googleApiKey = `AIza${'H'.repeat(35)}`;
const stripeLiveKey = `sk_live_${'I'.repeat(32)}`;
const jwt = [
  `eyJ${'J'.repeat(18)}`,
  `eyJ${'K'.repeat(24)}`,
  'L'.repeat(32),
].join('.');
const assignedSecret = `GITHUB_TOKEN=${'M'.repeat(32)}`;
const bearerSecret = `Authorization: Bearer ${'N'.repeat(32)}`;
const urlCredential = `https://user:${'P'.repeat(24)}@example.invalid/path`;
// Assembled from halves, like every other fixture here: a literal PEM header in
// a checked-in file is what credential scanners are built to stop, and a test
// fixture is not worth tripping someone's pre-push hook over.
const pemFence = '-'.repeat(5);
const pemLabel = 'PRIVATE KEY';
const pemKey = [
  `${pemFence}BEGIN ${pemLabel}${pemFence}`,
  'Q'.repeat(80),
  `${pemFence}END ${pemLabel}${pemFence}`,
].join('\n');
const sshPublicKey = `ssh-ed25519 ${'R'.repeat(68)} fixture-comment`;

function resultWith(text: string): SearchResult {
  return {
    slug: 'code/example',
    page_id: 1,
    title: `Credential evidence ${text}`,
    type: 'code',
    chunk_text: `before ${text} after`,
    chunk_source: 'compiled_truth',
    chunk_id: 2,
    chunk_index: 0,
    score: 0.9,
    stale: false,
    content_flag: { reason: 'fixture', detail: `found ${text}` },
    relational_path: ['code/source', text],
  };
}

describe('search output credential redaction', () => {
  test('redacts common credential shapes without printing the original value', () => {
    for (const credential of [
      classicGithubToken,
      fineGrainedGithubToken,
      openAiToken,
      anthropicToken,
      slackToken,
      awsAccessKey,
      googleApiKey,
      stripeLiveKey,
      jwt,
      assignedSecret,
      bearerSecret,
      urlCredential,
      pemKey,
      sshPublicKey,
    ]) {
      const output = redactCredentialLikeText(`prefix ${credential} suffix`);
      expect(output).not.toContain(credential);
      expect(output).toContain('<REDACTED:');
    }
  });

  test('does not redact ordinary hashes, identifiers, or short test labels', () => {
    const safe = [
      '5a0c1979cf439d434c527de4935687a178be4b8e',
      'a787412692c37ebb44eae5447967c568b0adc5b5',
      '550e8400-e29b-41d4-a716-446655440000',
      'ghp_test_fixture',
    ].join(' ');
    expect(redactCredentialLikeText(safe)).toBe(safe);
  });

  test('leaves ordinary prose and short placeholders alone', () => {
    // The assigned-secret pattern is the broad one: it matches NAME=value where
    // NAME reads like a secret. These are the cases that decide whether it is
    // usable on a corpus of notes and source code.
    for (const safe of [
      'the token is stored in the keychain, not in the repo',
      'rotate the api key quarterly and record the date',
      'export GITHUB_TOKEN=',
      'password: ****',
      'api_key = TODO',
      'set SECRET to whatever the vault returns',
    ]) {
      expect(redactCredentialLikeText(safe), safe).toBe(safe);
    }
  });

  test('a documented placeholder assignment is redacted, and that is the intended trade', () => {
    // `API_KEY=your-key-here` is long enough to clear the 8-character floor, so
    // it IS redacted. Pinned deliberately: losing a placeholder in a docs page
    // is the accepted cost of never printing the real assignment that sits in
    // the same shape. If this ever needs to change, it changes here first.
    const documented = 'API_KEY=your-key-here';
    const output = redactCredentialLikeText(documented);
    expect(output).not.toBe(documented);
    expect(output).toContain('<REDACTED:assigned_secret>');
  });

  test('is idempotent across calls — global regex state never skips a match', () => {
    // Every pattern carries the `g` flag and lives at module scope, so a stale
    // lastIndex would make the SECOND call on the same input miss. Two calls
    // must agree, and redacting twice must not find anything new.
    const input = `alpha ${classicGithubToken} beta ${awsAccessKey} gamma`;
    const first = redactCredentialLikeText(input);
    const second = redactCredentialLikeText(input);
    expect(second).toBe(first);
    expect(redactCredentialLikeText(first)).toBe(first);
    expect(first).not.toContain(classicGithubToken);
    expect(first).not.toContain(awsAccessKey);

    // Same guarantee through the result-shaped entry point.
    const results = [resultWith(classicGithubToken), resultWith(awsAccessKey)];
    expect(JSON.stringify(redactSearchResults(results))).toBe(
      JSON.stringify(redactSearchResults(results)),
    );
  });

  test('redacts every occurrence, not just the first, in one string', () => {
    const twoTokens = `${classicGithubToken} and ${classicGithubToken}`;
    const output = redactCredentialLikeText(twoTokens);
    expect(output).not.toContain(classicGithubToken);
    expect(output.match(/<REDACTED:github_token>/g)).toHaveLength(2);
  });

  test('redacts every string-bearing search-result field without mutating input', () => {
    const original = resultWith(classicGithubToken);
    const [redacted] = redactSearchResults([original]);

    expect(JSON.stringify(redacted)).not.toContain(classicGithubToken);
    expect(JSON.stringify(redacted)).toContain('<REDACTED:github_token>');
    expect(original.chunk_text).toContain(classicGithubToken);
    expect(redacted).not.toBe(original);
  });

  test('CLI search formatting redacts a raw result defensively', () => {
    const output = formatResult('search', [resultWith(classicGithubToken)]);
    expect(output).not.toContain(classicGithubToken);
    expect(output).toContain('<REDACTED:github_token>');
  });

  test('search operation redacts before returning to CLI or MCP transports', async () => {
    const rawResult = resultWith(classicGithubToken);
    const engine = {
      getConfig: async (key: string) => key === 'search.mcp_keyword_only' ? 'true' : 'false',
      searchKeyword: async () => [rawResult],
      getContentFlagsByPageIds: async () => new Map(),
      executeRaw: async () => [],
    };
    const op = operationsByName.search;
    const returned = await op.handler({
      engine,
      config: {},
      remote: true,
      dryRun: false,
      sourceId: 'default',
      logger: console,
    } as never, { query: 'credential fixture' }) as SearchResult[];

    expect(JSON.stringify(returned)).not.toContain(classicGithubToken);
    expect(rawResult.chunk_text).toContain(classicGithubToken);
  });
});

describe('search output redaction — shapes that must not slip through', () => {
  const fill = (n: number, c: string) => c.repeat(n);

  test('an assigned value may start with, or contain, punctuation', () => {
    for (const value of [
      `!${fill(20, 'p')}`,
      `$${fill(20, 'q')}`,
      `${fill(10, 'r')}!#%${fill(20, 's')}`,
    ]) {
      const out = redactCredentialLikeText(`password=${value}`);
      // No fragment of the value may survive, not merely its first run.
      expect(out).not.toContain(value);
      expect(out).not.toContain(value.slice(-12));
      expect(out).toContain('<REDACTED:assigned_secret>');
    }
  });

  test('a value longer than any old length cap is redacted, with no surviving tail', () => {
    const longBearer = fill(300, 't');
    const bearer = redactCredentialLikeText(`Authorization: Bearer ${longBearer}`);
    expect(bearer).not.toContain(fill(40, 't'));

    const longAssigned = fill(300, 'u');
    const assigned = redactCredentialLikeText(`API_KEY=${longAssigned}`);
    expect(assigned).not.toContain(fill(40, 'u'));

    const longGithub = ['ghp', fill(300, 'G')].join('_');
    expect(redactCredentialLikeText(longGithub)).not.toContain(fill(40, 'G'));
  });

  test('Basic credentials are redacted the same way as Bearer', () => {
    const basic = `Authorization: Basic ${fill(40, 'e')}==`;
    const out = redactCredentialLikeText(basic);
    expect(out).not.toContain(fill(40, 'e'));
    expect(out).toContain('<REDACTED:authorization_credentials>');
  });

  test('a private key cut off before its END fence still has its material removed', () => {
    const fence = '-'.repeat(5);
    const excerpt = `${fence}BEGIN PRIVATE KEY${fence}\n${fill(64, 'v')}\n${fill(64, 'w')}`;
    const out = redactCredentialLikeText(excerpt);
    expect(out).not.toContain(fill(64, 'v'));
    expect(out).not.toContain(fill(64, 'w'));
    expect(out).toContain('<REDACTED:pem_private_key>');
  });

  test('text before a truncated private key survives; only the key onward is removed', () => {
    const fence = '-'.repeat(5);
    const out = redactCredentialLikeText(`deploy notes:\n${fence}BEGIN RSA PRIVATE KEY${fence}\n${fill(64, 'k')}`);
    expect(out.startsWith('deploy notes:\n')).toBe(true);
    expect(out).not.toContain(fill(64, 'k'));
  });

  test('an ssh key inside one-line JSON leaves the other fields intact', () => {
    const json = `{"key":"ssh-ed25519 ${fill(68, 'x')} me@host","other":"keep-this-value"}`;
    const out = redactCredentialLikeText(json);
    expect(out).not.toContain(fill(68, 'x'));
    expect(out).toContain('"other":"keep-this-value"');
  });

  test('vendor-prefixed tokens the first list missed', () => {
    const sendgrid = ['SG', fill(22, 'a'), fill(43, 'b')].join('.');
    const digitalocean = `dop_v1_${fill(64, 'c')}`;
    for (const token of [sendgrid, digitalocean]) {
      const out = redactCredentialLikeText(`value ${token} end`);
      expect(out).not.toContain(token);
      expect(out).toContain('<REDACTED:');
    }
  });

  test('prose that merely names an auth scheme or a vendor prefix is left alone', () => {
    for (const safe of [
      'see Basic concepts in the docs',
      'Bearer of bad news',
      'the SG. prefix is SendGrid',
    ]) {
      expect(redactCredentialLikeText(safe), safe).toBe(safe);
    }
  });

  test('an unquoted assignment is redacted to the next whitespace, including a trailing field', () => {
    // Pinned as the accepted trade: a password may legitimately contain `,` or
    // `;`, so the value is not cut there. On an unquoted `k=v,k2=v2` line the
    // trailing field is redacted with it — over-redaction, never a leaked tail.
    const out = redactCredentialLikeText(`password=${fill(12, 'z')},next=1 tail`);
    expect(out).not.toContain(fill(12, 'z'));
    expect(out.endsWith(' tail')).toBe(true);
  });
});

describe('search output redaction — adversarial inputs and quoting', () => {
  const fill = (n: number, c: string) => c.repeat(n);
  const fence = '-'.repeat(5);

  test('many unterminated PEM fences are handled in linear time', () => {
    // Search output is page content, so its shape is attacker-chosen. A lazy
    // scan for the END fence made each BEGIN scan to the end of the text and
    // fail, and the unanchored search then retried from the next BEGIN:
    // quadratic. 20k fences took several seconds that way. The bound is set
    // far above the linear cost (single-digit milliseconds here) and far below
    // the quadratic one, so it discriminates without being timing-flaky.
    for (const kind of ['PUBLIC KEY', 'CERTIFICATE', 'PRIVATE KEY']) {
      const input = `${fence}BEGIN ${kind}${fence}\n`.repeat(20_000);
      const t0 = performance.now();
      redactCredentialLikeText(input);
      const ms = performance.now() - t0;
      expect(ms, `${kind}: ${ms.toFixed(0)} ms`).toBeLessThan(1000);
    }
  });

  test('a password containing "<" is redacted in full', () => {
    const rest = fill(20, 'z');
    const out = redactCredentialLikeText(`password="!abcdefghi<${rest}"`);
    expect(out).not.toContain(rest);
    expect(out).toContain('<REDACTED:assigned_secret>');
  });

  test('a value that is already a marker is not re-consumed (idempotence without excluding "<")', () => {
    const token = ['ghp', fill(36, 'A')].join('_');
    const once = redactCredentialLikeText(`password=${token}`);
    expect(once).not.toContain(token);
    expect(redactCredentialLikeText(once)).toBe(once);
  });

  test('short Basic credentials inside an Authorization header are redacted', () => {
    // base64("u:p") is "dTpw" — valid credentials can be four characters long.
    const out = redactCredentialLikeText('Authorization: Basic dTpw');
    expect(out).not.toContain('dTpw');
    expect(out).toContain('<REDACTED:authorization_credentials>');
  });

  test('a document that quotes the private-key marker keeps the rest of its text', () => {
    // Fail-closed for a truncated key must not become "erase from the first
    // mention of the marker": without key material after the fence, it is prose.
    const doc = `To find leaks, search for the string ${fence}BEGIN PRIVATE KEY${fence} in your repo, then rotate.`;
    expect(redactCredentialLikeText(doc)).toBe(doc);
  });

  test('an encrypted legacy private key with RFC 1421 headers is still redacted', () => {
    const key = [
      `${fence}BEGIN RSA PRIVATE KEY${fence}`,
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF',
      '',
      fill(64, 'm'),
      fill(64, 'n'),
    ].join('\n');
    const out = redactCredentialLikeText(`notes\n${key}`);
    expect(out).not.toContain(fill(64, 'm'));
    expect(out.startsWith('notes\n')).toBe(true);
  });
});
