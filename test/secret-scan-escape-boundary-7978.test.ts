/**
 * #7978: the vendor rules' left boundary `(^|[^A-Za-z0-9_])` read the last
 * character of a JSON escape (`\\n` -> `n`) or a percent-escape (`%22` ->
 * `2`) as part of a word, so a key at the start of an escaped JSON string or
 * inside a URL-encoded value was never claimed, and a vendor-claimed value
 * never joined the redaction echo dictionary, so a second copy glued to a word
 * (`token_<key>`) stayed in the output. Both directions are pinned here: every
 * escaped context now redacts, and a prefix embedded in an ordinary word, an
 * escape-looking sequence that is not one, or an identifier-embedded key with
 * no clean copy still does not fire.
 *
 * Every key is assembled at runtime from random parts (gitleaks, CEO-10).
 */
import { describe, expect, test } from 'bun:test';
import { ECHO_MAX_UNIQUE, ECHO_MAX_UNIQUE_VENDOR, redactFindings, scanText } from '../src/core/secret-scan.ts';
import { PROVIDER_KEY_SHAPES, alnum, hex } from './helpers/provider-keys.ts';

const j = (sep: string, ...parts: string[]) => parts.join(sep);
const SEG = () => alnum(24).replace(/[^A-Za-z0-9]/g, 'a');

/** One synthetic key per default-boundary vendor rule, plus the prebuilt credential shapes. */
const KEYS: ReadonlyArray<{ pattern: string; make(): string }> = [
  { pattern: 'anthropic', make: () => j('-', 'sk', 'ant', 'api03', alnum(32)) },
  { pattern: 'openai', make: () => j('-', 'sk', 'proj', alnum(32)) },
  { pattern: 'openai', make: () => j('-', 'sk', alnum(40)) },
  { pattern: 'voyage', make: () => j('-', 'pa', alnum(32)) },
  { pattern: 'github_pat', make: () => j('_', 'github', 'pat', alnum(40)) },
  { pattern: 'github_token', make: () => j('_', 'ghp', alnum(36)) },
  { pattern: 'gitlab_pat', make: () => j('-', 'glpat', alnum(24)) },
  { pattern: 'slack', make: () => j('-', 'xoxb', '1234567890', alnum(24)) },
  { pattern: 'aws_access_key', make: () => 'AKIA' + hex(16).toUpperCase() },
  { pattern: 'google_api_key', make: () => 'AIza' + alnum(35) },
  { pattern: 'stripe', make: () => j('_', 'sk', 'live', alnum(32)) },
  { pattern: 'sendgrid', make: () => j('.', 'SG', alnum(22), alnum(43)) },
  { pattern: 'twilio', make: () => 'AC' + hex(32) },
  { pattern: 'supabase_key', make: () => j('_', 'sb', 'secret', alnum(32)) },
  { pattern: 'npm_token', make: () => j('_', 'npm', alnum(36)) },
  { pattern: 'huggingface', make: () => j('_', 'hf', alnum(34)) },
  { pattern: 'digitalocean', make: () => j('_', 'dop', 'v1', hex(64)) },
  ...PROVIDER_KEY_SHAPES.map((s) => ({ pattern: s.pattern, make: s.make })),
  { pattern: 'gbrain_token', make: () => j('_', 'gbrain', 'at', hex(64)) },
  { pattern: 'jwt', make: () => j('.', 'eyJ' + SEG(), SEG(), SEG()) },
];

/** The escape that sits immediately before the key, as it appears in the raw text. */
const ESCAPES = ['\\n', '\\r', '\\t', '\\\\n', '\\u0022', '%22', '%3D', '%3d', '%0A'];

describe('#7978 a key right after a JSON escape or a percent-escape is claimed', () => {
  for (const { pattern, make } of KEYS) {
    test(`${pattern}: claimed after every escape, and redacted`, () => {
      for (const esc of ESCAPES) {
        const key = make();
        const line = `{"role":"tool","out":"config loaded${esc}${key}${esc === '%22' ? '%22' : '\\n'}done"}`;
        const findings = scanText(line);
        expect({ esc, found: findings.map((f) => f.pattern) }).toEqual({ esc, found: [pattern] });
        const out = redactFindings(line, { highEntropy: true }).text;
        expect({ esc, leaked: out.includes(key) }).toEqual({ esc, leaked: false });
        expect(out).toContain(`${esc}<REDACTED:${pattern}>`);
      }
    });
  }

  test('the #7978 reproduction: Bearer <openrouter key>, then the key after an escaped newline in tool output', () => {
    const k = j('-', 'sk', 'or', 'v1', hex(64));
    const out = redactFindings(`Authorization: Bearer ${k}\n{"out":"line\\n${k}"}`, { highEntropy: true }).text;
    expect(out.includes(k)).toBe(false);
    expect(out).toBe('Authorization: Bearer <REDACTED:openrouter>\n{"out":"line\\n<REDACTED:openrouter>"}');
  });

  test('a URL-encoded body: api_key%3D<key>%26next=1', () => {
    const k = j('_', 'gsk', alnum(52));
    expect(redactFindings(`body=api_key%3D${k}%26next%3D1`).text).toBe('body=api_key%3D<REDACTED:groq>%26next%3D1');
  });

  test('Bearer and Basic after an escaped newline claim their token', () => {
    const tok = alnum(40);
    expect(redactFindings(`{"h":"x\\nBearer ${tok}"}`).text).toBe('{"h":"x\\nBearer <REDACTED:bearer>"}');
    const basic = Buffer.from(`alice-example:${alnum(20)}`).toString('base64');
    expect(redactFindings(`{"h":"x\\nAuthorization: Basic ${basic}"}`).text).toBe('{"h":"x\\nAuthorization: Basic <REDACTED:basic_auth>"}');
  });

  test('a keyword-anchored high-entropy assignment after an escaped newline is claimed (transcript lane)', () => {
    const v = alnum(24) + '7';
    const out = redactFindings(`{"out":"ok\\npassword=${v}\\n"}`, { highEntropy: true }).text;
    expect(out.includes(v)).toBe(false);
  });
});

describe('#7978 a vendor-claimed value joins the echo dictionary', () => {
  test('a second copy glued to a word (token_<key>, prefix<key>) is scrubbed as that vendor', () => {
    const k = j('_', 'ghp', alnum(36));
    const out = redactFindings(`GITHUB_TOKEN=${k}\nurl?token_${k}&x=1 id=prefix${k}\n`).text;
    expect(out).toBe('GITHUB_TOKEN=<REDACTED:github_token>\nurl?token_<REDACTED:github_token>&x=1 id=prefix<REDACTED:github_token>\n');
  });

  test('a session-wide dictionary carries a vendor value claimed in one field to a glued copy in another', async () => {
    const { planRedaction, applyRedaction } = await import('../src/core/secret-scan.ts');
    const k = j('-', 'sk', 'or', 'v1', hex(64));
    const echoValues = new Map<string, string>();
    const glued = planRedaction(`cache_key=v1_${k}`, { echoValues });
    planRedaction(`OPENROUTER_API_KEY=${k}`, { echoValues });
    expect(applyRedaction(glued)).toBe('cache_key=v1_<REDACTED:openrouter>');
  });

  test('a vendor value under the 20-character echo floor (a short slack token) does not join', () => {
    const k = j('-', 'xoxb', alnum(11));
    expect(k.length).toBeLessThan(20);
    expect(redactFindings(`t=${k}\nid=x${k}`).text).toBe(`t=<REDACTED:slack>\nid=x${k}`);
  });
});

describe('#7978 no new false positives', () => {
  test('a vendor prefix inside an ordinary word stays clean, escaped or not', () => {
    const prose = [
      '{"out":"line one\\nrisk-assessment-matrix-for-the-quarter and task-scheduler-for-the-cluster"}',
      '{"out":"\\nskeleton-key-ceremony\\tdesk-assessment-overview-document"}',
      'q=%22risk-assessment-matrix-for-the-quarter%22&r=%20task-scheduler-configuration-for-cluster',
      '{"out":"\\nwhsec-is-not-a-key\\nghp-is-not-a-key\\nnpm_install_dependencies_for_workspace_now"}',
    ].join('\n');
    expect(scanText(prose)).toEqual([]);
    expect(redactFindings(prose, { highEntropy: true }).text).toBe(prose);
  });

  test('a backslash or percent sign that is not an escape is not a boundary', () => {
    for (const before of ['\\q', '\\x', '%ZZ', '%2', 'n', '2', '_']) {
      const key = j('_', 'ghp', alnum(36));
      const line = `id=a${before}${key}`;
      expect({ before, found: scanText(line).map((f) => f.pattern) }).toEqual({ before, found: [] });
    }
  });

  test('a key embedded in an identifier with no clean copy anywhere stays unclaimed (the push gate and redaction agree)', () => {
    const k = j('-', 'sk', alnum(40));
    const text = `id=prefix${k} and token_${k}`;
    expect(scanText(text)).toEqual([]);
    expect(redactFindings(text, { highEntropy: true }).text).toBe(text);
  });

  test('the escape stays in the output; only the key is redacted', () => {
    const k = j('_', 'npm', alnum(36));
    expect(redactFindings(`"a\\n${k}"`).text).toBe('"a\\n<REDACTED:npm_token>"');
    expect(redactFindings(`a%22${k}%22`).text).toBe('a%22<REDACTED:npm_token>%22');
  });
});

describe('#7978 vendor values cannot crowd the echo dictionary', () => {
  test('64 planted vendor keys ahead of a bearer token and an assignment still leave room for their bare echoes', () => {
    const planted = Array.from({ length: 64 }, () => `k=${j('_', 'ghp', alnum(36))}`);
    const tok = alnum(40);
    const pw = `Xk9${alnum(16)}7q`;
    const text = [...planted, `Authorization: Bearer ${tok}`, `PASSWORD=${pw}`, `your token is ${tok} and the password is ${pw}`].join('\n');
    const out = redactFindings(text, { highEntropy: true });
    expect(out.text.includes(tok)).toBe(false);
    expect(out.text.includes(pw)).toBe(false);
    expect(out.text.split('\n').at(-1)).toBe('your token is <REDACTED:bearer> and the password is <REDACTED:high_entropy_assignment>');
  });

  test('vendor values stop joining at ECHO_MAX_UNIQUE_VENDOR; the other families keep all ECHO_MAX_UNIQUE slots', () => {
    const vendor = Array.from({ length: ECHO_MAX_UNIQUE_VENDOR + 8 }, () => j('_', 'ghp', alnum(36)));
    const bearer = Array.from({ length: ECHO_MAX_UNIQUE }, () => alnum(40));
    const text = [...vendor.map((k) => `k=${k}`), ...bearer.map((t) => `Authorization: Bearer ${t}`)].join('\n');
    const echo = redactFindings(text).echoValues;
    expect([...echo.values()].filter((p) => p === 'github_token').length).toBe(ECHO_MAX_UNIQUE_VENDOR);
    expect([...echo.values()].filter((p) => p === 'bearer').length).toBe(ECHO_MAX_UNIQUE);
  });
});

