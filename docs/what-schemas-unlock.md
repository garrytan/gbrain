# What Schemas Unlock

Cortex turns a company's accumulated knowledge into a typed, queryable graph.
Without schemas, every page looks the same to retrieval: a meeting, a customer,
a roadmap decision, a support escalation, and a policy document all become
generic text. That works for keyword search. It falls apart when an agent needs
to answer operational questions across teams.

A schema declares the kinds of things inside a tenant brain, how those things
link to each other, which facts should be extracted, and which page types are
eligible for expert routing. Agents can propose schema changes, humans can
approve them, and Cortex applies them with locks, validation, audit records, and
source-aware permissions.

This is the "why" behind schema customization. The walkthrough in
`docs/schema-author-tutorial.md` is the "how."

## SaaS Use Cases

### 1. Meeting Knowledge Becomes Queryable

A company imports thousands of meeting notes under an `engineering/meetings/`
source path. If those pages are typed as plain notes, an agent can only search
text. It cannot understand attendees, decision dates, incident references, or
follow-up ownership.

Add a `meeting` type with a prefix and extraction enabled:

```bash
cortex schema add-type meeting --primitive temporal --prefix engineering/meetings/ --extractable --expert
cortex schema sync --apply
```

After the sync, agent answers can route through meeting-specific signals:
attendees, dates, linked projects, decisions, and repeated topics. The content
did not change. The structure did.

### 2. Team Sources Get Their Own Shape

Engineering, sales, support, and legal often need different types. A support
source may care about `customer`, `ticket`, `incident`, and `runbook`. A sales
source may care about `account`, `opportunity`, `stakeholder`, and `renewal`.
The company can keep one hosted brain while giving each team a sharper model of
its own work.

```bash
cortex schema add-type incident --primitive event --prefix engineering/incidents/ --extractable --expert
cortex schema add-type runbook --primitive document --prefix engineering/runbooks/ --expert
cortex schema add-type customer --primitive entity --prefix support/customers/ --extractable --expert
cortex schema add-link-type escalated-to --page-type ticket --target-type incident
```

The same tenant brain can now answer "which customers were affected by the May
incident" and "which runbook resolved similar outages" without flattening every
team into the same generic page type.

### 3. Agent-Led Onboarding Gets Better Over Time

During onboarding, an agent can inspect the first connected sources, detect
clusters, and propose the schema that best fits the tenant. For example:

```json
{
  "pack": "acme-company",
  "mutations": [
    {
      "op": "add_type",
      "name": "enterprise-account",
      "primitive": "entity",
      "prefix": "sales/accounts/enterprise/",
      "extractable": true,
      "expert_routing": true
    },
    {
      "op": "add_link_type",
      "name": "owns-renewal",
      "page_type": "stakeholder",
      "target_type": "renewal"
    }
  ]
}
```

The agent submits the mutation through MCP, Cortex validates and audits the
change, and a human can review the result in the console. This is a key SaaS
onboarding loop: the product adapts to the company instead of making the
company memorize a fixed taxonomy.

### 4. Skills Become Safer

Skill policies are stronger when the brain has typed content. A "renewal risk"
skill can be limited to account and renewal pages. An "incident review" skill
can be limited to incident, service, and runbook pages. Cortex still enforces
source access and allowed clients, while schemas let the skill target the right
kind of work.

Runtime adapters should annotate skill-backed MCP calls with `_skill_id`,
`skill_id`, or `_meta.skill_id`. Dispatch can then block draft skills,
disallowed clients, or source violations before the underlying operation runs.

### 5. Multiple Brains Stay Coherent

Some organizations will run multiple brains for hard boundaries such as data
residency, M&A, legal isolation, or dedicated enterprise deployments. Each brain
can have its own schema pack while still following the same Cortex product
contract: hosted MCP, OAuth clients, runtime manifest, invite flow, activity
audit, and console management.

Use sources for team-level boundaries. Use separate brains when the boundary
needs its own database, public URL, backup policy, or region.

## Why This Matters

Typed knowledge changes what agents can safely do:

- Search can route through domain-specific expert signals instead of generic
  text similarity alone.
- Facts can be extracted into comparable columns only for types where they make
  sense.
- Graph traversal can follow declared verbs such as `attended`, `owns-renewal`,
  `escalated-to`, or `depends-on`.
- Schema changes can be proposed by agents and approved by humans without
  losing auditability.
- Skill execution can be constrained by source, client, and content type.

The result is not just cleaner retrieval. It is safer agent automation for a
tenant brain that will keep changing as the company connects more systems.

## Where To Start

1. Create the organization and first brain through `/admin/signup` or the
   `saas_signup_create` MCP operation.
2. Connect the first sources from the console or MCP.
3. Run schema review from the console quality checks or with
   `cortex schema review-orphans --json`.
4. Let an admin agent propose schema mutations through `schema_apply_mutations`.
5. Approve, sync, and backfill with `cortex schema sync --apply`.
6. Use the Skills page to scope capabilities to the right clients and sources.

Schemas are the customization layer that makes Cortex feel like the customer's
company brain rather than a generic hosted search box.
