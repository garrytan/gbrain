/**
 * Agent operator contract v1 goldens (docs/designs/AGENT_OPERATOR_WAVE.md A0).
 *
 * The files under test/fixtures/agent-contract/v1/ freeze the wire shapes
 * every lane codes against and that old-client/new-server pairs run against.
 * Fixtures never contain `next` (computed at render time, never stored): the
 * normaliser strips it from the produced value and this file pins it
 * separately. Docs URLs are stored as `{{DOCS_BASE}}/…`.
 *
 * Regenerate: GBRAIN_TEST_UPDATE_GOLDENS=1 bun test test/agent-contract-goldens.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  __setDocsRefForTests, docsUrl, fallbackJsonDocument, noticeBlock, renderNotice, toAgentError,
  toolErrorResult, toolResultWithNotices, withAgentSiblings, type Notice, type RenderContext,
} from '../src/core/agent-output.ts';
import { opError, OperationError } from '../src/core/ops/contract.ts';
import '../src/core/operations.ts'; // registers shared-op CLI names for the A1 routing pin, as every gbrain process does
import { confirmationPayload } from '../src/core/consent.ts';
import { withEnv } from './helpers/with-env.ts';

const DIR = join(import.meta.dir, 'fixtures', 'agent-contract', 'v1');
const UPDATE = process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1';

// A1: every surface renders with the brain/source the call acted on; CLI argv carry them explicitly.
const routing = { brain: 'host', source: 'default' };
const stdio: RenderContext = {
  transport: 'stdio',
  surface: 'full',
  isCallable: (op) => op !== 'get_health',
  preapproved: () => false,
  routing,
};
const http: RenderContext = { ...stdio, transport: 'http', principal: 'client-example' };
const cli: RenderContext = { transport: 'cli', isCallable: () => false, preapproved: () => false, routing };

let base = '';
beforeAll(() => { __setDocsRefForTests('master'); base = docsUrl('').replace(/\/$/, ''); });
afterAll(() => { __setDocsRefForTests(null); });

function stripNext(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNext);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([k]) => k !== 'next').map(([k, x]) => [k, stripNext(x)]));
  }
  if (typeof v === 'string') {
    if (v.startsWith('{')) {
      try { return JSON.stringify(stripNext(JSON.parse(v)), null, 2); } catch { /* not JSON */ }
    }
    return v.split(base).join('{{DOCS_BASE}}').replace(/^next: [a-z_]+$/m, 'next: {{next}}');
  }
  return v;
}

function normalise(v: unknown): unknown {
  const s = stripNext(v);
  return typeof s === 'string' ? s : JSON.parse(JSON.stringify(s));
}

function golden(name: string, actual: unknown): void {
  const path = join(DIR, name);
  const value = normalise(actual);
  const text = typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) { mkdirSync(DIR, { recursive: true }); writeFileSync(path, text); }
  expect(text).toBe(readFileSync(path, 'utf8'));
}

const doctorFix = {
  argv: ['gbrain', 'doctor', '--json'],
  consent: [] as [],
  actor: 'agent' as const,
  why: 'Doctor reports which capability is missing and how to enable it.',
  requires_exclusive: false,
};

const noResultsNotice: Notice = {
  code: 'empty_retrieval',
  kind: 'info',
  why: 'No pages matched. Search ran keyword-only because embeddings are not configured.',
  fix: doctorFix,
  user_message: 'I found no notes on that topic. Your brain searches keywords only right now.',
};

const safetyNotice: Notice = {
  code: 'backup_coverage',
  kind: 'safety',
  why: 'Two sources have no backup.',
  fix: { ...doctorFix, argv: ['gbrain', 'backup', '--json'], why: 'Shows which assets are not backed up.' },
  user_message: 'Some of your notes are not backed up. Want me to show you which ones?',
};

describe('agent contract v1 goldens', () => {
  test('object result: content[0] is the bare body, no notices', () => {
    golden('object-result.json', toolResultWithNotices({ slug: 'notes/alpha-example', title: 'Alpha example' }, [], stdio));
  });

  test('bare-array result: content[0] stays a bare array; notices ride extra blocks and _meta', () => {
    const r = toolResultWithNotices([], [noResultsNotice], stdio);
    expect(JSON.parse(r.content[0].text)).toEqual([]);
    expect(r.content[1].text.startsWith('[gbrain notice empty_retrieval kind=info]')).toBe(true);
    golden('bare-array-result.json', r);
  });

  test('error with fix (MCP, tool callable)', () => {
    const e = opError('invalid_params', "Unknown sort 'bogus'.", 'Use one of: updated, created, title.', {
      fix: {
        argv: ['gbrain', 'list', '--sort', 'updated'],
        mcp: { tool: 'list_pages', arguments: { sort: 'updated' } },
        consent: [], actor: 'agent', why: 'updated is the default sort.', requires_exclusive: false,
        verify: { mcp: { tool: 'list_pages', arguments: { sort: 'updated', limit: 1 } } },
      },
    });
    const env = toAgentError(e, { transport: 'stdio', op: 'list_pages', render: stdio });
    expect(env.fix?.next).toBe('run');
    golden('error-with-fix.json', toolErrorResult(env));
  });

  test('error with notices: one block, notices inside the envelope', () => {
    const e = opError('unavailable', 'Semantic search is unavailable.', 'Keyword search still works.', { reason: 'embeddings_disabled' });
    e.notices = [safetyNotice];
    const r = toolErrorResult(toAgentError(e, { transport: 'stdio', op: 'query', render: stdio }));
    expect(r.content).toHaveLength(1);
    golden('error-with-notices.json', r);
  });

  test('nested legacy error keeps nesting and gains sibling code/fix', () => {
    const legacy = { error: { class: 'UsageError', code: 'code_def_requires_symbol', message: 'code-def requires a symbol name', hint: 'gbrain code-def <symbol> [--json]' } };
    golden('nested-legacy-error.json', withAgentSiblings(legacy, {
      code: 'code_def_requires_symbol',
      fix: { argv: ['gbrain', 'code-def', '--help'], consent: [], actor: 'agent', why: 'Shows the required symbol argument.', requires_exclusive: false },
    }, cli));
  });

  test('receipt-bearing error keeps write_request and points at the receipt, not a retry', () => {
    const e = opError('write_pending', 'The write was accepted and is still pending.', 'Inspect the receipt before resubmitting.', {
      fix: {
        mcp: { tool: 'get_write_request', arguments: { request_id: '11111111-2222-4333-8444-555555555555' } },
        consent: [], actor: 'agent', why: 'The receipt says whether the write committed.', requires_exclusive: false,
      },
    });
    e.writeRequest = { request_id: '11111111-2222-4333-8444-555555555555', state: 'queued', retry_after_ms: 2000 } as OperationError['writeRequest'];
    e.writeError = 'write_pending';
    golden('receipt-error.json', toolErrorResult(toAgentError(e, { transport: 'stdio', op: 'put_page', mutating: true, outcome: 'pending', render: stdio })));
  });

  test('legacy frozen error value with the new canonical code', () => {
    const e = opError('unknown_tool', 'Unknown: list_pagez', 'Call request_tools to see the tools this connection can call.', { legacy_error: 'unknown_operation' });
    const env = toAgentError(e, { transport: 'http', render: http });
    expect(env.error).toBe('unknown_operation');
    expect(env.code).toBe('unknown_tool');
    golden('legacy-error-value.json', toolErrorResult(env));
  });

  test('confirmation_required payload', () => {
    golden('confirmation-required.json', confirmationPayload({
      command: 'doctor',
      effects: ['paid'],
      actor: 'agent',
      what: 'doctor --remediate',
      why: 'Remediation re-embeds 120 stale pages through the configured provider.',
      risk: 'Spends up to the cap on embedding calls; no data is deleted.',
      user_message: 'Fixing your brain\'s health will cost about $0.40 in embedding calls. OK to proceed?',
      argv: ['gbrain', 'doctor', '--remediate', '--max-usd', '0.60'],
      preview_argv: ['gbrain', 'doctor', '--remediation-plan', '--json'],
      est_usd: 0.4,
      args: ['--remediate'],
    }, cli));
  });

  test('notice block text', () => {
    golden('notice-block.txt', noticeBlock(renderNotice(noResultsNotice, stdio)));
  });

  test('--json exit-time fallback document', () => {
    golden('json-fallback.json', fallbackJsonDocument(1));
  });
});

describe('deriveNext pins for the goldens (next is never stored)', () => {
  test('notice fix runs on stdio, error fix runs, consent asks', () => {
    expect(renderNotice(noResultsNotice, stdio).fix?.next).toBe('tell_user_to_run');
    const p = confirmationPayload({
      command: 'x', effects: ['paid'], actor: 'agent', what: 'x', why: 'w', risk: 'r', user_message: 'u',
      argv: ['gbrain', 'x'], args: [],
    }, cli);
    expect(p.fix.next).toBe('ask_user');
  });

  test('LLMS_REPO_BASE fork override', async () => {
    await withEnv({ LLMS_REPO_BASE: 'https://raw.githubusercontent.com/fork-org/gbrain/main/' }, () => {
      expect(docsUrl('docs/guides/error-codes.md#x')).toBe('https://raw.githubusercontent.com/fork-org/gbrain/main/docs/guides/error-codes.md#x');
    });
  });
});
