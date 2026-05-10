import { describe, expect, test } from 'bun:test';
import {
  GET_RECENT_SALIENCE_DESCRIPTION,
  FIND_ANOMALIES_DESCRIPTION,
  GET_RECENT_TRANSCRIPTS_DESCRIPTION,
  LIST_PAGES_DESCRIPTION,
  QUERY_DESCRIPTION,
  SEARCH_DESCRIPTION,
} from '../src/core/operations-descriptions.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import { BRAIN_TOOL_ALLOWLIST } from '../src/core/minions/tools/brain-allowlist.ts';

/**
 * Tool descriptions are LLM-facing strings that drive routing. v0.29 adds
 * three new ops + redirects on three existing ones. These tests pin the
 * key phrases that the routing decision depends on so accidental edits
 * (description rewrites, AI cleanup, voice changes) fail CI.
 */

describe('v0.29 — get_recent_salience description', () => {
  test('matches the operation registration', () => {
    expect(operationsByName['get_recent_salience'].description).toBe(GET_RECENT_SALIENCE_DESCRIPTION);
  });

  test('contains the explicit "Use this when" trigger phrase', () => {
    expect(GET_RECENT_SALIENCE_DESCRIPTION).toContain("Use this when the user asks");
  });

  test('lists the personal-query trigger keywords', () => {
    expect(GET_RECENT_SALIENCE_DESCRIPTION).toContain("what's been going on");
    expect(GET_RECENT_SALIENCE_DESCRIPTION).toContain("anything crazy happening");
    expect(GET_RECENT_SALIENCE_DESCRIPTION).toContain("notable");
  });

  test('explicitly bans semantic search for the same intent', () => {
    expect(GET_RECENT_SALIENCE_DESCRIPTION).toContain("Do NOT run a semantic search for these");
  });
});

describe('v0.29 — find_anomalies description', () => {
  test('matches the operation registration', () => {
    expect(operationsByName['find_anomalies'].description).toBe(FIND_ANOMALIES_DESCRIPTION);
  });

  test('mentions the cohort framing', () => {
    expect(FIND_ANOMALIES_DESCRIPTION).toContain("grouped by cohort");
    expect(FIND_ANOMALIES_DESCRIPTION).toContain("(tag or type)");
  });

  test('lists the unusual / what-stood-out trigger phrases', () => {
    expect(FIND_ANOMALIES_DESCRIPTION).toContain("stood out");
    expect(FIND_ANOMALIES_DESCRIPTION).toContain("unusual");
  });

  test('does not promise year-cohort behavior (deferred to v0.30)', () => {
    // v0.29 ships tag + type only. The phrase below confirms the description
    // does not lie about coverage — surfacing year would route the LLM to
    // call the op for date-bucket questions it can't actually serve.
    expect(FIND_ANOMALIES_DESCRIPTION).toContain("Cohort kinds: tag, type");
  });
});

describe('v0.29 — get_recent_transcripts description', () => {
  test('matches the operation registration', () => {
    expect(operationsByName['get_recent_transcripts'].description).toBe(GET_RECENT_TRANSCRIPTS_DESCRIPTION);
  });

  test('mandates priority over query/search for personal questions', () => {
    expect(GET_RECENT_TRANSCRIPTS_DESCRIPTION).toContain("FIRST");
  });

  test('explains raw vs polished distinction', () => {
    expect(GET_RECENT_TRANSCRIPTS_DESCRIPTION).toContain("NOT polished");
    expect(GET_RECENT_TRANSCRIPTS_DESCRIPTION).toContain("canonical source");
  });

  test('discloses the local-only constraint to the LLM', () => {
    expect(GET_RECENT_TRANSCRIPTS_DESCRIPTION).toContain("Local-only");
    expect(GET_RECENT_TRANSCRIPTS_DESCRIPTION).toContain("permission_denied");
  });
});

describe('v0.29 — redirect hints on existing ops', () => {
  test('list_pages mentions sort=updated_desc as the recency-question answer', () => {
    expect(operationsByName['list_pages'].description).toBe(LIST_PAGES_DESCRIPTION);
    expect(LIST_PAGES_DESCRIPTION).toContain("sort=updated_desc");
    expect(LIST_PAGES_DESCRIPTION).toContain("what did I touch this week");
  });

  test('query redirects personal/emotional queries to the v0.29 ops', () => {
    expect(operationsByName['query'].description).toBe(QUERY_DESCRIPTION);
    expect(QUERY_DESCRIPTION).toContain("get_recent_salience");
    expect(QUERY_DESCRIPTION).toContain("find_anomalies");
    expect(QUERY_DESCRIPTION).toContain("get_recent_transcripts");
  });

  test('query warns the LLM not to assume "crazy" means impressive', () => {
    expect(QUERY_DESCRIPTION).toContain("Do NOT assume");
    expect(QUERY_DESCRIPTION).toContain("difficult or emotionally charged");
  });

  test('search has the shorter redirect hint', () => {
    expect(operationsByName['search'].description).toBe(SEARCH_DESCRIPTION);
    expect(SEARCH_DESCRIPTION).toContain("get_recent_salience");
  });
});

describe('v0.29 — subagent allow-list', () => {
  test('includes get_recent_salience but not find_anomalies', () => {
    expect(BRAIN_TOOL_ALLOWLIST.has('get_recent_salience')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('find_anomalies')).toBe(false);
  });

  test('excludes get_recent_transcripts (codex C3 — would be a remote=true footgun)', () => {
    // The op throws permission_denied for remote=true callers, and all subagent
    // calls run with remote=true. Including it in the allow-list would mean
    // every subagent call to it returns an error — looks like a bug.
    expect(BRAIN_TOOL_ALLOWLIST.has('get_recent_transcripts')).toBe(false);
  });

  test('v0.29 ops referenced by the allow-list resolve to a registered Operation', () => {
    // brain-allowlist invariant: every name maps to an entry in operations.ts
    // OPERATIONS array. This guard catches rename drift.
    for (const name of ['get_recent_salience']) {
      expect(operationsByName[name]).toBeDefined();
    }
  });

  test('list_pages has new sort + updated_after params surfaced to MCP', () => {
    const op = operationsByName['list_pages'];
    expect(op.params.sort).toBeDefined();
    expect(op.params.updated_after).toBeDefined();
  });
});

describe('v0.29 — operations array carries the three new ops', () => {
  test('all three are registered (salience allow-listed, others restricted)', () => {
    const names = operations.map(o => o.name);
    expect(names).toContain('get_recent_salience');
    expect(names).toContain('find_anomalies');
    expect(names).toContain('get_recent_transcripts');
  });
});
