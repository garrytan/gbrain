#!/usr/bin/env bash
set -euo pipefail

# Guard the entrypoints most likely to be read by agents, customers, and
# generated llms.txt consumers. This is intentionally scoped; implementation
# compatibility aliases live elsewhere while the public surface stays Cortex.

files=(
  README.md
  AGENTS.md
  CLAUDE.md
  CONTRIBUTING.md
  DESIGN.md
  admin/DESIGN.md
  INSTALL_FOR_AGENTS.md
  package.json
  cortex.plugin.json
  cortex.yml
  .env.saas.example
  docker-compose.saas.yml
  Dockerfile
  Procfile
  fly.toml.example
  railway.json
  .env.testing.example
  .github/ISSUE_TEMPLATE/bug_report.md
  .github/workflows/release.yml
  .github/workflows/e2e.yml
  .github/workflows/heavy-tests.yml
  docs/INSTALL.md
  docs/CORTEX_VERIFY.md
  docs/CORTEX_AGENT_RUNTIME.md
  docs/CORTEX_RECOMMENDED_SCHEMA.md
  docs/CORTEX_PRODUCT_SPEC.md
  docs/mcp/DEPLOY.md
  docs/mcp/ALTERNATIVES.md
  docs/mcp/CHATGPT.md
  docs/mcp/CLAUDE_CODE.md
  docs/mcp/CLAUDE_COWORK.md
  docs/mcp/CLAUDE_DESKTOP.md
  docs/mcp/PERPLEXITY.md
  docs/tutorials/README.md
  docs/tutorials/company-brain.md
  docs/architecture/schema-packs.md
  docs/architecture/system-of-record.md
  docs/architecture/infra-layer.md
  docs/architecture/RETRIEVAL.md
  docs/architecture/lens-packs.md
  docs/architecture/brains-and-sources.md
  docs/architecture/topologies.md
  docs/guides/repo-architecture.md
  docs/guides/scaling-skills.md
  docs/guides/multi-source-brains.md
  docs/guides/plugin-authors.md
  docs/guides/skillpacks-as-scaffolding.md
  docs/guides/cron-schedule.md
  docs/guides/live-sync.md
  docs/what-schemas-unlock.md
  docs/schema-author-tutorial.md
  docs/skillpack-anatomy.md
  docs/storage-tiering.md
  docs/UPGRADING_DOWNSTREAM_AGENTS.md
  docs/guides/upgrades-auto-update.md
  docs/guides/agent-to-cortex.md
  docs/operations/headless-install.md
  docs/embedding-migrations.md
  docs/eval-bench.md
  docs/eval-capture.md
  docs/eval-takes-quality.md
  docs/eval/SEARCH_MODE_METHODOLOGY.md
  docs/deploy/multi-tenant-saas.md
  docs/deploy/saas-runtime-packaging.md
  docs/deploy/v0-ui-mvp-prompt.md
  docs/integrations/README.md
  docs/integrations/credential-gateway.md
  docs/integrations/embedding-providers.md
  docs/integrations/reliability-repair.md
  templates/HEARTBEAT.md.template
  llms.txt
  llms-full.txt
  scripts/llms-config.ts
  scripts/build-skillpack-anatomy.ts
  scripts/smoke-test.sh
  src/commands/apply-migrations.ts
  src/commands/check-update.ts
  src/commands/eval.ts
  src/commands/eval-brainstorm.ts
  src/commands/eval-code-retrieval.ts
  src/commands/eval-compare.ts
  src/commands/eval-conversation-parser.ts
  src/commands/eval-cross-modal.ts
  src/commands/eval-export.ts
  src/commands/eval-gate.ts
  src/commands/eval-longmemeval.ts
  src/commands/eval-prune.ts
  src/commands/eval-replay.ts
  src/commands/eval-run-all.ts
  src/commands/eval-suspected-contradictions.ts
  src/commands/eval-takes-quality.ts
  src/commands/eval-trajectory.ts
  src/commands/eval-whoknows.ts
  src/commands/founder-scorecard.ts
  src/commands/upgrade.ts
  src/core/embed-preflight.ts
  src/core/operations-descriptions.ts
  src/core/takes-quality-eval/replay.ts
  src/core/takes-quality-eval/trend.ts
  src/core/skillpack/rubric.ts
  skills/RESOLVER.md
  skills/manifest.json
  skills/setup/SKILL.md
  skills/schema-author/SKILL.md
)

pattern='GBrain|gbrain|garrytan|OpenClaw|GStack|gstack|personal brain|personal knowledge|self[- ]serve|self[- ]service|open[- ]source|local[- ]first|standalone install|individual memory|my brain|your brain|~/.gbrain|GBRAIN'
filename_pattern='gbrain|garrytan|openclaw|gstack|personal-brain|personal_ai'

existing=()
for file in "${files[@]}"; do
  if [ -e "$file" ]; then
    existing+=("$file")
  else
    echo "[check-cortex-public-copy] missing expected public surface: $file" >&2
    exit 1
  fi
done

while IFS= read -r file; do
  existing+=("$file")
done < <(find admin/app admin/components/cortex admin/lib -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) | sort)

while IFS= read -r file; do
  existing+=("$file")
done < <(
  find docs -type f \
    ! -path 'docs/designs/*' \
    ! -path 'docs/incidents/*' \
    ! -path 'docs/v0.38-smoke-test-report.md' \
    \( -name '*.md' -o -name '*.mdx' -o -name '*.txt' -o -name '*.yml' -o -name '*.yaml' -o -name '*.json' -o -name '*.example' -o -name '*.service' -o -name '*.partial' \) \
    | sort
)

while IFS= read -r file; do
  existing+=("$file")
done < <(
  find skills -type f \
    \( -name '*.md' -o -name '*.json' -o -name '*.jsonl' -o -name '*.yml' -o -name '*.yaml' -o -name '*.txt' \) \
    | sort
)

if grep -EnI "$pattern" "${existing[@]}"; then
  echo "[check-cortex-public-copy] legacy copy found in public Cortex surfaces" >&2
  exit 1
fi

for file in "${existing[@]}"; do
  if [[ "$file" =~ $filename_pattern ]]; then
    echo "[check-cortex-public-copy] legacy filename found in public Cortex surfaces: $file" >&2
    exit 1
  fi
done

echo "[check-cortex-public-copy] public Cortex surfaces are clean"
