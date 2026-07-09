# GBrain Skill Resolver

This is the dispatcher. Skills are the implementation. **Read the skill file before acting.** If two skills could match, read both. They are designed to chain (e.g., ingest then enrich for each entity).

## Always-on (every message)

| Trigger | Skill |
|---------|-------|
| Every inbound message (spawn parallel, don't block) | `skills/signal-detector/SKILL.md` |
| Any brain read/write/lookup/citation | `skills/brain-ops/SKILL.md` |

## Brain operations

| Trigger | Skill |
|---------|-------|
| "What do we know about", "tell me about", "search for", "who is", "background on", "notes on" | `skills/query/SKILL.md` |
| "Who knows who", "relationship between", "connections", "graph query" | `skills/query/SKILL.md` (use graph-query) |
| Creating/enriching a person or company page | `skills/enrich/SKILL.md` |
| Where does a new file go? Filing rules | `skills/repo-architecture/SKILL.md` |
| "where does this brain page go", "file this in the brain", "brain taxonomist", "taxonomy check", "refile brain page", "which directory does this page go" | `skills/brain-taxonomist/SKILL.md` |
| "EIIRP", "everything in its right place", "store this research", "put this in the brain", "make this re-doable", "DRY this up", "file all of this", "organize all of this work", "archive this research thread" | `skills/eiirp/SKILL.md` |
| Fix broken citations in brain pages | `skills/citation-fixer/SKILL.md` |
| "citation audit", "check citations", "fix citations" | `skills/citation-fixer/SKILL.md` (focused fix). For broader brain health, chain into `skills/maintain/SKILL.md` |
| "Research", "track", "extract from email", "investor updates", "donations" | `skills/data-research/SKILL.md` |
| Share a brain page as a link | `skills/publish/SKILL.md` |
| "validate frontmatter", "check frontmatter", "fix frontmatter", "frontmatter audit", "brain lint" | `skills/frontmatter-guard/SKILL.md` |
| "what search mode", "is my cache hot", "tune my retrieval", "compare search modes", "clear search overrides" | `gbrain search modes/stats/tune` directly. See `skills/conventions/search-modes.md` |
| "eval results", "search benchmark", "haters-immune methodology", "regression check on retrieval" | `gbrain eval run-all` / `gbrain eval compare`. See `docs/eval/SEARCH_MODE_METHODOLOGY.md` |

## Content & media ingestion

| Trigger | Skill |
|---------|-------|
| "capture this", "save this thought", "remember this", "drop this in the inbox", "save to brain" | `skills/capture/SKILL.md` |
| User shares a link, article, tweet, or idea | `skills/idea-ingest/SKILL.md` |
| "watch this video", "process this YouTube link", "ingest this PDF", "save this podcast", "process this book", "summarize this book", "PDF book", "ingest it into my brain", "what's in this screenshot", "check out this repo" | `skills/media-ingest/SKILL.md` |
| Meeting transcript received | `skills/meeting-ingestion/SKILL.md` |
| Generic "ingest this" (auto-routes to above) | `skills/ingest/SKILL.md` |

## Thinking skills (from GStack)

| Trigger | Skill |
|---------|-------|
| "Brainstorm", "I have an idea", "office hours" | GStack: office-hours |
| "Review this plan", "CEO review", "poke holes" | GStack: ceo-review |
| "Debug", "fix", "broken", "investigate" | GStack: investigate |
| "Retro", "what shipped", "retrospective" | GStack: retro |

> These skills come from GStack. If GStack is installed, the agent reads them directly.
> If not, brain-only mode still works (brain skills function without thinking skills).

## Operational

| Trigger | Skill |
|---------|-------|
| Task add/remove/complete/defer/review | `skills/daily-task-manager/SKILL.md` |
| Morning prep, meeting context, day planning | `skills/daily-task-prep/SKILL.md` |
| Daily briefing, "what's happening today" | `skills/briefing/SKILL.md` |
| Cron scheduling, quiet hours, job staggering | `skills/cron-scheduler/SKILL.md` |
| "get more out of gbrain", "is my brain set up right", "weekly brain checkup", "advise me on my brain", "gbrain advisor" | `skills/gbrain-advisor/SKILL.md` |
| Save or load reports | `skills/reports/SKILL.md` |
| "Create a skill", "improve this skill" | `skills/skill-creator/SKILL.md` |
| "Skillify this", "is this a skill?", "make this proper" | `skills/skillify/SKILL.md` |
| "Compress my resolver", "AGENTS.md too large", "RESOLVER.md too big", "functional area dispatcher", "shrink routing table" | `skills/functional-area-resolver/SKILL.md` |
| "Is gbrain healthy?", morning health check, skillpack-check | `skills/skillpack-check/SKILL.md` |
| "harvest this skill into gbrain", "publish this skill to gbrain", "lift this skill upstream", "share this skill with other gbrain clients", "promote my skill to gbrain" | `skills/skillpack-harvest/SKILL.md` |
| Post-restart health + auto-fix, "did the container restart break anything", smoke test | `skills/smoke-test/SKILL.md` |
| Cross-modal review, second opinion | `skills/cross-modal-review/SKILL.md` |
| "Validate skills", skill health check | `skills/testing/SKILL.md` |
| Webhook setup, external event processing | `skills/webhook-transforms/SKILL.md` |
| "Spawn agent", "background task", "parallel tasks", "steer agent", "pause/resume agent", "gbrain jobs submit", "submit a gbrain job", "submit a shell job", "shell job" | `skills/minion-orchestrator/SKILL.md` |
| "present options", "ask before proceeding", "choice gate", "user decision" | `skills/ask-user/SKILL.md` |

## Setup & migration

| Trigger | Skill |
|---------|-------|
| "Set up GBrain", first boot | `skills/setup/SKILL.md` |
| "Now what?", "fill my brain", "cold start", "bootstrap", "import my data", "what should I import first" | `skills/cold-start/SKILL.md` |
| "Migrate from Obsidian/Notion/Logseq" | `skills/migrate/SKILL.md` |
| Brain health check, maintenance run | `skills/maintain/SKILL.md` |
| "Extract links", "build link graph", "populate timeline" | `skills/maintain/SKILL.md` (extraction sections) |
| "Run dream", "process today's session", "synthesize my conversations", "consolidate yesterday's conversations", "what patterns did you see", "did the dream cycle run" | `skills/maintain/SKILL.md` (dream cycle section) |
| "Brain health", "what features am I missing", "brain score" | Run `gbrain features --json` |
| "Set up autopilot", "run brain maintenance", "keep brain updated" | Run `gbrain autopilot --install --repo ~/brain` |
| "Upgrade gbrain", "update gbrain", "gbrain update available", `UPGRADE_AVAILABLE`, "is gbrain up to date" | `skills/gbrain-upgrade/SKILL.md` |
| Agent identity, "who am I", customize agent | `skills/soul-audit/SKILL.md` |
| "Populate links", "extract links", "backfill graph" | `skills/maintain/SKILL.md` (graph population phase) |
| "Populate timeline", "extract timeline entries" | `skills/maintain/SKILL.md` (graph population phase) |

## Identity & access (always-on)

| Trigger | Skill |
|---------|-------|
| Non-owner sends a message | Check `ACCESS_POLICY.md` before responding |
| Agent needs to know its identity/vibe | Read `SOUL.md` |
| Agent needs user context | Read `USER.md` |
| Operational cadence (what to check and when) | Read `HEARTBEAT.md` |

## Disambiguation rules

When multiple skills could match:
1. Prefer the most specific skill (meeting-ingestion over ingest)
2. If the user mentions a URL, route by content type (link → idea-ingest, video → media-ingest)
3. If the user mentions a person/company, check if enrich or query fits better
4. Chaining is explicit in each skill's Phases section
5. When in doubt, ask the user (see `skills/ask-user/SKILL.md` for the choice-gate pattern)

## Conventions (cross-cutting)

These apply to ALL brain-writing skills:
- `skills/conventions/quality.md` — citations, back-links, notability gate
- `skills/conventions/brain-first.md` — check brain before external APIs
- `skills/conventions/brain-routing.md` — which brain (DB) and which source (repo) to target; cross-brain federation is latent-space only
- `skills/conventions/schema-evolution.md` — when to add a type vs alias vs prefix (read before `schema-author`)
- `skills/conventions/subagent-routing.md` — when to use Minions vs inline work
- `skills/ask-user/SKILL.md` — choice-gate pattern for human input at decision points
- `skills/_brain-filing-rules.md` — where files go
- `skills/_output-rules.md` — output quality standards

## Uncategorized

| Trigger | Skill |
|---------|-------|
| "personalized version of this book", "mirror this book", "two-column book analysis", "apply this book to my life", "how does this book apply to me" | `skills/book-mirror/SKILL.md` |
| "enrich this article", "enrich brain pages", "batch enrich", "make brain pages useful" | `skills/article-enrichment/SKILL.md` |
| "strategic reading", "read this through the lens of", "apply this to my problem", "what can I learn from this about", "extract a playbook from" | `skills/strategic-reading/SKILL.md` |
| "concept synthesis", "synthesize my concepts", "find patterns across my notes", "build my intellectual map", "trace idea evolution" | `skills/concept-synthesis/SKILL.md` |
| "idea lineage", "trace the lineage of this idea", "how my thinking about", "how has my thinking about", "what is my current version of", "show reversals in my thinking about", "where did this idea come from" | `skills/idea-lineage/SKILL.md` |
| "perplexity research", "what's new about", "current state of", "web research", "what changed about" | `skills/perplexity-research/SKILL.md` |
| "crawl my archive", "find gold in my archive", "archive crawler", "scan my dropbox for", "mine my old files for" | `skills/archive-crawler/SKILL.md` |
| "verify this academic claim", "check this study", "academic verify", "validate citation", "is this study real" | `skills/academic-verify/SKILL.md` |
| "make pdf from brain", "brain pdf", "convert brain page to pdf", "publish this page as pdf", "export brain page" | `skills/brain-pdf/SKILL.md` |
| "voice note", "ingest this voice memo", "transcribe and file", "voice note ingest", "save this audio note" | `skills/voice-note-ingest/SKILL.md` |
| "add a page type", "add a type to my schema", "schema author", "schema mutate", "schema pack add", "my brain has untyped pages", "propose new types from my corpus", "backfill page types", "evolve my schema", "researcher type", "make X an expert type" (dispatcher for: gbrain schema active/list/show/validate/graph/lint/stats/explain/use/downgrade/reload/init/fork/edit/diff/add-type/remove-type/update-type/add-alias/remove-alias/add-prefix/remove-prefix/add-link-type/remove-link-type/set-extractable/set-expert-routing/detect/suggest/review-candidates/review-orphans/sync) | `skills/schema-author/SKILL.md` |
| "unify my types", "migrate to gbrain-base-v2", "94 types to 14", "apply canonical taxonomy", "clean up my page types", "pack upgrade", "shrink type proliferation", "consolidate page types", "retype pages to canonical" (dispatcher for: gbrain onboard --check, gbrain onboard --check --explain, gbrain jobs submit unify-types, gbrain pages restore) | `skills/schema-unify/SKILL.md` |
| "agentic-workflows", "agentic workflows", "awesome copilot agentic workflows" | `skills/agentic-workflows/SKILL.md` |
| "acquire-codebase-knowledge", "acquire codebase knowledge", "awesome copilot acquire codebase knowledge" | `skills/acquire-codebase-knowledge/SKILL.md` |
| "acreadiness-assess", "acreadiness assess", "awesome copilot acreadiness assess" | `skills/acreadiness-assess/SKILL.md` |
| "acreadiness-generate-instructions", "acreadiness generate instructions", "awesome copilot acreadiness generate instructions" | `skills/acreadiness-generate-instructions/SKILL.md` |
| "acreadiness-policy", "acreadiness policy", "awesome copilot acreadiness policy" | `skills/acreadiness-policy/SKILL.md` |
| "add-educational-comments", "add educational comments", "awesome copilot add educational comments" | `skills/add-educational-comments/SKILL.md` |
| "adobe-illustrator-scripting", "adobe illustrator scripting", "awesome copilot adobe illustrator scripting" | `skills/adobe-illustrator-scripting/SKILL.md` |
| "agent-governance", "agent governance", "awesome copilot agent governance" | `skills/agent-governance/SKILL.md` |
| "agent-owasp-compliance", "agent owasp compliance", "awesome copilot agent owasp compliance" | `skills/agent-owasp-compliance/SKILL.md` |
| "agent-supply-chain", "agent supply chain", "awesome copilot agent supply chain" | `skills/agent-supply-chain/SKILL.md` |
| "agentic-eval", "agentic eval", "awesome copilot agentic eval" | `skills/agentic-eval/SKILL.md` |
| "ai-prompt-engineering-safety-review", "ai prompt engineering safety review", "awesome copilot ai prompt engineering safety review" | `skills/ai-prompt-engineering-safety-review/SKILL.md` |
| "ai-ready", "ai ready", "awesome copilot ai ready" | `skills/ai-ready/SKILL.md` |
| "ai-team-orchestration", "ai team orchestration", "awesome copilot ai team orchestration" | `skills/ai-team-orchestration/SKILL.md` |
| "appinsights-instrumentation", "appinsights instrumentation", "awesome copilot appinsights instrumentation" | `skills/appinsights-instrumentation/SKILL.md` |
| "apple-appstore-reviewer", "apple appstore reviewer", "awesome copilot apple appstore reviewer" | `skills/apple-appstore-reviewer/SKILL.md` |
| "arch-linux-triage", "arch linux triage", "awesome copilot arch linux triage" | `skills/arch-linux-triage/SKILL.md` |
| "architecture-blueprint-generator", "architecture blueprint generator", "awesome copilot architecture blueprint generator" | `skills/architecture-blueprint-generator/SKILL.md` |
| "arduino-azure-iot-edge-integration", "arduino azure iot edge integration", "awesome copilot arduino azure iot edge integration" | `skills/arduino-azure-iot-edge-integration/SKILL.md` |
| "arize-ai-provider-integration", "arize ai provider integration", "awesome copilot arize ai provider integration" | `skills/arize-ai-provider-integration/SKILL.md` |
| "arize-annotation", "arize annotation", "awesome copilot arize annotation" | `skills/arize-annotation/SKILL.md` |
| "arize-dataset", "arize dataset", "awesome copilot arize dataset" | `skills/arize-dataset/SKILL.md` |
| "arize-evaluator", "arize evaluator", "awesome copilot arize evaluator" | `skills/arize-evaluator/SKILL.md` |
| "arize-experiment", "arize experiment", "awesome copilot arize experiment" | `skills/arize-experiment/SKILL.md` |
| "arize-instrumentation", "arize instrumentation", "awesome copilot arize instrumentation" | `skills/arize-instrumentation/SKILL.md` |
| "arize-link", "arize link", "awesome copilot arize link" | `skills/arize-link/SKILL.md` |
| "arize-prompt-optimization", "arize prompt optimization", "awesome copilot arize prompt optimization" | `skills/arize-prompt-optimization/SKILL.md` |
| "arize-trace", "arize trace", "awesome copilot arize trace" | `skills/arize-trace/SKILL.md` |
| "aspire", "aspire", "awesome copilot aspire" | `skills/aspire/SKILL.md` |
| "aspnet-minimal-api-openapi", "aspnet minimal api openapi", "awesome copilot aspnet minimal api openapi" | `skills/aspnet-minimal-api-openapi/SKILL.md` |
| "audit-integrity", "audit integrity", "awesome copilot audit integrity" | `skills/audit-integrity/SKILL.md` |
| "automate-this", "automate this", "awesome copilot automate this" | `skills/automate-this/SKILL.md` |
| "autoresearch", "autoresearch", "awesome copilot autoresearch" | `skills/autoresearch/SKILL.md` |
| "aws-cdk-python-setup", "aws cdk python setup", "awesome copilot aws cdk python setup" | `skills/aws-cdk-python-setup/SKILL.md` |
| "aws-cloudwatch-investigation", "aws cloudwatch investigation", "awesome copilot aws cloudwatch investigation" | `skills/aws-cloudwatch-investigation/SKILL.md` |
| "aws-cost-optimize", "aws cost optimize", "awesome copilot aws cost optimize" | `skills/aws-cost-optimize/SKILL.md` |
| "aws-resource-health-diagnose", "aws resource health diagnose", "awesome copilot aws resource health diagnose" | `skills/aws-resource-health-diagnose/SKILL.md` |
| "aws-resource-query", "aws resource query", "awesome copilot aws resource query" | `skills/aws-resource-query/SKILL.md` |
| "aws-well-architected-review", "aws well architected review", "awesome copilot aws well architected review" | `skills/aws-well-architected-review/SKILL.md` |
| "az-cost-optimize", "az cost optimize", "awesome copilot az cost optimize" | `skills/az-cost-optimize/SKILL.md` |
| "azure-architecture-autopilot", "azure architecture autopilot", "awesome copilot azure architecture autopilot" | `skills/azure-architecture-autopilot/SKILL.md` |
| "azure-deployment-preflight", "azure deployment preflight", "awesome copilot azure deployment preflight" | `skills/azure-deployment-preflight/SKILL.md` |
| "azure-devops-cli", "azure devops cli", "awesome copilot azure devops cli" | `skills/azure-devops-cli/SKILL.md` |
| "azure-pricing", "azure pricing", "awesome copilot azure pricing" | `skills/azure-pricing/SKILL.md` |
| "azure-resource-health-diagnose", "azure resource health diagnose", "awesome copilot azure resource health diagnose" | `skills/azure-resource-health-diagnose/SKILL.md` |
| "azure-resource-visualizer", "azure resource visualizer", "awesome copilot azure resource visualizer" | `skills/azure-resource-visualizer/SKILL.md` |
| "azure-role-selector", "azure role selector", "awesome copilot azure role selector" | `skills/azure-role-selector/SKILL.md` |
| "azure-smart-city-iot-solution-builder", "azure smart city iot solution builder", "awesome copilot azure smart city iot solution builder" | `skills/azure-smart-city-iot-solution-builder/SKILL.md` |
| "azure-static-web-apps", "azure static web apps", "awesome copilot azure static web apps" | `skills/azure-static-web-apps/SKILL.md` |
| "batch-files", "batch files", "awesome copilot batch files" | `skills/batch-files/SKILL.md` |
| "bigquery-pipeline-audit", "bigquery pipeline audit", "awesome copilot bigquery pipeline audit" | `skills/bigquery-pipeline-audit/SKILL.md` |
| "boost-prompt", "boost prompt", "awesome copilot boost prompt" | `skills/boost-prompt/SKILL.md` |
| "brag-sheet", "brag sheet", "awesome copilot brag sheet" | `skills/brag-sheet/SKILL.md` |
| "breakdown-epic-arch", "breakdown epic arch", "awesome copilot breakdown epic arch" | `skills/breakdown-epic-arch/SKILL.md` |
| "breakdown-epic-pm", "breakdown epic pm", "awesome copilot breakdown epic pm" | `skills/breakdown-epic-pm/SKILL.md` |
| "breakdown-feature-implementation", "breakdown feature implementation", "awesome copilot breakdown feature implementation" | `skills/breakdown-feature-implementation/SKILL.md` |
| "breakdown-feature-prd", "breakdown feature prd", "awesome copilot breakdown feature prd" | `skills/breakdown-feature-prd/SKILL.md` |
| "breakdown-plan", "breakdown plan", "awesome copilot breakdown plan" | `skills/breakdown-plan/SKILL.md` |
| "breakdown-test", "breakdown test", "awesome copilot breakdown test" | `skills/breakdown-test/SKILL.md` |
| "centos-linux-triage", "centos linux triage", "awesome copilot centos linux triage" | `skills/centos-linux-triage/SKILL.md` |
| "chrome-devtools", "chrome devtools", "awesome copilot chrome devtools" | `skills/chrome-devtools/SKILL.md` |
| "cli-mastery", "cli mastery", "awesome copilot cli mastery" | `skills/cli-mastery/SKILL.md` |
| "cloud-design-patterns", "cloud design patterns", "awesome copilot cloud design patterns" | `skills/cloud-design-patterns/SKILL.md` |
| "code-exemplars-blueprint-generator", "code exemplars blueprint generator", "awesome copilot code exemplars blueprint generator" | `skills/code-exemplars-blueprint-generator/SKILL.md` |
| "code-tour", "code tour", "awesome copilot code tour" | `skills/code-tour/SKILL.md` |
| "codeql", "codeql", "awesome copilot codeql" | `skills/codeql/SKILL.md` |
| "comment-code-generate-a-tutorial", "comment code generate a tutorial", "awesome copilot comment code generate a tutorial" | `skills/comment-code-generate-a-tutorial/SKILL.md` |
| "commit-message-storyteller", "commit message storyteller", "awesome copilot commit message storyteller" | `skills/commit-message-storyteller/SKILL.md` |
| "containerize-aspnet-framework", "containerize aspnet framework", "awesome copilot containerize aspnet framework" | `skills/containerize-aspnet-framework/SKILL.md` |
| "containerize-aspnetcore", "containerize aspnetcore", "awesome copilot containerize aspnetcore" | `skills/containerize-aspnetcore/SKILL.md` |
| "content-management-systems", "content management systems", "awesome copilot content management systems" | `skills/content-management-systems/SKILL.md` |
| "context-map", "context map", "awesome copilot context map" | `skills/context-map/SKILL.md` |
| "conventional-branch", "conventional branch", "awesome copilot conventional branch" | `skills/conventional-branch/SKILL.md` |
| "conventional-commit", "conventional commit", "awesome copilot conventional commit" | `skills/conventional-commit/SKILL.md` |
| "convert-plaintext-to-md", "convert plaintext to md", "awesome copilot convert plaintext to md" | `skills/convert-plaintext-to-md/SKILL.md` |
| "copilot-cli-quickstart", "copilot cli quickstart", "awesome copilot copilot cli quickstart" | `skills/copilot-cli-quickstart/SKILL.md` |
| "copilot-instructions-blueprint-generator", "copilot instructions blueprint generator", "awesome copilot copilot instructions blueprint generator" | `skills/copilot-instructions-blueprint-generator/SKILL.md` |
| "copilot-pr-autopilot", "copilot pr autopilot", "awesome copilot copilot pr autopilot" | `skills/copilot-pr-autopilot/SKILL.md` |
| "copilot-sdk", "copilot sdk", "awesome copilot copilot sdk" | `skills/copilot-sdk/SKILL.md` |
| "copilot-spaces", "copilot spaces", "awesome copilot copilot spaces" | `skills/copilot-spaces/SKILL.md` |
| "copilot-usage-metrics", "copilot usage metrics", "awesome copilot copilot usage metrics" | `skills/copilot-usage-metrics/SKILL.md` |
| "cosmosdb-datamodeling", "cosmosdb datamodeling", "awesome copilot cosmosdb datamodeling" | `skills/cosmosdb-datamodeling/SKILL.md` |
| "create-agentsmd", "create agentsmd", "awesome copilot create agentsmd" | `skills/create-agentsmd/SKILL.md` |
| "create-architectural-decision-record", "create architectural decision record", "awesome copilot create architectural decision record" | `skills/create-architectural-decision-record/SKILL.md` |
| "create-github-action-workflow-specification", "create github action workflow specification", "awesome copilot create github action workflow specification" | `skills/create-github-action-workflow-specification/SKILL.md` |
| "create-github-issue-feature-from-specification", "create github issue feature from specification", "awesome copilot create github issue feature from specification" | `skills/create-github-issue-feature-from-specification/SKILL.md` |
| "create-github-issues-feature-from-implementation-plan", "create github issues feature from implementation plan", "awesome copilot create github issues feature from implementation plan" | `skills/create-github-issues-feature-from-implementation-plan/SKILL.md` |
| "create-github-issues-for-unmet-specification-requirements", "create github issues for unmet specification requirements", "awesome copilot create github issues for unmet specification requirements" | `skills/create-github-issues-for-unmet-specification-requirements/SKILL.md` |
| "create-implementation-plan", "create implementation plan", "awesome copilot create implementation plan" | `skills/create-implementation-plan/SKILL.md` |
| "create-llms", "create llms", "awesome copilot create llms" | `skills/create-llms/SKILL.md` |
| "create-readme", "create readme", "awesome copilot create readme" | `skills/create-readme/SKILL.md` |
| "create-specification", "create specification", "awesome copilot create specification" | `skills/create-specification/SKILL.md` |
| "create-spring-boot-java-project", "create spring boot java project", "awesome copilot create spring boot java project" | `skills/create-spring-boot-java-project/SKILL.md` |
| "create-spring-boot-kotlin-project", "create spring boot kotlin project", "awesome copilot create spring boot kotlin project" | `skills/create-spring-boot-kotlin-project/SKILL.md` |
| "create-technical-spike", "create technical spike", "awesome copilot create technical spike" | `skills/create-technical-spike/SKILL.md` |
| "create-tldr-page", "create tldr page", "awesome copilot create tldr page" | `skills/create-tldr-page/SKILL.md` |
| "creating-oracle-to-postgres-master-migration-plan", "creating oracle to postgres master migration plan", "awesome copilot creating oracle to postgres master migration plan" | `skills/creating-oracle-to-postgres-master-migration-plan/SKILL.md` |
| "creating-oracle-to-postgres-migration-bug-report", "creating oracle to postgres migration bug report", "awesome copilot creating oracle to postgres migration bug report" | `skills/creating-oracle-to-postgres-migration-bug-report/SKILL.md` |
| "creating-oracle-to-postgres-migration-integration-tests", "creating oracle to postgres migration integration tests", "awesome copilot creating oracle to postgres migration integration tests" | `skills/creating-oracle-to-postgres-migration-integration-tests/SKILL.md` |
| "csharp-async", "csharp async", "awesome copilot csharp async" | `skills/csharp-async/SKILL.md` |
| "csharp-docs", "csharp docs", "awesome copilot csharp docs" | `skills/csharp-docs/SKILL.md` |
| "csharp-mstest", "csharp mstest", "awesome copilot csharp mstest" | `skills/csharp-mstest/SKILL.md` |
| "csharp-nunit", "csharp nunit", "awesome copilot csharp nunit" | `skills/csharp-nunit/SKILL.md` |
| "csharp-tunit", "csharp tunit", "awesome copilot csharp tunit" | `skills/csharp-tunit/SKILL.md` |
| "csharp-xunit", "csharp xunit", "awesome copilot csharp xunit" | `skills/csharp-xunit/SKILL.md` |
| "daily-prep", "daily prep", "awesome copilot daily prep" | `skills/daily-prep/SKILL.md` |
| "data-breach-blast-radius", "data breach blast radius", "awesome copilot data breach blast radius" | `skills/data-breach-blast-radius/SKILL.md` |
| "datanalysis-credit-risk", "datanalysis credit risk", "awesome copilot datanalysis credit risk" | `skills/datanalysis-credit-risk/SKILL.md` |
| "dataverse-python-advanced-patterns", "dataverse python advanced patterns", "awesome copilot dataverse python advanced patterns" | `skills/dataverse-python-advanced-patterns/SKILL.md` |
| "dataverse-python-production-code", "dataverse python production code", "awesome copilot dataverse python production code" | `skills/dataverse-python-production-code/SKILL.md` |
| "dataverse-python-quickstart", "dataverse python quickstart", "awesome copilot dataverse python quickstart" | `skills/dataverse-python-quickstart/SKILL.md` |
| "dataverse-python-usecase-builder", "dataverse python usecase builder", "awesome copilot dataverse python usecase builder" | `skills/dataverse-python-usecase-builder/SKILL.md` |
| "debian-linux-triage", "debian linux triage", "awesome copilot debian linux triage" | `skills/debian-linux-triage/SKILL.md` |
| "declarative-agents", "declarative agents", "awesome copilot declarative agents" | `skills/declarative-agents/SKILL.md` |
| "dependabot", "dependabot", "awesome copilot dependabot" | `skills/dependabot/SKILL.md` |
| "devops-rollout-plan", "devops rollout plan", "awesome copilot devops rollout plan" | `skills/devops-rollout-plan/SKILL.md` |
| "diagnose", "diagnose", "awesome copilot diagnose" | `skills/diagnose/SKILL.md` |
| "documentation-writer", "documentation writer", "awesome copilot documentation writer" | `skills/documentation-writer/SKILL.md` |
| "dotnet-best-practices", "dotnet best practices", "awesome copilot dotnet best practices" | `skills/dotnet-best-practices/SKILL.md` |
| "dotnet-design-pattern-review", "dotnet design pattern review", "awesome copilot dotnet design pattern review" | `skills/dotnet-design-pattern-review/SKILL.md` |
| "dotnet-mcp-builder", "dotnet mcp builder", "awesome copilot dotnet mcp builder" | `skills/dotnet-mcp-builder/SKILL.md` |
| "dotnet-timezone", "dotnet timezone", "awesome copilot dotnet timezone" | `skills/dotnet-timezone/SKILL.md` |
| "dotnet-upgrade", "dotnet upgrade", "awesome copilot dotnet upgrade" | `skills/dotnet-upgrade/SKILL.md` |
| "doublecheck", "doublecheck", "awesome copilot doublecheck" | `skills/doublecheck/SKILL.md` |
| "draw-io-diagram-generator", "draw io diagram generator", "awesome copilot draw io diagram generator" | `skills/draw-io-diagram-generator/SKILL.md` |
| "drawio", "drawio", "awesome copilot drawio" | `skills/drawio/SKILL.md` |
| "editorconfig", "editorconfig", "awesome copilot editorconfig" | `skills/editorconfig/SKILL.md` |
| "ef-core", "ef core", "awesome copilot ef core" | `skills/ef-core/SKILL.md` |
| "efcore-d2-db-diagram", "efcore d2 db diagram", "awesome copilot efcore d2 db diagram" | `skills/efcore-d2-db-diagram/SKILL.md` |
| "em-dash", "em dash", "awesome copilot em dash" | `skills/em-dash/SKILL.md` |
| "email-drafter", "email drafter", "awesome copilot email drafter" | `skills/email-drafter/SKILL.md` |
| "entra-agent-user", "entra agent user", "awesome copilot entra agent user" | `skills/entra-agent-user/SKILL.md` |
| "eval-driven-dev", "eval driven dev", "awesome copilot eval driven dev" | `skills/eval-driven-dev/SKILL.md` |
| "exam-ready", "exam ready", "awesome copilot exam ready" | `skills/exam-ready/SKILL.md` |
| "excalidraw-diagram-generator", "excalidraw diagram generator", "awesome copilot excalidraw diagram generator" | `skills/excalidraw-diagram-generator/SKILL.md` |
| "eyeball", "eyeball", "awesome copilot eyeball" | `skills/eyeball/SKILL.md` |
| "fabric-lakehouse", "fabric lakehouse", "awesome copilot fabric lakehouse" | `skills/fabric-lakehouse/SKILL.md` |
| "fedora-linux-triage", "fedora linux triage", "awesome copilot fedora linux triage" | `skills/fedora-linux-triage/SKILL.md` |
| "finalize-agent-prompt", "finalize agent prompt", "awesome copilot finalize agent prompt" | `skills/finalize-agent-prompt/SKILL.md` |
| "finnish-humanizer", "finnish humanizer", "awesome copilot finnish humanizer" | `skills/finnish-humanizer/SKILL.md` |
| "first-ask", "first ask", "awesome copilot first ask" | `skills/first-ask/SKILL.md` |
| "flowstudio-power-automate-build", "flowstudio power automate build", "awesome copilot flowstudio power automate build" | `skills/flowstudio-power-automate-build/SKILL.md` |
| "flowstudio-power-automate-debug", "flowstudio power automate debug", "awesome copilot flowstudio power automate debug" | `skills/flowstudio-power-automate-debug/SKILL.md` |
| "flowstudio-power-automate-governance", "flowstudio power automate governance", "awesome copilot flowstudio power automate governance" | `skills/flowstudio-power-automate-governance/SKILL.md` |
| "flowstudio-power-automate-mcp", "flowstudio power automate mcp", "awesome copilot flowstudio power automate mcp" | `skills/flowstudio-power-automate-mcp/SKILL.md` |
| "flowstudio-power-automate-monitoring", "flowstudio power automate monitoring", "awesome copilot flowstudio power automate monitoring" | `skills/flowstudio-power-automate-monitoring/SKILL.md` |
| "fluentui-blazor", "fluentui blazor", "awesome copilot fluentui blazor" | `skills/fluentui-blazor/SKILL.md` |
| "folder-structure-blueprint-generator", "folder structure blueprint generator", "awesome copilot folder structure blueprint generator" | `skills/folder-structure-blueprint-generator/SKILL.md` |
| "foundry-agent-sync", "foundry agent sync", "awesome copilot foundry agent sync" | `skills/foundry-agent-sync/SKILL.md` |
| "foundry-hosted-agent-copilotkit", "foundry hosted agent copilotkit", "awesome copilot foundry hosted agent copilotkit" | `skills/foundry-hosted-agent-copilotkit/SKILL.md` |
| "freecad-scripts", "freecad scripts", "awesome copilot freecad scripts" | `skills/freecad-scripts/SKILL.md` |
| "from-the-other-side-anitta", "from the other side anitta", "awesome copilot from the other side anitta" | `skills/from-the-other-side-anitta/SKILL.md` |
| "from-the-other-side-quinn", "from the other side quinn", "awesome copilot from the other side quinn" | `skills/from-the-other-side-quinn/SKILL.md` |
| "from-the-other-side-vega", "from the other side vega", "awesome copilot from the other side vega" | `skills/from-the-other-side-vega/SKILL.md` |
| "from-the-other-side-wiggins", "from the other side wiggins", "awesome copilot from the other side wiggins" | `skills/from-the-other-side-wiggins/SKILL.md` |
| "game-engine", "game engine", "awesome copilot game engine" | `skills/game-engine/SKILL.md` |
| "gdpr-compliant", "gdpr compliant", "awesome copilot gdpr compliant" | `skills/gdpr-compliant/SKILL.md` |
| "gen-specs-as-issues", "gen specs as issues", "awesome copilot gen specs as issues" | `skills/gen-specs-as-issues/SKILL.md` |
| "generate-custom-instructions-from-codebase", "generate custom instructions from codebase", "awesome copilot generate custom instructions from codebase" | `skills/generate-custom-instructions-from-codebase/SKILL.md` |
| "generate-image", "generate image", "awesome copilot generate image" | `skills/generate-image/SKILL.md` |
| "geofeed-tuner", "geofeed tuner", "awesome copilot geofeed tuner" | `skills/geofeed-tuner/SKILL.md` |
| "git-commit", "git commit", "awesome copilot git commit" | `skills/git-commit/SKILL.md` |
| "git-flow-branch-creator", "git flow branch creator", "awesome copilot git flow branch creator" | `skills/git-flow-branch-creator/SKILL.md` |
| "github-actions-efficiency", "github actions efficiency", "awesome copilot github actions efficiency" | `skills/github-actions-efficiency/SKILL.md` |
| "github-actions-hardening", "github actions hardening", "awesome copilot github actions hardening" | `skills/github-actions-hardening/SKILL.md` |
| "github-actions-runtime-upgrade-conventions", "github actions runtime upgrade conventions", "awesome copilot github actions runtime upgrade conventions" | `skills/github-actions-runtime-upgrade-conventions/SKILL.md` |
| "github-codespaces-efficiency", "github codespaces efficiency", "awesome copilot github codespaces efficiency" | `skills/github-codespaces-efficiency/SKILL.md` |
| "github-copilot-starter", "github copilot starter", "awesome copilot github copilot starter" | `skills/github-copilot-starter/SKILL.md` |
| "github-release", "github release", "awesome copilot github release" | `skills/github-release/SKILL.md` |
| "go-mcp-server-generator", "go mcp server generator", "awesome copilot go mcp server generator" | `skills/go-mcp-server-generator/SKILL.md` |
| "gsap-framer-scroll-animation", "gsap framer scroll animation", "awesome copilot gsap framer scroll animation" | `skills/gsap-framer-scroll-animation/SKILL.md` |
| "gtm-0-to-1-launch", "gtm 0 to 1 launch", "awesome copilot gtm 0 to 1 launch" | `skills/gtm-0-to-1-launch/SKILL.md` |
| "gtm-ai-gtm", "gtm ai gtm", "awesome copilot gtm ai gtm" | `skills/gtm-ai-gtm/SKILL.md` |
| "gtm-board-and-investor-communication", "gtm board and investor communication", "awesome copilot gtm board and investor communication" | `skills/gtm-board-and-investor-communication/SKILL.md` |
| "gtm-developer-ecosystem", "gtm developer ecosystem", "awesome copilot gtm developer ecosystem" | `skills/gtm-developer-ecosystem/SKILL.md` |
| "gtm-enterprise-account-planning", "gtm enterprise account planning", "awesome copilot gtm enterprise account planning" | `skills/gtm-enterprise-account-planning/SKILL.md` |
| "gtm-enterprise-onboarding", "gtm enterprise onboarding", "awesome copilot gtm enterprise onboarding" | `skills/gtm-enterprise-onboarding/SKILL.md` |
| "gtm-operating-cadence", "gtm operating cadence", "awesome copilot gtm operating cadence" | `skills/gtm-operating-cadence/SKILL.md` |
| "gtm-partnership-architecture", "gtm partnership architecture", "awesome copilot gtm partnership architecture" | `skills/gtm-partnership-architecture/SKILL.md` |
| "gtm-positioning-strategy", "gtm positioning strategy", "awesome copilot gtm positioning strategy" | `skills/gtm-positioning-strategy/SKILL.md` |
| "gtm-product-led-growth", "gtm product led growth", "awesome copilot gtm product led growth" | `skills/gtm-product-led-growth/SKILL.md` |
| "gtm-technical-product-pricing", "gtm technical product pricing", "awesome copilot gtm technical product pricing" | `skills/gtm-technical-product-pricing/SKILL.md` |
| "harness-engineering", "harness engineering", "awesome copilot harness engineering" | `skills/harness-engineering/SKILL.md` |
| "image-annotations", "image annotations", "awesome copilot image annotations" | `skills/image-annotations/SKILL.md` |
| "image-manipulation-image-magick", "image manipulation image magick", "awesome copilot image manipulation image magick" | `skills/image-manipulation-image-magick/SKILL.md` |
| "impediment-prioritization", "impediment prioritization", "awesome copilot impediment prioritization" | `skills/impediment-prioritization/SKILL.md` |
| "import-infrastructure-as-code", "import infrastructure as code", "awesome copilot import infrastructure as code" | `skills/import-infrastructure-as-code/SKILL.md` |
| "incident-postmortem", "incident postmortem", "awesome copilot incident postmortem" | `skills/incident-postmortem/SKILL.md` |
| "integrate-context-matic", "integrate context matic", "awesome copilot integrate context matic" | `skills/integrate-context-matic/SKILL.md` |
| "issue-fields-migration", "issue fields migration", "awesome copilot issue fields migration" | `skills/issue-fields-migration/SKILL.md` |
| "java-add-graalvm-native-image-support", "java add graalvm native image support", "awesome copilot java add graalvm native image support" | `skills/java-add-graalvm-native-image-support/SKILL.md` |
| "java-docs", "java docs", "awesome copilot java docs" | `skills/java-docs/SKILL.md` |
| "java-junit", "java junit", "awesome copilot java junit" | `skills/java-junit/SKILL.md` |
| "java-mcp-server-generator", "java mcp server generator", "awesome copilot java mcp server generator" | `skills/java-mcp-server-generator/SKILL.md` |
| "java-refactoring-extract-method", "java refactoring extract method", "awesome copilot java refactoring extract method" | `skills/java-refactoring-extract-method/SKILL.md` |
| "java-refactoring-remove-parameter", "java refactoring remove parameter", "awesome copilot java refactoring remove parameter" | `skills/java-refactoring-remove-parameter/SKILL.md` |
| "java-springboot", "java springboot", "awesome copilot java springboot" | `skills/java-springboot/SKILL.md` |
| "javascript-typescript-jest", "javascript typescript jest", "awesome copilot javascript typescript jest" | `skills/javascript-typescript-jest/SKILL.md` |
| "javax-to-jakarta-migration", "javax to jakarta migration", "awesome copilot javax to jakarta migration" | `skills/javax-to-jakarta-migration/SKILL.md` |
| "kotlin-mcp-server-generator", "kotlin mcp server generator", "awesome copilot kotlin mcp server generator" | `skills/kotlin-mcp-server-generator/SKILL.md` |
| "kotlin-springboot", "kotlin springboot", "awesome copilot kotlin springboot" | `skills/kotlin-springboot/SKILL.md` |
| "legacy-circuit-mockups", "legacy circuit mockups", "awesome copilot legacy circuit mockups" | `skills/legacy-circuit-mockups/SKILL.md` |
| "linkedin-post-formatter", "linkedin post formatter", "awesome copilot linkedin post formatter" | `skills/linkedin-post-formatter/SKILL.md` |
| "lsp-setup", "lsp setup", "awesome copilot lsp setup" | `skills/lsp-setup/SKILL.md` |
| "make-repo-contribution", "make repo contribution", "awesome copilot make repo contribution" | `skills/make-repo-contribution/SKILL.md` |
| "markdown-to-html", "markdown to html", "awesome copilot markdown to html" | `skills/markdown-to-html/SKILL.md` |
| "mcp-cli", "mcp cli", "awesome copilot mcp cli" | `skills/mcp-cli/SKILL.md` |
| "mcp-copilot-studio-server-generator", "mcp copilot studio server generator", "awesome copilot mcp copilot studio server generator" | `skills/mcp-copilot-studio-server-generator/SKILL.md` |
| "mcp-create-adaptive-cards", "mcp create adaptive cards", "awesome copilot mcp create adaptive cards" | `skills/mcp-create-adaptive-cards/SKILL.md` |
| "mcp-create-declarative-agent", "mcp create declarative agent", "awesome copilot mcp create declarative agent" | `skills/mcp-create-declarative-agent/SKILL.md` |
| "mcp-deploy-manage-agents", "mcp deploy manage agents", "awesome copilot mcp deploy manage agents" | `skills/mcp-deploy-manage-agents/SKILL.md` |
| "mcp-security-audit", "mcp security audit", "awesome copilot mcp security audit" | `skills/mcp-security-audit/SKILL.md` |
| "mcp-security-baseline", "mcp security baseline", "awesome copilot mcp security baseline" | `skills/mcp-security-baseline/SKILL.md` |
| "md-to-docx", "md to docx", "awesome copilot md to docx" | `skills/md-to-docx/SKILL.md` |
| "meeting-minutes", "meeting minutes", "awesome copilot meeting minutes" | `skills/meeting-minutes/SKILL.md` |
| "memory-merger", "memory merger", "awesome copilot memory merger" | `skills/memory-merger/SKILL.md` |
| "mentoring-juniors", "mentoring juniors", "awesome copilot mentoring juniors" | `skills/mentoring-juniors/SKILL.md` |
| "microsoft-agent-framework", "microsoft agent framework", "awesome copilot microsoft agent framework" | `skills/microsoft-agent-framework/SKILL.md` |
| "microsoft-code-reference", "microsoft code reference", "awesome copilot microsoft code reference" | `skills/microsoft-code-reference/SKILL.md` |
| "microsoft-docs", "microsoft docs", "awesome copilot microsoft docs" | `skills/microsoft-docs/SKILL.md` |
| "microsoft-skill-creator", "microsoft skill creator", "awesome copilot microsoft skill creator" | `skills/microsoft-skill-creator/SKILL.md` |
| "migrating-oracle-to-postgres-stored-procedures", "migrating oracle to postgres stored procedures", "awesome copilot migrating oracle to postgres stored procedures" | `skills/migrating-oracle-to-postgres-stored-procedures/SKILL.md` |
| "minecraft-plugin-development", "minecraft plugin development", "awesome copilot minecraft plugin development" | `skills/minecraft-plugin-development/SKILL.md` |
| "mini-context-graph", "mini context graph", "awesome copilot mini context graph" | `skills/mini-context-graph/SKILL.md` |
| "mkdocs-translations", "mkdocs translations", "awesome copilot mkdocs translations" | `skills/mkdocs-translations/SKILL.md` |
| "msgraph-sdk", "msgraph sdk", "awesome copilot msgraph sdk" | `skills/msgraph-sdk/SKILL.md` |
| "msstore-cli", "msstore cli", "awesome copilot msstore cli" | `skills/msstore-cli/SKILL.md` |
| "multi-stage-dockerfile", "multi stage dockerfile", "awesome copilot multi stage dockerfile" | `skills/multi-stage-dockerfile/SKILL.md` |
| "mvvm-toolkit", "mvvm toolkit", "awesome copilot mvvm toolkit" | `skills/mvvm-toolkit/SKILL.md` |
| "mvvm-toolkit-di", "mvvm toolkit di", "awesome copilot mvvm toolkit di" | `skills/mvvm-toolkit-di/SKILL.md` |
| "mvvm-toolkit-messenger", "mvvm toolkit messenger", "awesome copilot mvvm toolkit messenger" | `skills/mvvm-toolkit-messenger/SKILL.md` |
| "namecheap", "namecheap", "awesome copilot namecheap" | `skills/namecheap/SKILL.md` |
| "nano-banana-pro-openrouter", "nano banana pro openrouter", "awesome copilot nano banana pro openrouter" | `skills/nano-banana-pro-openrouter/SKILL.md` |
| "napkin", "napkin", "awesome copilot napkin" | `skills/napkin/SKILL.md` |
| "next-intl-add-language", "next intl add language", "awesome copilot next intl add language" | `skills/next-intl-add-language/SKILL.md` |
| "noob-mode", "noob mode", "awesome copilot noob mode" | `skills/noob-mode/SKILL.md` |
| "nuget-manager", "nuget manager", "awesome copilot nuget manager" | `skills/nuget-manager/SKILL.md` |
| "onboard-context-matic", "onboard context matic", "awesome copilot onboard context matic" | `skills/onboard-context-matic/SKILL.md` |
| "oo-component-documentation", "oo component documentation", "awesome copilot oo component documentation" | `skills/oo-component-documentation/SKILL.md` |
| "openapi-to-application-code", "openapi to application code", "awesome copilot openapi to application code" | `skills/openapi-to-application-code/SKILL.md` |
| "optimize-simplicite-logs", "optimize simplicite logs", "awesome copilot optimize simplicite logs" | `skills/optimize-simplicite-logs/SKILL.md` |
| "pdftk-server", "pdftk server", "awesome copilot pdftk server" | `skills/pdftk-server/SKILL.md` |
| "penpot-uiux-design", "penpot uiux design", "awesome copilot penpot uiux design" | `skills/penpot-uiux-design/SKILL.md` |
| "performance-review-writer", "performance review writer", "awesome copilot performance review writer" | `skills/performance-review-writer/SKILL.md` |
| "pester-migration", "pester migration", "awesome copilot pester migration" | `skills/pester-migration/SKILL.md` |
| "pester-should-migration", "pester should migration", "awesome copilot pester should migration" | `skills/pester-should-migration/SKILL.md` |
| "phoenix-cli", "phoenix cli", "awesome copilot phoenix cli" | `skills/phoenix-cli/SKILL.md` |
| "phoenix-evals", "phoenix evals", "awesome copilot phoenix evals" | `skills/phoenix-evals/SKILL.md` |
| "phoenix-tracing", "phoenix tracing", "awesome copilot phoenix tracing" | `skills/phoenix-tracing/SKILL.md` |
| "php-mcp-server-generator", "php mcp server generator", "awesome copilot php mcp server generator" | `skills/php-mcp-server-generator/SKILL.md` |
| "pinecone-rag", "pinecone rag", "awesome copilot pinecone rag" | `skills/pinecone-rag/SKILL.md` |
| "planning-oracle-to-postgres-migration-integration-testing", "planning oracle to postgres migration integration testing", "awesome copilot planning oracle to postgres migration integration testing" | `skills/planning-oracle-to-postgres-migration-integration-testing/SKILL.md` |
| "plantuml-ascii", "plantuml ascii", "awesome copilot plantuml ascii" | `skills/plantuml-ascii/SKILL.md` |
| "playwright-automation-fill-in-form", "playwright automation fill in form", "awesome copilot playwright automation fill in form" | `skills/playwright-automation-fill-in-form/SKILL.md` |
| "playwright-explore-website", "playwright explore website", "awesome copilot playwright explore website" | `skills/playwright-explore-website/SKILL.md` |
| "playwright-generate-test", "playwright generate test", "awesome copilot playwright generate test" | `skills/playwright-generate-test/SKILL.md` |
| "postgresql-code-review", "postgresql code review", "awesome copilot postgresql code review" | `skills/postgresql-code-review/SKILL.md` |
| "postgresql-optimization", "postgresql optimization", "awesome copilot postgresql optimization" | `skills/postgresql-optimization/SKILL.md` |
| "power-apps-code-app-scaffold", "power apps code app scaffold", "awesome copilot power apps code app scaffold" | `skills/power-apps-code-app-scaffold/SKILL.md` |
| "power-bi-dax-optimization", "power bi dax optimization", "awesome copilot power bi dax optimization" | `skills/power-bi-dax-optimization/SKILL.md` |
| "power-bi-model-design-review", "power bi model design review", "awesome copilot power bi model design review" | `skills/power-bi-model-design-review/SKILL.md` |
| "power-bi-performance-troubleshooting", "power bi performance troubleshooting", "awesome copilot power bi performance troubleshooting" | `skills/power-bi-performance-troubleshooting/SKILL.md` |
| "power-bi-report-design-consultation", "power bi report design consultation", "awesome copilot power bi report design consultation" | `skills/power-bi-report-design-consultation/SKILL.md` |
| "power-platform-architect", "power platform architect", "awesome copilot power platform architect" | `skills/power-platform-architect/SKILL.md` |
| "power-platform-mcp-connector-suite", "power platform mcp connector suite", "awesome copilot power platform mcp connector suite" | `skills/power-platform-mcp-connector-suite/SKILL.md` |
| "powerbi-modeling", "powerbi modeling", "awesome copilot powerbi modeling" | `skills/powerbi-modeling/SKILL.md` |
| "pr-dashboard", "pr dashboard", "awesome copilot pr dashboard" | `skills/pr-dashboard/SKILL.md` |
| "pr-screenshots", "pr screenshots", "awesome copilot pr screenshots" | `skills/pr-screenshots/SKILL.md` |
| "prd", "prd", "awesome copilot prd" | `skills/prd/SKILL.md` |
| "premium-frontend-ui", "premium frontend ui", "awesome copilot premium frontend ui" | `skills/premium-frontend-ui/SKILL.md` |
| "project-workflow-analysis-blueprint-generator", "project workflow analysis blueprint generator", "awesome copilot project workflow analysis blueprint generator" | `skills/project-workflow-analysis-blueprint-generator/SKILL.md` |
| "prompt-optimizer", "prompt optimizer", "awesome copilot prompt optimizer" | `skills/prompt-optimizer/SKILL.md` |
| "publish-to-pages", "publish to pages", "awesome copilot publish to pages" | `skills/publish-to-pages/SKILL.md` |
| "pytest-coverage", "pytest coverage", "awesome copilot pytest coverage" | `skills/pytest-coverage/SKILL.md` |
| "python-azure-iot-edge-modules", "python azure iot edge modules", "awesome copilot python azure iot edge modules" | `skills/python-azure-iot-edge-modules/SKILL.md` |
| "python-mcp-server-generator", "python mcp server generator", "awesome copilot python mcp server generator" | `skills/python-mcp-server-generator/SKILL.md` |
| "python-pypi-package-builder", "python pypi package builder", "awesome copilot python pypi package builder" | `skills/python-pypi-package-builder/SKILL.md` |
| "qdrant-clients-sdk", "qdrant clients sdk", "awesome copilot qdrant clients sdk" | `skills/qdrant-clients-sdk/SKILL.md` |
| "qdrant-deployment-options", "qdrant deployment options", "awesome copilot qdrant deployment options" | `skills/qdrant-deployment-options/SKILL.md` |
| "qdrant-model-migration", "qdrant model migration", "awesome copilot qdrant model migration" | `skills/qdrant-model-migration/SKILL.md` |
| "qdrant-monitoring", "qdrant monitoring", "awesome copilot qdrant monitoring" | `skills/qdrant-monitoring/SKILL.md` |
| "qdrant-monitoring-debugging", "qdrant monitoring debugging", "awesome copilot qdrant monitoring debugging" | `skills/qdrant-monitoring-debugging/SKILL.md` |
| "qdrant-monitoring-setup", "qdrant monitoring setup", "awesome copilot qdrant monitoring setup" | `skills/qdrant-monitoring-setup/SKILL.md` |
| "qdrant-performance-optimization", "qdrant performance optimization", "awesome copilot qdrant performance optimization" | `skills/qdrant-performance-optimization/SKILL.md` |
| "qdrant-indexing-performance-optimization", "qdrant indexing performance optimization", "awesome copilot qdrant indexing performance optimization" | `skills/qdrant-indexing-performance-optimization/SKILL.md` |
| "qdrant-memory-usage-optimization", "qdrant memory usage optimization", "awesome copilot qdrant memory usage optimization" | `skills/qdrant-memory-usage-optimization/SKILL.md` |
| "qdrant-search-speed-optimization", "qdrant search speed optimization", "awesome copilot qdrant search speed optimization" | `skills/qdrant-search-speed-optimization/SKILL.md` |
| "qdrant-scaling", "qdrant scaling", "awesome copilot qdrant scaling" | `skills/qdrant-scaling/SKILL.md` |
| "qdrant-minimize-latency", "qdrant minimize latency", "awesome copilot qdrant minimize latency" | `skills/qdrant-minimize-latency/SKILL.md` |
| "qdrant-scaling-data-volume", "qdrant scaling data volume", "awesome copilot qdrant scaling data volume" | `skills/qdrant-scaling-data-volume/SKILL.md` |
| "qdrant-horizontal-scaling", "qdrant horizontal scaling", "awesome copilot qdrant horizontal scaling" | `skills/qdrant-horizontal-scaling/SKILL.md` |
| "qdrant-sliding-time-window", "qdrant sliding time window", "awesome copilot qdrant sliding time window" | `skills/qdrant-sliding-time-window/SKILL.md` |
| "qdrant-tenant-scaling", "qdrant tenant scaling", "awesome copilot qdrant tenant scaling" | `skills/qdrant-tenant-scaling/SKILL.md` |
| "qdrant-vertical-scaling", "qdrant vertical scaling", "awesome copilot qdrant vertical scaling" | `skills/qdrant-vertical-scaling/SKILL.md` |
| "qdrant-scaling-qps", "qdrant scaling qps", "awesome copilot qdrant scaling qps" | `skills/qdrant-scaling-qps/SKILL.md` |
| "qdrant-scaling-query-volume", "qdrant scaling query volume", "awesome copilot qdrant scaling query volume" | `skills/qdrant-scaling-query-volume/SKILL.md` |
| "qdrant-search-quality", "qdrant search quality", "awesome copilot qdrant search quality" | `skills/qdrant-search-quality/SKILL.md` |
| "qdrant-search-quality-diagnosis", "qdrant search quality diagnosis", "awesome copilot qdrant search quality diagnosis" | `skills/qdrant-search-quality-diagnosis/SKILL.md` |
| "qdrant-search-strategies", "qdrant search strategies", "awesome copilot qdrant search strategies" | `skills/qdrant-search-strategies/SKILL.md` |
| "qdrant-version-upgrade", "qdrant version upgrade", "awesome copilot qdrant version upgrade" | `skills/qdrant-version-upgrade/SKILL.md` |
| "quality-playbook", "quality playbook", "awesome copilot quality playbook" | `skills/quality-playbook/SKILL.md` |
| "quasi-coder", "quasi coder", "awesome copilot quasi coder" | `skills/quasi-coder/SKILL.md` |
| "react-audit-grep-patterns", "react audit grep patterns", "awesome copilot react audit grep patterns" | `skills/react-audit-grep-patterns/SKILL.md` |
| "react-container-presentation-component", "react container presentation component", "awesome copilot react container presentation component" | `skills/react-container-presentation-component/SKILL.md` |
| "react18-batching-patterns", "react18 batching patterns", "awesome copilot react18 batching patterns" | `skills/react18-batching-patterns/SKILL.md` |
| "react18-dep-compatibility", "react18 dep compatibility", "awesome copilot react18 dep compatibility" | `skills/react18-dep-compatibility/SKILL.md` |
| "react18-enzyme-to-rtl", "react18 enzyme to rtl", "awesome copilot react18 enzyme to rtl" | `skills/react18-enzyme-to-rtl/SKILL.md` |
| "react18-legacy-context", "react18 legacy context", "awesome copilot react18 legacy context" | `skills/react18-legacy-context/SKILL.md` |
| "react18-lifecycle-patterns", "react18 lifecycle patterns", "awesome copilot react18 lifecycle patterns" | `skills/react18-lifecycle-patterns/SKILL.md` |
| "react18-string-refs", "react18 string refs", "awesome copilot react18 string refs" | `skills/react18-string-refs/SKILL.md` |
| "react19-concurrent-patterns", "react19 concurrent patterns", "awesome copilot react19 concurrent patterns" | `skills/react19-concurrent-patterns/SKILL.md` |
| "react19-source-patterns", "react19 source patterns", "awesome copilot react19 source patterns" | `skills/react19-source-patterns/SKILL.md` |
| "react19-test-patterns", "react19 test patterns", "awesome copilot react19 test patterns" | `skills/react19-test-patterns/SKILL.md` |
| "readme-blueprint-generator", "readme blueprint generator", "awesome copilot readme blueprint generator" | `skills/readme-blueprint-generator/SKILL.md` |
| "refactor", "refactor", "awesome copilot refactor" | `skills/refactor/SKILL.md` |
| "refactor-method-complexity-reduce", "refactor method complexity reduce", "awesome copilot refactor method complexity reduce" | `skills/refactor-method-complexity-reduce/SKILL.md` |
| "refactor-plan", "refactor plan", "awesome copilot refactor plan" | `skills/refactor-plan/SKILL.md` |
| "remember", "remember", "awesome copilot remember" | `skills/remember/SKILL.md` |
| "remember-interactive-programming", "remember interactive programming", "awesome copilot remember interactive programming" | `skills/remember-interactive-programming/SKILL.md` |
| "repo-story-time", "repo story time", "awesome copilot repo story time" | `skills/repo-story-time/SKILL.md` |
| "resemble-detect", "resemble detect", "awesome copilot resemble detect" | `skills/resemble-detect/SKILL.md` |
| "review-and-refactor", "review and refactor", "awesome copilot review and refactor" | `skills/review-and-refactor/SKILL.md` |
| "reviewing-oracle-to-postgres-migration", "reviewing oracle to postgres migration", "awesome copilot reviewing oracle to postgres migration" | `skills/reviewing-oracle-to-postgres-migration/SKILL.md` |
| "rhino3d-scripts", "rhino3d scripts", "awesome copilot rhino3d scripts" | `skills/rhino3d-scripts/SKILL.md` |
| "roundup", "roundup", "awesome copilot roundup" | `skills/roundup/SKILL.md` |
| "roundup-setup", "roundup setup", "awesome copilot roundup setup" | `skills/roundup-setup/SKILL.md` |
| "ruby-mcp-server-generator", "ruby mcp server generator", "awesome copilot ruby mcp server generator" | `skills/ruby-mcp-server-generator/SKILL.md` |
| "ruff-recursive-fix", "ruff recursive fix", "awesome copilot ruff recursive fix" | `skills/ruff-recursive-fix/SKILL.md` |
| "rust-mcp-server-generator", "rust mcp server generator", "awesome copilot rust mcp server generator" | `skills/rust-mcp-server-generator/SKILL.md` |
| "salesforce-apex-quality", "salesforce apex quality", "awesome copilot salesforce apex quality" | `skills/salesforce-apex-quality/SKILL.md` |
| "salesforce-component-standards", "salesforce component standards", "awesome copilot salesforce component standards" | `skills/salesforce-component-standards/SKILL.md` |
| "salesforce-flow-design", "salesforce flow design", "awesome copilot salesforce flow design" | `skills/salesforce-flow-design/SKILL.md` |
| "sandbox-npm-install", "sandbox npm install", "awesome copilot sandbox npm install" | `skills/sandbox-npm-install/SKILL.md` |
| "scaffolding-oracle-to-postgres-migration-test-project", "scaffolding oracle to postgres migration test project", "awesome copilot scaffolding oracle to postgres migration test project" | `skills/scaffolding-oracle-to-postgres-migration-test-project/SKILL.md` |
| "scoutqa-test", "scoutqa test", "awesome copilot scoutqa test" | `skills/scoutqa-test/SKILL.md` |
| "screen-recording", "screen recording", "awesome copilot screen recording" | `skills/screen-recording/SKILL.md` |
| "secret-scanning", "secret scanning", "awesome copilot secret scanning" | `skills/secret-scanning/SKILL.md` |
| "security-review", "security review", "awesome copilot security review" | `skills/security-review/SKILL.md` |
| "semantic-kernel", "semantic kernel", "awesome copilot semantic kernel" | `skills/semantic-kernel/SKILL.md` |
| "setup-my-iq", "setup my iq", "awesome copilot setup my iq" | `skills/setup-my-iq/SKILL.md` |
| "shuffle-json-data", "shuffle json data", "awesome copilot shuffle json data" | `skills/shuffle-json-data/SKILL.md` |
| "slang-shader-engineer", "slang shader engineer", "awesome copilot slang shader engineer" | `skills/slang-shader-engineer/SKILL.md` |
| "snowflake-semanticview", "snowflake semanticview", "awesome copilot snowflake semanticview" | `skills/snowflake-semanticview/SKILL.md` |
| "sponsor-finder", "sponsor finder", "awesome copilot sponsor finder" | `skills/sponsor-finder/SKILL.md` |
| "spring-boot-testing", "spring boot testing", "awesome copilot spring boot testing" | `skills/spring-boot-testing/SKILL.md` |
| "sql-code-review", "sql code review", "awesome copilot sql code review" | `skills/sql-code-review/SKILL.md` |
| "sql-optimization", "sql optimization", "awesome copilot sql optimization" | `skills/sql-optimization/SKILL.md` |
| "sql-server-table-reconciliation", "sql server table reconciliation", "awesome copilot sql server table reconciliation" | `skills/sql-server-table-reconciliation/SKILL.md` |
| "ssma-console", "ssma console", "awesome copilot ssma console" | `skills/ssma-console/SKILL.md` |
| "structured-autonomy-generate", "structured autonomy generate", "awesome copilot structured autonomy generate" | `skills/structured-autonomy-generate/SKILL.md` |
| "structured-autonomy-implement", "structured autonomy implement", "awesome copilot structured autonomy implement" | `skills/structured-autonomy-implement/SKILL.md` |
| "structured-autonomy-plan", "structured autonomy plan", "awesome copilot structured autonomy plan" | `skills/structured-autonomy-plan/SKILL.md` |
| "suggest-awesome-github-copilot-agents", "suggest awesome github copilot agents", "awesome copilot suggest awesome github copilot agents" | `skills/suggest-awesome-github-copilot-agents/SKILL.md` |
| "suggest-awesome-github-copilot-instructions", "suggest awesome github copilot instructions", "awesome copilot suggest awesome github copilot instructions" | `skills/suggest-awesome-github-copilot-instructions/SKILL.md` |
| "suggest-awesome-github-copilot-skills", "suggest awesome github copilot skills", "awesome copilot suggest awesome github copilot skills" | `skills/suggest-awesome-github-copilot-skills/SKILL.md` |
| "swift-mcp-server-generator", "swift mcp server generator", "awesome copilot swift mcp server generator" | `skills/swift-mcp-server-generator/SKILL.md` |
| "technical-job-search", "technical job search", "awesome copilot technical job search" | `skills/technical-job-search/SKILL.md` |
| "technology-stack-blueprint-generator", "technology stack blueprint generator", "awesome copilot technology stack blueprint generator" | `skills/technology-stack-blueprint-generator/SKILL.md` |
| "terraform-azurerm-set-diff-analyzer", "terraform azurerm set diff analyzer", "awesome copilot terraform azurerm set diff analyzer" | `skills/terraform-azurerm-set-diff-analyzer/SKILL.md` |
| "threat-model-analyst", "threat model analyst", "awesome copilot threat model analyst" | `skills/threat-model-analyst/SKILL.md` |
| "tiny-stepping", "tiny stepping", "awesome copilot tiny stepping" | `skills/tiny-stepping/SKILL.md` |
| "tldr-prompt", "tldr prompt", "awesome copilot tldr prompt" | `skills/tldr-prompt/SKILL.md` |
| "transloadit-media-processing", "transloadit media processing", "awesome copilot transloadit media processing" | `skills/transloadit-media-processing/SKILL.md` |
| "typescript-mcp-server-generator", "typescript mcp server generator", "awesome copilot typescript mcp server generator" | `skills/typescript-mcp-server-generator/SKILL.md` |
| "typespec-api-operations", "typespec api operations", "awesome copilot typespec api operations" | `skills/typespec-api-operations/SKILL.md` |
| "typespec-create-agent", "typespec create agent", "awesome copilot typespec create agent" | `skills/typespec-create-agent/SKILL.md` |
| "typespec-create-api-plugin", "typespec create api plugin", "awesome copilot typespec create api plugin" | `skills/typespec-create-api-plugin/SKILL.md` |
| "ui-screenshots", "ui screenshots", "awesome copilot ui screenshots" | `skills/ui-screenshots/SKILL.md` |
| "unit-test-vue-pinia", "unit test vue pinia", "awesome copilot unit test vue pinia" | `skills/unit-test-vue-pinia/SKILL.md` |
| "update-avm-modules-in-bicep", "update avm modules in bicep", "awesome copilot update avm modules in bicep" | `skills/update-avm-modules-in-bicep/SKILL.md` |
| "update-implementation-plan", "update implementation plan", "awesome copilot update implementation plan" | `skills/update-implementation-plan/SKILL.md` |
| "update-llms", "update llms", "awesome copilot update llms" | `skills/update-llms/SKILL.md` |
| "update-markdown-file-index", "update markdown file index", "awesome copilot update markdown file index" | `skills/update-markdown-file-index/SKILL.md` |
| "update-specification", "update specification", "awesome copilot update specification" | `skills/update-specification/SKILL.md` |
| "vardoger-analyze", "vardoger analyze", "awesome copilot vardoger analyze" | `skills/vardoger-analyze/SKILL.md` |
| "vscode-ext-commands", "vscode ext commands", "awesome copilot vscode ext commands" | `skills/vscode-ext-commands/SKILL.md` |
| "vscode-ext-localization", "vscode ext localization", "awesome copilot vscode ext localization" | `skills/vscode-ext-localization/SKILL.md` |
| "web-design-reviewer", "web design reviewer", "awesome copilot web design reviewer" | `skills/web-design-reviewer/SKILL.md` |
| "webapp-testing", "webapp testing", "awesome copilot webapp testing" | `skills/webapp-testing/SKILL.md` |
| "what-context-needed", "what context needed", "awesome copilot what context needed" | `skills/what-context-needed/SKILL.md` |
| "winmd-api-search", "winmd api search", "awesome copilot winmd api search" | `skills/winmd-api-search/SKILL.md` |
| "winui3-migration-guide", "winui3 migration guide", "awesome copilot winui3 migration guide" | `skills/winui3-migration-guide/SKILL.md` |
| "workiq-copilot", "workiq copilot", "awesome copilot workiq copilot" | `skills/workiq-copilot/SKILL.md` |
| "write-coding-standards-from-file", "write coding standards from file", "awesome copilot write coding standards from file" | `skills/write-coding-standards-from-file/SKILL.md` |
| "x-twitter-scraper", "x twitter scraper", "awesome copilot x twitter scraper" | `skills/x-twitter-scraper/SKILL.md` |
