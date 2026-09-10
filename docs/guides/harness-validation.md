# Harness integration validation

Evidence recorded **2026-09-10**. Repository and local HTTP tests establish the
behavior below. They do not establish that Grok Bot or Muse has loaded a native
skill, preserved files across a platform reset, or recalled a fact in a new
conversation. Those are separate release checks.

| Area | Automated evidence | Remaining platform evidence |
| --- | --- | --- |
| Local setup | Real PGLite initialization, isolated routing, explicit adoption, interrupted initialization/upgrade with durable schema resume, live-owner busy errors, ownership conflicts, and runtime replacement | Verify the chosen persistent directory survives the harness's lifecycle |
| Backup and restore | Database-only facts, private archive permissions, checksums/path rejection, changing-file rejection, private staging after interrupted publication, relocated writes, original-brain preservation, and unfinished-job quarantine | Explicitly choose and verify a protected off-VM copy |
| Memory behavior | Remember, recall, correction, withdrawal, restart, and withdrawal surviving stale-source reimport | Observe GBrain calls across actual harness conversations |
| Hosted onboarding | Real CLI → HTTP administration → private credential handoff → MCP memory round trip, on PostgreSQL and PGLite | Reload the native client and observe its calls |
| Grants and tokens | Profiles, separate write fences, operation ceilings, source restrictions, revision conflicts, stable credentials, scope removal, refresh ceilings, and confidential/public PKCE flows | A real Grok Bot native OAuth connector test before promoting that adapter |
| Delegation | Atomic admission, queued/running policy changes, replay restrictions, per-client accounting, and a real HTTP → queue → CLI worker journey | Confirm the deployed worker and configured provider complete the actual task |
| Admin UI | Headless Chrome against the real HTTP/PostgreSQL service: preview, creation, unlimited/concurrency-1 defaults, stale-edit rejection, reload, lost-response reconciliation, and credential recovery without duplicate grants or secret rotation | Normal operator deployment checks |

The packaged-install smoke used an archive of the review workspace and the
downloaded, checksummed Bun 1.3.13 runtime. It exercised the packaged TypeScript
setup entry and finite launcher calls after deleting acquisition files and
caches. It did not run the published shell download path against an unpublished
release or establish native-harness persistence.

The [instruction behavior cases](../../evals/harness-instructions/README.md)
cover routing, opt-in capture, chat-only requests, hosted credentials, and
honest completion reports. A fresh-context instruction exercise records
proposed actions; it is separate from actual tool execution and native tests.

The delegated worker test uses a **local Anthropic-compatible HTTP fixture**. It
executes a real bound brain tool, returns a randomized result, and settles
attributed reservations. It does not contact a paid model provider or run inside
a vendor harness. Tests with a fake MCP peer cover failure and reconciliation
behavior; the PostgreSQL/PGLite journeys provide the separate real-server proof.

## Reproduce the focused lifecycle checks

Run from a development checkout with dependencies installed:

```bash
bun test --timeout 60000 test/agent-install-backup.serial.test.ts \
  test/harness-access.serial.test.ts test/harness-delivery-recovery.serial.test.ts \
  test/harness-install-ownership.test.ts test/harness-verification-uncertainty.test.ts
```

For PostgreSQL, use the repository's isolated E2E wrapper with a dedicated test
database, as described in [testing](../TESTING.md):

```bash
bun run test:e2e test/e2e/client-grants.test.ts \
  test/e2e/harness-access.test.ts test/e2e/delegated-grants-withdrawal.test.ts \
  test/e2e/delegated-http-worker.test.ts
```

Do not point this runner at a personal brain. Full verification uses the
repository's `bun run verify`, unit/serial suites, and PostgreSQL E2E suite.
Tests requiring external provider keys or platform credentials remain visibly
skipped unless those resources are supplied.

## Actual-harness acceptance

Use randomized harmless facts and record observed tool calls, returned IDs, and
the result of every cleanup. A fluent answer alone is insufficient.

1. Complete setup, relay the required search-mode choice, and enable the saved
   instruction through the actual harness controls. Record its identifier.
2. Ask the agent to remember a unique fact with provenance. Start a new
   conversation and ask for it without repeating the fact; observe GBrain recall.
3. Correct the fact and verify the stored correction. Withdraw it, synchronize
   its original source, and verify it stays out of active memory.
4. Restart the environment, repair a removed runtime, and restore a private
   backup into a new root. Verify writes reach the intended installation and
   the original remains unchanged.
5. If delegation is granted, explicitly run the paid worker challenge. Require
   the randomized terminal result and successful cleanup, not just a job ID.

Missing native activation, untested persistence, unknown mutation outcomes,
unavailable workers, and failed cleanup stay incomplete. Muse native MCP support
and a universal arbitrary-harness configuration format are not claimed.
