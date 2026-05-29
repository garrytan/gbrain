# Cortex Recommended Tenant Schema

Cortex schemas make a hosted company brain feel like the customer's actual
organization. They define page types, prefixes, link verbs, extraction rules,
and expert-routing hints that agents use when answering questions or running
skills.

Use this as the starter taxonomy for a company tenant. Fork and customize it
per brain when a team connects enough source data to justify a sharper shape.

## Principles

1. **Organizations own brains.** A company can have multiple brains, but the
   default path is one company brain with multiple sources.
2. **Sources model sub-brains.** Engineering, support, sales, leadership,
   legal, and integrations should usually be sources inside one brain.
3. **Types model meaning.** A meeting, incident, account, customer, renewal,
   runbook, policy, and decision should not all behave like generic notes.
4. **Links model workflows.** Use verbs that agents can traverse:
   `attended`, `owns-renewal`, `escalated-to`, `mitigated-by`, `depends-on`,
   `decided-in`, and `mentioned`.
5. **Skills respect policy.** Skill execution is scoped by allowed clients and
   sources, with optional type-level targeting from the schema.

## Baseline Sources

| Source | Purpose | Example Prefixes |
| --- | --- | --- |
| `default` | Shared company knowledge and first onboarding content | `company/`, `people/`, `meetings/` |
| `engineering` | Incidents, services, repos, runbooks, roadmap | `engineering/incidents/`, `engineering/runbooks/`, `engineering/services/` |
| `support` | Customers, tickets, escalations, help content | `support/customers/`, `support/tickets/` |
| `sales` | Accounts, opportunities, stakeholders, renewals | `sales/accounts/`, `sales/opportunities/` |
| `leadership` | Board, strategy, planning, exec decisions | `leadership/board/`, `leadership/strategy/` |
| `legal` | Contracts, policies, cases, security reviews | `legal/contracts/`, `legal/policies/` |
| `integrations` | Connector-ingested raw and normalized data | `integrations/composio/`, `integrations/slack/` |

## Starter Types

| Type | Primitive | Prefix | Extractable | Expert |
| --- | --- | --- | --- | --- |
| `person` | entity | `people/` | yes | yes |
| `company` | entity | `company/` | yes | yes |
| `meeting` | temporal | `meetings/` | yes | yes |
| `decision` | annotation | `decisions/` | yes | yes |
| `project` | entity | `projects/` | yes | yes |
| `source-note` | document | `sources/` | no | no |
| `incident` | event | `engineering/incidents/` | yes | yes |
| `service` | entity | `engineering/services/` | yes | yes |
| `runbook` | document | `engineering/runbooks/` | no | yes |
| `ticket` | event | `support/tickets/` | yes | yes |
| `customer` | entity | `support/customers/` | yes | yes |
| `account` | entity | `sales/accounts/` | yes | yes |
| `opportunity` | entity | `sales/opportunities/` | yes | yes |
| `renewal` | event | `sales/renewals/` | yes | yes |
| `contract` | document | `legal/contracts/` | yes | yes |
| `policy` | document | `legal/policies/` | yes | yes |

## Starter Link Verbs

| Verb | From | To | Why It Matters |
| --- | --- | --- | --- |
| `attended` | `person` | `meeting` | Meeting recall and expert routing. |
| `decided-in` | `decision` | `meeting` | Decision provenance. |
| `owns` | `person` | `project` | Responsibility lookup. |
| `depends-on` | `project` | `service` | Impact analysis. |
| `mitigated-by` | `incident` | `runbook` | Incident review and response automation. |
| `affected` | `incident` | `customer` | Support and customer success follow-up. |
| `owns-renewal` | `person` | `renewal` | Sales workflow automation. |
| `signed` | `company` | `contract` | Legal and account status. |
| `governed-by` | `service` | `policy` | Security and compliance lookup. |

## Onboarding Flow

1. Create the organization.
2. Create the first company brain.
3. Add the first sources.
4. Run schema stats and orphan review.
5. Fork the active pack if it is read-only.
6. Add team-specific types only when the prefix has real content.
7. Dry-run sync before applying a backfill.
8. Update skill policies for source/client access.
9. Verify queries from both a human console session and an agent OAuth client.

## Example Mutation

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

## Completion Criteria

A tenant schema is useful when:

- Coverage is visible in schema stats.
- Important team prefixes have first-class types.
- Sensitive sources remain scoped to the right clients.
- Skills run only for allowed clients and sources.
- Agent and console workflows can both propose, review, apply, and verify schema
  changes.
