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
  repoUrl: "https://github.com/momoiicom/open-gbrain",
  rawBaseUrl:
    process.env.LLMS_REPO_BASE ??
    "https://raw.githubusercontent.com/momoiicom/open-gbrain/master",
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
      },
      {
        title: "docs/guides/quiet-hours.md",
        description: "Notification hold + timezone-aware delivery.",
        path: "docs/guides/quiet-hours.md",
      },
      {
        title: "docs/mcp/DEPLOY.md",
        description: "MCP server deployment.",
        path: "docs/mcp/DEPLOY.md",
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

// Target ~600KB so llms-full.txt fits in ~150k-token contexts with room to spare.
// Generator prints a WARN if exceeded; ship with includeInFull=false exclusions.
export const FULL_SIZE_BUDGET = 600_000;
