/**
 * llms-config — single source of truth for llms.txt + llms-full.txt.
 *
 * Consumed by scripts/build-llms.ts (emits llms.txt, llms-full.txt) and
 * test/build-llms.test.ts (asserts paths resolve, content contract holds).
 *
 * Adding a doc? Add it here and run `bun run build:llms`. The drift-detection
 * test fails CI if you forget.
 *
 * Fork-friendliness: `rawBaseUrl` reads from `LLMS_REPO_BASE` so forks can
 * regenerate without manual URL rewrites:
 *   LLMS_REPO_BASE=https://raw.githubusercontent.com/fork-org/gbrain/main bun run build:llms
 */

export type DocEntry = {
  title: string;
  description: string;
  path: string;
  includeInFull?: boolean;
};

export type DocSection = {
  heading: string;
  optional?: boolean;
  entries: DocEntry[];
};

export const PROJECT = {
  name: "GBrain",
  summary:
    "GBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable engines (PGLite default, Postgres+pgvector for scale), contract-first operations, 26 fat-markdown skills. Teaches agents brain ops, ingestion, enrichment, scheduling, identity, and access control.",
  repoUrl: "https://github.com/garrytan/gbrain",
  rawBaseUrl:
    process.env.LLMS_REPO_BASE ??
    "https://raw.githubusercontent.com/garrytan/gbrain/master",
};

export const SECTIONS: DocSection[] = [
  {
    heading: "Core entry points",
    entries: [
      {
        title: "AGENTS.md",
        description:
          "Start here if you are not Claude Code. Install order, trust boundary, skill resolver, config/debug/migration pointers.",
        path: "AGENTS.md",
      },
      {
        title: "CLAUDE.md",
        description:
          "Architecture reference. Key files, trust boundaries, engine factory, test layout.",
        path: "CLAUDE.md",
      },
      {
        title: "INSTALL_FOR_AGENTS.md",
        description: "9-step agent installation.",
        path: "INSTALL_FOR_AGENTS.md",
      },
      {
        title: "skills/RESOLVER.md",
        description: "Skill dispatcher. Read first for any task.",
        path: "skills/RESOLVER.md",
      },
      {
        title: "README.md",
        description: "Project overview, benchmarks, 30-minute setup.",
        path: "README.md",
      },
    ],
  },
  {
    heading: "Configuration",
    entries: [
      {
        title: "docs/ENGINES.md",
        description: "PGLite vs Postgres trade-off and when to migrate.",
        path: "docs/ENGINES.md",
      },
      {
        title: "docs/GBRAIN_RECOMMENDED_SCHEMA.md",
        description:
          "MECE directory structure (people/, companies/, concepts/).",
        path: "docs/GBRAIN_RECOMMENDED_SCHEMA.md",
        // v0.40.6.0: 64KB reference doc. Web index entry stays; the single-fetch
        // bundle gets the README + setup guides instead. Keeps llms-full.txt
        // under the 600KB budget as CLAUDE.md grows with each release.
        includeInFull: false,
      },
      {
        title: "docs/what-schemas-unlock.md",
        description:
          "Why schemas matter: 7 killer use cases (4000 invisible meetings, founder ops brain, research brain, legal brain, team brain, agent-as-co-curator) + the structural argument for typed page kinds. Read this before pitching schema authoring (v0.40.7.0).",
        path: "docs/what-schemas-unlock.md",
      },
      {
        title: "docs/schema-author-tutorial.md",
        description:
          "5-minute walkthrough: fork the bundled pack, add a custom `researcher` type, backfill existing pages via `gbrain schema sync --apply`, prove the T1.5 wiring via `gbrain whoknows` (v0.40.7.0).",
        path: "docs/schema-author-tutorial.md",
      },
      {
        title: "docs/guides/live-sync.md",
        description: "Incremental markdown sync setup.",
        path: "docs/guides/live-sync.md",
      },
      {
        title: "docs/guides/cron-schedule.md",
        description: "Recurring job scheduling.",
        path: "docs/guides/cron-schedule.md",
      },
      {
        title: "docs/guides/minions-deployment.md",
        description:
          "Deploying the gbrain jobs worker: crontab + watchdog, inline --follow, systemd/Procfile/fly.toml, upgrade checklist.",
        path: "docs/guides/minions-deployment.md",
        // v0.41.8.0: 13KB deployment runbook. Web index entry stays;
        // single-fetch bundle drops it to keep under FULL_SIZE_BUDGET
        // (CLAUDE.md grew past 600KB once master's v0.41.2-v0.41.6 +
        // this wave's annotations landed). Operators read this once;
        // agents rarely need it in context.
        includeInFull: false,
      },
      {
        title: "docs/guides/quiet-hours.md",
        description: "Notification hold + timezone-aware delivery.",
        path: "docs/guides/quiet-hours.md",
      },
      {
        title: "docs/guides/scaling-skills.md",
        description:
          "Three-tier architecture for agents with 300+ skills: always-loaded, resolver-routed, and dormant. Per-turn token math, the v0.41.7.0 compact list-format resolver, and the `gbrain doctor` safety net. 306 skills, ~21K tokens freed per turn, zero capability loss.",
        path: "docs/guides/scaling-skills.md",
      },
      {
        title: "docs/mcp/DEPLOY.md",
        description: "MCP server deployment.",
        path: "docs/mcp/DEPLOY.md",
      },
    ],
  },
  {
    heading: "AI providers",
    entries: [
      {
        title: "docs/ai-providers/zeroentropy.md",
        description:
          "ZeroEntropy zembed-1 embedding + zerank-2 reranker (hosted): API key, embedding switch, reranker config.",
        path: "docs/ai-providers/zeroentropy.md",
        // Setup walkthrough — discoverable in the index, not inlined in the
        // single-fetch bundle (keeps llms-full.txt under FULL_SIZE_BUDGET).
        includeInFull: false,
      },
      {
        title: "docs/ai-providers/llama-server-reranker.md",
        description:
          "Local reranker via llama.cpp --reranking: Qwen3-Reranker or self-hosted ZE weights, --alias setup, gbrain config keys, cold-start timeout, budget-cap interaction.",
        path: "docs/ai-providers/llama-server-reranker.md",
        includeInFull: false,
      },
    ],
  },
  {
    heading: "Debugging",
    entries: [
      {
        title: "docs/GBRAIN_VERIFY.md",
        description:
          "7-check post-setup verification. Start here when something feels off.",
        path: "docs/GBRAIN_VERIFY.md",
      },
      {
        title: "docs/guides/minions-fix.md",
        description: "Troubleshooting the Minions job queue.",
        path: "docs/guides/minions-fix.md",
      },
      {
        title: "docs/integrations/reliability-repair.md",
        description: "Data integrity recovery.",
        path: "docs/integrations/reliability-repair.md",
      },
    ],
  },
  {
    heading: "Migrations",
    entries: [
      {
        title: "docs/UPGRADING_DOWNSTREAM_AGENTS.md",
        description:
          "Patches for downstream agent skill forks. One section per release.",
        path: "docs/UPGRADING_DOWNSTREAM_AGENTS.md",
        // Excluded from inlined bundle (v0.41.7.0): 25KB of release-by-release
        // migration patches that are valuable as a reference but don't need
        // to ride along in every llms-full.txt fetch. Pushes the bundle back
        // under FULL_SIZE_BUDGET after the v0.41.7.0 scaling-skills guide
        // landed.
        includeInFull: false,
      },
      {
        title: "skills/migrations/",
        description:
          "Per-version (v0.5.0 - v0.14.1) agent-executable migration instructions.",
        path: "skills/migrations/",
      },
      {
        title: "CHANGELOG.md",
        description:
          "Release-summary voice + itemized changes + self-repair block per version.",
        path: "CHANGELOG.md",
        includeInFull: false,
      },
    ],
  },
  {
    heading: "Philosophy",
    optional: true,
    entries: [
      {
        title: "docs/ethos/THIN_HARNESS_FAT_SKILLS.md",
        description: "Why skills live in markdown.",
        path: "docs/ethos/THIN_HARNESS_FAT_SKILLS.md",
        includeInFull: false,
      },
      {
        title: "docs/ethos/MARKDOWN_SKILLS_AS_RECIPES.md",
        description: "Homebrew for Personal AI.",
        path: "docs/ethos/MARKDOWN_SKILLS_AS_RECIPES.md",
        includeInFull: false,
      },
    ],
  },
  {
    heading: "Optional",
    optional: true,
    entries: [
      {
        title: "docs/designs/",
        description: "Forward-looking designs.",
        path: "docs/designs/",
        includeInFull: false,
      },
      {
        title: "docs/architecture/infra-layer.md",
        description: "Shared infra patterns.",
        path: "docs/architecture/infra-layer.md",
        includeInFull: false,
      },
    ],
  },
];

export const INLINE_TIPS = [
  "`gbrain doctor [--json] [--fast] [--fix]` - built-in health checks.",
  "`gbrain orphans [--json]` - pages with zero inbound wikilinks.",
  "`gbrain repair-jsonb [--dry-run]` - repair v0.12.0 double-encoded JSONB rows.",
  "`gbrain upgrade` runs post-upgrade + apply-migrations.",
];

// Target ~750KB so llms-full.txt fits in ~190k-token contexts with room to spare.
// Bumped 600KB→700KB in v0.41.9.0, then 700KB→750KB once CLAUDE.md crossed 700KB:
// it's ~540KB (77% of the bundle) and grows ~5-15KB per release with each feature's
// Key Files annotation. Both master (v0.41.34-38 waves) and this branch (skillopt
// wave) independently hit the 700KB line and bumped to the same 750KB. CLAUDE.md is
// the whole point of the one-fetch bundle, so it stays inlined; the budget tracks
// its legitimate growth. Still fits comfortably in 200k+ context models.
// Generator prints a WARN if exceeded; ship with includeInFull=false exclusions.
export const FULL_SIZE_BUDGET = 750_000;
