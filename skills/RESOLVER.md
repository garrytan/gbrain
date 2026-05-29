# Cortex Runtime Skill Resolver

This is the public Cortex runtime dispatcher. It intentionally advertises only
hosted SaaS skills that are Cortex-branded, tenant-scoped, and agent-callable.
Historical or locally customized skills can remain in the repository while they
are being reworked, but agents should not route to them from this catalog.

## SaaS Onboarding And Access

| Trigger | Skill |
| --- | --- |
| "Set up Cortex", "create Cortex org", "initialize company brain", "Cortex setup", "invite teammates", "connect an agent", "runtime manifest", "onboarding URL" | `skills/setup/SKILL.md` |

## Schema And Customization

| Trigger | Skill |
| --- | --- |
| "add a page type", "add a type to our schema", "tenant brain has untyped pages", "schema is not matching our sources", "propose new types from our corpus", "backfill page types", "evolve the schema", "extend the schema pack", "make X an expert type", "schema mutate", "schema sync", "schema author" | `skills/schema-author/SKILL.md` |

## Agent Parity Rule

Every listed skill must preserve both paths:

- Human path: the Cortex admin console can perform or inspect the workflow.
- Agent path: a Cortex MCP/control-plane operation can perform or inspect the
  same workflow with tenant, brain, source, and OAuth scope enforcement.

When a legacy skill is rebranded for SaaS, add it here only after its public copy,
commands, setup assumptions, and tests are Cortex-clean.
