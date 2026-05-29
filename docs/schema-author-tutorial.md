# Tutorial: Customize A Tenant Schema

This tutorial shows how an admin or admin-scoped agent can customize a Cortex
tenant brain after onboarding. You will inspect the active schema, fork it if it
is read-only, add an `incident` type, backfill matching pages, and verify that
query paths can use the new type.

Read `what-schemas-unlock.md` first for the product rationale.

## Requirements

- A Cortex tenant with at least one brain.
- An admin OAuth client or operator console session.
- A source with example pages under a stable prefix such as
  `engineering/incidents/`.
- The Cortex CLI connected with:

  ```bash
  cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'
  ```

Agents can perform the same workflow through MCP by calling
`schema_apply_mutations`, `schema_stats`, `schema_lint`, and
`schema_review_orphans`.

## Step 1: Inspect The Active Pack

```bash
cortex schema active --json
cortex schema stats --json
```

Record the active pack name, whether it is writable, total pages, typed pages,
untyped pages, and per-type counts.

If the pack is read-only, fork the active pack id returned by the command:

```bash
cortex schema fork <active-pack> acme-company
cortex schema use acme-company
```

## Step 2: Review Untyped Pages

```bash
cortex schema review-orphans --limit 50 --json
```

Look for a stable prefix with enough repeated content to deserve a type. For
this tutorial, assume the tenant has incident reports under:

```text
engineering/incidents/
```

Good candidates have:

- A repeated domain concept.
- A stable source or prefix.
- Queries that should route differently from generic notes.
- Facts that should be extracted consistently.
- Skills that should target the content.

## Step 3: Add A Type

```bash
cortex schema add-type incident \
  --primitive event \
  --prefix engineering/incidents/ \
  --extractable \
  --expert
```

This declares that pages under `engineering/incidents/` are incident events,
eligible for facts extraction and expert routing.

If the tenant also has runbooks, add a link verb:

```bash
cortex schema add-type runbook \
  --primitive document \
  --prefix engineering/runbooks/ \
  --expert

cortex schema add-link-type mitigated-by \
  --page-type incident \
  --target-type runbook
```

## Step 4: Lint

```bash
cortex schema lint --with-db
```

Fix any prefix collisions, dangling link targets, or expert-routing warnings
before backfilling.

## Step 5: Dry-Run Backfill

```bash
cortex schema sync --json
```

Confirm:

- `total_would_apply` matches the expected number of pages.
- Sample slugs are inside the intended source/prefix.
- No unrelated team content is included.

## Step 6: Apply Backfill

```bash
cortex schema sync --apply
```

The backfill updates `page.type` for matching pages. It is idempotent: running it
again should find nothing new to apply.

## Step 7: Verify Retrieval

```bash
cortex schema stats --json
cortex whoknows "latest production outage"
cortex graph-query engineering/incidents/example --depth 2
```

In the console, check:

- Quality page: schema coverage improved.
- Skills page: incident-related skills can be scoped to the right source and
  allowed clients.
- Activity page: schema mutation and backfill operations are visible.

## Agent Batch Example

An admin-scoped agent can apply the same change in one batch:

```json
{
  "pack": "acme-company",
  "mutations": [
    {
      "op": "add_type",
      "name": "incident",
      "primitive": "event",
      "prefix": "engineering/incidents/",
      "extractable": true,
      "expert_routing": true
    },
    {
      "op": "add_type",
      "name": "runbook",
      "primitive": "document",
      "prefix": "engineering/runbooks/",
      "extractable": false,
      "expert_routing": true
    },
    {
      "op": "add_link_type",
      "name": "mitigated-by",
      "page_type": "incident",
      "target_type": "runbook"
    }
  ]
}
```

After mutation, the agent should run lint, dry-run sync, request approval if the
backfill count is surprising, apply sync, and report the verification query.

## Completion Checklist

- Active pack is writable.
- New type and link verbs are visible in `cortex schema graph`.
- Lint passes.
- Backfill count matches expectation.
- Retrieval or graph query proves the type is used.
- Any affected skills have updated source/client policy.
- The same steps are possible through MCP for agent parity.
