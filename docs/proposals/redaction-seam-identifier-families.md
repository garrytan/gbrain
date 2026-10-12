# Proposal: Redaction seam — identifier families (PHI) before persist and before provider egress

**Status:** RFC — reference implementation in PR #6553 (see *Implementation notes*)
**Date:** 2026-10-12
**Refs:** #6468 (credential redaction before providers, opt-in redact-on-write), #3688 (guardrail seam wiring), #5575 (trust tiers + write gate)
**Context:** `docs/guardrails.md` says enforcement "will get its own explicitly-named seam and its own RFC — it will not silently reuse" the observe-only seam. This is that RFC. It generalises the credential proposal in #6468 to a second pattern class — structured personal and health identifiers (the PHI identifier families) — and fixes the places where each class is applied, so the two proposals ship as one seam instead of two.

## The Problem

An operator running a brain near health-adjacent notes (a clinic's ops wiki, a care-coordination inbox, a founder's notes on a digital-health portfolio) has three tools today, and a gap between them:

1. **The guardrail seam observes.** A registered provider sees markdown, code, the latest chat message, expansion queries and tool inputs at the pre-persist / pre-inference moment — and by hard invariant can do nothing about what it sees. A shadow-mode PHI detector built on it (regex families with checksum guards: SSN, NPI, DEA, Medicare MBI, MRN, DOB, plan ids, plus clinical-context keywords) can tell the operator *where* identifiers enter, and that is all.
2. **Retrieval output is redacted — for credentials.** `redactRetrievalOutput` replaces credential-shaped text with `<REDACTED:pattern>` on search, recall, context_pack and delta. Identifier families are not in the scanner, so a patient's SSN in a stored page comes back verbatim to a remote caller.
3. **Chunks are projected — for private keys only.** `credentialSafeProjection` keeps key material out of chunks, embeddings and delivered evidence. Every other pattern, credential or identifier, is embedded raw.

And, per `docs/guides/write-refusals.md` "What stays raw by design", configured providers receive stored text unredacted at embed, rerank, expand and synthesis time. #6468 proposes closing that for credentials. For PHI the same egress is a disclosure to a third party the operator may have no agreement with, so the identifier class needs the same seam, under the same opt-in, with the same content-free receipts.

Nothing above is a defect in gbrain's defaults: a personal brain should not silently rewrite its owner's notes. The gap is that an operator who *wants* identifiers kept out of embeddings, provider requests and (optionally) stored text has no supported switch, and the only extension point they are offered is contractually observe-only.

## Goals

- One named enforcement seam, separate from `src/core/guardrails.ts` the way `write-gate.ts` is separate: never imported by it, never weakening its invariants.
- Pattern **classes** on the existing scanner: `credential` (today's rules) and `identifier` (new families). Same token, same fingerprint and allowlist mechanics, same perf pins.
- Three application points, each independently switchable, all default **off** for the identifier class so default behaviour is byte-identical:
  1. **projection** — chunks, embeddings and delivered evidence are cut from a redacted copy (the private-key mechanism, generalised);
  2. **egress** — provider-bound text at the gateway is redacted before the request leaves;
  3. **on-write** — stored text is redacted at ingest, routed by trust tier (the #6468 design, extended to the identifier class).
- Receipts and counters that never carry a matched value.

## Non-goals

- Free-text person names and other NER-grade detection. Regex families are a floor; a model tier can plug into the same seam later.
- Encryption at rest, provider agreements, access policy. Infrastructure controls; out of scope here.
- Changing what `get_page`, `fetch`, `get_chunks`, `get_raw_data` and `get_versions` return. Raw reads stay raw, governed by visibility.
- Any change to the observe-only guardrail seam. Providers registered there keep seeing the **pre-redaction** text at the same five hooks.

## What exists today (the pieces this reuses)

| Piece | Where | Reused for |
| --- | --- | --- |
| Pattern registry + `<REDACTED:pattern>` + `sha256:` fingerprints + `.gbrain-scan-allow` | `src/core/secret-scan.ts` | the identifier families join this registry |
| `planRedaction` / `applyRedaction` + echo dictionary | `src/core/secret-scan.ts` | egress and on-write splicing |
| `credentialSafeProjection` | `src/core/credential-projection.ts`, applied in `markdown-chunks.ts`, `code-chunks.ts`, `chunkers/recursive.ts`, `search/evidence-delivery.ts` | the projection point, generalised to a policy |
| `credential_projection_pending` + provider-free re-chunk | `page-state/credential-reseal.ts`, doctor check | re-sealing existing pages when a family is switched on |
| `redactRetrievalOutput` + per-op `outputRedaction` | `src/core/search/output-redaction.ts` | retrieval output picks up identifier families automatically once they are in the registry |
| Trust tiers + `write_gate.*` routing | `src/core/trust/tier.ts`, `write-gate.ts` | on-write routing by tier |
| `invokeAI` observers + attribution | `src/core/ai/invocation-guard.ts` | content-free egress counters |
| `eval.scrub_pii` (default-on, explicit-false opt-out) | `src/core/config.ts` | the config idiom for a privacy switch |

## Design

### 1. Pattern classes in the scanner

Add a `class: 'credential' | 'identifier'` field to the registry entries in `secret-scan.ts`. Every existing rule is `credential`. The new `identifier` rules, each with the false-positive guard that makes it safe to run over prose:

| Pattern | Guard |
| --- | --- |
| `ssn` | dashed form; bare nine digits only with an SSN context word in the window |
| `npi` | `NPI` keyword + the 80840-prefixed Luhn check digit |
| `dea` | registrant-type letter + checksum digit |
| `medicare_mbi` | the full CMS character-class format |
| `mrn`, `health_plan_id` | context keyword required (`MRN`, `member id`, …) |
| `dob` | labelled dates only (`DOB:`, `date of birth`); bare dates are too ambiguous |
| `phone`, `email` | shape-based; phone needs separators |

Deliberately **not** in the default identifier set: ICD-10 codes (a diagnosis code is content, not an identifier; a clinic brain searches by it) and bare IP addresses. Both can be a later opt-in family.

`ScanOpts` gains `classes?: ReadonlyArray<'credential' | 'identifier'>` (default `['credential']`). Nothing changes for existing callers. `patternSince` stamps each new rule with the version that adds it, so allowlist entries and refusals can name it.

Echo scrubbing: identifier values are short and structured; none qualifies for the echo dictionary (the floors stay as they are), so a redacted SSN never seeds a dictionary entry.

### 2. Policy, in config

```
redaction.projection_classes   class list | none          (default none)
redaction.egress_classes       class list | none          (default none)
redaction.on_write             off | facts | all          (default off; #6468)
redaction.on_write_classes     class list                 (default credential)
```

A class list is comma-separated over `credential`, `identifier`, `contact`.
Keys live in the DB plane next to `write_gate.*` and are registered in the
known-keys list; `gbrain config set` refuses an unknown class or mode and
writes nothing. Credential egress (#6468 item 1) is proposed there as
default-on; this RFC takes no position on that default — here it is the
`credential` class in `redaction.egress_classes`, off by default.

### 3. Projection (chunks, embeddings, evidence)

`credentialSafeProjection(text)` becomes `redactionProjection(text, policy)`: the private-key spans as today, plus — when `redaction.identifiers.projection` is on — every identifier-class span replaced by its `<REDACTED:pattern>` token with newlines preserved, so chunk anchors and line numbers stay stable. The four call sites do not move. The stored body is unchanged.

Switching the policy on marks affected pages the way the private-key migration did: a provider-free re-chunk seals them, `gbrain embed --stale` re-embeds, and doctor reports `redaction_projection_pending` until both have run. Switching it off marks the same pages the other way. Pages that match no identifier rule are untouched by either transition.

### 4. Egress (the gateway seam)

A single helper in `src/core/ai/gateway.ts`, next to `classifyGatewayGuardrail`:

```ts
function redactProviderInput(text: string, surface: 'embed' | 'rerank' | 'expand' | 'chat' | 'tool_input'): string
```

Order at every call site is fixed: **guardrail observe → redact → send**. The observe-only providers keep seeing raw text, as they do today. Applied to: `embed` / `embedQuery` inputs, `rerank` query and documents, `expand` query, and every message and tool input the `chat` / `toolLoop` path sends. Tool *output* fed back into the loop is included: it is provider-bound text. System prompts are included: some recipes assemble them from stored text, and the seam should not have to know which.

Not applied: audio bytes (`transcription.ts`) and image bytes (OCR, multimodal). The transcript and OCR text those calls return enter through the ingest path and are covered by projection and on-write like any other page.

Counts, not content: each redaction increments a per-pattern, per-provider counter attached to the `invokeAI` attribution for that call, so the existing invocation observers can surface `redactions: { ssn: 2 }` without any text. The gateway never logs a value.

Failure mode: the scanner is deterministic, regex-bounded and perf-pinned (as `test/secret-scan-perf.test.ts` pins it today). A thrown error here is a bug, and is surfaced as the call's error. It is **not** swallowed: silently sending raw text is the outcome this seam exists to prevent. This is the write gate's fail-closed arm, not the guardrail seam's fail-open one, and it is why the seam is a separate module with its own tests.

### 5. On-write (opt-in, by trust tier)

As #6468: with `redaction.on_write` set, writes at tier `agent_written` or `external_untrusted` store the redacted text; `user_confirmed`, `operator_curated` and `tool_observed` writes keep today's behaviour. `redaction.on_write_classes` chooses whether identifier families join credentials in that splice.

Placement: in `importFromContent`, after `screenImportContent` and after the `file_storage.markdown` guardrail hook (so observers still see raw text), **before** `settleContentDisposition` and the content hash — the hash is computed over the redacted body, matching the write-pipeline order #6468 cites. The facts write path gets the same splice before its hash. The write receipt lists `redacted: [{ pattern, fingerprint }]`, never a value, and the page's `page_versions` row records the redacted body like any other write.

### 6. Separation from the guardrail seam

- New module `src/core/redaction-seam.ts` owns policy loading and the three application helpers. `guardrails.ts` never imports it; it never imports `guardrails.ts` (the `write-gate.ts` precedent, enforced by the layering guard).
- The five observe hooks, their payload boundaries and their fail-open contract are unchanged. `test/guardrails.test.ts` is unchanged.
- A guardrail provider that wants enforcement still cannot get it through `registerGuardrailProvider`. It gets it by the operator setting policy; the provider's job stays observation and audit.

## Config and operator surface

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `redaction.projection_classes` | class list, `none` | `none` | tokens in chunks, embeddings, evidence; setting it re-seals matching pages |
| `redaction.egress_classes` | class list, `none` | `none` | tokens in provider-bound text |
| `redaction.on_write` | `off`, `facts`, `all` | `off` | store redacted text at untrusted tiers (#6468) |
| `redaction.on_write_classes` | class list | `credential` | which classes the on-write splice applies |

`gbrain doctor` adds `redaction_projection_pending` (chunks cut under a
different class list than the policy names). `docs/guides/write-refusals.md`
gains a "Redaction policy (opt-in)" section and the "What stays raw by
design" entry for providers says what the egress switch changes.

## Rollout

1. **Families + retrieval.** Identifier rules land in the registry behind `classes`. Retrieval output redaction picks them up only when the identifier class is enabled for retrieval; this RFC proposes enabling it together with projection under the one `redaction.identifiers.projection` key, so an operator turns on "identifiers are redacted wherever credentials are" with one switch. No provider calls, no migration.
2. **Projection** + re-seal + doctor check.
3. **Egress** helper at the gateway, with the counters.
4. **On-write** for both classes, with receipts.

Each step is a separate PR with its own tests; each is a no-op with defaults.

## Tests ("done means")

- **Default byte-identity.** With no `redaction.*` keys set, chunk text, embedding input, every provider request body and every stored page are byte-identical to today's. Snapshot over the existing import and search fixtures.
- **Family precision.** A false-positive budget for the identifier families over the synthetic prose corpus, in the shape of `test/secret-scan-fp-budget.test.ts`; each guard has a positive and a near-miss fixture (a year that looks like an SSN fragment, a 10-digit order number next to `NPI`, a version string shaped like an IP).
- **Perf pin.** The identifier families join `test/secret-scan-perf.test.ts` with the same ceilings.
- **Projection.** Idempotent; newline-preserving; chunk anchors unchanged for a page with and without matches; evidence delivery cuts from the projection; re-seal marks exactly the matching pages on both policy transitions.
- **Egress.** With a stub provider that records request bodies, a planted SSN, NPI and MBI in a page and in a `remember` fact never appear in any embed, rerank, expand, chat or tool-loop request when egress is on; they do appear when it is off; the guardrail provider registered alongside sees the raw text in both cases. Counters report per pattern and never carry a value.
- **On-write.** A remote `remember` at `agent_written` with `on_write=facts` and `on_write_classes=credential+identifier` stores the token and its receipt names pattern + fingerprint only; the same write from the local CLI at `user_confirmed` stores raw text; `page_versions` and the content hash reflect the stored (redacted) body.
- **Separation.** `check:layering` (or a one-line sibling) fails if `guardrails.ts` and `redaction-seam.ts` import each other.
- **Recall impact.** The egress and projection PRs report the recall delta on the public benchmark in `docs/eval-bench.md` with identifiers on, over a fixture set seeded with identifier-bearing pages. Expected: negligible, because identifiers are rarely the retrieval key; the number goes in the PR body either way.

## Alternatives considered

- **Let guardrail providers return a rewrite.** Rejected: it is the one thing `docs/guardrails.md` forbids, and for good reason — a fail-open seam cannot be an enforcement seam.
- **A second scanner module for identifiers.** Rejected: two registries means two tokens, two allowlists, two fingerprint formats and two perf pins. The class field keeps one of each.
- **Redact on read only (extend `redactRetrievalOutput`).** Necessary but not sufficient: it leaves embeddings and provider requests raw, which is the gap #6468 names.
- **Encrypt at rest instead.** A different threat (disk, backups); it does not change what a provider receives. Complementary, not a substitute.
- **NER first.** Higher recall for names, but a model call on the write path breaks the zero-LLM write contract the write gate relies on. Regex families first; a model tier can later plug into the same seam as an additional class.

## Open questions

1. Should `phone` and `email` be in the identifier class by default, or a third `contact` class? They overlap with the `eval.scrub_pii` families and are far more common in ordinary notes than the health identifiers.
2. Does credential egress (#6468) ship default-on? This RFC works with either answer; the identifier switch is default-off regardless.
3. One allowlist file for both classes (`.gbrain-scan-allow`, fingerprint lines) — or does an operator want to allow an identifier pattern wholesale (`allow-pattern: npi`) for a brain where NPIs are the point? Proposed: fingerprint lines only in step 1; pattern-level allow as a follow-up if asked for.
4. Where the content-free counters persist, if anywhere, beyond the process lifetime. Proposed: nowhere in step 3; the observer hook exists for an operator who wants them in their own store.

## Reference implementation

The identifier families, their guards and 35 synthetic-fixture tests exist today as a standalone MIT shadow-mode provider package for the observe-only seam (`gbrain-phi-guard`). Its detectors are zero-dependency pure functions and can be folded into `secret-scan.ts` under the `identifier` class in step 1; its fixtures (placeholder names, well-known test numbers) carry over as the precision suite. The package itself stays what it is — the visibility layer — and gains nothing from this RFC except a policy to point its operator at.

## Implementation notes

The reference implementation ships with this proposal and differs from the
text above in four places, each chosen while building it:

1. **Class lists, not per-class booleans.** One key per enforcement point
   holding a class list (`identifier,contact`) replaced
   `redaction.identifiers.projection` / `.egress`, so a third class needs no
   new key. `email` and `phone` are their own `contact` class (open question
   1): they are common in ordinary notes and the synthetic brain-like fixture
   contains them, so they are never implied by `identifier`.
2. **Re-seal on `config set`.** Writing `redaction.projection_classes`
   re-chunks the pages that match under the old or the new list in the same
   command, with no provider call, and records the sealed list; the doctor
   check compares that record with the policy. No new CLI command.
3. **Counters stay in-process.** `providerRedactionCounts()` and
   `observeProviderRedactions()` expose per-surface, per-pattern counts; no
   `provider_redaction` doctor check (a doctor process would always report
   zero) and nothing persisted.
4. **On-write covers the page path.** The splice runs in
   `settleContentDisposition`, which every page write through
   `importFromContent` crosses (remote `put_page`, capture, connector and
   inbox imports, sync); the memory verbs' own fact rows (`remember`) are a
   follow-up, so the acceptance test for a remote `remember` is not yet met.

Modules: `src/core/identifier-patterns.ts`, `src/core/redaction-policy.ts`,
`src/core/credential-projection.ts` (`retrievalTextProjection`),
`src/core/ai/provider-redaction.ts`, `src/core/redaction-on-write.ts`,
`src/core/page-state/redaction-reseal.ts`,
`src/commands/config/redaction-values.ts`,
`src/commands/doctor/checks/redaction-projection.ts`. Tests:
`test/identifier-patterns.test.ts`, `test/redaction-policy.test.ts`,
`test/redaction-projection.test.ts`, `test/provider-redaction.test.ts`,
`test/redaction-on-write.test.ts`.

