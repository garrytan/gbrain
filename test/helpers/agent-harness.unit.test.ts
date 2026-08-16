/**
 * Unit coverage for the real-agent door harness that needs NO real binary and
 * pays ZERO API cost. Exercises:
 *   - parseClaudeStream against a captured `claude -p --output-format
 *     stream-json` NDJSON fixture (tool_use names + final result text).
 *   - parseCodexJsonl against a captured `codex exec --json` JSONL fixture
 *     (command_execution → toolCalls, agent_message → finalText, reasoning).
 *   - hermeticChildEnv: drops CONDUCTOR_* / CLAUDE_* / GSTACK_* / MCP_* /
 *     GBRAIN_*, promotes GSTACK_ANTHROPIC_API_KEY, honors extraAllow, and lets
 *     overrides win.
 *   - resolveClaudeBinary / resolveCodexBinary SMOKE (whatever this machine
 *     has — assertion is only that the result is a string-or-null, plus a note
 *     printed when found).
 *
 * The env test mutates process.env and restores it in finally so it never
 * leaks into sibling tests.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseClaudeStream,
  parseCodexJsonl,
  hermeticChildEnv,
  hermesChildEnv,
  grokChildEnv,
  promotedEnv,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveHermesBinary,
  resolveGrokBinary,
  hasHermesAuth,
  hasGrokAuth,
  parseDotenvFile,
  seedHermesHome,
  seedGrokConfig,
  opencodeChildEnv,
  hasOpencodeAuth,
  seedOpencodeConfig,
  parseOpencodeJsonl,
  runOneShotSpawn,
} from './agent-harness.ts';
import { withEnv } from './with-env.ts';

// A captured claude stream-json turn: a system init line, an assistant text +
// tool_use turn, a tool_result user line, a second assistant text turn, and the
// terminal result line. Trailing blank + one malformed line prove the parser
// tolerates both.
const CLAUDE_NDJSON = [
  '{"type":"system","subtype":"init","session_id":"abc","tools":["mcp__gbrain__recall"]}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me search the brain."},{"type":"tool_use","id":"tu_1","name":"mcp__gbrain__recall","input":{"query":"fulfillment center"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"Summit Robotics runs the Rivermouth fulfillment center."}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Summit Robotics runs the Rivermouth fulfillment center."}]}}',
  '',
  'this is not json and must be skipped',
  '{"type":"result","subtype":"success","is_error":false,"result":"Summit Robotics runs the Rivermouth fulfillment center.","num_turns":2,"total_cost_usd":0.01}',
];

// A captured codex exec --json turn: thread.started, a reasoning item, a
// command_execution item, an agent_message item, turn.completed, plus a blank
// and a malformed line.
const CODEX_JSONL = [
  '{"type":"thread.started","thread_id":"th_123"}',
  '{"type":"item.completed","item":{"type":"reasoning","text":"I should read the file to answer."}}',
  '{"type":"item.completed","item":{"type":"command_execution","command":"cat facts.md","exit_code":0}}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"The fulfillment center is Rivermouth."}}',
  '',
  '{oops not json',
  '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
];

describe('parseClaudeStream', () => {
  test('extracts tool_use names and the final result text', () => {
    const parsed = parseClaudeStream(CLAUDE_NDJSON);
    expect(parsed.toolCalls).toEqual(['mcp__gbrain__recall']);
    expect(parsed.finalText).toBe('Summit Robotics runs the Rivermouth fulfillment center.');
  });

  test('falls back to last assistant text when no result line', () => {
    const noResult = CLAUDE_NDJSON.filter((l) => !l.includes('"type":"result"'));
    const parsed = parseClaudeStream(noResult);
    expect(parsed.finalText).toBe('Summit Robotics runs the Rivermouth fulfillment center.');
    expect(parsed.toolCalls).toEqual(['mcp__gbrain__recall']);
  });

  test('empty input yields empty result, never throws', () => {
    expect(parseClaudeStream([])).toEqual({ finalText: '', toolCalls: [] });
  });
});

describe('parseCodexJsonl', () => {
  test('extracts command executions, agent message, and reasoning', () => {
    const parsed = parseCodexJsonl(CODEX_JSONL);
    expect(parsed.toolCalls).toEqual(['cat facts.md']);
    expect(parsed.finalText).toBe('The fulfillment center is Rivermouth.');
    expect(parsed.reasoning).toEqual(['I should read the file to answer.']);
  });

  test('empty input yields empty result, never throws', () => {
    expect(parseCodexJsonl([])).toEqual({ finalText: '', toolCalls: [], reasoning: [], mcpToolCalls: [] });
  });

  test('mcp_tool_call items extract {server, tool} from top-level fields', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', server: 'gbrain', tool: 'recall' },
    });
    expect(parseCodexJsonl([line]).mcpToolCalls).toEqual([{ server: 'gbrain', tool: 'recall' }]);
  });

  test('mcp_tool_call falls back to invocation.{server,tool} and name', () => {
    const nested = JSON.stringify({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', invocation: { server: 'gbrain', tool: 'search' } },
    });
    const named = JSON.stringify({
      type: 'item.completed',
      item: { type: 'mcp_tool_call', server: 'gbrain', name: 'context_pack' },
    });
    const parsed = parseCodexJsonl([nested, named]);
    expect(parsed.mcpToolCalls).toEqual([
      { server: 'gbrain', tool: 'search' },
      { server: 'gbrain', tool: 'context_pack' },
    ]);
  });
});

describe('promotedEnv', () => {
  test('promotes GSTACK_ANTHROPIC_API_KEY when canonical is unset', () => {
    const out = promotedEnv({ GSTACK_ANTHROPIC_API_KEY: 'sk-gstack' } as NodeJS.ProcessEnv);
    expect(out.ANTHROPIC_API_KEY).toBe('sk-gstack');
  });

  test('does NOT clobber an existing canonical key', () => {
    const out = promotedEnv({
      ANTHROPIC_API_KEY: 'sk-real',
      GSTACK_ANTHROPIC_API_KEY: 'sk-gstack',
    } as NodeJS.ProcessEnv);
    expect(out.ANTHROPIC_API_KEY).toBe('sk-real');
  });
});

describe('hermeticChildEnv', () => {
  test('drops CONDUCTOR_*/CLAUDE_*/GSTACK_*/MCP_*/GBRAIN_*, keeps PATH/HOME, promotes GSTACK key', async () => {
    // Contaminate the process env with everything a real Conductor + Claude
    // Code session would carry (ANTHROPIC_API_KEY unset so promotion shows).
    await withEnv(
      {
        CONDUCTOR_WORKSPACE_PATH: '/should/drop',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDECODE: '1',
        MCP_SERVER: 'gbrain',
        GBRAIN_HOME: '/operator/.gbrain',
        GSTACK_HOME: '/operator/.gstack',
        ANTHROPIC_API_KEY: undefined,
        GSTACK_ANTHROPIC_API_KEY: 'sk-promote-me',
      },
      () => {
        const env = hermeticChildEnv({ HOME: '/tmp/hermetic-home', GBRAIN_HOME: '/tmp/hermetic-gbrain' });

        // Dropped.
        expect(env.CONDUCTOR_WORKSPACE_PATH).toBeUndefined();
        expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
        expect(env.CLAUDECODE).toBeUndefined();
        expect(env.MCP_SERVER).toBeUndefined();
        expect(env.GSTACK_HOME).toBeUndefined();
        // GSTACK_ANTHROPIC_API_KEY itself is dropped (prefix), but its value was
        // promoted onto the allowlisted canonical name.
        expect(env.GSTACK_ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBe('sk-promote-me');

        // Kept.
        expect(env.PATH).toBe(process.env.PATH);
        // Overrides win — HOME is the temp one, and a GBRAIN_HOME override is
        // honored even though the bare GBRAIN_ prefix is dropped.
        expect(env.HOME).toBe('/tmp/hermetic-home');
        expect(env.GBRAIN_HOME).toBe('/tmp/hermetic-gbrain');
      },
    );
  });

  test('extraAllow admits exact names and PREFIX_* forms (codex auth surface)', async () => {
    await withEnv(
      {
        OPENAI_API_KEY: 'sk-openai',
        CODEX_HOME: '/operator/.codex',
        CODEX_SANDBOX: 'workspace-write',
      },
      () => {
        const env = hermeticChildEnv({}, { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] });
        expect(env.OPENAI_API_KEY).toBe('sk-openai');
        expect(env.CODEX_HOME).toBe('/operator/.codex');
        expect(env.CODEX_SANDBOX).toBe('workspace-write');

        // Without extraAllow, the same vars are dropped.
        const scrubbed = hermeticChildEnv({});
        expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
        expect(scrubbed.CODEX_HOME).toBeUndefined();
      },
    );
  });
});

describe('binary resolution SMOKE', () => {
  test('resolveClaudeBinary returns a string or null', () => {
    const bin = resolveClaudeBinary();
    expect(bin === null || typeof bin === 'string').toBe(true);
    if (bin) console.log(`[smoke] claude resolved at: ${bin}`);
  });

  test('resolveCodexBinary returns a string or null', () => {
    const bin = resolveCodexBinary();
    expect(bin === null || typeof bin === 'string').toBe(true);
    if (bin) console.log(`[smoke] codex resolved at: ${bin}`);
  });

  test('resolveHermesBinary returns a string or null', () => {
    const bin = resolveHermesBinary();
    expect(bin === null || typeof bin === 'string').toBe(true);
    if (bin) console.log(`[smoke] hermes resolved at: ${bin}`);
  });

  test('hasHermesAuth returns a boolean', () => {
    expect(typeof hasHermesAuth()).toBe('boolean');
  });
});

describe('hasHermesAuth truth table (env leg — pins the anthropic-only, non-empty-value gate)', () => {
  // The .env-file leg reads the operator's real ~/.hermes/.env, so only the
  // env-var leg is exercised hermetically here; the file PARSING contract is
  // pinned by the parseDotenvFile + seedHermesHome describes below.
  const CLEAR = {
    ANTHROPIC_API_KEY: undefined,
    GSTACK_ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    GSTACK_OPENAI_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
  } as const;

  /** True only when the operator's real ~/.hermes/.env carries an anthropic key. */
  const fileLegHasAnthropicKey = () =>
    Boolean(parseDotenvFile(join(process.env.HOME ?? '', '.hermes', '.env')).ANTHROPIC_API_KEY?.trim());

  test('non-empty anthropic env key → true', async () => {
    await withEnv({ ...CLEAR, ANTHROPIC_API_KEY: 'sk-test-nonempty' }, () => {
      expect(hasHermesAuth()).toBe(true);
    });
  });

  test('GSTACK_-prefixed anthropic key promotes → true', async () => {
    await withEnv({ ...CLEAR, GSTACK_ANTHROPIC_API_KEY: 'sk-test-promoted' }, () => {
      expect(hasHermesAuth()).toBe(true);
    });
  });

  test('BLANK env value → does NOT count as auth (a blank CI secret must skip, not fail paid)', async () => {
    await withEnv({ ...CLEAR, ANTHROPIC_API_KEY: '   ' }, () => {
      expect(hasHermesAuth()).toBe(fileLegHasAnthropicKey());
    });
  });

  test('a NON-anthropic provider key alone → false (door is anthropic-pinned; a second provider mis-routes provider-auto)', async () => {
    await withEnv({ ...CLEAR, OPENAI_API_KEY: 'sk-openai-only' }, () => {
      expect(hasHermesAuth()).toBe(fileLegHasAnthropicKey());
    });
  });
});

describe('hermesChildEnv — the single-auth-source enforcement point', () => {
  test('scrubs EVERY provider key (incl. allowlisted anthropic vars) and pins HOME/HERMES_HOME', async () => {
    // A regression here (dropping the delete loop) re-leaks the operator's
    // real key into every hermes child and reintroduces the provider-auto
    // 401 mis-route — detectable only in the triple-gated paid lane, so the
    // contract is pinned hermetically here.
    await withEnv({
      ANTHROPIC_API_KEY: 'sk-operator',
      ANTHROPIC_BASE_URL: 'https://operator.example',
      ANTHROPIC_AUTH_TOKEN: 'tok-operator',
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'sk-openrouter',
      GSTACK_ANTHROPIC_API_KEY: undefined,
      GSTACK_OPENAI_API_KEY: undefined,
      HERMES_HOME: '/operator/.hermes',
    }, () => {
      const env = hermesChildEnv('/tmp/hermes-child-test');
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']) {
        expect(env[k]).toBeUndefined();
      }
      expect(env.HOME).toBe('/tmp/hermes-child-test');
      expect(env.HERMES_HOME).toBe('/tmp/hermes-child-test/.hermes');
    });
  });

  test('GITHUB_* step-metadata files are deleted (the backported grok scrub, via the shared factory)', async () => {
    await withEnv({
      GITHUB_ENV: '/tmp/gh-env-file',
      GITHUB_PATH: '/tmp/gh-path-file',
      GITHUB_OUTPUT: '/tmp/gh-output-file',
      GITHUB_STATE: '/tmp/gh-state-file',
      GITHUB_STEP_SUMMARY: '/tmp/gh-summary-file',
      GITHUB_ACTIONS: 'true',
    }, () => {
      const env = hermesChildEnv('/tmp/hermes-child-test');
      for (const k of ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']) {
        expect(env[k]).toBeUndefined();
      }
      // Read-only CI metadata stays allowed (prefix rule intact).
      expect(env.GITHUB_ACTIONS).toBe('true');
    });
  });
});

describe('parseDotenvFile', () => {
  test('parses KEY=VALUE, skips comments/blanks, strips quotes and export prefixes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-dotenv-'));
    try {
      const f = join(dir, '.env');
      writeFileSync(f, [
        '# comment',
        '',
        'ANTHROPIC_API_KEY=sk-plain',
        'export OPENAI_API_KEY="sk-quoted"',
        "OPENROUTER_API_KEY='sk-single'",
        'BLANK_KEY=',
        'not a kv line',
      ].join('\n'), 'utf-8');
      const parsed = parseDotenvFile(f);
      expect(parsed.ANTHROPIC_API_KEY).toBe('sk-plain');
      expect(parsed.OPENAI_API_KEY).toBe('sk-quoted');
      expect(parsed.OPENROUTER_API_KEY).toBe('sk-single');
      expect(parsed.BLANK_KEY).toBe('');
      expect(Object.keys(parsed)).not.toContain('not a kv line');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unreadable file → empty object, never throws', () => {
    expect(parseDotenvFile('/nonexistent/path/.env')).toEqual({});
  });
});

describe('seedHermesHome single-key copy (injectable source — never the operator home)', () => {
  test('copies EXACTLY the anthropic key; other providers and behavior knobs stay behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-seedhh-'));
    try {
      const src = join(dir, 'source.env');
      writeFileSync(src, [
        'ANTHROPIC_API_KEY=sk-copy-me',
        'OPENAI_API_KEY=sk-openai-stays-home',  // second provider → dropped (mis-routes provider-auto)
        'OPENROUTER_API_KEY=sk-or-stays-home',  // second provider → dropped
        'TELEGRAM_BOT_TOKEN=secret-stays-home', // unlisted → dropped
        'HERMES_BASE_URL=https://internal',     // unlisted → dropped
      ].join('\n'), 'utf-8');

      const home = join(dir, 'home');
      const hermesHome = await withEnv({
        ANTHROPIC_API_KEY: undefined, GSTACK_ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined, GSTACK_OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
      }, () => seedHermesHome(home, { sourceEnvPath: src }));

      expect(hermesHome).toBe(join(home, '.hermes'));
      const written = readFileSync(join(hermesHome, '.env'), 'utf-8');
      expect(written).toBe('ANTHROPIC_API_KEY=sk-copy-me\n');
      // seedHermesHome never writes config.yaml (hermes owns that schema —
      // the model pin goes through the hermes CLI instead).
      expect(existsSync(join(hermesHome, 'config.yaml'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no source file + no env keys → no .env written (gate stays closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-seedhh2-'));
    try {
      const home = join(dir, 'home');
      await withEnv({
        ANTHROPIC_API_KEY: undefined, GSTACK_ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined, GSTACK_OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined,
      }, () => seedHermesHome(home, { sourceEnvPath: join(dir, 'missing.env') }));
      expect(existsSync(join(home, '.hermes', '.env'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hasGrokAuth truth table (env-only — pins the non-empty-value gate)', () => {
  // Env-only on purpose: keyless grok exits 1 with "Not signed in … set the
  // XAI_API_KEY environment variable" (observed v1.0.4); no credential file
  // was observed keyless (GROK-CLI-PIN.md marks the authed inventory pending).
  test('non-empty XAI_API_KEY → true', async () => {
    await withEnv({ XAI_API_KEY: 'xai-sentinel' }, () => {
      expect(hasGrokAuth()).toBe(true);
    });
  });

  test('blank XAI_API_KEY (empty CI secret) → false, never a paid failure', async () => {
    await withEnv({ XAI_API_KEY: '   ' }, () => {
      expect(hasGrokAuth()).toBe(false);
    });
  });

  test('unset XAI_API_KEY → false', async () => {
    await withEnv({ XAI_API_KEY: undefined }, () => {
      expect(hasGrokAuth()).toBe(false);
    });
  });
});

describe('grokChildEnv — explicit key re-admission + CI metadata scrub', () => {
  test('XAI_API_KEY survives via explicit override; HOME/GROK_HOME point at the temp home', async () => {
    await withEnv({ XAI_API_KEY: 'xai-child-sentinel' }, () => {
      const env = grokChildEnv('/tmp/grok-child-test');
      // Not in ALLOW_EXACT — only the explicit override carries it through.
      expect(env.XAI_API_KEY).toBe('xai-child-sentinel');
      expect(env.HOME).toBe('/tmp/grok-child-test');
      expect(env.GROK_HOME).toBe('/tmp/grok-child-test/.grok');
    });
  });

  test('other provider keys and GITHUB_* step-metadata files are deleted', async () => {
    await withEnv({
      XAI_API_KEY: 'xai-x',
      ANTHROPIC_API_KEY: 'ant-must-not-leak',
      OPENAI_API_KEY: 'oai-must-not-leak',
      GITHUB_ENV: '/tmp/gh-env-file',
      GITHUB_PATH: '/tmp/gh-path-file',
      GITHUB_OUTPUT: '/tmp/gh-output-file',
      GITHUB_STATE: '/tmp/gh-state-file',
      GITHUB_ACTIONS: 'true',
    }, () => {
      const env = grokChildEnv('/tmp/grok-child-test');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      // The GITHUB_ prefix rule would forward these writable step-metadata
      // files to an untrusted agent child — poisoning later workflow steps.
      expect(env.GITHUB_ENV).toBeUndefined();
      expect(env.GITHUB_PATH).toBeUndefined();
      expect(env.GITHUB_OUTPUT).toBeUndefined();
      expect(env.GITHUB_STATE).toBeUndefined();
      // Read-only CI metadata stays allowed (prefix rule intact).
      expect(env.GITHUB_ACTIONS).toBe('true');
    });
  });
});

describe('seedGrokConfig — the auto-update kill-switch seed', () => {
  test('writes [cli] auto_update=false, optional model pin, never credentials', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-seed-'));
    try {
      const grokHome = seedGrokConfig(home, { defaultModel: 'grok-4.5' });
      const doc = readFileSync(join(grokHome, 'config.toml'), 'utf-8');
      expect(doc).toContain('[cli]');
      expect(doc).toContain('auto_update = false');
      expect(doc).toContain('default = "grok-4.5"');
      expect(doc).not.toMatch(/XAI|api[_-]?key/i);
      // Parseable by the same parser the door reads with.
      expect(() => (Bun as unknown as { TOML: { parse(s: string): unknown } }).TOML.parse(doc)).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('without a model opt, only the [cli] section is written', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-seed-'));
    try {
      seedGrokConfig(home);
      const doc = readFileSync(join(home, '.grok', 'config.toml'), 'utf-8');
      expect(doc).toContain('auto_update = false');
      expect(doc).not.toContain('[models]');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('resolveGrokBinary — fail-closed GROK_BIN handling', () => {
  test('returns a string-or-null; a string is an absolute path', () => {
    const p = resolveGrokBinary();
    if (p !== null) expect(p.startsWith('/')).toBe(true);
    else expect(p).toBeNull();
  });

  test('valid executable GROK_BIN is returned verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-resolve-'));
    const shim = join(dir, 'grok');
    try {
      writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
      await withEnv({ GROK_BIN: shim }, () => {
        expect(resolveGrokBinary()).toBe(shim);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('set-but-invalid GROK_BIN fails CLOSED — never falls through to PATH (community-binary mis-bind guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'grok-resolve-'));
    const notExec = join(dir, 'grok-noexec');
    try {
      writeFileSync(notExec, '#!/bin/sh\n', { mode: 0o644 });
      await withEnv({ GROK_BIN: notExec }, () => {
        expect(resolveGrokBinary()).toBeNull();
      });
      await withEnv({ GROK_BIN: 'relative/grok' }, () => {
        expect(resolveGrokBinary()).toBeNull();
      });
      await withEnv({ GROK_BIN: '/tmp/foo/../grok' }, () => {
        expect(resolveGrokBinary()).toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('opencodeChildEnv — XDG redirection + explicit anthropic re-admission (5a-core factory)', () => {
  test('ANTHROPIC_API_KEY survives via explicit override; HOME + both XDG dirs point at the temp home; autoupdate env kill set', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'ant-child-sentinel' }, () => {
      const env = opencodeChildEnv('/tmp/opencode-child-test');
      expect(env.ANTHROPIC_API_KEY).toBe('ant-child-sentinel');
      expect(env.HOME).toBe('/tmp/opencode-child-test');
      expect(env.XDG_CONFIG_HOME).toBe('/tmp/opencode-child-test/.config');
      expect(env.XDG_DATA_HOME).toBe('/tmp/opencode-child-test/.local/share');
      expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    });
  });

  test('other provider keys, the OPENCODE_CONFIG* shadow trio, and GITHUB_* step files are deleted', async () => {
    await withEnv({
      ANTHROPIC_API_KEY: 'ant-x',
      OPENAI_API_KEY: 'oai-must-not-leak',
      XAI_API_KEY: 'xai-must-not-leak',
      OPENROUTER_API_KEY: 'or-must-not-leak',
      GOOGLE_GENERATIVE_AI_API_KEY: 'ggl-must-not-leak',
      OPENCODE_CONFIG: '/operator/custom.json',
      OPENCODE_CONFIG_DIR: '/operator/cfgdir',
      OPENCODE_CONFIG_CONTENT: '{"mcp":{}}',
      GITHUB_ENV: '/tmp/gh-env-file',
      GITHUB_ACTIONS: 'true',
    }, () => {
      const env = opencodeChildEnv('/tmp/opencode-child-test');
      for (const k of [
        'OPENAI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
        'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
        'GITHUB_ENV',
      ]) {
        expect(env[k]).toBeUndefined();
      }
      expect(env.GITHUB_ACTIONS).toBe('true');
    });
  });

  test('binDir PATH-prepends (staged bare-`gbrain` registrations must resolve in every spawn)', async () => {
    await withEnv({}, () => {
      const env = opencodeChildEnv('/tmp/opencode-child-test', { binDir: '/tmp/staged-bin' });
      expect(env.PATH?.startsWith('/tmp/staged-bin:')).toBe(true);
    });
  });
});

describe('CI credential scrub — no door agent child ever sees the workflow/OIDC tokens (5a-core factory)', () => {
  test('GITHUB_TOKEN, ACTIONS_RUNTIME_TOKEN, ACTIONS_ID_TOKEN_REQUEST_TOKEN are deleted for EVERY agent child env', async () => {
    await withEnv({
      GITHUB_TOKEN: 'ghs_must-not-leak', // rides the GITHUB_ prefix allowlist without the scrub
      ACTIONS_RUNTIME_TOKEN: 'art-must-not-leak',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-must-not-leak',
      GITHUB_ACTIONS: 'true',
    }, () => {
      const envs: Array<[string, NodeJS.ProcessEnv]> = [
        ['hermes', hermesChildEnv('/tmp/agent-cred-scrub')],
        ['grok', grokChildEnv('/tmp/agent-cred-scrub')],
        ['opencode', opencodeChildEnv('/tmp/agent-cred-scrub')],
      ];
      for (const [label, env] of envs) {
        expect(`${label}:${env.GITHUB_TOKEN ?? ''}`).toBe(`${label}:`);
        expect(`${label}:${env.ACTIONS_RUNTIME_TOKEN ?? ''}`).toBe(`${label}:`);
        expect(`${label}:${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ''}`).toBe(`${label}:`);
        // Benign CI metadata still flows — the scrub is credential-shaped, not prefix-wide.
        expect(env.GITHUB_ACTIONS).toBe('true');
      }
    });
  });
});

describe('hasOpencodeAuth — the PAID leg gate only (keyless free tier carries the core SMOKE)', () => {
  test('non-empty ANTHROPIC_API_KEY (or its GSTACK_ promotion) → true; blank/absent → false', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'ant-key', GSTACK_ANTHROPIC_API_KEY: undefined }, () => {
      expect(hasOpencodeAuth()).toBe(true);
    });
    await withEnv({ ANTHROPIC_API_KEY: undefined, GSTACK_ANTHROPIC_API_KEY: 'promoted-key' }, () => {
      expect(hasOpencodeAuth()).toBe(true);
    });
    await withEnv({ ANTHROPIC_API_KEY: '   ', GSTACK_ANTHROPIC_API_KEY: undefined }, () => {
      expect(hasOpencodeAuth()).toBe(false);
    });
    await withEnv({ ANTHROPIC_API_KEY: undefined, GSTACK_ANTHROPIC_API_KEY: undefined }, () => {
      expect(hasOpencodeAuth()).toBe(false);
    });
  });
});

describe('seedOpencodeConfig — the autoupdate kill-switch seed (config half of the double kill)', () => {
  test('writes autoupdate:false + optional model pin, valid JSON, never credentials', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-seed-'));
    try {
      const cfgPath = seedOpencodeConfig(home, { defaultModel: 'anthropic/claude-haiku-4-5' });
      const doc = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      expect(doc.autoupdate).toBe(false);
      expect(doc.model).toBe('anthropic/claude-haiku-4-5');
      expect(doc.$schema).toBe('https://opencode.ai/config.json');
      expect(JSON.stringify(doc)).not.toMatch(/api[_-]?key|bearer/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('without a model opt, no model key is written', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-seed-'));
    try {
      const cfgPath = seedOpencodeConfig(home);
      const doc = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      expect(doc.model).toBeUndefined();
      expect(doc.autoupdate).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('parseOpencodeJsonl (pure — fixtures pinned to observed v1.18.18 shapes)', () => {
  test('collects text parts and tool names; skips malformed lines and unknown types', () => {
    const lines = [
      JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: {} }),
      JSON.stringify({ type: 'tool_use', timestamp: 2, sessionID: 's', part: { type: 'tool', tool: 'gbrain_recall', callID: 'c1', state: { status: 'completed', input: { query: 'door codeword' }, output: '{}' } } }),
      'NOT JSON {{{',
      JSON.stringify({ type: 'mystery_event', part: { text: 'must-not-count' } }),
      JSON.stringify({ type: 'text', timestamp: 3, sessionID: 's', part: { id: 'p1', text: 'kestrel-3f82e013', time: {} } }),
      JSON.stringify({ type: 'step_finish', part: {} }),
    ];
    const parsed = parseOpencodeJsonl(lines);
    expect(parsed.finalText).toBe('kestrel-3f82e013');
    expect(parsed.toolCalls).toEqual(['gbrain_recall']);
  });

  test('empty/garbage input → empty result, never throws', () => {
    expect(parseOpencodeJsonl([])).toEqual({ finalText: '', toolCalls: [] });
    expect(parseOpencodeJsonl(['{', 'null', '42'])).toEqual({ finalText: '', toolCalls: [] });
  });
});

describe('runOneShotSpawn — drain-cap timer hygiene', () => {
  test('returns promptly on a fast child and clears every drain-cap timer (no post-run event-loop hold)', async () => {
    // The bounded() drain caps are timeoutMs + 30s each; uncleared they keep
    // Bun alive for minutes after a successful door run. Spy on clearTimeout:
    // the main kill timer + the three bounded races (stdout, stderr, exited)
    // must ALL clear when the real promises win.
    const realClear = globalThis.clearTimeout;
    let clears = 0;
    globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
      clears++;
      return realClear(id);
    }) as typeof clearTimeout;
    try {
      const t0 = Date.now();
      const res = await runOneShotSpawn({
        argv: ['echo', 'door-timer-hygiene'],
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 240_000, // door-scale timeout — the leak would be ~270s of hold
      });
      expect(res.exitCode).toBe(0);
      expect(res.finalText).toBe('door-timer-hygiene');
      expect(res.timedOut).toBe(false);
      expect(Date.now() - t0).toBeLessThan(10_000); // returned promptly, no cap wait
      expect(clears).toBeGreaterThanOrEqual(4); // kill timer + 3 bounded drain caps
    } finally {
      globalThis.clearTimeout = realClear;
    }
  });
});
