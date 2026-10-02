#!/usr/bin/env bun
/**
 * Secret-scan false-positive budget (security fix wave B3, CEO-8, CEO-18).
 * A measurement tool, not a test: it compares the scanner at a base git ref
 * with the working tree over the same corpus and reports the NEW hits the
 * current rules add. The CI-enforced thresholds on the synthetic fixture live
 * in test/secret-scan-fp-budget.test.ts, which imports the builder below.
 *
 *   bun scripts/secret-scan-fp-budget.ts [--base origin/master] [--json]
 *   bun scripts/secret-scan-fp-budget.ts --dir <brain-dir> [--base <ref>]
 *
 * Corpora: every tracked text file under src/, docs/ and skills/ (the repo
 * corpus) and the synthetic brain-like fixture (emails, invites, meeting
 * notes, agent transcripts, quoted docs, plus a secret-bearing part). Each
 * is scanned twice per scanner: `highEntropy: true` (retrieval output,
 * transcript ingest, hooks, the atoms drain, hook heartbeat, embed-facts
 * error text, the context-engine relay refusal) and `highEntropy: false`
 * (the `sources push` gate, bootstrap verify, bootstrap repo scan, corpus
 * segments, the compiled-context sensitivity scan). A hit is NEW when its
 * (pattern, fingerprint) pair is absent from the base scanner's findings for
 * the same document (multiset difference). A document is NEWLY FLAGGED when
 * the base scanner found nothing in it and the current one finds something:
 * with `highEntropy: false` that is a push newly blocked or a context entry
 * newly dropped, with `highEntropy: true` a relay newly refused.
 *
 * `--dir` is the opt-in maintainer run over a local brain: it walks the
 * markdown files under the directory and prints per-pattern counts ONLY —
 * never a path, line or any content. The repo report lists `path:line` for
 * new hits (public files) and never prints matched text either.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as current from '../src/core/secret-scan.ts';

interface Finding {
  pattern: string;
  line: number;
  fingerprint: string;
}

export interface Scanner {
  scanText(text: string, opts?: { highEntropy?: boolean }): Finding[];
}

export interface CorpusDoc {
  id: string;
  /** `clean`: must gain no finding. `secret`: every planted value must be redacted. */
  kind: 'clean' | 'secret';
  text: string;
  /** Secret docs: values that must not survive redaction with or without `highEntropy`. */
  secrets?: string[];
  /** Secret docs: values only the opt-in assignment rule claims (must not survive `highEntropy: true`). */
  assignmentSecrets?: string[];
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function rand(n: number): string {
  const bytes = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[bytes[i]! % ALNUM.length];
  return s.slice(0, n - 1) + String(bytes[0]! % 10);
}

function b64Lines(count: number, last = 64): string[] {
  return Array.from({ length: count }, (_, i) =>
    randomBytes(64).toString('base64').replace(/=/g, '').slice(0, i === count - 1 ? last : 64));
}

/**
 * Synthetic, privacy-safe brain-like fixture, assembled at runtime so no
 * credential-shaped literal or userinfo URL appears in source (CEO-10).
 * Placeholder people and companies only.
 */
export function buildSyntheticBrainCorpus(): CorpusDoc[] {
  const sep = ':' + '//';
  const url = (scheme: string, rest: string) => [scheme, sep, rest].join('');
  const at = '@';
  const dashes = '-'.repeat(5);
  const marker = (word: 'BEGIN' | 'END') => [dashes, word, ' RSA PRIVATE KEY', dashes].join('');
  const clean: CorpusDoc[] = [
    {
      id: 'email-newsletter',
      kind: 'clean',
      text: [
        `From: alice-example <alice${at}acme-example.com>`,
        `To: charlie-example <charlie${at}widget-co.example>`,
        'Subject: Pricing update for the Basic plan',
        '',
        'Hi Charlie,',
        'The Basic plan now includes SSO. Basic responsibilities for admins are listed here:',
        url('https', 'acme-example.com/pricing?ref=newsletter&utm_source=email&utm_campaign=q3-2026'),
        `Docs: ${url('https', 'docs.acme-example.com/auth/tokens#rotation')}`,
        'Your password reset link expires in 24 hours. We will never ask for your password.',
        '',
        'Thanks,',
        'Alice',
        '--',
        'alice-example | Head of Platform | acme-example',
        `m: +1 555 0100 | ${url('https', 'acme-example.com')} | ${url('https', 'x.example/acme-example')}`,
        `Unsubscribe: ${url('https', 'lists.acme-example.com/u/8f14e45fceea167a5a36dedd4bea2543?list=news')}`,
        'Sent from my phone',
      ].join('\n'),
    },
    {
      id: 'calendar-invite',
      kind: 'clean',
      text: [
        'BEGIN:VCALENDAR',
        'SUMMARY:Weekly sync - acme-example / widget-co',
        'DTSTART:20260115T170000Z',
        `ORGANIZER;CN=alice-example:mailto:alice${at}acme-example.com`,
        `DESCRIPTION:Join: ${url('https', 'meet.example.com/abc-defg-hij')}\\nOr by phone +1 555-0100 PIN 123 456 789#`,
        `LOCATION:${url('https', 'zoom.example/j/81234567890?pwd=Zk9sUm1QaE5vT3BxR2hYdz09')}`,
        `X-TEAMS:${url('https', 'teams.example/l/meetup-join/19%3ameeting_YTdkZDI3%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf%22%7d')}`,
        `X-CAL:${url('https', 'calendar.example.com/event?eid=NWZ0aDd2cWdzNzN0OGtwM2Y5c2Rv&ctz=America/Los_Angeles')}`,
        'END:VCALENDAR',
      ].join('\n'),
    },
    {
      id: 'meeting-notes',
      kind: 'clean',
      text: [
        '# 2026-01-15 platform sync',
        '- Decision: rotate the API token next week; owner alice-example.',
        '- The token budget per request stays at 4096; password_min_length: 12.',
        '- Basic auth is deprecated in v2, use Bearer tokens from the OAuth flow.',
        '- Authorization: Basic auth is deprecated (the header form is going away).',
        '- Credential rotation runbook lives in the wiki; the token is stored in the keychain, not in the repo.',
        '- TOKEN_TTL_SECONDS = 3600 and secret_name = my-app/prod/database-credentials',
        '- Follow-ups: basic internationalization support, Bearer of bad news slide.',
        `- Registry: ${url('https', 'registry.example/')}${at}scope/pkg and ${url('http', 'localhost:5173/')}${at}vite/client`,
        `- Status page ${url('https', 'status.example.com:443/')}${at}acme-example`,
      ].join('\n'),
    },
    {
      id: 'agent-transcript',
      kind: 'clean',
      text: [
        'user: why does the deploy fail?',
        'assistant: running the checks',
        `tool: git push ${url('https', 'github.com/acme-example/app.git')} main`,
        `tool: curl -H "Authorization: Bearer $TOKEN" ${url('https', 'api.acme-example.com/v1/items')}`,
        'tool: export API_KEY=$(op read op://vault/item/field)',
        'tool: grep -n "password = process.env.DB_PASSWORD_2" src/db.ts',
        'tool: const token = await getToken(scope2, audience3)',
        'tool: token_url: "https://oauth2.example.com/token"',
        'tool: credentials_path: "/home/alice-example/.config/gcloud/application_default_credentials.json"',
        'tool: secret_file = ./config/secrets2.example.json',
        'tool: password: "${{ secrets.DB_PASSWORD }}"',
        `tool: clone ${url('https', `user:<password>${at}git.example.com/team/repo.git`)}`,
        `tool: clone ${url('https', `deploy:\${DEPLOY_TOKEN}${at}git.example.com/team/repo.git`)}`,
        `tool: ssh git${at}github.com:acme-example/app.git`,
        `tool: psql ${url('postgres', 'localhost:5432/app')}`,
        'tool: commit 3e365f5f1a2b4c8d9e0f1a2b3c4d5e6f70819293 550e8400-e29b-41d4-a716-446655440000',
        'tool: npm install @types/node lodash.merge@4.6.2',
        'assistant: the config uses config.secrets.apiKey2 and settings.token.refreshUrl2.',
      ].join('\n'),
    },
    {
      id: 'quoted-docs-end-marker',
      kind: 'clean',
      text: [
        'Key files end with this line:',
        marker('END'),
        'and nothing secret should follow it in docs.',
        'For Basic auth the header looks like `Authorization: Basic <base64 of user:password>`.',
      ].join('\n'),
    },
  ];
  const ghp = ['ghp', rand(36)].join('_');
  const httpPw = rand(24);
  const basicValue = Buffer.from(`svc-acme:${rand(18)}`).toString('base64');
  const dop = ['dop', 'v1', randomBytes(32).toString('hex')].join('_');
  const punctuated = `${rand(10)}!#%${rand(8)}`;
  const quoted = `${rand(8)}&()<${rand(8)}`;
  const assigned = rand(28);
  const truncated = b64Lines(4, 21);
  const split = b64Lines(3, 30);
  const secret: CorpusDoc[] = [
    {
      id: 'secret-transcript',
      kind: 'secret',
      text: [
        `tool: git remote set-url origin ${url('https', `x-access-token:${httpPw}${at}github.com/acme-example/app.git`)}`,
        `tool: curl -H "authorization: basic ${basicValue}" ${url('https', 'api.acme-example.com')}`,
        `tool: export DIGITALOCEAN_ACCESS_TOKEN=${dop}`,
        `tool: export GITHUB_TOKEN=${ghp}`,
        `tool: DB_PASSWORD=${punctuated}`,
        `tool: {"client_secret": "${quoted}"}`,
        `tool: SMTP_TOKEN=${assigned}. retrying`,
        `assistant: I used ${assigned} for the retry.`,
      ].join('\n'),
      secrets: [httpPw, basicValue, dop, ghp],
      assignmentSecrets: [punctuated, quoted, assigned],
    },
    {
      id: 'secret-truncated-key-excerpt',
      kind: 'secret',
      text: `Deploy key excerpt from the ticket:\n${marker('BEGIN')}\n${truncated.join('\n')}`,
      secrets: truncated,
    },
    {
      id: 'secret-split-key-chunk',
      kind: 'secret',
      text: `${split.join('\n')}\n${marker('END')}\nrotate this one`,
      secrets: split,
    },
  ];
  return [...clean, ...secret];
}

/** Multiset of `pattern\0fingerprint` keys. */
function findingKeys(findings: Finding[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of findings) {
    const k = `${f.pattern}\0${f.fingerprint}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Findings of `after` whose (pattern, fingerprint) is not matched one-for-one in `before`. */
export function newFindings(before: Finding[], after: Finding[]): Finding[] {
  const remaining = findingKeys(before);
  const out: Finding[] = [];
  for (const f of after) {
    const k = `${f.pattern}\0${f.fingerprint}`;
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else out.push(f);
  }
  return out;
}

export interface ModeReport {
  newHitsByPattern: Record<string, number>;
  docsNewlyFlagged: number;
  newHits: Array<{ doc: string; pattern: string; line: number }>;
}

export function measure(docs: Array<{ id: string; text: string }>, base: Scanner, head: Scanner, highEntropy: boolean): ModeReport {
  const report: ModeReport = { newHitsByPattern: {}, docsNewlyFlagged: 0, newHits: [] };
  for (const d of docs) {
    const before = base.scanText(d.text, { highEntropy });
    const after = head.scanText(d.text, { highEntropy });
    if (before.length === 0 && after.length > 0) report.docsNewlyFlagged++;
    for (const f of newFindings(before, after)) {
      report.newHitsByPattern[f.pattern] = (report.newHitsByPattern[f.pattern] ?? 0) + 1;
      report.newHits.push({ doc: d.id, pattern: f.pattern, line: f.line });
    }
  }
  return report;
}

async function loadBaseScanner(ref: string): Promise<Scanner> {
  const source = execFileSync('git', ['show', `${ref}:src/core/secret-scan.ts`], { encoding: 'utf-8' });
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-base-'));
  const file = join(dir, 'secret-scan.ts');
  writeFileSync(file, source);
  try {
    return (await import(file)) as Scanner;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function repoCorpus(): Array<{ id: string; text: string }> {
  const files = execFileSync('git', ['ls-files', 'src', 'docs', 'skills'], { encoding: 'utf-8' }).split('\n').filter(Boolean);
  const out: Array<{ id: string; text: string }> = [];
  for (const f of files) {
    const buf = readFileSync(f);
    if (buf.length > current.SCAN_MAX_FILE_BYTES || current.looksBinaryBuffer(buf)) continue;
    out.push({ id: f, text: buf.toString('utf-8') });
  }
  return out;
}

function brainCorpus(dir: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.md') && st.size <= current.SCAN_MAX_FILE_BYTES) out.push({ id: String(out.length), text: readFileSync(p, 'utf-8') });
    }
  };
  walk(resolve(dir));
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const base = await loadBaseScanner(opt('--base') ?? 'origin/master');
  const head: Scanner = current;
  const dir = opt('--dir');
  const corpora: Record<string, Array<{ id: string; text: string }>> = dir
    ? { brain: brainCorpus(dir) }
    : { repo: repoCorpus(), synthetic: buildSyntheticBrainCorpus().filter((d) => d.kind === 'clean') };
  const result: Record<string, { docs: number; highEntropyTrue: ModeReport; highEntropyFalse: ModeReport }> = {};
  for (const [name, docs] of Object.entries(corpora)) {
    const t = measure(docs, base, head, true);
    const f = measure(docs, base, head, false);
    if (dir) {
      t.newHits = [];
      f.newHits = [];
    }
    result[name] = { docs: docs.length, highEntropyTrue: t, highEntropyFalse: f };
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const [name, r] of Object.entries(result)) {
    console.log(`\n${name}: ${r.docs} documents`);
    for (const [mode, m] of [['highEntropy: true', r.highEntropyTrue], ['highEntropy: false', r.highEntropyFalse]] as const) {
      const total = Object.values(m.newHitsByPattern).reduce((a, b) => a + b, 0);
      console.log(`  ${mode}: ${total} new hits, ${m.docsNewlyFlagged} documents newly flagged`);
      for (const [p, n] of Object.entries(m.newHitsByPattern).sort()) console.log(`    ${p}: ${n}`);
      for (const h of m.newHits) console.log(`      ${h.doc}:${h.line} ${h.pattern}`);
    }
  }
}

if (import.meta.main) await main();
