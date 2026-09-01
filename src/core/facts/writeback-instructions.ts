/**
 * Ambient memory writeback — the canonical instruction section (F1 leaf).
 *
 * ONE builder feeds every activation surface: the MCP initialize
 * `instructions` field on all three transports (src/mcp/instructions.ts
 * composes it under the base operating contract) and the managed bootstrap
 * instruction blocks (src/core/bootstrap/instructions-block.ts). Single
 * source ⇒ the surfaces structurally cannot drift.
 *
 * Discipline inherited from src/mcp/instructions.ts: pure source text, no
 * filesystem or dynamic loading — compiled binaries and remote-only installs
 * must not depend on a repository checkout being present. Keep the section
 * LEAN (~15 lines): it rides every session's context window.
 *
 * Visibility posture (F5): callers resolve it via
 * src/core/facts/writeback-config.ts — unset config → 'world' (the
 * `remember` verb's documented default; the remote remember→recall
 * round-trip works), explicit non-world → 'private' with the recall
 * trade-off stated. This builder renders whichever posture it is handed and
 * never widens.
 */

export interface AmbientWritebackOpts {
  mode: 'salient' | 'all';
  /** Literal duration shorthand the agent passes on transient facts, e.g. '3d'. */
  transientTtl: string;
  /** Resolved write posture — see module header. */
  visibility: 'world' | 'private';
  /** True only when `extract_facts` is actually callable on this transport's
   * allowed-op set (OV2-14) — never advertise an uncallable tool. The
   * engine-free harness block cannot probe the serve's surface, so it passes
   * 'unknown' and gets HEDGED lines ("when it is in your tool list") that
   * stay honest whether the serve is full-surface or clamped to verbs. */
  extractFactsAvailable: boolean | 'unknown';
}

export function buildAmbientWritebackSection(opts: AmbientWritebackOpts): string {
  const candidatePolicy = opts.mode === 'salient'
    ? 'Save the durable, notable ones: preferences, corrections, decisions, commitments, relationships, and project-state changes.'
    : 'Save every direct factual statement the user makes — still excluding operational chatter, assistant-generated content, secrets or credentials, and quoted third-party material.';
  const multiFact = opts.extractFactsAvailable === true
    ? 'For a raw turn carrying several facts, submit the turn text once through extract_facts instead of many remember calls.'
    : opts.extractFactsAvailable === 'unknown'
      ? 'For a raw turn carrying several facts, submit the turn text once through extract_facts when that tool is in your tool list; otherwise distill them yourself and call remember once per claim.'
      : 'When a turn carries several facts, distill them yourself and call remember once per claim.';
  // Surface-honest like the multi-fact line: only warn about extract_facts'
  // missing ttl parameter when the tool may actually be advertised.
  const transientLine = opts.extractFactsAvailable === false
    ? `pass ttl: "${opts.transientTtl}".`
    : `always save via remember with ttl: "${opts.transientTtl}" — never batch them through extract_facts (it cannot set a ttl, so they would become permanent).`;
  const visibilityLine = opts.visibility === 'world'
    ? 'Pass visibility: "world" explicitly on every save. "world" means readable by agents authorized on THIS brain — not the public internet. Never widen a private fact on your own.'
    : 'Pass visibility: "private" explicitly on every save — this brain\'s operator keeps facts private by default (omitting visibility would silently widen: remember defaults to world). Private facts are readable by the local CLI only, not by remote sessions. Never widen to world on your own.';
  return `Ambient memory writeback (enabled by this brain's operator — mode: ${opts.mode}):
1. Treat every substantive statement the user makes about themselves, their people, projects, or plans as a memory candidate. ${candidatePolicy}
2. Save with remember: ONE claim per call; set kind (event | preference | commitment | belief | fact) and set entity whenever a person, company, or project is the subject (e.g. people/alice-example, companies/acme-example).
3. ${multiFact}
4. Include concise provenance on every save: harness name, session or thread id when available, and the date (e.g. "codex session 8f3a, 2026-09-01").
5. Durable facts (preferences, corrections, decisions, commitments, relationships, project state): omit ttl — they never expire.
6. Transient facts (current health, location, travel, mood, near-term schedule): ${transientLine}
7. Skip: greetings, acknowledgements, questions that carry no new facts, tool output, quoted third-party material, and pasted or imported text — unless the user explicitly asks you to remember it.
8. Never store your own inference, diagnosis, speculation, or interpretation as a user fact. Never store raw transcripts.
9. ${visibilityLine}
10. Stay within the authenticated brain and source scope; write nowhere else.
11. Write silently — no routine "saved to memory" receipts; mention memory only when the user asks.`;
}
