# GBrain Company Skill Resolver

Use this resolver when `get_brain_identity.brain_role` is `company`.

Company GBrain is an aggregate organization brain. It reads company-owned pages and
sanitized member snapshot sources such as `member-alice`. It must not open an
individual member's DB path directly.

## Always-on

| Trigger | Skill |
|---------|-------|
| Any company brain read/write/lookup/citation | `skills/brain-ops/SKILL.md` |

## Enabled

| Trigger | Skill |
|---------|-------|
| Search, lookup, "what do we know", relationship/graph questions | `skills/query/SKILL.md` |
| Company research, metrics, investor/customer/company tracking | `skills/data-research/SKILL.md` |
| Current-state web research with brain context | `skills/perplexity-research/SKILL.md` |
| Synthesize patterns across company-visible notes | `skills/concept-synthesis/SKILL.md` |
| Apply a reading/source to a company problem | `skills/strategic-reading/SKILL.md` |
| Company briefing, meeting prep from company-visible sources | `skills/briefing/SKILL.md` |
| Save or load company reports | `skills/reports/SKILL.md` |
| Company brain health, citation audit, stale info, orphans | `skills/maintain/SKILL.md` |
| Validate/repair frontmatter on company-owned pages | `skills/frontmatter-guard/SKILL.md` |
| Fix citations on company-owned pages | `skills/citation-fixer/SKILL.md` |
| Agent-readable health/smoke checks | `skills/skillpack-check/SKILL.md`, `skills/smoke-test/SKILL.md` |
| Ask for operator confirmation at a decision gate | `skills/ask-user/SKILL.md` |

## Admin-Only

These are allowed only for a company admin/operator on the host, not for normal
company agents or Hermes clients:

| Trigger | Skill |
|---------|-------|
| Setup, first boot, migration, cold start | `skills/setup/SKILL.md`, `skills/migrate/SKILL.md`, `skills/cold-start/SKILL.md` |
| Company cron, jobs, webhooks | `skills/cron-scheduler/SKILL.md`, `skills/minion-orchestrator/SKILL.md`, `skills/webhook-transforms/SKILL.md` |
| Create/update skills | `skills/skill-creator/SKILL.md`, `skills/skillify/SKILL.md`, `skills/testing/SKILL.md` |
| Publish/export company pages | `skills/publish/SKILL.md`, `skills/brain-pdf/SKILL.md` |
| Company identity/access setup | `skills/soul-audit/SKILL.md` |

## Disabled In Company Mode

Do not route company agents to personal ingestion, personal tasking, archive
crawling, personalized book analysis, voice-note ingestion, or direct member
source mutation skills. Member sources are imported snapshots; enrich company-owned
synthesis pages instead.
