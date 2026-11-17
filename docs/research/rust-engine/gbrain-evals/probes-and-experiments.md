> Appendix to [../gbrain-evals.md](../gbrain-evals.md). Detailed per-area notes from one research pass over gbrain-evals `cd447b3` (v0.10.237) and gbrain `6ce7195`. Paths are relative to the gbrain-evals root unless marked `gbrain:`. "G1" to "G10" in the text name the appendix files listed in the main map.

# G4 research map: n-series, p-series, q1/q2/t0 families, and one-off runners

Repo: the gbrain-evals checkout (HEAD cd447b3, v0.10.237). Paths below are relative to `eval/runner/` unless shown otherwise. gbrain pin resolution goes through `eval/runner/gbrain-under-test.ts` (`importGbrain(gut, subpath)` imports `<gut.root>/<subpath>`, i.e. a built gbrain checkout, so `src/...` paths are source-level, not the package `exports`).

Notation used below:
- "importGbrain(src/...)" = in-process import of a gbrain source module through `gbrain-under-test.ts` (line 117).
- "pkg gbrain/..." = static import of the package subpath export (type-only in most cases).
- "Published" = a file under `docs/benchmarks/` or `docs/findings/` is named after the runner, or cites `eval/runner/<name>` (checked with rg, names only). "Registered" = `eval/registry.ts` cites the runner path.
- "Keyless" = runs with no provider key and no paid calls by default.

## Summary table

| Runner | Entry path | Measures | Run command | Tier / time / cost | LLM keys | Corpus | Coupling |
|---|---|---|---|---|---|---|---|
| N1 knowledge update | n1-knowledge-update.ts | Supersession and value-change recall through lifecycle transports | `bun eval/runner/n1-knowledge-update.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF]`; `--slice ci` | Keyless default; paid arm $0.05 estimate | OPENAI (paid arm only) | generated (n1-knowledge-update-gen) | mixed: lifecycle drivers + in-process |
| N12 format fidelity | n12-format-fidelity.ts | Transcript/format parsing fidelity and attendee roles | `bun eval/runner/n12-format-fidelity.ts [--seed N] [--output] [--gbrain]` | Keyless (all in process) | none | generated (n12-format-fidelity-gen) | in-process |
| N13 code intelligence | n13-code-intelligence.ts | Readiness of six code_* ops on pinned pathe snapshot | `bun eval/runner/n13-code-intelligence.ts [--output] [--gbrain] [--json]` | Keyless, in-memory PGLite | none | vendored snapshot + committed gold | in-process |
| N14 large-page fidelity | n14-large-page-fidelity.ts | Find/read deep content in 2 MB to 1 GB pages; update cost | `bun eval/runner/n14-large-page-fidelity.ts [--tier 2mb\|20mb\|...\|1gb] [--tiers a,b] [--arms ...]` | Tiers up to 1 GB, manual; wall time unknown; one paid path | ANTHROPIC, OPENAI (paid path) | generated (n14-large-page-gen) | in-process + child self-spawn |
| N15 skillopt method | n15-skillopt-method.ts | Whether skill optimizers can be told apart on gbrain's shipped skills | `bun eval/runner/n15-skillopt-method.ts [--output] [--json]`; `--smoke`, `--probe`, `--dataset v3 --stage ...` (paid) | Default hermetic; paid ledger stages $50 and $470 (log) | ANTHROPIC, OPENAI (paid) | generated (skillopt-method gen, v1/v2/v3) | none (no gbrain import) |
| N2-3 prompt A/B | n2-3-prompt-ab.ts | Contradiction judge prompt before vs after gbrain commit | `bun eval/runner/n2-3-prompt-ab.ts arm --gbrain CKOUT@REF --label before\|after --output F [--paid --budget-run-id ID]`; `compare A B --output R` | $0 without --paid | ANTHROPIC (paid) | generated (n2-contradiction-gen) | in-process |
| N2 contradiction surfacing | n2-contradiction-surfacing.ts | Candidate discovery and classification of planted contradictions | `bun eval/runner/n2-contradiction-surfacing.ts` (paid arm gated) | Paid estimate $8, probe budget $10 | ANTHROPIC (paid classification) | generated (n2-contradiction-gen) | in-process |
| N2 judge replay | n2-judge-replay.ts | Re-judge N2 pairs on current models (capture/verify/select/judge/score) | `bun eval/runner/n2-judge-replay.ts` stages | Capture $0; judge stage paid | per model, key read by gbrain gateway (not named in file) | N2 generated world + paid receipt | in-process |
| N3 temporal as-of | n3-temporal-asof.ts | As-of and date-filter answers vs gold | `bun eval/runner/n3-temporal-asof.ts [--seed N] [--output] [--gbrain] [--json]` | Keyless | none | generated (n3-temporal-gen) | in-process |
| N4 entity resolution | n4-entity-resolution.ts | Entity slug resolution, recall, remember, identity list | `bun eval/runner/n4-entity-resolution.ts [--seed N] [--output DIR] [--gbrain] [--json]` | Keyless | none | generated (n4-entity-gen) | in-process |
| N4 similar pages | n4-similar-pages.ts | put_page "similar_pages" hint: names an existing page or stays quiet | `bun eval/runner/n4-similar-pages.ts [--seeds 1,2,3] [--pools A] [--output] [--gbrain] [--json]` | Keyless | none | N4 ledger + no-referent names | in-process |
| N5 forget residue | n5-forget-residue.ts | Forget withdrawal survives reimport and restart | `bun eval/runner/n5-forget-residue.ts [--seed N] [--output] [--gbrain]`; `--slice ci` | Keyless; lifecycle matrix | none | generated (n5 forget ledger) | CLI/MCP/HTTP (lifecycle drivers) |
| N6 Postgres HTTP | n6-postgres-http.ts | Visibility leaks over Postgres + real HTTP MCP | `bun eval/runner/n6-postgres-http.ts [--pg-url URL] [--output] [--attest PREREG] [--concurrency 8] [--only ops] [--gbrain]`; `rescore RECEIPT` | Keyless; needs local Docker Postgres (pgvector/pgvector:pg16) | none | generated (n6-visibility-gen) | HTTP + CLI spawn + in-process seeding |
| N6 visibility fuzz | n6-visibility-fuzz.ts | Read ops leak protected content to 7 callers | `bun eval/runner/n6-visibility-fuzz.ts [--seed N] [--gbrain] [--output] [--only ops] [--attest] [--json]` | Keyless, in-memory | none | generated (n6-visibility-gen) | in-process |
| N7 open loops email | n7-open-loops-email.ts | Gmail-shaped thread loop detection and store scenarios | `bun eval/runner/n7-open-loops-email.ts` (see file header) | Keyless (paid arm gated) | ANTHROPIC (paid) | generated (n7-gmail-loops-gen) | in-process |
| N8 proactive recall | n8-proactive-recall.ts | Unsolicited recall at delivery; associative false alarms | `bun eval/runner/n8-proactive-recall.ts [--seed N] [--output] [--gbrain] [--attest] [--json] [--record-bugs]` | Keyless | none | generated + eval/data/associative-recall-v1 | in-process |
| N9 multi-hop paraphrase | n9-multi-hop-paraphrase.ts | Composed 2 and 3 hop questions, canonical and paraphrase wording | `bun eval/runner/n9-multi-hop-paraphrase.ts [--gbrain] [--output] [--corpus DIR] [--paid --budget-run-id ID]` | Keyword default; paid embeddings est. $0.07 | OPENAI (--paid) | generated (n9-multihop-paraphrase-gen) on world-v1 | in-process (reuses relational-ab) |
| P4 stream compaction | p4-stream/run.ts | LongMemEval as live stream with small window, real Claude Code lanes | `bun eval/runner/p4-stream/run.ts --arms ... --models ... --build A=CKOUT@SHA --paid --budget-usd CAP --output DIR` | Paid; budget required | ANTHROPIC, OPENAI (judge) | LongMemEval / BEAM (downloaded) | MCP (stdio) + CLI hook spawn |
| P4 analyze/beam/hooks/model/transcript | p4-stream/*.ts | Helpers for P4 (analysis, corpus, hooks, model call, transcript) | `bun eval/runner/p4-stream/analyze.ts ROWS.ndjson [--effect 0.03] [--power 0.8]` (analyze only) | $0 for analyze | none (model.ts calls provider) | n/a | model.ts: none (fetch); hooks.ts: CLI spawn |
| P5 agent harness (helper) | p5-agent.ts | Shared P5 agent brain, tools arm, judge calls, checkpoints | helper, no own runner | n/a | ANTHROPIC/OPENAI (judge helper) | n/a | MCP (cat40 McpClient) + CLI (`bun -e`) |
| P5 brain (helper) | p5-brain.ts | Shared put_page/extract/edges plumbing for P5 runners | helper, no own runner | $0 | none | n/a | in-process |
| P8 quote grounding | p8-quote-grounding.ts | Whether `think` keeps supported quotes and flags unsupported | `bun eval/runner/p8-quote-grounding.ts --gbrain CKOUT@REF [--questions FILE]`; `--make-questions ...` | Dev; paid judges | provider keys via ChatClient (none named in file) | amara world, sealed-confirmation (custodian) | in-process |
| P8 withdraw retrieval | p8-withdraw-retrieval.ts | Cosine neighbour retrieval for withdrawal review at 0.80 | `bun p8-withdraw-retrieval.ts RESULTS.jsonl` | Paid embedding calls | OPENAI (required) | P8 review rows (input file) | none |
| P8 write cost | p8-write-cost.ts | $ and latency per write with extraction on/off | `bun eval/runner/p8-write-cost.ts --gbrain CKOUT@REF [--sessions 200] [--arms on,off,...]` | Paid meter; budget ledger | ANTHROPIC/OPENAI | LongMemEval-S sessions | MCP (gbrain serve stdio) + CLI (runCli) |
| Q1 cell | q1/cell.ts (+ cells/*.ts) | BEAM-10M and related scoreboard cells; ingest and QA | `bun eval/runner/q1/cell.ts plan\|show\|run\|merge ...`; `run --cell ID --paid --budget-run-id ID` | Paid; budget ledger; long (hours per cell) | ANTHROPIC, OPENAI, judge providers | BEAM-10M (custodian, sealed) | HTTP + MCP + in-process |
| Q1 calibration cell and calibrate | q1/calibration-cell.ts, q1/calibrate.ts | Reader tokenizer calibration on dev smoke packs | `bun eval/runner/q1/calibrate.ts DIR...`; `q1/calibration-cell.ts --reader ... --budget-ledger F --run-id ID --lease-usd N` | Paid cell; calibrate $0 | ANTHROPIC/OPENAI/particle | LoCoMo dev smoke | HTTP via proxy |
| Q1 stress pilot | q1/stress-pilot.ts | Ingest and serve stress on BEAM-1M dev | `bun eval/runner/q1/stress-pilot.ts --system URL --provider-proxy URL ...` | Paid proxy; long | provider keys via proxy | BEAM-1M dev | HTTP (fetch to shim) |
| Q1 reread / second judge | q1/reread-cell.ts, q1/second-judge.ts | Re-read frozen contexts with another reader; second-judge check | `bun eval/runner/q1/reread-cell.ts --cell ID --arm ID --source OUT/runs/ID --reader ...`; `q1/second-judge.ts --cell ... --arm ... --root ... --out` | Paid | ANTHROPIC/OPENAI | frozen contexts from source cell | none (judges via chat client) |
| Q1 rejudge systems | q1/rejudge-systems.ts (+ rejudge-rule.ts) | GST-1365 judge-robustness re-judging | `bun eval/runner/q1/rejudge-systems.ts plan\|judge\|referee\|controls\|summary ...` | Paid, leased | multiple providers | published cell answers | none (judge providers) |
| Q1 publish | q1/publish.ts | Assemble scoreboard receipt from campaign state | `bun eval/runner/q1/publish.ts --config publication.json --results DIR --out DIR` | $0 | none | campaign state | CLI (git worktree, spawn of cell.ts merge) |
| Q1 particle report | q1/particle-addon-report.ts | Particle-1 add-on aggregates from published cells | `bun eval/runner/q1/particle-addon-report.ts --root OUT --out DIR` | $0 | none | published cells | none |
| Q1 power | q1/power.ts | Power and coverage simulation for Family 1 | `bun eval/runner/q1/power.ts` (see header) | $0 | none | none (simulated) | none |
| Q1 custodian tools | q1/beam10m-manifest.ts, q1/beam10m_extract.py, q1/beam10m-structure.ts, q1/d8-manifest.ts | BEAM-10M and D8 manifests; structure counts | `bun eval/runner/q1/beam10m-manifest.ts status`; `fetch --write` (custodian) | $0 status; fetch needs custody host | none | BEAM-10M (HF download) | none (fetch from HF API) |
| Q1 ops tools | q1/raise-lease.ts, q1/reattach.ts, q1/persist.sh | Raise leases, reattach VMs, persist public campaign state | `bun eval/runner/q1/raise-lease.ts raise\|show\|settle ...`; `q1/reattach.ts --campaign M --state DIR` | Spend control | none | n/a | CLI (bash ubi-runner, Bun.spawnSync) |
| Q1 reuse and golden | q1/reuse-check.ts, q1/golden-fixture.ts | Can a row be reused at a commit; golden fixture digest | `bun eval/runner/q1/reuse-check.ts --prior C --planned C --systems ...`; `q1/golden-fixture.ts ROOT` | $0 | none | git trees | CLI (git, tar, spawn) |
| Q1 helpers | q1/hedge.ts, q1/usage.ts, q1/secret-scan.ts, q1/rejudge-rule.ts, q1/scoreboard-errors.ts | Hedge classifier, usage buckets, secret scan, decision rule | `bun eval/runner/q1/hedge.ts classify --text ...`; `q1/secret-scan.ts DIR` | $0 | none | n/a | none (imports only) |
| Q2 campaign and preflight | q2/campaign.ts, q2/preflight.ts, q2/checkpoints.ts, q2/export.ts | Campaign ledger, preflight, resume, allowlisted export | `bun eval/runner/q2/campaign.ts status\|preflight\|record ... --campaign ROOT`; `q2/export.ts --campaign ROOT --step export --run aggregate --out F` | $0 except paid steps | ANTHROPIC, OPENAI (preflight checks keys present) | custody roots | CLI (spawn/execFileSync git, sh); in-process (imports gbrain-under-test) |
| Q2 junk audit | q2/junk-audit.ts (+ n-corpus.ts, k-conformance.ts, junk-classes.ts, grammar-lines.ts) | G1, G3, G4, G2 grammar gates on sets N and K | `bun eval/runner/q2/junk-audit.ts ...` (custodian) | Paid flag; budget | ANTHROPIC/OPENAI | custodian sets N, K | importGbrain(src/core/line-grammar.ts) + in-process |
| Q2 G5 | q2/g5.ts | Carry-over of P5 H1/H2 gates (noninferiority) | `bun eval/runner/q2/g5.ts --world-baseline R --world-candidate R --variants R --output DIR` | $0 (receipts in) | none | receipts | in-process via p5-brain |
| Q2 C-gates and transitions | q2/c-gates.ts, q2/transitions.ts | Transition identity and C gates on link_transitions rows | `bun eval/runner/q2/c-gates.ts select\|...` (see header) | $0 | none | custody | in-process via p5-brain |
| Q2 judges | q2/judge.ts, q2/wta-judge.ts | Q2 line labels and answer judging (two judges) | helper; invoked by junk-audit and campaign | Paid | ANTHROPIC, OPENAI | custody work root | none (fetch via p5-agent chatText) |
| Q2 stats and sims | q2/power-sim.ts, q2/crossed-bootstrap.ts, q2/stats.ts, q2/q-set.ts | G6 power, crossed bootstrap, Wilson and cluster stats | `bun eval/runner/q2/power-sim.ts --receipts A,B --pairs 100 --ingests 3 --sims 200` | $0 | none | receipts | none |
| T0 program primary | t0-program-primary.ts (+ t0/delivery.ts, t0/score.ts) | End-to-end failure after correction on cross-session prep | `bun eval/runner/t0-program-primary.ts --gbrain CKOUT@REF --output DIR [--seeds a,b] [--tasks id,...]` | Hermetic default; paid needs --paid and budget run | ANTHROPIC (reader) | generated PP world (program-primary-gen) | MCP (cat40 McpClient, gbrain serve) + in-process import of generator |
| T0b program primary (hard) | t0b-program-primary.ts | Harder T0 world on T0 carrier | `bun eval/runner/t0b-program-primary.ts ...` (see header) | Hermetic default ($0 scripted); paid with budget | ANTHROPIC (paid) | generated hard world (program-primary-hard-gen) | MCP + in-process |
| T0 parity | t0/parity.ts | Native Claude Code parity slice with gbrain hooks and MCP | `bun eval/runner/t0/parity.ts --gbrain CKOUT@REF --output DIR --tasks id,... [--model claude-sonnet-5-5]` | Paid (real claude CLI); budget | ANTHROPIC (claude CLI) | generated PP world | CLI (spawn claude + gbrain serve/hook) |
| T0 brief | t0/brief.ts | Proactive brief on/off (T0 carrier) | helper for T0 family | $0 to build; paid via T0 | ANTHROPIC (via T0) | PP brief world | MCP via T0 |
| T0 paired and analyze | t0/paired.ts, t0/analyze.ts | Paired risk ratio and failure counts | `bun eval/runner/t0/paired.ts --baseline R.jsonl --candidate R.jsonl [--repeats 1,2] [--out F]` | $0 | none | results.jsonl | none (imports power/risk-ratio) |
| A4 abstention | a4-abstention.ts | CRAG grade calibration and abstention | `bun eval/runner/a4-abstention.ts [--seed N] [--output] [--gbrain] [--paid --budget-usd N]` | Paid estimate $4; s4 estimate $0.5 | ANTHROPIC | LongMemEval-style generated | in-process (13 importGbrain calls) |
| A4 S4 rescore | a4-s4-rescore.ts | Keyless rescore of an A4 S4-on receipt | `bun eval/runner/a4-s4-rescore.ts RECEIPT.json` | $0 | none | receipt | none |
| ARS agent retrieval shapes | agent-retrieval-shapes.ts | 15 retrieval shapes (E1 to E15) on an operator-style brain | `bun eval/runner/agent-retrieval-shapes.ts [--seed N] [--output] [--gbrain] [--families ...]` | Keyless | none | generated | in-process (operations.ts, pglite-engine.ts, import-file.ts) |
| Attendance world score | attendance-world-score.ts | Scores N9 one-hop attendance rows against attendee lists | `bun eval/runner/attendance-world-score.ts --receipt N9.json --corpus DIR [--json]` | $0 | none | world-v1-attendees | none (reads receipts) |
| Attendee role planner | attendee-role-planner.ts | Attendee-role questions on world-v1-shaped corpus | `bun eval/runner/attendee-role-planner.ts [--corpus DIR] [--output] [--gbrain] [--attest PREREG]` | Keyless | none | eval/data/world-v1-attendees | in-process (relational-ab core) |
| Belief weekly probes | belief-weekly-probes.ts | W11 sealed confirmation of gbrain W4 weekly belief diff | `bun eval/runner/belief-weekly-probes.ts --gbrain CKOUT@REF [--seeds 20261016] --output DIR` | Keyless dev | none | generated (belief-weekly-gen) | in-process (test helper, operations.ts, belief/changes.ts) |
| Chronicle lift | chronicle-lift.ts | auto_chronicle OFF vs ON lift | `bun eval/runner/chronicle-lift.ts corpus --out DIR` ($0); `run --out DIR --budget-usd N [--arms off,on-a,on-b] [--repeats 2]`; `score --out DIR` | Paid; budget required | ANTHROPIC (judge + reader) | generated amara-life-v1 vault | CLI (spawnSync bun src/cli.ts) + MCP (McpClient) |
| Coding spike | coding-spike.ts | Coding-agent memory spike (SDE bench, Docker) | `bun eval/runner/coding-spike.ts --tasks ID --arms none,gbrain`; `--stub-upstream` (keyless) | Paid with Docker; budget | ANTHROPIC/OPENAI (opencode) | sdebench (external, Docker) | CLI (docker, python spike.py) + in-process |
| Constrained relational | constrained-relational.ts | Constrained relational retrieval (P3 E4) | `bun eval/runner/constrained-relational.ts [--seeds 11,13] [--gbrain CKOUT@SHA] [--output] --paid --budget-usd 1` | Paid (embeddings); budget | OPENAI (embeddings) | generated constrained-relational-gen | in-process |
| Parse relational questions | parse-relational-questions.ts | Which relation gbrain's parser picks per question | `bun eval/runner/parse-relational-questions.ts CKOUT QUESTIONS.jsonl... > relations.json` | $0 | none | JSONL questions | in-process (reads gbrain source) |
| Relation line variants | relation-line-variants.ts | Do typed relation lines reach the graph | `bun eval/runner/relation-line-variants.ts [--seeds 1,2,3] [--phrasing A] [--output] [--gbrain] [--json]` | Keyless | none | generated relation-line-variants-gen | in-process |
| Relational A/B | relational-ab.ts | Relational retrieval OFF vs ON on shared index | `bun eval/runner/relational-ab.ts --budget-usd 1` (live); `--stub-embed --limit 8 --seeds 1` (keyless) | Live estimate $0.07; budget | OPENAI (embeddings) | generated relational-paraphrase | in-process (hybrid, embedding, gateway) |
| Evidence auto v2 | evidence-auto-v2.ts | Does auto evidence delivery keep whole-page gains | `bun eval/runner/evidence-auto-v2.ts <command> ...` (plan-costed; sealed E2) | Paid; est. cost table in file (lines 78-83) | ANTHROPIC (Sonnet judges) | LongMemEval-S (500) + sealed set | in-process (import-file) |
| Feedback replay LoCoMo | feedback-replay-locomo.ts | Use-attributed feedback replay on LoCoMo | `bun eval/runner/feedback-replay-locomo.ts --gbrain CKOUT@SHA --output DIR [--lambdas 0.1,0.2,0.3] [--paid --budget-usd N]` | Paid; budget | ANTHROPIC | LoCoMo dev conversations | in-process |
| Feedback replay world | feedback-replay-world.ts | P3 dev feedback replay on world-v1 | `bun eval/runner/feedback-replay-world.ts --gbrain CKOUT@SHA --output DIR --paid --budget-usd N` | Paid; budget | ANTHROPIC | world-v1 | in-process |
| Feedback think replay | feedback-think-replay.ts | Implicit citation feedback via think operation | `bun eval/runner/feedback-think-replay.ts --gbrain CKOUT@SHA --output DIR --paid --budget-usd N` | Paid; budget | ANTHROPIC | generated world | in-process (operations.ts, feedback/*) |
| Forward reference heal | forward-reference-heal.ts | Links written before their target heal after page appears | `bun eval/runner/forward-reference-heal.ts [--seeds 1,2,3] [--arm local\|http] [--sweep-every 10] [--withhold 0.2] [--output] [--gbrain] [--json]` | Keyless; `--arm http` uses HTTP transport | none | generated world-v1 | local: in-process; http: HTTP |
| Hub world | hub-world.ts | Degree-dependent ranking on hub-heavy world | `bun eval/runner/hub-world.ts --corpus-dir DIR [--gbrain CKOUT@SHA] [--seeds 1]` | Paid flag; budget | ANTHROPIC/OPENAI (paid) | hub-world-gen directory | in-process via relational-ab |
| Hub world arms | hub-world-arms.ts | Read-time arms over one index (dampening, graph signals) | `bun eval/runner/hub-world-arms.ts --corpus-dir DIR --gbrain CKOUT@REF` | Keyless default | none | hub-world-gen | in-process via relational-ab |
| Line grammar junk audit | line-grammar-junk-audit.ts | Typed line grammar stays out of ordinary list lines (P5 H3) | `bun eval/runner/line-grammar-junk-audit.ts fetch-vault`; `--gbrain CKOUT@REF --output DIR [--corpora lme-s,locomo,blue-book]` | $0 except judged parts | ANTHROPIC/OPENAI (paid judge) | LongMemEval-S, LoCoMo, blue-book vault (downloaded) | in-process (src/core/line-grammar.ts) + fetch (HTTP raw files) |
| Line grammar typing | line-grammar-typing.ts | Link typing on prose stays as before (P5 H1) | `bun eval/runner/line-grammar-typing.ts [--output] [--gbrain] [--dir eval/data/world-v1] [--json]` | Keyless | none | eval/data/world-v1 (committed) | in-process |
| Living pages breakeven | living-pages-breakeven.ts | Build decision: break-even read/write ratio from ops CSV | `bun eval/runner/living-pages-breakeven.ts --ops OPS.csv [--page-days N] [--json out.json]` | $0 | none | owner's op counts CSV | none |
| Living pages CSV | living-pages-csv.ts | CSV parser helper for living-pages breakeven | helper only | $0 | none | n/a | none |
| Quoted reads | quoted-reads.ts | Remote read quote-fence inverse (quoted: transcript) | helper; no usage text | $0 | none | n/a | in-process (imports gbrain src) |
| Reading headroom | reading-headroom.ts | Keyless recount over committed W10 receipts | `bun eval/runner/reading-headroom.ts` (see header) | $0 | none | committed receipts | in-process (node_modules gbrain chunker) |
| Reading notes recount | reading-notes-recount.ts | Recount of reading-notes receipts | `bun eval/runner/reading-notes-recount.ts` | $0 | none | committed receipts | none (imports node:fs only) |
| Reading notes requests | reading-notes-requests.ts | Offline paired requests (no sends) | `bun eval/runner/reading-notes-requests.ts --input F --output F --model M --max-tokens N` | Offline, $0 | none | LongMemEval (private) | pkg gbrain-reader/* (type + reader config) |
| Reading notes run | reading-notes-run.ts | Capped execution of a request plan | `bun eval/runner/reading-notes-run.ts --execute --input F --requests F --journal F --max-usd N --approval-id ID` | Paid, capped | ANTHROPIC (sonnet-4-6) | request plan | pkg gbrain-reader/ai/gateway, invocation-guard, model-pricing, eval/longmemeval/reader |
| Save notes dedup | save-notes-dedup.ts | put_page similar-page hint reduces duplicate pages (P5 H5b) | `GBRAIN_EVAL_CONFIG=put_page.similar_pages=true bun eval/runner/save-notes-dedup.ts --gbrain CKOUT@REF ...`; `compare A B` | Paid (agent); scripted mode $0 | ANTHROPIC (agent via p5-agent) | save-notes-dedup-gen | MCP (p5-agent) + in-process |
| Structure-aware chunks | structure-aware-chunks.ts | Chunk heading path and heading-lead effect on retrieval (GBRA-234) | `bun eval/runner/structure-aware-chunks.ts plan\|run\|cat\|guard\|report --gbrain CKOUT@REF ...` | Keyless plan; embeddings paid | OPENAI (embeddings) | QASPER dev v0.3 + cat13 corpora | in-process |
| Takes bootstrap frontier | takes-bootstrap-frontier.ts | Takes classifier on four frontier models (W4) | `bun eval/runner/takes-bootstrap-frontier.ts route-check\|run\|rescore [flags]` | route-check paid; rescore $0 | ANTHROPIC, OPENAI, others (chat gateway) | committed takes corpus | CLI (spawnSync self, git ls-tree) + pkg gateway via overlay |
| W6 embedding matrix | w6-embedding-matrix.ts | Summary of Cat 13 embedding x rerank receipts | `bun eval/runner/w6-embedding-matrix.ts summarize RESULTS_DIR` | $0 | none | committed receipts | none (imports stats/paired.ts) |
| W8 negative controls | w8-negative-controls.ts | Summary of live negative-control receipts | `bun eval/runner/w8-negative-controls.ts summarize RESULTS_DIR` | $0 | none | committed receipts | none |
| Write then answer | write-then-answer.ts | Typed relation lines help agent answer from its own brain (Q2 G6, P5 H6) | `bun eval/runner/write-then-answer.ts ...` (one arm per invocation; see header) | Paid; budget ledger | ANTHROPIC/OPENAI (agent, judge) | generated career chronicle + amara | MCP (gbrain serve via p5-agent/cat40) + CLI (extract --stale) |

Keyless vs paid is a per-mode property. Rows above give the default mode first; paid modes are gated by `--paid`, `--budget-usd`, or `--budget-run-id` (see `budget-ledger.ts`, `paid-arm.ts`).

## Cross-cutting pattern (applies to every section below)

- In-process gbrain is loaded with `importGbrain(gut, 'src/...')` (`gbrain-under-test.ts:117`). The `gut` object comes from `resolveGbrainUnderTest(spec)` and points at a built checkout (`--gbrain CKOUT@REF`), not the npm pin. This is the coupling a Rust parity gate must replace with CLI or MCP.
- Package-subpath imports (`gbrain/operations`, `gbrain/pglite-engine`, `gbrain/search/hybrid`, `gbrain/embedding`, `gbrain/ai/gateway`, `gbrain/config`, `gbrain/engine`, `gbrain/import-file`, `gbrain/types`) appear almost only as `import type` (erasable). Runtime use goes through `importGbrain`.
- Transports: MCP stdio (`cat40/gbrain-arm.ts` McpClient spawns `bun <build>/src/cli.ts serve --surface ...`), MCP HTTP and CLI (`lifecycle/drivers.ts`: `runCli`, `McpStdioDriver`, `McpHttpDriver`), and hooks (`bun <build>/src/cli.ts hook <event>`, used by `p4-stream/hooks.ts`, `t0/delivery.ts`).

---

## Section A: n-series runners

### N1 knowledge update (`n1-knowledge-update.ts`, helper `lifecycle/n1-score.ts`)
- Measures: whether updated values, reverts, and backdated values survive restart, reimport, and concurrent writes. Question: does gbrain answer with the current value after supersession.
- Run: `bun eval/runner/n1-knowledge-update.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF]`; CI slice `--slice ci` (header lines 43-45). Paid arm gated by `--paid` and a budget run (lines 541-545).
- Cost and time: unknown for the keyless path. Paid arm estimate `PAID_ESTIMATE_USD = 0.05` (line 389).
- LLM keys: keyless default. Paid arm uses OPENAI_API_KEY to configure embeddings (`configureGateway`, line 411, dims 1536).
- Corpus: generated, seeded ledger from `eval/generators/n1-knowledge-update-gen.ts` (fictional people and companies). Not downloaded.
- Metrics: probe pass rates per stage (updated, restart, reimport, concurrent) per cell; registry id `N1` and `N1-ci` (line 567).
- gbrain imports: `gbrain/operations` (type OperationContext, line 50); importGbrain `src/core/pglite-engine.ts` (PGLiteEngine: connect, initSchema, disconnect); `src/core/operations.ts` (ops by name: put_page, get_page, remember, ontology_propose); `src/core/ai/gateway.ts` (configureGateway, paid only, line 410). Also imports `lifecycle/slice.ts`, `lifecycle/drivers.ts` (type Driver), `lifecycle/n1-score.ts`.
- Coupling: mixed. In-process for seeding and ops. Header (lines 11-13) says each cell runs engine x transport through `lifecycle/slice.ts`, which uses CLI, stdio MCP and HTTP drivers.
- Parity-gate fit: deterministic keyless default; fast to medium.
- Published: `docs/benchmarks/2026-10-01-n1-knowledge-update.md`; `docs/plans/2026-10-01-eval-category-wave/PLAN.md` cites the runner.

### N12 format fidelity (`n12-format-fidelity.ts`)
- Measures: whether the same conversation in each registered transcript format keeps speaker, timestamp, and turn count, and whether gbrain admits what it cannot parse. Also meeting attendee vs mention separation.
- Run: `bun eval/runner/n12-format-fidelity.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF] [--json]` (line 46).
- Cost: $0, all in process, keyless, LLM fallback and polish off (header lines 27-30).
- LLM keys: none.
- Corpus: `eval/generators/n12-format-fidelity-gen.ts` and `n12-format-renderers.ts` (generated). Formats enumerated at run time from gbrain (`transcriptAdapters()`, `BUILTIN_PATTERNS`).
- Metrics: role attribution, timestamp exact match, turn-count error, detection rate, noise leaks, invented timestamps. Promotion rules from `registry.ts` (`registryEntry('N12')`, line 763).
- gbrain imports: importGbrain `src/core/transcripts/detect.ts` (detectAdapter, adapter parse); `src/core/operations.ts` (put_page, list_pages, get_links, get_backlinks, lines 455-466); `src/core/pglite-engine.ts` (PGLiteEngine: connect, initSchema, disconnect, setConfig).
- Coupling: in-process.
- Parity-gate fit: deterministic, keyless, fast. Good parity candidate.
- Published: `docs/benchmarks/2026-10-01-n12-format-fidelity.md` (and wave14 repin summaries).

### N13 code intelligence (`n13-code-intelligence.ts`, helpers `generators/n13-code-scout-vendor.ts`, `generators/n13-ts-gold.ts`)
- Measures: readiness, latency, and documented limits of six code_* operations on the vendored unjs/pathe snapshot. Explicitly a readiness report, not a quality gate (header lines 1-12).
- Run: `bun eval/runner/n13-code-intelligence.ts [--output DIR] [--gbrain CKOUT@REF] [--json]` (line 33).
- Cost and time: keyless, in-memory PGLite; wall time not stated (unknown).
- LLM keys: none.
- Corpus: vendored `eval/data/n13-code-scout` (MIT, hash-checked against `manifest.json` before use, `verifyVendoredCorpus`). Gold `eval/data/n13-code-scout/ts-gold.json`, built once by `generators/n13-ts-gold.ts` with the pinned TypeScript compiler; gold is never gbrain output.
- Metrics: per-op readiness and timing; harness error if gold commit differs from corpus commit (line 183).
- gbrain imports: importGbrain `src/core/operations.ts` (operations.find(...).handler for code_callers, code_def, code_refs, code_blast, code_flow, with `remote: true` for the remote refusal check, line 234); `engine.initSchema`, `engine.executeRaw`, `engine.connect`, `engine.disconnect`. Also calls the import and resolve phases (header lines 16-20: `importCodeFile`, `resolveSymbolEdgesIncremental`) through the `gbrain sync`/`reindex-code` paths (header).
- Coupling: in-process. Header says the readiness step runs through `handleToolCall` (the `gbrain call` path).
- Published: `docs/benchmarks/2026-10-01-n13-code-intelligence.md`; registry cites it (`eval/registry.ts`).

### N14 large-page fidelity (`n14-large-page-fidelity.ts`, generator `eval/generators/n14-large-page-gen.ts`)
- Measures: whether an agent can find and read deep content in very large pages (2 MB to 1 GB), and whether appends and forget stay cheap. Arms: single-page, managed-parts, and others (header lines 13-30).
- Run: `bun eval/runner/n14-large-page-fidelity.ts [--tier 2mb|20mb|24mib|100mib|128mib|200mb|256mib|260mib|1gb | --tiers 2mb,20mb] [--arms ...]` (line 45). 1 GB is manual.
- Cost and time: wall time and peak RSS are recorded (lines 38-40); no total time or cost stated, so unknown. Paid path gated by `requirePaidArm` and budget run (line 62-66).
- LLM keys: ANTHROPIC_API_KEY and OPENAI_API_KEY referenced (2 each). Keyless by default for the fidelity probes; paid arm for embeddings and answers.
- Corpus: generated, `eval/generators/n14-large-page-gen.ts` (iMessage-style chat, project log, novel; planted needles per decile; presence oracle rescans raw bytes).
- Metrics: needle presence and hit rate per decile, ingest wall, append visible rank, forget and delete outcomes (lines 163-191).
- gbrain imports: importGbrain `src/core/operations.ts` (get_page, search, recall, query, upload_page_part, begin_page_upload, get_write_request), `src/core/import-file.ts`, `src/core/ai/gateway.ts`, `src/commands/export.ts`, `src/commands/embed.ts`; pkg `gbrain/pglite-engine` (type). Engine: setConfig, initSchema, connect, disconnect.
- Coupling: in-process, plus a child process of itself (`spawn(process.execPath, [import.meta.path, '--child', specPath])`, line 1230) for memory isolation.
- Published: `docs/benchmarks/2026-10-14-n14-large-page-fidelity-baseline.md`, `2026-10-15-...-wave-a.md`, `-wave-b1`, `2026-10-18-...-wave-b2.md`, `2026-10-20-...-wave-b3.md`, `2026-10-25-...-wave-b4.md`.
- Parity-gate fit: tiers above 20 MB are slow and memory heavy; small tiers are a fast parity check.

### N15 SkillOpt method (`n15-skillopt-method.ts`, helpers `skillopt-method/*`, generator `generators/skillopt-method/gen.ts`)
- Measures: whether skill optimizers are distinguishable on gbrain's query, briefing, and fact-check skills. Phase 1 is the measuring stick (header lines 1-12). Targets are frontier models (claude-opus-5-5, gpt-6.1-sol), per the header.
- Run: `bun eval/runner/n15-skillopt-method.ts [--output DIR] [--json]` (hermetic default); `--smoke --paid --budget-run-id ID [--skills query]`; `--probe --target opus|sol --stage f0a|f0b|test ... --paid --budget-run-id ID`; `--dataset v3 --stage calibration|gate ...` (lines 76-79).
- Cost: ledger-priced. Log lines name a $50 calibration run and a $470 ceiling gate (lines 57-60). Default hermetic run is $0.
- LLM keys: ANTHROPIC_API_KEY and OPENAI_API_KEY in paid stages. Default run keyless.
- Corpus: generated, `generators/skillopt-method/gen.ts`, datasets v1, v2, v3 with MANIFEST.json and seed SKILL.md checked by sha256 at gbrain pins (3ec766c40 for v1/v2, 311a83bbe for v3; header lines 17-22).
- Metrics: judge scoring (`skillopt-method/score.ts`), paired difference (`test-stage.ts`), headroom probe (`headroom.ts`); gates are preregistered.
- gbrain imports: none. It reads `gbrain-version.ts` for pin metadata only.
- Coupling: none for gbrain execution. It calls model APIs through its own modules (`skillopt-method/rollouts.ts`, `one-shot.ts`). Note: the skill under test is a text file at the gbrain pin, not a running gbrain.
- Published: `docs/benchmarks/2026-11-02-skillopt-ceiling/` (PREREGISTRATION.md, receipts). CHANGELOG.md references it.
- Parity-gate fit: not a gbrain parity runner; LLM required for scoring. Out of scope for the Rust parity gate.

### N2-3 prompt A/B (`n2-3-prompt-ab.ts`)
- Measures: contradiction judge prompt before vs after a gbrain commit, on a fresh N2 world (development data; the counted seed 20261001 is kept in the N2 report).
- Run: `bun eval/runner/n2-3-prompt-ab.ts arm --gbrain CKOUT@REF --label before|after --output arm.json [--seed 20261002] [--paid --budget-run-id ID]`; `bun eval/runner/n2-3-prompt-ab.ts compare before.json after.json --output receipt.json [--ledger-summary F]` (lines 5-17).
- Cost: $0 without `--paid` (judges nothing; records offered pairs and hash). Paid estimate per shard from N2 (see below).
- LLM keys: ANTHROPIC_API_KEY (paid judge only).
- Corpus: generated, `generators/n2-contradiction-gen.ts` (`generateN2World`, `n2Gold`, `renderN2Page`). Sample threshold 103 (line 20s).
- Metrics: offered pair set hash equality across arms (`offered_keys_sha256`); judged pair verdicts vs oracle; unplanted pairs sampled at 40%.
- gbrain imports: importGbrain `src/core/eval-contradictions/types.ts` (type only at 30-ish lines); operations path via `put_page`; `runContradictionProbe` from `src/core/eval-contradictions/runner.ts` (invoked via n2-contradiction-surfacing family), and hybridSearch keyword-only.
- Coupling: in-process.
- Published: `docs/benchmarks/2026-10-01-n2-contradiction-surfacing.md` covers the same family; `docs/plans/2026-10-03-cat40-followups/PLAN.md` cites the runner. No dedicated A/B report found by name.

### N2 contradiction surfacing (`n2-contradiction-surfacing.ts`, generator `generators/n2-contradiction-gen.ts`)
- Measures: whether gbrain offers planted contradicting pairs (candidate discovery) and classifies them against independent claim spans (paid classification only).
- Run: `bun eval/runner/n2-contradiction-surfacing.ts` with its paid arm gated by budget; see header (lines 1-40) and `PROBE_BUDGET_USD = 10`.
- Cost: `PAID_ESTIMATE_USD = 8` (line 61); `PROBE_BUDGET_USD = 10` (line 63). Raised from $6 on 2026-10-03.
- LLM keys: ANTHROPIC_API_KEY (6 refs), paid classification uses gbrain `judgeContradiction`.
- Corpus: generated (`n2-contradiction-gen.ts`).
- Metrics: candidate discovery rate (planted pair offered under any supplied query), classification scores under oracle judge.
- gbrain imports: importGbrain `src/core/search/hybrid.ts`, `src/core/eval-contradictions/types.ts`, `trends.ts`, `runner.ts` (runContradictionProbe), `judge.ts` (judgeContradiction); importGbrain `src/cli/main.ts` and `src/cli.ts` (CLI entry, line noted in grep). Also engine via `put_page`.
- Coupling: in-process (plus CLI import of `src/cli.ts`, which means it loads the CLI module, not a subprocess).
- Published: `docs/benchmarks/2026-10-01-n2-contradiction-surfacing.md` (and `2026-10-06-n2-judges.md`).

### N2 judge replay (`n2-judge-replay.ts`)
- Measures: re-judges N2 prompt v4 pairs with current models through gbrain's `judgeContradiction`, scored against the ledger and the paid Haiku receipt (McNemar, Clopper-Pearson).
- Run: stages `capture` ($0, hermetic), `verify`, `select`, `judge` (paid, one model), `score` (keyless). Header lines 1-16.
- Cost: capture is $0. Judge stage paid under the ledger guard. Estimate per model not extracted (unknown).
- LLM keys: judge stage only.
- Corpus: N2 generated world plus paid receipt (`docs/benchmarks/2026-10-03-...` receipt referenced in header).
- gbrain imports: importGbrain `src/core/eval-contradictions/types.ts`; `judgeContradiction` (prompt v4 at pin); `runContradictionProbe` (capture).
- Coupling: in-process.
- Published: `docs/benchmarks/2026-10-06-n2-judges.md`, `2026-10-06-n2-judges-preregistration.md`, `docs/benchmarks/2026-10-06-n2-judges/judge-*.json`.

### N3 temporal as-of (`n3-temporal-asof.ts`, generator `generators/n3-temporal-gen.ts`, helper `generators/job-state.ts`)
- Measures: as-of state, timeline "before", page-date filtering, and chronicle event extraction answers vs gold derived from the ledger, not from gbrain.
- Run: `bun eval/runner/n3-temporal-asof.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF] [--json]` (line 43).
- Cost: $0 keyless. Time unknown.
- LLM keys: none (chronicle judge is scripted).
- Corpus: generated ledger (people, job changes with valid and recorded dates, meetings, timezone edge pages).
- Metrics: answer correctness against gold per feature; a descriptive comparison of valid-time vs recorded-time gold (line 72).
- gbrain imports: `gbrain/config` (type GBrainConfig, line 46), `gbrain/operations` (type, line 47), `gbrain/pglite-engine` (type, line 48). importGbrain `src/core/pglite-engine.ts`, `src/core/operations.ts` (put_page, add_timeline_entry, ontology_propose, ontology_get, get_timeline, query, get_page, find_trajectory, chronicle_last_seen), `src/core/chronicle/extract-events.ts` (runChronicleExtract, line 214), `src/core/chronicle/config.ts`. Engine: initSchema, setConfig (search.mcp_keyword_only, brain.timezone, chronicle.tz), executeRaw.
- Coupling: in-process.
- Published: `docs/benchmarks/2026-09-30-n3-temporal-asof.md` (directory and md both present).

### N4 entity resolution (`n4-entity-resolution.ts`, generator `generators/n4-entity-gen.ts`)
- Measures: resolver cascade, recall, remember, identity list, and search landing on the right entity for name variants, refusal on ambiguity, and separation of same-name people.
- Run: `bun eval/runner/n4-entity-resolution.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF] [--json]` (line 53).
- Cost: $0, keyless; time unknown.
- LLM keys: none.
- Corpus: generated (`n4-entity-gen.ts`), ledger fingerprint `ledgerFingerprint`.
- Metrics: per-probe resolution correctness across callers (local, remote 1 source, remote 2 sources).
- gbrain imports: `gbrain/engine` (type BrainEngine, line 57), `gbrain/operations` (types, line 58), `gbrain/config` (type, line 59), `gbrain/import-file` (dynamic import, line 298-299). importGbrain `src/core/pglite-engine.ts`, `src/core/operations.ts` (entity_identity_link, entity_identity_list, recall, search, remember), `src/core/import-file.ts`, `src/core/entities/resolve.ts` (resolveEntitySlugWithSource), `src/core/entities/resolve-on-save.ts`. Engine: initSchema, connect, disconnect, executeRaw, insertFact.
- Coupling: in-process.
- Published: `docs/benchmarks/2026-09-30-n4-entity-resolution.md`; registry cites the runner (`eval/registry.ts`).

### N4 similar pages (`n4-similar-pages.ts`)
- Measures: whether put_page's "did you mean an existing page?" hint names the existing page and stays quiet for names no page matches (P5 H5a).
- Run: `bun eval/runner/n4-similar-pages.ts [--seeds 1,2,3] [--pools A] [--output DIR] [--gbrain CKOUT@REF] [--json]` (line 33).
- Cost: $0 keyless.
- LLM keys: none.
- Corpus: N4 ledger (`n4-entity-gen.ts`) plus `generators/no-referent-names-gen.ts` (at least 50 names).
- gbrain imports: `gbrain/operations` (type, line 41); importGbrain `src/core/config.ts`, `src/core/operations.ts` (put_page, delete_page), `src/core/import-file.ts` (importFromContent). Engine: initSchema, connect, disconnect, executeRaw (setConfig and getConfig are declared in the local type but not called).
- Coupling: in-process.
- Published: no dedicated report; cited by `docs/benchmarks/2026-10-11-wave14-repin/run1/3001fd9a5/offline-tier-summary.md` and others under wave14-repin.

### N5 forget residue (`n5-forget-residue.ts`, `lifecycle/slice.ts`, `lifecycle/drivers.ts`, `promotion.ts`)
- Measures: whether `forget` withdraws a claim from active recall through immediate, settled, reimport, and restart stages, scoped to subject and source, with corrections allowed back. Original prose, page history, files and backups may keep text by design (header lines 1-18).
- Run: `bun eval/runner/n5-forget-residue.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF]`; `--slice ci [--output DIR]` (lines 41-43).
- Cost: $0, keyless. Time unknown.
- LLM keys: none.
- Corpus: generated ledger (`generators/seeded.ts` fingerprint), vault files written to disk.
- Metrics: canary recall before and after forget per tier and transport; documented non-guarantees reported separately.
- gbrain imports: none via importGbrain. Imports `registry.ts`, `lifecycle/slice.ts` (ENGINES, IFACES, SliceCell, runMatrix), `lifecycle/drivers.ts` (Driver type), `gbrain-under-test.ts` (for product identity), `receipt.ts`, `promotion.ts`. Uses `execFileSync('git', ['-C', vault, 'log', '-p', '--all'])` (line 334).
- Coupling: CLI, stdio MCP, and HTTP. Header line 525: transports are trusted local CLI `gbrain call`, stdio `gbrain serve`, and HTTP `gbrain serve --http` with OAuth client_credentials clients.
- Published: `docs/benchmarks/2026-10-01-n5-forget-residue.md` (`docs/benchmarks/2026-10-01-n1-n5-preregistration.md`); `docs/plans/2026-10-01-eval-category-wave/PLAN.md`.
- Parity-gate fit: deterministic, but multi-transport and slow (matrix of engines and transports).

### N6 postgres HTTP (`n6-postgres-http.ts`)
- Measures: the N6 visibility probes over a real Postgres database and the production HTTP transport, with pooled connections and warm caches (header lines 1-22). W12 of the 2026-10 round.
- Run: `bun eval/runner/n6-postgres-http.ts [--pg-url <admin url>] [--output DIR] [--attest PREREG] [--concurrency 8] [--only op1,op2] [--gbrain CKOUT@REF]`; negative control `--control-remote-private-pages --only get_page,search`; keyless `rescore RECEIPT.json` (lines 26-28).
- Postgres: default URL `postgres://postgres@127.0.0.1:55442/postgres` or env `LIFECYCLE_PG_URL` (line 665). Creates a database with `CREATE DATABASE` (line 318). Image digest read via `docker inspect pgvector/pgvector:pg16` (line 572). Needs a localhost Docker Postgres (registry note line 1471).
- Server: spawned as `bun <build>/src/cli.ts serve --http --bind 127.0.0.1 --port N` with GBRAIN_POOL_SIZE=8 and raised rate limits (lines 351, 590).
- Cost: $0; time unknown.
- LLM keys: none.
- Corpus: generated (`generators/n6-visibility-gen.ts`), same world as N6 visibility fuzz.
- Metrics: leak verdicts per op per principal (none, invalid, expired, scoped, owner) and pg_stat_activity samples.
- gbrain imports: pkg `gbrain/operations` (type Operation, OperationContext); importGbrain `src/core/operations.ts` (in-process control and seed). Seeds through gbrain's write path by a trusted local caller in process (header). Uses `bun` `SQL` for admin queries.
- Coupling: HTTP (`fetch` to `http://127.0.0.1:<port>/mcp` and `/token`, lines 217, 236, 271) plus CLI spawn of `gbrain serve --http`. The in-process path is only the seed and control.
- Published: `docs/benchmarks/2026-10-06-n6-postgres-http.md` and `-preregistration.md`; `docs/benchmarks/2026-10-16-n6-known-as-of.md`.
- Parity-gate fit: an HTTP parity probe. Needs Postgres and Docker; not fast. The one runner in scope already in the shape a Rust parity gate would want (process boundary, HTTP only for probes).

### N6 visibility fuzz (`n6-visibility-fuzz.ts`, generator `generators/n6-visibility-gen.ts`)
- Measures: whether any read op leaks protected content (private pages, held takes, private facts, derived atoms, ungranted source beta) to seven callers (trusted local, six remote scoped to alpha).
- Run: `bun eval/runner/n6-visibility-fuzz.ts [--seed N] [--gbrain CKOUT@REF] [--output DIR] [--only op1,op2] [--attest PREREG] [--json]` (line 69 region).
- Cost: $0 keyless; time unknown.
- LLM keys: none.
- Corpus: generated (`generators/n6-visibility-gen.ts`), seed `N6_DEFAULT_SEED`.
- Metrics: forbidden-marker presence per op per caller, three repeats per probe.
- gbrain imports: pkg `gbrain/operations` (types Operation, OperationContext, AuthInfo, ParamDef). importGbrain `src/core/operations.ts`, `src/core/pglite-engine.ts`, `src/mcp/dispatch.ts` (dispatchToolCall), `src/core/scope.ts` (operationScopesAllowed), `src/core/minions/tools/brain-allowlist.ts` (buildBrainTools), `src/core/eval-contradictions/runner.ts` and `trends.ts` (contradictions, optional), `src/core/belief/coverage.ts` (optional). Engine: initSchema, executeRaw, connect, disconnect.
- Coupling: in-process. It enumerates `operations` at run time and calls them through `dispatchToolCall` (the MCP dispatcher), so it covers the MCP path in process without a server.
- Published: `docs/benchmarks/2026-09-30-n6-visibility-fuzz.md`; `docs/benchmarks/2026-10-16-n6-known-as-of.md` cites it.

### N7 open loops email (`n7-open-loops-email.ts`, generator `generators/n7-gmail-loops-gen.ts`)
- Measures: Gmail thread parsing and loop detection, plus open_loops store mechanics (closure on reply, nudge hold, calendar hold, mute, redaction for a remote caller).
- Run: no usage line found in the header; see header lines 1-30 and `--paid` gated paths. Use `bun eval/runner/n7-open-loops-email.ts` (keyless).
- Cost: keyless default. Paid arm gated (2 refs). Time unknown.
- LLM keys: ANTHROPIC_API_KEY (3 refs, paid extract path; `runLoopsExtract`).
- Corpus: generated (`n7-gmail-loops-gen.ts`), raw Gmail API JSON rendered from the ledger; parsed through gbrain's `GmailClient` with a stub fetch.
- Metrics: loop verdict vs documented-rule oracle; store scenario pass rates.
- gbrain imports: `gbrain/operations` (type, line 50); importGbrain `src/core/operations.ts` (open_loops, loops_close, loops_mute), `src/core/google/...` GmailClient (getThread), `src/core/google/google-render.ts` (renderThreadPage), `src/core/google/loops-extract.ts` (runLoopsExtract), `src/core/loops/loops-store.ts` (upsertOpenLoop), `src/core/import-file.ts` (importFromContent), `src/core/ai/gateway.ts` (configureGateway, paid). Engine: executeRaw, initSchema, connect, disconnect. Also `detectThreadLoop` and `applyThreadLoopVerdict` through the loops module.
- Coupling: in-process; GmailClient is driven with a stub fetch, so no network.
- Published: `docs/benchmarks/2026-10-01-n7-open-loops-email.md`; `docs/benchmarks/2026-10-03-n7-oracle-amendment.md`.

### N8 proactive recall (`n8-proactive-recall.ts`, generators `n8-proactive-recall-gen.ts` and `eval/data/associative-recall-v1`)
- Measures: unsolicited recall at final delivery for two worlds. Mechanics arm scores delivered pages and bytes; associative arm scores strict and adjudicated false-alarm rates. gbrain does not claim general associative recall (header lines 15-34).
- Run: `bun eval/runner/n8-proactive-recall.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF] [--attest PREREG] [--json] [--record-bugs]` (line 41-ish).
- Cost: $0 keyless; time unknown.
- LLM keys: none.
- Corpus: generated mechanics world plus committed associative-recall-v1 probes and adjudication file (`eval/data/n8-proactive-recall/associative-negatives-adjudication-v1.json`).
- gbrain imports: `gbrain/operations` (type, line 41); importGbrain `src/core/operations.ts` (volunteer_context, search, get_page), `src/core/import-file.ts` (importFromContent), `assembleTurnContext` (local only). Engine: softDeletePage, initSchema, executeRaw, connect, disconnect.
- Coupling: in-process for the local arm. Remote arm (prior_context) runs via the operation with `remote: true` (in process).
- Published: `docs/benchmarks/2026-10-01-n8-proactive-recall.md`; `docs/benchmarks/2026-10-06-n8-privacy-gate.md`.

### N9 multi-hop paraphrase (`n9-multi-hop-paraphrase.ts`, generator `generators/n9-multihop-paraphrase-gen.ts`, shared core `relational-ab.ts`)
- Measures: strict supporting-fact all-hit@10 for 125 composed two- and three-hop questions in canonical and paraphrase wording, with controls (solvability, single-page shortcut subset, gold-shuffle negative).
- Run: `bun eval/runner/n9-multi-hop-paraphrase.ts` (keyword, default); `--gbrain ../gbrain@3a284ae --output /tmp/n9`; `--paid --budget-run-id <id>` for OpenAI embeddings; `--corpus eval/data/world-v1-attendees` (lines 29-32).
- Cost: default keyword is $0. Paid estimate `N9_PAID_ESTIMATE_USD = 0.07` (line 68). Time unknown.
- LLM keys: OPENAI_API_KEY only in paid mode (4 refs; `embed = paid ? 'openai' : 'keyword'`, line 437).
- Corpus: generated composed questions committed by hash; world-v1 or world-v1-attendees.
- Metrics: all-hit@10, stage funnel, composed-query capability check (`parseRelationalQuery`); controls. Latency summary is wall time of hybridSearch arms (line 601).
- gbrain imports: pkg `gbrain/pglite-engine` (type, line 41); importGbrain via `relational-ab.ts` (`hybridSearch`, `embedQuery`, `configureGateway`, `diagnoseEmbedding`, `src/core/search/hybrid.ts`, `src/core/embedding.ts`, `src/core/ai/gateway.ts`). Engine: executeRaw for link edges (line 369).
- Coupling: in-process. Forks itself via `spawn(process.execPath, args)` (line 388) to run a child.
- Published: `docs/benchmarks/2026-10-01-n9-multi-hop.md`, `2026-10-01-n9-multi-hop-preregistration.md`.

---

## Section B: P-series runners

### P4 stream compaction (`p4-stream/run.ts`, helpers `analyze.ts`, `beam.ts`, `hooks.ts`, `model.ts`, `transcript.ts`)
- Measures: LongMemEval (and BEAM) as a live conversation with a small window through gbrain's real Claude Code lanes (hooks and MCP).
- Run: `bun eval/runner/p4-stream/run.ts --arms Aprime,B,C --models claude-sonnet-5-5 --build A=<gbrain>@<sha> --benchmark lme-s|beam-100k|beam-500k|beam-1m --split dev --window 32000 --paid --budget-usd <cap> --output DIR` (header lines 1-10). Analyze: `bun eval/runner/p4-stream/analyze.ts ROWS.ndjson [--effect 0.03] [--power 0.8] [--json]`.
- Cost: paid, budget required. Per-cell cost comes from `ctx.proxy.finalize` (line 346). Total time unknown.
- LLM keys: ANTHROPIC_API_KEY (1 ref in run.ts) and OPENAI_API_KEY (judge; `--judge-model openai:gpt-4o-2024-08-06`).
- Corpus: LongMemEval S and BEAM (downloaded from HF through `beam.ts`, `fetch(m.raw_base + rel)`, line 27).
- Metrics: judge verdicts over repeats (`--judge-runs 10`), McNemar-style paired analysis in `analyze.ts`.
- gbrain imports: `run.ts` imports `cat40/gbrain-arm.ts` (McpClient, MeteringProxy), `lifecycle/drivers.ts` (runCli), `budget-ledger.ts`, `gbrain-under-test.ts` (resolveGbrainUnderTest), `memory-qa/qa-v2.ts` (ChatClient, judgeResponse). No direct importGbrain.
- Coupling: MCP (stdio `gbrain serve --surface starter`, `McpClient` at run.ts:212) and CLI (`runCli`, hook spawns `bun <build>/src/cli.ts hook <event>` in `hooks.ts:16`). `model.ts` calls the provider through `fetch` (line 32).
- Published: `docs/audit/2026-11-09-openai-cache-writes.md` and `docs/audit/2026-11-09-openai-cache-writes/other-runners/` reference this family. No benchmark report by name.

### P5 agent harness (helper: `p5-agent.ts`)
- Not a runner. Shared harness for P5 agent runners (save-notes-dedup, write-then-answer) and P5 judge calls (junk audit, H6 answers). Provides `AgentBrain`, `ToolsArm`, `chatText`, `openPaid`, `Checkpoint`, `flagValue`, `limitFlag`, `seededSample`, `runPool`, `firstJsonObject`.
- gbrain imports: `./cat40/gbrain-arm.ts` (McpClient). Engine via `bun -e` scripts (`execFileSync('bun', ['-e', script])`, lines 128-156). Engine methods: connect, disconnect, executeRaw (lines in e.* calls).
- Coupling: MCP (`new McpClient(this.run, ['--surface', 'full'])`, line 107) and CLI (`bun -e` scripts, `tar`, `rsync`).
- LLM keys: ANTHROPIC and OPENAI (judge `chatText` via fetch, metered).
- Published: referenced by `docs/audit/2026-11-09-openai-cache-writes/other-runners/` only.

### P5 brain (helper: `p5-brain.ts`)
- Not a runner. Shared PGLite plumbing for P5 runners: `put(slug, markdown)` through the `put_page` op, `sweep()` (extractStaleFromDB catch-up), `edges()`, `readPageSnapshot`.
- gbrain imports: `gbrain/operations` (type, line 25); importGbrain `src/core/config.ts` (line 27-ish), `src/core/operations.ts` (put_page, get_links), `src/commands/extract.ts` via `extractStaleFromDB` (line 68). Engine: initSchema, setConfig, getConfig, executeRaw, readPageSnapshot, connect, disconnect. Uses `McpHttpDriver`, `runCli`, `startFakeEmbedder` (lifecycle), and `freePort` (slice).
- Coupling: in-process (plus `lifecycle` helpers for HTTP/CLI in the same runner).
- Used by: q2/g5.ts, q2/c-gates.ts, q2/export.ts, q2/preflight.ts, line-grammar tests.

### P8 quote grounding (`p8-quote-grounding.ts`)
- Measures: whether `gbrain think` (with `think.quote_verify`) keeps supported quotes and flags unsupported ones, judged per span by an independent model.
- Run: `bun eval/runner/p8-quote-grounding.ts --gbrain CKOUT@REF [--questions eval/data/p8-quote-grounding/dev-questions.json]`; `--make-questions --n 50 --seed 1 --out-questions FILE [--model gpt-6.1-sol]`; `--make-questions --corpus amara|sealed-confirmation [--corpus-dir DIR]`; `--heldout-questions FILE` (lines 23-34).
- Cost: paid judge and reader; unknown per run. Dev only.
- LLM keys: ANTHROPIC and OPENAI via `ChatClient` (`memory-qa/qa-v2.ts`).
- Corpus: amara-life-v1 (rendered by `chronicle-lift.ts` `renderCorpus`) and sealed-confirmation haystacks (custodian only).
- Metrics: supported spans wrongly flagged (rate, Wilson 95% upper bound), unsupported spans kept.
- gbrain imports: importGbrain `src/core/import-file.ts` (importFromContent), `src/core/think/...` (runThink, via `importGbrain` line 298), `src/core/ai/...` via resolveGbrainUnderTest. Engine via PGLite with real embeddings.
- Coupling: in-process. The runner captures the exact prompt via runThink's client seam.
- Published: `docs/benchmarks/2026-10-04-p8-dev/` (quote-grounding summaries), `docs/receipts-manifest.json`.

### P8 withdraw retrieval (`p8-withdraw-retrieval.ts`)
- Measures: cosine neighbour retrieval for withdrawal-review families at a 0.80 floor, per slice, using text-embedding-3-large (1536 dims).
- Run: `bun p8-withdraw-retrieval.ts <rows.jsonl>` (file header line 1).
- Cost: paid OpenAI embeddings for each unique text (batches of 256).
- LLM keys: OPENAI_API_KEY (required; `fetch('https://api.openai.com/v1/embeddings')`, line 8).
- Corpus: input rows file (not in repo; produced by the review lane).
- Coupling: none (no gbrain). Calls OpenAI HTTP directly.
- Published: no report by name; registry-linked? Not found.

### P8 write cost (`p8-write-cost.ts`)
- Measures: dollars, latency, calls, and settle time for agent writes with background fact extraction on vs off (floor), per 1,000 messages and pages.
- Run: `bun eval/runner/p8-write-cost.ts --gbrain CKOUT@REF [--sessions 200] [--arms on,off,on:openai:gpt-6-luna]` (line 25).
- Cost: metered; budget ledger (`startPaidRun`, line 34). Time unknown.
- LLM keys: ANTHROPIC and OPENAI through gbrain's extraction (metered proxy).
- Corpus: LongMemEval-S sessions (`loadLmeS`, `renderSessionPage`, `memory-qa/corpus.ts`).
- Metrics: put_page and remember latency p50/p95, generative attempts on commit path (must be 0), dollars by model.
- gbrain imports: none via importGbrain. Imports `cat40/gbrain-arm.ts` (GbrainSlot, McpClient, MeteringProxy), `lifecycle/drivers.ts` (runCli), `lifecycle/builds.ts` (prepareBuild).
- Coupling: MCP (stdio `gbrain serve`, line 105) and CLI (`gbrain jobs work` drain, `runCli`).
- Published: `docs/benchmarks/2026-10-08-facts-extraction-model/PREREGISTRATION.md`, `write-cost/receipt-*.json`; `docs/plans/2026-10-07-10x-memory-advantage/audit/B-benchmark-scale-cost.md`.

---

## Section C: q1 family (Q1 scoreboard, F6, RS1, BG1)

All q1 runners share `budget-ledger.ts`, `paid-arm.ts`, `decisions/errors.ts`, and `memory-qa/*` helpers. Most are paid. Only analysis and custodian tools run without a key.

### Q1 cell runner (`q1/cell.ts`, cell definitions `q1/cells/definitions.ts`, `q1/cells/{q1,f6,rs1,bg1}-cells.json`, `q1/cells/{f6,rs1,bg1}.ts`)
- Measures: scoreboard cells for BEAM-10M and the F6, RS1 and BG1 campaigns (conversation ingest and reader QA per system). Question: how do memory systems rank on BEAM-10M at an 8,000-token reader budget.
- Run: `bun eval/runner/q1/cell.ts plan [--json] [--campaign-out M] [--with-smoke] [--sealed-cap-usd U]`; `show --cell ID`; `run --cell ID [--paid --budget-run-id ID] [--limit N] [--out DIR] [--arms a,b]` (lines 5-11); `merge --cell ID --from DIR... --out DIR` (line 11).
- Cost: estimated per cell; `estimateCell` and ledger; cell prompts for ask_user when over estimate (line 1651). Hours per cell (expected_hours). Ingest finish timeout is 1.5x expected hours (line 251).
- LLM keys: ANTHROPIC and OPENAI (2 each); judge providers in `providers/openai-compatible.ts`.
- Corpus: BEAM-10M (custodian dataset, `eval/decisions/datasets/beam-10m-9b20961.json`; hashes filled by custodian) and LoCoMo and BEAM-1M dev (`decisions/splits`); also D8 (`q1/d8-manifest.ts`). Sealed conversations never leave custody.
- Metrics: pass rate per instrument (`memory-qa/instruments.ts`, PASS_THRESHOLD), clustered paired deltas (`stats/paired.ts`), outcomes (`memory-qa/outcomes.ts`).
- gbrain imports: none via importGbrain in the cell runner. It uses `systems/gbrain-agent.ts` (imported via cell.ts line 100) which calls `importGbrain` (line 121) and runs gbrain in process (its header says "In process rather than a gbrain serve subprocess", systems/gbrain-agent.ts:13). Also `systems/http.ts` (HttpMemorySystem, a shim over HTTP), `cat40/pg-arm.ts`, `metering-proxy.ts` (MeteringProxy, ProxyControl), `shootout-cell.ts`.
- Coupling: mixed. HTTP to a memory system shim and provider proxy (`fetch` to `${proxy}/__proxy/status`, line 1625); in-process for gbrain-agent; MCP-equivalent only through `systems/mcp-tools.ts`.
- Published: `docs/benchmarks/2026-10-06-scoreboard-preregistration.md`, `docs/findings/2026-11-04-particle-1-f6-addon.md`, `docs/comparison-systems.md`; registry and CHANGELOG cite q1. 66 references across docs.
- Parity-gate fit: not for the parity gate. Paid, long, sealed.

### Q1 calibration cell and calibrate (`q1/calibration-cell.ts`, `q1/calibrate.ts`)
- Measures: per-reader tokenizer calibration from dev smoke packs, measured against provider-reported input tokens.
- Run: `bun eval/runner/q1/calibrate.ts <cell output dir>... [--json] [--pre-normalizer]`; `bun eval/runner/q1/calibration-cell.ts --reader particle:particle-1 --out DIR --budget-ledger F --run-id ID --lease-usd N [--cell s3-smoke.baseline-hybrid.baseline]` (lines 5-6).
- Cost: calibration-cell is paid (`paid` 2 refs); calibrate.ts is $0.
- LLM keys: provider via `--keyless-upstream` option; reader keys as required.
- Corpus: LoCoMo dev smoke cell (`runs/<cell>/contexts.ndjson`).
- Coupling: in-process imports of `systems/render-v2.ts` (encodingCount, measureCalibration, readerTokenizer). Calls providers through the lease proxy in process.
- Published: `docs/findings/2026-11-04-particle-1-f6-addon.md` (cites particle add-on); the calibration cell is dev data only.

### Q1 stress pilot (`q1/stress-pilot.ts`)
- Measures: ingest wall time per 1,000 messages, serve memory (RSS), brain size on disk as the brain grows, quiesce barrier wait, serve restart. BEAM-1M dev conversations written into one gbrain-defaults namespace.
- Run: `bun eval/runner/q1/stress-pilot.ts --system http://127.0.0.1:8700 --provider-proxy http://127.0.0.1:8787 ...`; setup `bash eval/systems/bootstrap.sh up --system gbrain-defaults` (lines 24-29).
- Cost: paid (5 refs) via provider proxy; long (about 11M tokens).
- LLM keys: via provider proxy.
- Corpus: BEAM-1M dev (`eval/decisions/splits/beam-1m.json`), dev only.
- Coupling: HTTP. `fetch` to the shim (`systems/http.ts` HttpMemorySystem), line 213. No in-process gbrain.
- Published: no report found by name. Q1 scoreboard family (see above).

### Q1 reread cell (`q1/reread-cell.ts`)
- Measures: re-reads each frozen context of a source cell with another reader (particle-1 add-on, GBEV-31 / GST-1153; RS1 re-reads); no retrieval or packing again.
- Run: `bun eval/runner/q1/reread-cell.ts --cell <source cell id> --arm <arm id> --source <out>/runs/<cell id>... --reader particle:particle-1` (line 7).
- Cost: paid (3 refs); budget ledger 14 refs.
- LLM keys: ANTHROPIC and OPENAI (new reader).
- Corpus: frozen contexts from the source cell (`contexts.ndjson`).
- Coupling: none for gbrain (imports memory-qa and metering-proxy).
- Published: `docs/findings/2026-11-04-particle-1-f6-addon.md`.

### Q1 second judge (`q1/second-judge.ts`)
- Measures: A6 sensitivity; where particle-1 minus Opus is above 0, gpt-6.1-sol judges both readers' answers on that cell again with the same instrument (`<instrument>@openai:gpt-6.1-sol`).
- Run: `bun eval/runner/q1/second-judge.ts --cell <id> --arm <id> [--manifest q1|f6] --root <cell output>... --out DIR`; `summary --out DIR...` (lines 8-11).
- Cost: paid (2 refs).
- LLM keys: OPENAI (judge) and ANTHROPIC (readers).
- Coupling: none for gbrain.
- Published: `docs/benchmarks/` A6 and GBEV-35 reports (cited in header; path not verified by name).

### Q1 rejudge systems and rule (`q1/rejudge-systems.ts`, `q1/rejudge-rule.ts`)
- Measures: GST-1365 judge robustness; each published system answer is re-judged by a frontier judge from a family that does not grade its own readers; a third family referees disagreements; known-answer controls from BEAM gold.
- Run: `bun eval/runner/q1/rejudge-systems.ts plan <roots> --out DIR [--rates-from DIR]`; `cut`, `judge --stratum A|B|C|D`, `reuse-check --judge P:M`, `referee`, `controls`, `summary` (lines 7-13).
- Cost: paid, leased (23 budget refs). Time unknown.
- LLM keys: ANTHROPIC, OPENAI, and provider families (`providers/openai-compatible.ts`, `JUDGE_PROVIDERS`).
- Corpus: published cells (`answers.ndjson`, `judgments.ndjson`).
- Published: `docs/benchmarks/2026-11-04-gst-1365-judge-robustness-preregistration.md` (cited in header).

### Q1 publish (`q1/publish.ts`)
- Measures: assembles the Q1 scoreboard receipt from campaign state (no model calls).
- Run: `bun eval/runner/q1/publish.ts --config docs/benchmarks/2026-10-06-scoreboard/publication.json --results DIR --out DIR [--trees DIR] [--custody] [--frontier-redo J]` (lines 6-7).
- Cost: $0. LLM keys: none.
- Coupling: CLI (`execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'add', ...])`, line 145; `spawnSync(process.execPath, ['eval/runner/q1/cell.ts', 'merge', ...])`, line 192).
- Published: the receipt it writes is consumed by `eval/runner/scoreboard.ts render`.

### Q1 particle add-on report (`q1/particle-addon-report.ts`)
- Measures: particle-1 beside claude-opus-5-5 and other readers on the same questions, in aggregates only.
- Run: `bun eval/runner/q1/particle-addon-report.ts --root <cell output> [--root ...] --out DIR` (line 5).
- Cost: $0. LLM keys: none (reads published cells).
- Imports: `cat40/loop.ts` (priceUsage), `memory-qa/instruments.ts`, `memory-qa/outcomes.ts`, `memory-qa/records.ts`, `stats/paired.ts`.
- Coupling: none for gbrain.
- Published: `docs/findings/2026-11-04-particle-1-f6-addon.md`.

### Q1 power (`q1/power.ts`)
- Measures: smallest true difference Family 1 detects with 80% power, with BEAM-10M's ten conversations, about 20 questions each, and a Holm family of nine comparisons.
- Run: `bun eval/runner/q1/power.ts` (header lines 1-15).
- Cost: $0, simulation. LLM keys: none. Coupling: none (imports `stats/paired.ts`, `stats/wild-cluster.ts`).
- Published: `docs/benchmarks/2026-10-06-scoreboard-preregistration.md` cites the power plan.

### Q1 custodian and dataset tools (`q1/beam10m-manifest.ts`, `q1/beam10m_extract.py`, `q1/beam10m-structure.ts`, `q1/d8-manifest.ts`)
- Measures: BEAM-10M manifest fill (hashes), parquet split to per-conversation chat and questions files, structure counts (never text, never questions), D8 manifest fill.
- Run: `bun eval/runner/q1/beam10m-manifest.ts status [--json]` ($0); `fetch [--root DIR] [--write]` (custodian; `GBRAIN_EVALS_CUSTODY_LOG`); `uv run --no-project --python 3.12 --with pyarrow==21.0.0 python eval/runner/q1/beam10m_extract.py --out <root>/beam-10m/9b20961 <shards>` (custodian); `q1/d8-manifest.ts status|fill --write` (custodian; `GBRAIN_EVALS_D8_SOURCE`).
- Cost: $0. LLM keys: none.
- Corpus: BEAM-10M from Hugging Face (`fetch` to `https://huggingface.co/api/datasets/<repo>/tree/<rev>/data`, line 44; `fetch(url)`, line 51), downloaded not committed.
- Coupling: none for gbrain. CLI (`Bun.spawnSync` for the python extract).
- Published: `eval/decisions/datasets/beam-10m-9b20961.json` (hashes null until custodian run).

### Q1 operations: lease, reattach, persist (`q1/raise-lease.ts`, `q1/reattach.ts`, `q1/persist.sh`)
- Measures: not a measurement. Raise a running lease in place, reattach VMs after host loss, copy public campaign state to the results branch.
- Run: `bun eval/runner/q1/raise-lease.ts raise|show|settle|clear-stale-lock --campaign M --state DIR --lease ID [--usd N --reason "..."]`; `bun eval/runner/q1/reattach.ts --campaign M --state DIR [--once] [--interval-min 10] [--hours 5.8]`; `eval/runner/q1/persist.sh <state dir> <campaign id> [minutes] [hours]` (refuses sealed campaigns).
- Cost: spends via leases (17 budget refs in raise-lease).
- Coupling: CLI (`Bun.spawnSync(['bash', runner, 'ssh', vm, command])`, `ubi-runner.sh`, `pgrep`). No gbrain.
- Published: `docs/benchmarks/` lease plans (not verified).

### Q1 reuse check and golden fixture (`q1/reuse-check.ts`, `q1/golden-fixture.ts`)
- Measures: whether F6 can reuse a competitor or baseline row from campaign A24 at a given commit; golden fixture digest and measurement identity of a tree.
- Run: `bun eval/runner/q1/reuse-check.ts --prior <commit> --planned <commit> --systems a,b,... --preregistration FILE --a24-source ID [--json]`; `bun eval/runner/q1/golden-fixture.ts <root>` (lines 5, 102).
- Cost: $0. LLM keys: none.
- Coupling: CLI (`execFileSync('git', ...)`, `spawnSync(process.execPath, [golden-fixture.ts, dir])`). Golden fixture imports the tree's own modules from the checkout (not from gbrain's `src/`).
- Published: `docs/benchmarks/2026-10-06-scoreboard-preregistration.md`.

### Q1 helpers (`q1/hedge.ts`, `q1/usage.ts`, `q1/secret-scan.ts`, `q1/scoreboard-errors.ts`)
- hedge.ts: deterministic lexical classifiers (abstain, hedged, confident). `classify`, `sample`, `validate` subcommands. $0, no model calls.
- usage.ts: maps provider usage to buckets (anthropic uncached input plus cache buckets; openai cached included). Imported by `p4-stream/model.ts`.
- secret-scan.ts: scans output dirs for secrets; `bun eval/runner/q1/secret-scan.ts <dir>... [--json]`.
- scoreboard-errors.ts: error codes and operator messages for the decide and scoreboard CLIs.
- All $0, keyless, no gbrain imports (except none).

## Section D: q2 family (Q2 parser gaps, G-gates)

### Q2 campaign and preflight (`q2/campaign.ts`, `q2/preflight.ts`, `q2/checkpoints.ts`, `q2/export.ts`)
- Measures: not a measurement. Campaign manifest and ledger (`docs/benchmarks/2026-10-06-q2-parser-gaps-campaign.json`), preflight (dependencies, prices, builds, permissions), resume checkpoints, allowlisted aggregate export.
- Run: `bun eval/runner/q2/campaign.ts status|preflight|not-run|record --campaign ROOT [--step ID --run NAME --receipt F --spend-usd N]` (lines 11-15); `bun eval/runner/q2/export.ts --campaign ROOT --step export --run aggregate --out F` (line 7).
- Cost: $0 except paid steps recorded via the ledger.
- LLM keys: preflight checks ANTHROPIC and OPENAI keys (2 refs each in preflight.ts).
- Coupling: preflight imports `gbrain-under-test.ts` (`parseGbrainSpec`, `resolveGbrainUnderTest`), `p5-brain.ts` (`p5Receipt`), `cat40/loop.ts` (provider), and runs `git rev-parse` on the checkout (line 61). CLI for `command -v bin` checks (`execFileSync('sh', ...)`). Checks `node_modules/gbrain/package.json` (line 52) to confirm the pinned package is installed.
- Published: `docs/benchmarks/2026-10-06-q2-parser-gaps-runbook.md`, `docs/benchmarks/2026-10-06-q2-parser-gaps-preregistration.md`, `docs/audit/2026-11-04-superiority-p.md`.

### Q2 junk audit and set helpers (`q2/junk-audit.ts`, `q2/n-corpus.ts`, `q2/k-conformance.ts`, `q2/junk-classes.ts`, `q2/grammar-lines.ts`)
- Measures: G1 (natural junk), G3 (conformance), G4 (guard loss) and G2 (relation-line precision in arm B ingest brains), on sets N and K. Zero-tolerance junk classes: timecode, task marker, citation, and two more (`junk-classes.ts`).
- Run: custodian run via `q2/junk-audit.ts` with `--paid` and a budget; flags via `p5-agent.ts` (`limitFlag`, `openPaid`, `closePaid`).
- Cost: paid (1 paid flag; budget 3 refs). Time unknown.
- LLM keys: ANTHROPIC and OPENAI via judges.
- Corpus: set N from BEAM-1M sealed conversations (`n-corpus.ts`; custody root), set K from `k-conformance.ts` (committed grammar pages with decoys, custody format `k-pages.jsonl`).
- gbrain imports: `junk-audit.ts` imports `gbrain-under-test.ts` (`importGbrain`, `resolveGbrainUnderTest`, `gbrainSpecFrom`), `p5-brain.ts` (`openP5Brain`, `p5Receipt`), `line-grammar-junk-audit.ts` (`mintDocs`), and `import`s `src/core/line-grammar.ts` through importGbrain (line-grammar-junk-audit.ts). Engine via `p5-brain.ts`. `junk-classes.ts` imports `itemClass`, `listLines` from `line-grammar-junk-audit.ts`. `grammar-lines.ts` calls `extractGrammarLines` on finished arm-B brains with the build's own parser.
- Coupling: in-process.
- Published: `docs/benchmarks/2026-10-06-q2-parser-gaps-preregistration.md` and runbook.

### Q2 G5 (`q2/g5.ts`)
- Measures: carry-over of P5 H1 and H2: world-v1 anyTypeMatch noninferiority at 0.01 (two-sided 95% lower bound), and the variants gate.
- Run: `bun eval/runner/q2/g5.ts --world-baseline <receipt> --world-candidate <receipt> --variants <receipt> --output DIR` (line 10).
- Cost: $0 (receipts in). LLM keys: none.
- gbrain imports: `gbrain-under-test.ts` and `p5-brain.ts` (`p5Receipt`); no direct engine.
- Coupling: in-process (only for receipt identity).
- Published: `docs/benchmarks/2026-10-06-q2-parser-gaps-preregistration.md`.

### Q2 C-gates and transitions (`q2/c-gates.ts`, `q2/transitions.ts`)
- Measures: transition identity (subject, target, type, kind, date) and C-gate decisions (I1/W1 with oriented primary metric).
- Run: `bun eval/runner/q2/c-gates.ts select|...` (see header).
- Cost: $0 (receipts and link_transitions). LLM keys: none.
- gbrain imports: `gbrain-under-test.ts`, `p5-brain.ts` (`p5Receipt`), `stats/paired.ts`, `stats/fixed-sequence.ts`. Transitions read gbrain's `link_transitions` rows.
- Coupling: in-process.

### Q2 judges (`q2/judge.ts`, `q2/wta-judge.ts`)
- Measures: Q2 line labels (G1, G2, G4, adoption recall; judge prompt `q2-judge-v1`, two judges, disagreement counts as wrong) and answer judging (rubric `q2-wta-judge-v1`, answerable and unanswerable scored separately).
- Run: helper; called from junk-audit and write-then-answer.
- Cost: paid. LLM keys: ANTHROPIC and OPENAI through `p5-agent.ts` `chatText`.
- Coupling: none for gbrain.

### Q2 stats and simulations (`q2/power-sim.ts`, `q2/crossed-bootstrap.ts`, `q2/stats.ts`, `q2/q-set.ts`)
- power-sim: G6 power simulation from development receipts. `bun eval/runner/q2/power-sim.ts --receipts a.json,b.json --pairs 100|amara=106,career=200 --ingests 3 --sims 200 [--effects 0,3,5] [--seed 20261006]`.
- crossed-bootstrap: crossed bootstrap over question pairs and ingest brains.
- stats: Wilson intervals, per-100,000 junk bound, cluster bootstrap.
- q-set: custodian question file (`q-questions.json`) and career-chronicle corpus.
- All $0. LLM keys: none. Coupling: none for gbrain (imports `p5-agent.ts` flagValue and `write-then-answer.ts` helpers for power-sim, `stats/paired.ts`).

## Section E: t0 family (program primary)

### T0 program primary (`t0-program-primary.ts`, helpers `t0/delivery.ts`, `t0/score.ts`, `t0/analyze.ts`, generator `generators/program-primary-gen.ts`)
- Measures: one binary end-to-end failure per task run: unsupported or stale statements in session-2 deliverables after a correction on cross-session meeting or reply preparation. Preregistered in `docs/benchmarks/2026-10-08-program-primary-preregistration.md`.
- Run: `bun eval/runner/t0-program-primary.ts --gbrain CKOUT@REF --output DIR [--seeds a,b] [--tasks id,...]` (line 45). Hermetic (scripted oracle, $0) by default; paid cells need `--paid` and a budget run (lines 40-42).
- Cost: paid readers via `budget-ledger.ts` (`startPaidRun`, 15 budget refs). Per-cell `usd` split reader vs gbrain internal (line 340-349). Time unknown.
- LLM keys: ANTHROPIC (reader, paid only).
- Corpus: generated PP world (`generators/program-primary-gen.ts`, `generateWorld`, `renderPPDoc`, `PP_DEV_SEEDS`, `PP_SESSION2_DAY`). Not downloaded.
- Metrics: failure per cell; mutants at $0 (line 40); analysis via `t0/analyze.ts` (`clusteredRate`, `riskDifference`) and `t0/paired.ts`.
- gbrain imports: `t0-program-primary.ts` imports `cat40/gbrain-arm.ts` (`GbrainSlot`, `MeteringProxy`, `rerankProbe`), `cat40/loop.ts` (`runAgent`, `provider`), `lifecycle/builds.ts` (`prepareBuild`). `t0/delivery.ts` runs `bun <buildDir>/src/cli.ts hook <event>` (spawn, line 76). `GbrainSlot` starts `gbrain serve --surface starter`. Engine ops are MCP tool calls.
- Coupling: MCP (stdio, via `GbrainSlot`) and CLI hook spawn. `execFileSync('git', ['rev-parse', 'HEAD'])` (line 357).
- Published: `docs/benchmarks/2026-10-08-program-primary/` (baseline receipt, cost JSON, experiment.json), `docs/benchmarks/2026-10-08-program-primary-preregistration.md`.
- Parity-gate fit: MCP-based. Mutants and scripted oracle make the keyless path a plausible parity check for the Rust binary.

### T0b program primary, hard (`t0b-program-primary.ts`, generator `generators/program-primary-hard-gen.ts`)
- Measures: the harder workload (hard world with knobs, custodian personas) on the T0 carrier; three brains per persona built from the same world.
- Run: see header (lines 1-30). Hermetic default (scripted oracle reader on keyless brains, $0); paid with budget run.
- Cost: paid (2 refs), budget 13 refs. Time unknown.
- LLM keys: ANTHROPIC (paid).
- Corpus: generated hard world (`DEFAULT_KNOBS`, `PPH_BASELINE_SEEDS`, `PPH_DEV_SEEDS`, `PPH_RUNNABLE_SEEDS`, `PPH_SESSION2_DAY`, `PPH_TODAY`, `renderHardDoc`).
- gbrain imports: imports `t0-program-primary.ts` runSessionWith (same MCP slot), `t0/delivery.ts` (hook spawn), `t0/score.ts`, `cat40/gbrain-arm.ts`. importGbrain: none (direct generator import). Calls `execFileSync('git', ['rev-parse', 'HEAD'])` (line 274).
- Coupling: MCP plus CLI hook spawn (same as T0).
- Published: `docs/benchmarks/2026-10-08-program-primary-hard-preregistration.md`, `-hard-baseline.md`, `-hard-root-cause.md`, `2026-10-11-t0b-sealed-confirmation.md`.

### T0 parity (`t0/parity.ts`)
- Measures: native harness parity slice. Same tasks as the injected-context carrier, run through a real Claude Code process (the version Cat 41 pins) with gbrain's SessionStart and UserPromptSubmit hooks and gbrain's stdio MCP server configured.
- Run: `bun eval/runner/t0/parity.ts --gbrain CKOUT@REF --output DIR --tasks id,... [--model claude-sonnet-5-5]` (line 22).
- Cost: paid, budget (6 refs). Real `claude` CLI run.
- LLM keys: ANTHROPIC (through the Claude Code process).
- Corpus: generated PP world (`generators/program-primary-gen.ts`).
- Coupling: CLI (`spawn('claude', argv, ...)` line 63; `mcpServers: { gbrain: { command: 'bun', args: [build/src/cli.ts, 'serve', '--surface', 'starter'] } }`, line 125). The hook events are also spawned via `t0/delivery.ts`.
- Published: `docs/benchmarks/2026-10-13-cat41-setup-run4-preregistration.md` and `2026-10-14-cat41-setup-run5-preregistration.md` (cat41 setup runs); no direct parity report by name.

### T0 brief (`t0/brief.ts`)
- Measures: proactive brief on (`context.proactive_brief=true` after restore) vs off, on the T0 carrier. Wave 5 D6.
- Run: helper for the T0 family; invoked via `t0-program-primary` configuration (no standalone usage line found).
- Cost: paid via T0 (budget). LLM keys: ANTHROPIC.
- gbrain imports: generator only (`generatePersona`, `PP_BRIEF_V2_DEV_SEEDS`, `ratioInterval`, `riskDifference`). Config set via `DB config` (MCP/CLI).
- Coupling: MCP through the T0 slot.
- Published: `docs/benchmarks/2026-10-08-program-primary/` (brief arms, receipts) not verified by name.

### T0 paired and analyze (`t0/paired.ts`, `t0/analyze.ts`)
- Measures: candidate vs baseline paired risk ratio per reader, then pooled (`power/risk-ratio.ts` `decide`, conditional binomial, 95%, loss tolerance 3.0 points, persona clusters). analyze.ts: failure counts per arm and reader with clustered intervals, resource envelope.
- Run: `bun eval/runner/t0/paired.ts --baseline <results.jsonl[.gz]> --candidate <results.jsonl[.gz]> [--repeats 1,2] [--out paired.json]` (line 6).
- Cost: $0. LLM keys: none. Coupling: none (imports `power/risk-ratio.ts`, `t0-program-primary.ts` `COUNTED_READERS` and `CellRecord` types only).

## Section F: One-off and research runners

These are one-off or exploratory unless the notes say otherwise. "Published" uses the rule in the intro.

### A4 abstention (`a4-abstention.ts`)
- Measures: whether gbrain's CRAG grade is calibrated to evidence, and whether it abstains; two separate questions. Also S4-on receipt.
- Run: `bun eval/runner/a4-abstention.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF]`; paid via `startPaidRun` (line 438, `estimateUsd: 0.5`); `--paid --budget-usd N` (3 paid refs).
- Cost: `PAID_ESTIMATE_USD = 4` (line 63).
- LLM keys: ANTHROPIC (5 refs).
- Corpus: generated (LongMemEval-style answer rows).
- gbrain imports: importGbrain (13 calls) for `src/core/search/...`, `src/core/crag...` grade modules, operations. Coupling: in-process.
- Published: `docs/benchmarks/2026-10-01-a4-abstention.md`, `docs/benchmarks/2026-10-06-a4-s4-on.md`, `docs/plans/2026-10-08-gbrain-budgeted-delivery/PLAN.md`. Not one-off.

### A4 S4 rescore (`a4-s4-rescore.ts`)
- Keyless $0 re-score of an A4 S4-on receipt. `bun eval/runner/a4-s4-rescore.ts docs/benchmarks/2026-10-06-a4-s4-on/receipt.json` (file header). No gbrain import. Published: `docs/benchmarks/2026-10-06-a4-s4-on.md`.

### Agent retrieval shapes (`agent-retrieval-shapes.ts`, registry id `agent-retrieval-shapes`, alias ARS)
- Measures: whether gbrain returns the page the agent needed for 15 families (E1 to E15) of retrieval shapes reported on a large multi-source production brain.
- Run: `bun eval/runner/agent-retrieval-shapes.ts [--seed N] [--output DIR] [--gbrain CKOUT@REF] [--families ...]` (line 36).
- Cost: $0, keyless; time unknown. LLM keys: none.
- Corpus: generated.
- gbrain imports: `gbrain/config` (type), `gbrain/operations` (type, line 42), `gbrain/pglite-engine` (type, line 43); importGbrain `src/core/pglite-engine.ts`, `src/core/operations.ts` (sources_add, search, run_doctor, put_page, get_page, get_chunks), `src/core/import-file.ts`. Engine: initSchema, connect, disconnect, executeRaw. Dynamic `import('gbrain/operations')` at 325.
- Coupling: in-process.
- Published: `docs/benchmarks/2026-10-20-agent-retrieval-shapes.md` (and receipt.json).

### Attendance world score (`attendance-world-score.ts`)
- Scores W3 attendance (N9 one-hop "Who attended ...?" rows and composed families) against attendee lists on meeting pages, not against gbrain output.
- Run: `bun eval/runner/attendance-world-score.ts --receipt <n9 receipt.json> --corpus <dir> [--json]` (line 7).
- Cost: $0. Keys: none. Coupling: none (reads receipts and corpus files).
- Published: `docs/benchmarks/2026-10-06-attendance-world.md`; `docs/plans/2026-10-15-lhf-wave-2/` cites it.

### Attendee role planner (`attendee-role-planner.ts`)
- Measures: attendee-role questions on a world-v1-shaped corpus; W3 of the 2026-10 round (development phrasing).
- Run: `bun eval/runner/attendee-role-planner.ts [--corpus eval/data/world-v1-attendees] [--output DIR] [--gbrain CKOUT@REF] [--attest PREREG]` (line 19).
- Cost: $0, keyword search only (`embed: 'keyword'`, line 103). Keys: none.
- gbrain imports: via `relational-ab.ts` (`loadRelationalProduct`, `runSharedIndexPairs`), plus `generators/constrained-relational-gen.ts` (PHRASING_A). importGbrain (3 calls).
- Coupling: in-process.
- Published: `docs/benchmarks/2026-10-06-attendance-world.md`, `docs/benchmarks/2026-10-06-attendance-world-preregistration.md`.

### Belief weekly probes (`belief-weekly-probes.ts`)
- Measures: W11, sealed confirmation of gbrain's W4 weekly cited belief diff (`delta {beliefs: true}`, `gbrain beliefs changes`). Runs gbrain's own W4 acceptance probe on the build under test.
- Run: `bun eval/runner/belief-weekly-probes.ts --gbrain CKOUT@REF [--seeds 20261016] --output DIR` (line 21).
- Cost: $0 keyless dev; time unknown. Keys: none.
- Corpus: generated (`generators/belief-weekly-gen.ts`, fresh seed and phrasing per run).
- gbrain imports: importGbrain `test/helpers/belief-ledger.ts`, `src/core/search/token-budget.ts`, `src/core/operations.ts`, `src/core/belief/changes.ts`. Also `execFileSync('git', ['rev-parse', 'HEAD'])` (line 142).
- Coupling: in-process.
- Published: `docs/benchmarks/2026-10-17-w11-w4-sealed-confirmation-preregistration.md`, `docs/benchmarks/2026-10-05-heldout-verdicts/w11-w4-heldout-2026-10-17.json`.

### Chronicle lift (`chronicle-lift.ts`)
- Measures: auto_chronicle OFF vs ON lift (preregistered).
- Run: `bun eval/runner/chronicle-lift.ts corpus --out DIR` ($0 vault render); `run --out DIR --budget-usd N [--arms off,on-a,on-b] [--repeats 2]`; `score --out DIR [--review R] [--model ID]` (lines 15-24).
- Cost: metered; `--budget-usd` required for run. Time unknown.
- LLM keys: ANTHROPIC (2 refs; judge is the gbrain default chat model with ANTHROPIC_API_KEY only, line 396).
- Corpus: generated amara-life-v1 vault (committed generator); also used by p8-quote-grounding.
- gbrain imports: none via importGbrain. Runs gbrain as a CLI: `spawnSync('bun', [GBRAIN/src/cli.ts, ...args])` (line 195) and `Bun.spawn` (line 200). MCP via `new McpClient({ buildDir: GBRAIN, env }, [])` (line 271). Uses `bun -e` script (line 255).
- Coupling: CLI and MCP.
- Published: `docs/benchmarks/2026-10-04-auto-chronicle-lift.md` and `-rerun.md`; `docs/settings.md`.

### Coding spike (`coding-spike.ts`, helper `eval/harness-provider/coding-spike/spike.py`)
- Measures: coding-agent memory spike on the SDE coding benchmark (regression fix, pytest graded in second container). Few tasks with no memory and with gbrain retrieval injected.
- Run: `bun eval/runner/coding-spike.ts --tasks boltons-discount-001 --arms none,gbrain`; keyless plumbing check: `--stub-upstream` (file header).
- Cost: paid through Docker and the provider. Budget (10 refs). Time unknown.
- LLM keys: ANTHROPIC/OPENAI via opencode in Docker.
- Corpus: sdebench (external, Docker image built locally; `docker image inspect/rm`, lines 115, 195).
- gbrain: retrieval injected by the runner; no importGbrain. Coupling: CLI (`Bun.spawnSync(docker ...)`, `Bun.spawn([install.python, spike.py ...])`).
- Published: `docs/benchmarks/2026-10-05-memory-proof-wave-dev/coding-spike.md`.

### Constrained relational (`constrained-relational.ts`)
- Measures: constrained relational retrieval (P3 E4). Seeded worlds indexed with extraction and real embeddings; each question through gbrain's hybrid search. Pins via `GBRAIN_EVAL_SEARCH_PINS`.
- Run: `bun eval/runner/constrained-relational.ts [--seeds 11,13] [--gbrain CKOUT@SHA] [--output DIR] --paid --budget-usd 1` (dev).
- Cost: paid (budget 4 refs). LLM keys: OPENAI (embeddings).
- gbrain imports: importGbrain `src/core/search/hybrid.ts`, `src/core/ai/gateway.ts`; also `importGbrain` on `src/core/...` for extraction. Coupling: in-process.
- Published: `docs/benchmarks/2026-10-11-wave14-repin/...offline-tier-summary.md` and `docs/decisions.md` cite it.

### Parse relational questions (`parse-relational-questions.ts`)
- Measures: which relation gbrain's parser picks for each question in Query-shaped JSONL files (read from a gbrain checkout, not an output of the parser run).
- Run: `bun eval/runner/parse-relational-questions.ts <gbrain-checkout> <questions.jsonl>... > relations.json` (file header line 1-6).
- Cost: $0. Keys: none. Coupling: in-process (reads the checkout's parser module; no spawn). Imports from `gbrain-under-test.ts`? No. It reads the module through a path argument.
- Published: `CHANGELOG.md` and `docs/benchmarks/2026-10-16-lhf-wave-2-attendance-preregistration.md` mention it. One-off helper.

### Relation line variants (`relation-line-variants.ts`, generator `generators/relation-line-variants-gen.ts`)
- Measures: P5 H2. Do typed relation lines reach the graph, and do near-miss lines stay out?
- Run: `bun eval/runner/relation-line-variants.ts [--seeds 1,2,3] [--phrasing A] [--keep-prose] [--type-rows] [--output DIR] [--gbrain CKOUT[@ref]] [--json]` (line 33).
- Cost: $0. Keys: none. Corpus: world-v1 generated variant of person pages.
- gbrain imports: importGbrain `src/core/...` for put_page and `extractStaleFromDB` (via `p5-brain.ts`); `forward-reference-heal` imports `linksTo` from the generator. Coupling: in-process.
- Published: `docs/benchmarks/2026-10-11-wave14-repin/...offline-tier-summary.md`; `eval/registry.ts` cites it.

### Relational A/B (`relational-ab.ts`, helper for N9, hub-world-arms, attendee-role-planner)
- Measures: production relational retrieval OFF vs ON on the same extracted index, with one shared query embedding and a five-chunk output window.
- Run: `bun eval/runner/relational-ab.ts --budget-usd 1` (live; `RELATIONAL_AB_ESTIMATE_USD = 0.07`, line 493); keyless plumbing: `bun eval/runner/relational-ab.ts --stub-embed --limit 8 --seeds 1` (lines 29-30).
- Cost: live $0.07 estimate; budget $1 cap in example. LLM keys: OPENAI (6 refs; `embedQuery`, `configureGateway` with `RELATIONAL_EMBEDDER`).
- Corpus: generated relational paraphrase (`generators/relational-paraphrase-gen.ts`), `PARAPHRASE_PATH`.
- gbrain imports: pkg `gbrain/pglite-engine` (type, line 36), `gbrain/search/hybrid` (hybridSearch, line 37), `gbrain/types` (type, line 38), `gbrain/embedding` (embedQuery, line 39), `gbrain/ai/gateway` (configureGateway, getEmbeddingModel, getEmbeddingDimensions, `__setEmbedTransportForTests`, diagnoseEmbedding, line 40). importGbrain: `src/core/search/hybrid.ts`, `src/core/embedding.ts`. Engine: getConfig.
- Coupling: in-process. Note `__setEmbedTransportForTests` is a test seam on the gateway.
- Published: `docs/benchmarks/2026-09-29-relational-paraphrase.md`, `2026-09-29-repin-cats-1-2-6.md`.

### Evidence auto v2 (`evidence-auto-v2.ts`, helpers `evidence-delivery/e1.ts`)
- Measures: whether gbrain's default `auto` evidence delivery at the product budget keeps whole-page gains on conversation questions. LongMemEval-S is a sanity check; the decision uses the sealed E2 confirmation set.
- Run: `bun eval/runner/evidence-auto-v2.ts <command> ...` (usage line 375); the file has a cost plan (lines 78-83: freeze LongMemEval-S, sanity and sealed E2).
- Cost: planned in-file estimates (e.g. freeze 500 LongMemEval questions). Totals computed at run time; not fixed here. Budget (30 refs).
- LLM keys: ANTHROPIC (Sonnet readers and judges); OPENAI (embeddings for freeze).
- Corpus: LongMemEval-S (downloaded) and sealed E2 haystacks (custodian).
- gbrain imports: importGbrain `src/core/import-file.ts` (importFromContent, line 338); `evidence-delivery/e1.ts` (in-repo runner helper).
- Coupling: in-process.
- Published: `docs/benchmarks/2026-09-30-evidence-auto-v2.md`; `docs/benchmarks/2026-09-30-evidence-auto-v2/scripts/pipeline-lme.sh`; `docs/budget-ledger.md` cites it.

### Feedback replay LoCoMo (`feedback-replay-locomo.ts`)
- Measures: use-attributed retrieval feedback replay (plan E1 shape) on LoCoMo; dev reads devConversations; held-out run reads sealed (`--split sealed`).
- Run: `bun eval/runner/feedback-replay-locomo.ts --gbrain CKOUT@SHA --output DIR [--lambdas 0.1,0.2,0.3] [--paid --budget-usd N]` (line 14).
- Cost: paid (1 paid ref), budget (4 refs). LLM keys: ANTHROPIC.
- gbrain imports: importGbrain `src/core/search/hybrid.ts`, `src/core/pglite-engine.ts`, `src/core/import-file.ts` (importFromContent), `src/core/feedback/settings.ts`, `src/core/feedback/record.ts`, `src/core/feedback/rate.ts`, `src/core/ai/gateway.ts` (8 calls). Coupling: in-process.
- Published: `docs/decisions.md` cites it. No dedicated report found by name. One-off dev replay.

### Feedback replay world (`feedback-replay-world.ts`)
- Measures: P3 dev-only replay of use-attributed retrieval feedback on BrainBench world-v1 (relational template and paraphrase questions, gold from world-v1 facts); same arms as `p3-feedback-replay-dev.ts` (not in this repo tree; cited in header).
- Run: `bun eval/runner/feedback-replay-world.ts --gbrain CKOUT@SHA --output DIR [--lambdas ...] [--positive-only] --paid --budget-usd N` (line 7).
- Cost: paid. LLM keys: ANTHROPIC.
- Corpus: world-v1 (`eval/data/world-v1`), templates via `generators/relational-paraphrase-gen.ts` (`templateOfText`).
- gbrain imports: importGbrain `src/core/search/hybrid.ts`, `src/core/feedback/settings.ts`, `src/core/feedback/record.ts`, `src/core/feedback/rate.ts`, `src/core/ai/gateway.ts`. Coupling: in-process.
- Published: `docs/decisions.md` cites it. One-off dev.

### Feedback think replay (`feedback-think-replay.ts`)
- Measures: P3 E2: use-attributed feedback from the implicit citation signal only, through gbrain's `think` operation with a trusted local context (so each answer is recorded and its cited pages feed ranking).
- Run: `bun eval/runner/feedback-think-replay.ts --gbrain CKOUT@SHA --output DIR --paid --budget-usd N` (line 4 of header).
- Cost: paid. LLM keys: ANTHROPIC.
- gbrain imports: importGbrain `src/core/pglite-engine.ts`, `src/core/operations.ts` (think), `src/core/import-file.ts`, `src/core/feedback/settings.ts`, `src/core/feedback/record.ts`, `src/core/ai/gateway.ts`. Coupling: in-process.
- Published: `docs/decisions.md`; `CHANGELOG.md` cites it. One-off dev.

### Forward reference heal (`forward-reference-heal.ts`)
- Measures: P5 H4: do links written before their target page exists heal once the page appears. Writes world-v1 (240 pages) with withheld targets and sweeps.
- Run: `bun eval/runner/forward-reference-heal.ts [--seeds 1,2,3] [--arm local|http] [--sweep-every 10] [--withhold 0.2] [--output DIR] [--gbrain CKOUT[@ref]] [--json]` (line 1-ish usage).
- Cost: $0. LLM keys: none.
- Corpus: world-v1 (generated, `generators/relation-line-variants-gen.ts`, `generators/seeded.ts` Rng and fingerprint).
- gbrain imports: `--arm local` in process via importGbrain (`p5-brain.ts`, `extractStaleFromDB`); `--arm http` uses an HTTP transport (`lifecycle` HTTP driver).
- Coupling: in-process (local arm) and HTTP (http arm), per the usage line.
- Published: `docs/benchmarks/2026-10-06-followups-repin/offline-tier/...`; `eval/registry.ts`.

### Hub world (`hub-world.ts`, generator `generators/hub-world-gen.ts`)
- Measures: R1, ranking changes that depend on entity degree (dampening, graph signals) on a hub-heavy world (a few entities with thousands of inbound links).
- Run: `bun eval/runner/hub-world.ts --corpus-dir DIR [--gbrain CKOUT@SHA] [--seeds 1]` (line 19-ish).
- Cost: paid flag and budget (4 refs); keyless run is the default for the retrieval numbers. LLM keys: ANTHROPIC/OPENAI for paid.
- gbrain imports: via `relational-ab.ts` (importGbrain, `embedQuery`, `hybridSearch`). Coupling: in-process.
- Published: `docs/decisions.md`, `docs/benchmarks/2026-10-05-heldout-program/branch-folds.md`.

### Hub world arms (`hub-world-arms.ts`)
- Measures: several read-time arms (hub dampening, graph signals) over ONE index per gbrain build (P2 E1 dev).
- Run: `bun eval/runner/hub-world-arms.ts --corpus-dir DIR --gbrain CKOUT@REF` (line 19).
- Cost: keyless default (`runSharedIndexPairs`). LLM keys: none for keyword.
- gbrain imports: via `relational-ab.ts`. Coupling: in-process.
- Published: `docs/benchmarks/2026-10-05-heldout-program/branch-folds.md` cites it. No standalone report.

### Line grammar junk audit (`line-grammar-junk-audit.ts`, helper for Q2)
- Measures: P5 H3. Whether the typed line grammar stays out of ordinary list lines. Two shapes: relation lines (`- works_at [[companies/acme]]`) and fact lines (`- [preference] ...`).
- Run: `bun eval/runner/line-grammar-junk-audit.ts fetch-vault` (download and verify the vault); `bun eval/runner/line-grammar-junk-audit.ts --gbrain CKOUT@REF --output DIR [--corpora lme-s,locomo,blue-book]` (lines 44-45).
- Cost: $0 for minting and audit; paid judge part (1 paid ref, budget 4 refs). LLM keys: ANTHROPIC/OPENAI for judged parts.
- Corpus: LongMemEval-S, LoCoMo, and a blue-book vault (downloaded by `fetch-vault`, hash-checked; `fetch(m.raw_base + ...)`, line 97).
- gbrain imports: importGbrain `src/core/line-grammar.ts` (parser functions). Coupling: in-process.
- Published: `docs/benchmarks/2026-10-11-wave14-repin/...offline-tier-summary.md`; `docs/benchmarks/2026-10-06-q2-parser-gaps-runbook.md`.

### Line grammar typing (`line-grammar-typing.ts`)
- Measures: P5 H1. Whether link typing on ordinary prose is unchanged, with world-v1 (240 rich-prose pages) written into in-memory PGLite through `put_page`.
- Run: `bun eval/runner/line-grammar-typing.ts [--output DIR] [--gbrain CKOUT[@ref]] [--dir eval/data/world-v1] [--json]` (line 38).
- Cost: $0. LLM keys: none.
- gbrain imports: importGbrain (2 calls) for `put_page` and `extractStaleFromDB`; scored against gold from `type-accuracy.ts` (in-repo). Coupling: in-process.
- Published: `docs/benchmarks/2026-10-11-wave14-repin/...offline-tier-summary.md`.

### Living pages breakeven (`living-pages-breakeven.ts`)
- Measures: W9 build decision. Break-even read/write ratio and classification of the owner's `mcp_request_log` operation counts.
- Run: `bun eval/runner/living-pages-breakeven.ts --ops <ops.csv> [--page-days N] [--json out.json]` (line 9).
- Cost: $0. LLM keys: none. Coupling: none for gbrain (reads a CSV).
- Published: `docs/benchmarks/2026-10-17-living-pages-preregistration.md`; report directory `docs/benchmarks/2026-10-17-living-pages/`.

### Living pages CSV (`living-pages-csv.ts`)
- Helper only. Exports `csv(text)` parser for `operation, ok` rows (used by breakeven). No usage line, no run. $0, no gbrain.

### Quoted reads (`quoted-reads.ts`)
- Measures: harness-side inverse of gbrain's remote read quote fence (since v0.60.536.0 text below the owner's tier is inside a `quoted: 'transcript'` fence). Harness compares returned text with what it wrote, reading inside the fence through the build's inverse, and fails on a build that quotes without one.
- Run: helper; no usage line. Used by harness tests.
- Cost: $0. LLM keys: none.
- gbrain imports: importGbrain (2 calls) for `src/core/search/transcript-quote.ts` (inverse) and the read path. Coupling: in-process.
- Published: `CHANGELOG.md` only.

### Reading headroom (`reading-headroom.ts`)
- Measures: exploratory $0 keyless recount over committed W10a and W10b receipts. How much of what gbrain delivers to the reader is the answer's own sessions, how long a frontier reader's notes are, and how many wrong answers commit to a value.
- Run: `bun eval/runner/reading-headroom.ts` (see header).
- Cost: $0. LLM keys: none (token estimator is local).
- Imports: `../../node_modules/gbrain/src/core/chunkers/token-estimate.ts` (cl100kAvailable, estimateTokens). Direct source file import from the installed package path, not `importGbrain`. Coupling: in-process (pure function).
- Published: `docs/benchmarks/2026-10-08-reading-headroom.md`; `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`.

### Reading notes recount (`reading-notes-recount.ts`)
- Measures: recount of the reading-notes arms (transfer: baseline vs notes; oracle: four arms) from committed receipts with cost checks.
- Run: `bun eval/runner/reading-notes-recount.ts` (no usage line; verifies receipts).
- Cost: $0. LLM keys: none. Coupling: none for gbrain.
- Published: `docs/benchmarks/2026-09-25-reading-notes.md` (and `.md`), `docs/corrections.md`.

### Reading notes requests (`reading-notes-requests.ts`)
- Measures: offline paired requests through the native reader's evidence and sanitizer path (schema 2: opaque session ids).
- Run: `bun eval/runner/reading-notes-requests.ts --input <private> --output <file> --model <model> --max-tokens <n>` (line 94: args must include the 4 options).
- Cost: $0 offline. LLM keys: none (`offline capture` stub client, line 75).
- gbrain imports: pkg `gbrain-reader/eval/longmemeval/reader` (generateAnswer, readerConfigHash, resolveReaderConfig, READER_MAX_SESSION_CHARS) and `gbrain-reader/types` (type SearchResult). Note: this is the reader package (`gbrain-reader` pin), not `gbrain`.
- Coupling: in-process (reader package).
- Published: `docs/benchmarks/2026-09-25-reading-notes.md`.

### Reading notes run (`reading-notes-run.ts`)
- Measures: explicit, capped execution of an offline paired request plan (never run from tests or recount).
- Run: `bun eval/runner/reading-notes-run.ts --execute --input F --requests F --journal F --max-usd N --approval-id ID` (line 129; the usage needs exactly 11 args).
- Cost: paid, capped by `--max-usd`. Model fixed to `anthropic:claude-sonnet-4-6` (line 8). LLM keys: ANTHROPIC.
- gbrain imports: pkg `gbrain-reader/ai/gateway` (chat, configureGateway), `gbrain-reader/ai/invocation-guard` (withAIInvocationGuard), `gbrain-reader/core/model-pricing` (canonicalLookup), `gbrain-reader/eval/longmemeval/reader` (resolveReaderConfig, readerConfigHash). Coupling: in-process (reader package, not gbrain CLI or MCP).
- Published: `docs/benchmarks/2026-09-25-reading-notes.md`.

### Save notes dedup (`save-notes-dedup.ts`)
- Measures: P5 H5b. Whether the put_page similar-page hint reduces duplicate pages when an agent saves notes, without merging different entities.
- Run: `GBRAIN_EVAL_CONFIG=put_page.similar_pages=true bun eval/runner/save-notes-dedup.ts --gbrain CKOUT@REF ...` (header line 30); `--scripted` (naive scripted writer, $0; proves plumbing and classifier; line 33); `compare <receipt A> <receipt B>`.
- Cost: paid agent (budget 8 refs); scripted $0. LLM keys: ANTHROPIC (agent via p5-agent).
- Corpus: generated `generators/save-notes-dedup-gen.ts`.
- gbrain imports: via `p5-agent.ts` (MCP `McpClient`) and `p5-brain.ts`. Coupling: MCP for the agent, in-process for setup.
- Published: `docs/benchmarks/2026-10-11-wave14-repin/...offline-tier-summary.md` (cites it).

### Structure-aware chunks (`structure-aware-chunks.ts`, GBRA-234)
- Measures: whether heading-path prefix at embed time (`GBRAIN_EXP_HEADING_PREFIX=1`) or heading-lead inline chunking (`GBRAIN_EXP_HEADINGS_LEAD=1`) raise chunk retrieval on long heading-structured documents (QASPER dev v0.3 and cat13 corpora).
- Run: `bun eval/runner/structure-aware-chunks.ts plan --gbrain CKOUT@REF --qasper <json>`; `run --gbrain ... --qasper <json> --corpus a|aw|b --arm <arm>`; `cat --gbrain ... --cat 13|13b --arm base|prefix|kw_base|kw_terms --out DIR`; `guard --gbrain ... --out DIR`; `report --out DIR` (lines 27-33).
- Cost: `usd_est_total_cold_cache` reported (line 357) from embedding price; OpenAI embeddings. LLM keys: OPENAI (3 refs).
- Corpus: QASPER dev v0.3 (external, downloaded); cat13 corpora (generated/committed under `docs/benchmarks/2026-10-28-structure-aware-chunks/`).
- gbrain imports: importGbrain for `PGLiteEngine`, `importFromContent`, `hybridSearch`, `embedQuery`, `parseMarkdown`, `prepareMarkdownChunks` (lines 268-281). Engine: executeRaw for `content_chunks` update (line 439).
- Coupling: in-process.
- Published: `docs/benchmarks/2026-10-28-structure-aware-chunks.md`, `-preregistration.md`, `docs/benchmarks/preregistrations.d/structure-aware-chunks.json`.

### Takes bootstrap frontier (`takes-bootstrap-frontier.ts`)
- Measures: W4 of the 2026-10 follow-up: gbrain's takes-bootstrap classifier on four frontier models through the priced harness overlay (`eval/runner/takes-bootstrap/harness-overlay.mjs`).
- Run: `bun eval/runner/takes-bootstrap-frontier.ts route-check|run|rescore [flags]` (line 217). `route-check` runs one short gbrain `chat()` call per model; `rescore` is keyless and $0.
- Cost: `capFor(plan, budget, committed, minimum)` per model (line 50); `startPaidRun` with estimate 0.01 per model (line 119). Budget 16 refs.
- LLM keys: ANTHROPIC, OPENAI, and others via the gateway (route-check and run).
- Corpus: committed takes predictions (rescore reads committed predictions files).
- gbrain imports: `git ls-tree` and `git hash-object` (verify pins, lines 72-76); spawns self with `process.execPath` (line 170, child run per arm); `DEFAULT_GBRAIN_DIR = node_modules/gbrain` (line 29). Uses the installed package path for the overlay.
- Coupling: CLI (spawn of itself, `git` plumbing); the classifier runs through gbrain's `chat()` in a child process.
- Published: `docs/benchmarks/2026-10-06-takes-bootstrap-frontier.md`, `-preregistration.md`, `docs/benchmarks/2026-10-04-takes-bootstrap-verdict.md`, `docs/audit/2026-11-09-openai-cache-writes/other-runners/results.json`.

### W6 embedding matrix (`w6-embedding-matrix.ts`)
- Measures: keyless $0 summary of the Cat 13 embedder x rerank matrix receipts (`cat13-<embedder>-rerank-<on|off>.receipt.json`).
- Run: `bun eval/runner/w6-embedding-matrix.ts summarize <results dir>` (line 1-ish).
- Cost: $0. LLM keys: none. Coupling: none (reads receipts; imports `receipt.ts` helpers only).
- Published: `docs/benchmarks/2026-10-06-embedding-matrix.md`, `-preregistration.md`.

### W8 negative controls (`w8-negative-controls.ts`)
- Measures: keyless $0 summary of the W8 live negative controls (lane B part), applying the preregistered rule per control.
- Run: `bun eval/runner/w8-negative-controls.ts summarize <results dir>`.
- Cost: $0. LLM keys: none. Coupling: none (reads committed receipts).
- Published: `docs/benchmarks/2026-10-06-negative-controls.md` (and `-preregistration.md`).

### Write then answer (`write-then-answer.ts`, shared with Q2 G6 and q2/power-sim)
- Measures: Q2 G6 (and P5 H6): do typed relation lines help an agent answer from a brain it wrote itself. One arm per invocation, every model, one corpus; the agent writes the brain through gbrain's MCP server in fixed batches, then `gbrain extract --stale` reconciles links after each batch.
- Run: one invocation per arm and corpus (see header; the `--paid` flag is required for model calls; budget ledger).
- Cost: paid, budget ledger (`startPaidRun` in p5-agent; 11 budget refs). Per-arm USD per run (`agent_usd`, `judge_usd`, lines 232, 285-343).
- LLM keys: ANTHROPIC and OPENAI (agent, judge, and wta judge).
- Corpus: generated career chronicle (`generators/career-chronicle-dev-gen.ts`, `CAREER_TODAY`) and the amara vault (`renderCorpus` via `chronicle-lift.ts`).
- gbrain imports: via `p5-agent.ts` (MCP `McpClient`) and `p5-brain.ts` (`extractStaleFromDB`). Also `q2/grammar-lines.ts` `extractGrammarLines` on finished arm-B brains.
- Coupling: MCP (agent writes through gbrain's MCP server) and CLI (`gbrain extract --stale`).
- Published: `docs/plans/2026-10-07-10x-memory-advantage/audit/A-evidence-brief.md`; `docs/benchmarks/2026-10-11-wave14-repin/...offline-tier-summary.md`; `docs/benchmarks/2026-10-06-q2-parser-gaps-runbook.md`.

---

## Helpers and non-runner files covered

| File | Role | Imports gbrain | Coupling |
|---|---|---|---|
| p5-agent.ts | Shared agent and judge harness | no (cat40 McpClient) | MCP + CLI (`bun -e`) |
| p5-brain.ts | PGLite put/sweep/edges plumbing | yes, importGbrain (config, operations, pglite-engine, extract) | in-process |
| q1/hedge.ts, q1/usage.ts, q1/secret-scan.ts, q1/scoreboard-errors.ts | Pure helpers | no | none |
| q1/cells/definitions.ts | Cell definition helpers for Q1, F6, RS1, BG1 | no | none |
| q2/stats.ts, q2/q-set.ts, q2/n-corpus.ts, q2/k-conformance.ts, q2/junk-classes.ts, q2/grammar-lines.ts, q2/checkpoints.ts | Q2 helpers | junk-classes and grammar-lines import line-grammar-junk-audit; grammar-lines calls build parser | in-process via line-grammar-junk-audit |
| t0/delivery.ts | Hook delivery contract | no | CLI hook spawn |
| t0/score.ts | Failure scorer | no | none |
| t0/analyze.ts | Failure analysis | no (imports generator) | none |
| line-grammar-junk-audit.ts | Mints docs and audits lines | importGbrain src/core/line-grammar.ts | in-process |
| hub-world-gen etc. | Generators under `generators/` | no | none |

## Cross-cutting observations

- Most of this scope is in-process, via `importGbrain(gut, 'src/...')` against a built checkout (`gbrain-under-test.ts:117`). A Rust port needs a CLI or MCP adapter for each of these module-level calls. The most common imports: `src/core/operations.ts` (about 25 runners), `src/core/pglite-engine.ts` (about 20), `src/core/import-file.ts` (about 12), `src/core/search/hybrid.ts`, `src/core/ai/gateway.ts`. Those five cover most of the in-process surface.
- Operations are invoked by name: `operations.find(o => o.name === N)!.handler(ctx, params)` (n1, n3, n4, n12, n13, agent-retrieval-shapes, p5-brain). The op names used are the same as the MCP tool names, so a CLI or MCP adapter can drive them with the same parameters. Exception: n6-visibility-fuzz uses `dispatchToolCall` from `src/mcp/dispatch.ts`, the MCP dispatcher in process.
- Engine calls are a small set: connect, initSchema, disconnect, executeRaw, setConfig, getConfig, insertFact, softDeletePage, readPageSnapshot. Several runners use raw SQL via `executeRaw` (n4, n7, n8, n9, n13, n3, n5, agent-retrieval-shapes, p5-agent). A Rust parity gate must either expose these through a CLI JSON adapter or replace raw SQL reads with operation calls.
- Runners that already drive gbrain as a process: N5 (lifecycle CLI, stdio MCP, HTTP), N6 postgres HTTP (HTTP MCP plus `gbrain serve --http`), P4 stream (stdio MCP and hook spawn), P8 write cost (MCP and CLI drain), T0 family (stdio MCP and hook spawn; T0 parity runs real `claude` with gbrain hooks and MCP), chronicle-lift (CLI spawn and MCP), takes-bootstrap-frontier (child spawn), write-then-answer and p5-agent (MCP plus `gbrain extract --stale`).
- Keyless default is the norm for N-series deterministic probes (N1 default, N3, N4, N4-similar, N5, N6 visibility, N6 postgres, N8, N12, N13, N14 default, relation-line variants, line-grammar typing, forward-reference-heal local, hub-world arms, attendee-role-planner, agent-retrieval-shapes, belief-weekly-probes). These are the cheapest parity candidates.
- Paid runners are gated consistently: `paidRequested` and `requirePaidArm` (`paid-arm.ts`), `startPaidRun` and `budgetOptionsFrom` (`budget-ledger.ts`), `--paid`, `--budget-usd`, `--budget-run-id`. Estimates are constants in the file (`PAID_ESTIMATE_USD` in n1, n2-contradiction, n9, a4-abstention; `RELATIONAL_AB_ESTIMATE_USD` in relational-ab).
- Sealed data is custodian-only: BEAM-10M (q1), sealed-confirmation haystacks (p8, q2), custody roots (q2, q1 publish). Runners that read sealed data are not reproducible from the repo. Parity work should avoid them.
- Several families depend on `gbrain-reader` (a separate pinned package) rather than `gbrain`: reading-notes-run and reading-notes-requests. Those are reader-side, not gbrain-side.
- Surprises: (1) `n15-skillopt-method.ts` has no gbrain import and no gbrain process call; it is an LLM-only probe of skill text. (2) `p8-withdraw-retrieval.ts` is a one-line OpenAI embedding script, not a gbrain runner. (3) `t0/brief.ts` and `t0/score.ts` have no standalone usage line. (4) `reading-headroom.ts` imports a file from `node_modules/gbrain/src/...` directly (line 29), not via `importGbrain`, so it depends on the installed package rather than the overlay checkout. (5) Several runners disable keyword search or set `GBRAIN_EVAL_CONFIG` via env, so their results depend on env pins as well as the build.
- Published status (from the rg check of docs and `eval/`): N1, N2, N3, N4, N5, N6 (both), N7, N8, N9, N12, N13, N14, N15 (via CHANGELOG and docs/audit), A4, agent-retrieval-shapes, attendance, belief-weekly, chronicle-lift, coding-spike, relational-ab, evidence-auto-v2, structure-aware-chunks, takes-bootstrap-frontier, w6, w8, reading-headroom, living-pages-breakeven, t0-program-primary and t0b, q1 family (`docs/findings`, `docs/comparison-systems.md`), and q2 family (`docs/benchmarks/2026-10-06-q2-parser-gaps-*`) all have report files or are cited by them. One-offs with no dedicated report: feedback-replay-locomo, feedback-replay-world, feedback-think-replay (cited only from `docs/decisions.md`), hub-world-arms (cited only from `docs/benchmarks/2026-10-05-heldout-program/branch-folds.md`), parse-relational-questions, quoted-reads, living-pages-csv, reading-notes-recount (cited from `docs/corrections.md` and the reading-notes report), n4-similar-pages (cited only from wave14-repin summaries), p8-withdraw-retrieval (no citation), coding-spike (cited from one memory-proof wave note), and w8-negative-controls (has a report).
- Unknowns: total wall time and cost for most paid runners (not in code); N14 1 GB tier time; n6 Postgres setup time; q1 aggregate campaign cost (in `docs/benchmarks` receipts, not in this scope).
- Scope note: no paid run was executed, no API key was used, and no network call was made. All findings come from source reads and rg over the repository, as the task required.
