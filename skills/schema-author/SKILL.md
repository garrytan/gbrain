---
name: schema-author
description: Evolve a Cortex tenant brain's schema pack with agent-proposed, admin-approved page types, prefixes, link verbs, facts extraction, and expert routing
tools:
  - cortex schema active
  - cortex schema list
  - cortex schema stats
  - cortex schema review-orphans
  - cortex schema detect
  - cortex schema suggest
  - cortex schema lint
  - cortex schema graph
  - cortex schema explain
  - cortex schema fork
  - cortex schema use
  - cortex schema add-type
  - cortex schema remove-type
  - cortex schema update-type
  - cortex schema add-alias
  - cortex schema remove-alias
  - cortex schema add-prefix
  - cortex schema remove-prefix
  - cortex schema add-link-type
  - cortex schema remove-link-type
  - cortex schema set-extractable
  - cortex schema set-expert-routing
  - cortex schema sync
  - cortex schema reload
  - mcp:get_active_schema_pack
  - mcp:list_schema_packs
  - mcp:schema_stats
  - mcp:schema_lint
  - mcp:schema_graph
  - mcp:schema_explain_type
  - mcp:schema_review_orphans
  - mcp:schema_apply_mutations
  - mcp:reload_schema_pack
triggers:
  - "add a page type"
  - "add a type to my schema"
  - "tenant brain has untyped pages"
  - "schema is not matching our sources"
  - "propose new types from our corpus"
  - "backfill page types"
  - "evolve the schema"
  - "extend the schema pack"
  - "make X an expert type"
  - "schema mutate"
  - "schema sync"
  - "schema author"
brain_first: exempt
writes_pages: []
---

# Schema Author

Use this skill when a Cortex tenant needs a better knowledge shape: new page
types, prefixes, link verbs, extraction flags, expert-routing flags, or a
backfill of existing content into the right types.

Schema authoring is part of SaaS onboarding and customization. The agent can
detect a gap, propose mutations, and apply them through MCP when it has the
right admin scope. Humans can perform the same work from the console or CLI.

## Non-Goals

- Filing one specific page belongs to the page-writing or source-ingestion
  workflow.
- Querying who knows about a topic belongs to search or expert routing.
- Creating a team boundary belongs to source management.
- Creating a hard isolation boundary belongs to brain management.

Schema authoring changes the tenant's type system. Treat it as a durable product
configuration change.

## Contract

Schema authoring is complete only when:

- The active tenant pack has been inspected.
- Proposed mutations name the affected sources, prefixes, and expected backfill.
- A writable pack has been selected or forked.
- Lint passes before mutation.
- Backfill is dry-run before apply.
- The matching MCP/control-plane mutation path is available for agents.
- A query or graph check proves the new type is usable.

## When To Invoke

Invoke when you see any of these:

- A source has many untyped pages under the same prefix.
- A team repeatedly asks questions that should route through a domain-specific
  type such as `incident`, `runbook`, `account`, `ticket`, `policy`, `customer`,
  `renewal`, `case`, or `meeting`.
- A skill should target a typed class of content.
- An admin asks an agent to propose schema improvements from connected sources.
- A migration needs to backfill `page.type` after adding a type.

## Workflow

### Phase 1: Inspect The Active Pack

```bash
cortex schema active --json
cortex schema stats --json
cortex schema review-orphans --limit 50 --json
```

Look for coverage gaps, shared prefixes, dead prefixes, and source-specific
clusters. If a source contains a stable operational concept, propose a type.

### Phase 2: Propose Changes

Use deterministic detection first:

```bash
cortex schema detect --json
cortex schema suggest --json
```

Turn the candidate into a concise proposal:

- Type name.
- Primitive.
- Source and prefix.
- Whether it should be extractable.
- Whether it should be expert-routed.
- Link verbs it should support.
- Expected backfill count.
- Skills or agent workflows that benefit.

### Phase 3: Mutate A Writable Pack

If the active pack is bundled or read-only, fork the active base pack before
mutation. Use the pack id returned by `cortex schema active --json`:

```bash
cortex schema fork <active-pack> acme-company
cortex schema use acme-company
```

Add the type and links:

```bash
cortex schema add-type incident \
  --primitive event \
  --prefix engineering/incidents/ \
  --extractable \
  --expert

cortex schema add-link-type mitigated-by \
  --page-type incident \
  --target-type runbook
```

Agent path: call `schema_apply_mutations` with an admin-scoped OAuth client.

### Phase 4: Lint And Backfill

Always dry-run before applying:

```bash
cortex schema lint --with-db
cortex schema sync --json
cortex schema sync --apply
```

Check the affected count and sample slugs. A prefix that unexpectedly matches a
large set should be corrected before apply.

### Phase 5: Verify Query Behavior

```bash
cortex schema stats --json
cortex whoknows "latest production outage"
cortex graph-query engineering/incidents/example --depth 2
```

In the console, verify the Quality and Skills pages show the new type's impact
on source coverage and skill targeting.

## MCP Batch Shape

Agents should prefer one atomic batch when applying multiple related changes:

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
      "op": "add_link_type",
      "name": "mitigated-by",
      "page_type": "incident",
      "target_type": "runbook"
    }
  ]
}
```

The server validates, locks, writes, audits, and invalidates caches before the
mutation is visible to query paths.

## Output Format

Report:

- Pack name and new version/hash.
- Types, prefixes, and link verbs changed.
- Lint result.
- Backfill dry-run count and applied count.
- A query or graph check proving the new type is usable.
- Any skills or clients that need policy updates after the schema change.

## Anti-Patterns

- Do not add a type for a one-time import.
- Do not add expert routing without a real prefix.
- Do not apply a backfill without a dry-run.
- Do not mutate a bundled pack directly.
- Do not widen source access just to make schema mutation easier; use the right
  admin client.
- Do not let runtime adapters invent their own type filters. Keep schema,
  source access, and skill policy enforced by Cortex.

## Failure Modes

- `PACK_READONLY`: fork the pack first.
- `TYPE_EXISTS`: update the existing type or choose a more specific name.
- `INVALID_RESULT`: lint found a dangling reference or prefix collision.
- `STILL_REFERENCED`: remove aliases, link verbs, or enrichable references
  before removing a type.
- `LOCK_BUSY`: another mutation is running; retry after it completes.
- `permission_denied`: the OAuth client lacks the admin scope needed for schema
  mutation.
