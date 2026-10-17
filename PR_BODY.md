## Scope

Automatic fact capture retains the deterministic filter (`off`/`shadow`/`on`), identity-arm routing, opt-in home-entity counterparty routing and per-page cap. The expanded low-notability prompt rubric is opt-in through `facts.extraction_low_rubric=on`; default `off` preserves upstream prompt bytes. Four precomputed prompts combine low-tier admission with the rubric. Entity guidance stays upstream.

## Effect on a real company page

Measurement on a production company page (~1,000 facts) used 200 hand-labeled current facts across two sets. Of these, 61% were legitimately company-level, 8% low-value and 31% about a more specific entity, mostly without an existing page. Most growth there is legitimately company-level.

The deterministic layer is high-precision and low-recall. On tuned set A, drops had precision 6/6 and recall 6/11. On held-out set B it caught 0/5 drop candidates, with no false positives; rerouting had precision 3/5 and recall 3/36. These results do not establish uniformly precise rerouting.

A Claude prompt-rubric proxy over fact text gave the expanded low definition precision 6/10 and recall 6/16, and caught 0/5 on held-out B. It remains opt-in. An LLM "most specific entity" instruction was evaluated and rejected for precision: it moved 115/200 claims off the company page at about 47% precision, including 53 of 122 genuinely company-level claims. The variant and its config key are removed.

Routing is limited by missing deal/program pages. The per-page cap, plus an external archiver, is the reliable bound; filtering and routing alone cannot bound legitimate company-level accumulation. The external archiver is outside this patch.

## Risks and operational limits

- Admission can lose recall, and routing can misroute claims. Start in shadow mode: drops are not stored anywhere, so no dropped-fact archive exists for recovery.
- Withdrawals remain subject-scoped. Routing must not reroute around tombstones or resurrect withdrawn claims.
- Archivers must preserve withdrawal semantics and valid fences. Fence-row health checks matter: the cap refuses rather than writing DB-only when a backed page cannot safely accept another row.
- Managed and local persistence must retain parity for routing, caps and refusals; local tests do not establish deployed-host parity.

## Validation

See TEST-OUTPUT.txt for offline focused tests, guards, prompt byte checks and generated documentation checks. No production corpus was accessed for this patch; the measurements above are supplied aggregate results, not a new evaluation run.
