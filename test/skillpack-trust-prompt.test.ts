/**
 * Tests for src/core/skillpack/trust-prompt.ts — codex G4 first-install
 * confirm + identity rendering + state-based TOFU skip.
 */
import { describe, test, expect } from 'bun:test';

import {
  renderIdentityBlock,
  askTrust,
  type TrustPromptInput,
} from '../src/core/skillpack/trust-prompt.ts';
import {
  SKILLPACK_STATE_SCHEMA_VERSION,
  type SkillpackState,
} from '../src/core/skillpack/state.ts';
import { SKILLPACK_API_VERSION } from '../src/core/skillpack/manifest-v1.ts';

function makeInput(
  over: Partial<TrustPromptInput> = {},
): TrustPromptInput {
  return {
    manifest: {
      api_version: SKILLPACK_API_VERSION,
      name: 'hackathon-evaluation',
      version: '0.1.0',
      description: 'YC hackathon judging rubric',
      author: 'Garry Tan',
      license: 'MIT',
      homepage: 'https://github.com/garrytan/skillpack-hackathon-evaluation',
      gbrain_min_version: '0.36.0',
      skills: ['skills/judge-submission'],
    },
    resolved: {
      path: '/tmp/cached/garrytan/skillpack-hackathon-evaluation/abc123',
      kind: 'git',
      source: 'https://github.com/garrytan/skillpack-hackathon-evaluation.git',
      pinned_commit: 'abc1234567890abcdef1234567890abcdef12345',
      tarball_sha256: null,
      cache_hit: false,
    },
    tier: 'endorsed',
    state: { schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [] },
    ...over,
  };
}

describe('renderIdentityBlock — pure formatter', () => {
  test('renders the canonical identity block for a git source', () => {
    const block = renderIdentityBlock(makeInput());
    expect(block).toContain('Name:          hackathon-evaluation');
    expect(block).toContain('Version:       0.1.0');
    expect(block).toContain('Author:        Garry Tan');
    expect(block).toContain('Source:        https://github.com/garrytan/skillpack-hackathon-evaluation.git');
    expect(block).toContain('Pinned commit: abc1234567890abcdef1234567890abcdef12345');
    expect(block).toContain('Tier:          endorsed');
    expect(block).toContain('Description:   YC hackathon judging rubric');
  });

  test('shows tarball SHA when source kind is tarball', () => {
    const block = renderIdentityBlock(
      makeInput({
        resolved: {
          path: '/tmp/cache',
          kind: 'tarball',
          source: '/Users/me/pack.tgz',
          pinned_commit: null,
          tarball_sha256: 'deadbeef',
          cache_hit: false,
        },
      }),
    );
    expect(block).toContain('Tarball SHA:   sha256:deadbeef');
    expect(block).not.toContain('Pinned commit');
  });
});

describe('askTrust — decision matrix', () => {
  test('local-path source skips prompt entirely', async () => {
    const d = await askTrust(
      makeInput({
        resolved: {
          path: '/Users/me/local-pack',
          kind: 'local',
          source: '/Users/me/local-pack',
          pinned_commit: null,
          tarball_sha256: null,
          cache_hit: false,
        },
      }),
    );
    expect(d.trusted).toBe(true);
    expect(d.reason).toBe('local_path_no_prompt');
  });

  test('already-trusted skips prompt (state has matching identity)', async () => {
    const state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [
        {
          name: 'hackathon-evaluation',
          version: '0.1.0',
          author: 'Garry Tan',
          source: 'https://github.com/garrytan/skillpack-hackathon-evaluation.git',
          source_kind: 'git',
          pinned_commit: 'abc1234567890abcdef1234567890abcdef12345',
          tarball_sha256: null,
          tier: 'endorsed',
          scaffolded_at: '2026-01-01T00:00:00Z',
          workspace: '/tmp/ws',
          skill_slugs: ['skills/judge-submission'],
        },
      ],
    };
    const d = await askTrust(makeInput({ state }));
    expect(d.trusted).toBe(true);
    expect(d.reason).toBe('already_trusted');
  });

  test('--trust flag bypasses prompt for first-install', async () => {
    const d = await askTrust(makeInput(), { trustFlag: true });
    expect(d.trusted).toBe(true);
    expect(d.reason).toBe('trust_flag_bypassed');
  });

  test('non-TTY without --trust flag refuses', async () => {
    const d = await askTrust(makeInput(), { isTTY: false });
    expect(d.trusted).toBe(false);
    expect(d.reason).toBe('non_tty_no_trust_flag');
  });

  test('accepts when user answers "y"', async () => {
    const d = await askTrust(makeInput(), {
      isTTY: true,
      readLine: async () => 'y',
    });
    expect(d.trusted).toBe(true);
    expect(d.reason).toBe('prompt_accepted');
  });

  test('accepts when user answers "yes" (case-insensitive)', async () => {
    const d = await askTrust(makeInput(), {
      isTTY: true,
      readLine: async () => 'YES',
    });
    expect(d.trusted).toBe(true);
    expect(d.reason).toBe('prompt_accepted');
  });

  test('rejects when user answers "n"', async () => {
    const d = await askTrust(makeInput(), {
      isTTY: true,
      readLine: async () => 'n',
    });
    expect(d.trusted).toBe(false);
    expect(d.reason).toBe('prompt_rejected');
  });

  test('rejects on empty input (default to no)', async () => {
    const d = await askTrust(makeInput(), {
      isTTY: true,
      readLine: async () => '',
    });
    expect(d.trusted).toBe(false);
    expect(d.reason).toBe('prompt_rejected');
  });

  test('rejects on garbage input (default to no)', async () => {
    const d = await askTrust(makeInput(), {
      isTTY: true,
      readLine: async () => 'maybe',
    });
    expect(d.trusted).toBe(false);
    expect(d.reason).toBe('prompt_rejected');
  });

  test('author mismatch in state still triggers prompt', async () => {
    const state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [
        {
          name: 'hackathon-evaluation',
          version: '0.1.0',
          author: 'Different Author', // mismatch
          source: 'https://github.com/different/skillpack-hackathon-evaluation.git',
          source_kind: 'git',
          pinned_commit: 'abc1234567890abcdef1234567890abcdef12345',
          tarball_sha256: null,
          tier: 'endorsed',
          scaffolded_at: '2026-01-01T00:00:00Z',
          workspace: '/tmp/ws',
          skill_slugs: ['skills/judge-submission'],
        },
      ],
    };
    let promptShown = false;
    const d = await askTrust(makeInput({ state }), {
      isTTY: true,
      readLine: async () => {
        promptShown = true;
        return 'y';
      },
    });
    expect(promptShown).toBe(true);
    expect(d.reason).toBe('prompt_accepted');
  });
});
