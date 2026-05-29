/**
 * llms-config - single source of truth for llms.txt + llms-full.txt.
 *
 * Consumed by scripts/build-llms.ts (emits llms.txt, llms-full.txt) and
 * test/build-llms.test.ts (asserts paths resolve, content contract holds).
 *
 * Adding a doc? Add it here and run `bun run build:llms`. The drift-detection
 * test fails CI if you forget.
 *
 * Brand override: `LLMS_REPO_BASE` and `LLMS_REPO_URL` let private/customer
 * forks regenerate without manual URL rewrites.
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
  name: "Cortex Company Brain",
  summary:
    "Cortex is a hosted, multi-tenant company-brain SaaS. It gives each organization scoped brains, sources, team invites, invite delivery outbox records, OAuth agent clients, skills, runtime manifests, Composio ingestion, and MCP access through one Cortex-branded control plane.",
  repoUrl:
    process.env.LLMS_REPO_URL ??
    "https://github.com/Versatly/CortexBrain",
  rawBaseUrl:
    process.env.LLMS_REPO_BASE ??
    "https://raw.githubusercontent.com/Versatly/CortexBrain/main",
};

export const SECTIONS: DocSection[] = [
  {
    heading: "SaaS entry points",
    entries: [
      {
        title: "README.md",
        description:
          "Cortex product model, hosted quick start, CLI commands, UI tabs, and agent parity table.",
        path: "README.md",
      },
      {
        title: "AGENTS.md",
        description:
          "Agent operating protocol for the Cortex SaaS: signup, onboarding, invites, runtime install, and trust boundary.",
        path: "AGENTS.md",
      },
      {
        title: "INSTALL_FOR_AGENTS.md",
        description:
          "Hosted tenant onboarding guide for agents connecting a company to Cortex, including invite delivery outbox and claim/result expectations.",
        path: "INSTALL_FOR_AGENTS.md",
      },
      {
        title: "docs/tutorials/company-brain.md",
        description:
          "Company-brain walkthrough: organizations, brains, sources, scoped agents, team invites, and MCP OAuth.",
        path: "docs/tutorials/company-brain.md",
      },
      {
        title: "docs/CORTEX_AGENT_RUNTIME.md",
        description:
          "Agent runtime contract for Cortex SaaS: tenant operations, runtime manifests, source scoping, skills, integrations, and MCP parity.",
        path: "docs/CORTEX_AGENT_RUNTIME.md",
      },
      {
        title: "docs/CORTEX_PRODUCT_SPEC.md",
        description:
          "Cortex product spec covering first-class objects, required journeys, console tabs, agent parity, deployment requirements, and demo gates.",
        path: "docs/CORTEX_PRODUCT_SPEC.md",
      },
    ],
  },
  {
    heading: "Deployment and runtime",
    entries: [
      {
        title: "docs/deploy/multi-tenant-saas.md",
        description:
          "Production SaaS deployment model: Supabase, Railway/Docker, admin console, signup, tenant isolation, and operations.",
        path: "docs/deploy/multi-tenant-saas.md",
      },
      {
        title: "docs/deploy/saas-runtime-packaging.md",
        description:
          "Runtime packaging contract for agents: onboarding URLs, runtime manifests, `cortex connect`, and client setup.",
        path: "docs/deploy/saas-runtime-packaging.md",
      },
      {
        title: "docs/guides/agent-to-cortex.md",
        description:
          "How agent runtimes should call Cortex through hosted MCP, OAuth clients, source scoping, skill ids, and operator-only shell jobs.",
        path: "docs/guides/agent-to-cortex.md",
      },
      {
        title: "docs/mcp/DEPLOY.md",
        description:
          "Hosted HTTP MCP deployment with OAuth 2.1, scoped clients, runtime manifests, and client connection patterns.",
        path: "docs/mcp/DEPLOY.md",
      },
      {
        title: "docs/operations/headless-install.md",
        description:
          "Headless deployment guide for hosted Cortex in Docker, Railway, CI, or other server environments.",
        path: "docs/operations/headless-install.md",
        includeInFull: false,
      },
      {
        title: ".env.saas.example",
        description:
          "Production-shaped environment template using Cortex-branded variables.",
        path: ".env.saas.example",
        includeInFull: false,
      },
    ],
  },
  {
    heading: "Product model",
    entries: [
      {
        title: "docs/architecture/brains-and-sources.md",
        description:
          "Decision model for organizations, brains, sources, sub-team boundaries, and cross-brain ownership.",
        path: "docs/architecture/brains-and-sources.md",
      },
      {
        title: "docs/CORTEX_RECOMMENDED_SCHEMA.md",
        description:
          "Recommended tenant schema for company brains: sources, starter types, link verbs, onboarding flow, and schema completion criteria.",
        path: "docs/CORTEX_RECOMMENDED_SCHEMA.md",
      },
      {
        title: "docs/architecture/topologies.md",
        description:
          "Topology guidance for single-brain, multi-source, and multi-brain company deployments.",
        path: "docs/architecture/topologies.md",
        includeInFull: false,
      },
      {
        title: "docs/integrations/README.md",
        description:
          "Integration recipe model and ingestion surface, including third-party connector setup.",
        path: "docs/integrations/README.md",
        includeInFull: false,
      },
    ],
  },
  {
    heading: "Console UI",
    entries: [
      {
        title: "docs/deploy/v0-ui-mvp-prompt.md",
        description:
          "V0 prompt and implementation contract for the Next.js App Router admin console with shadcn components.",
        path: "docs/deploy/v0-ui-mvp-prompt.md",
      },
    ],
  },
  {
    heading: "Verification",
    entries: [
      {
        title: "docs/CORTEX_VERIFY.md",
        description:
          "Hosted Cortex verification runbook for SaaS smoke, runtime manifest, onboarding URLs, admin walkthrough, agent parity, and demo gates.",
        path: "docs/CORTEX_VERIFY.md",
      },
      {
        title: "scripts/saas-live-smoke.ts",
        description:
          "End-to-end hosted SaaS smoke: signup, invite delivery outbox claim/result, invite, source, skill policy, agent OAuth, Composio webhook, token, and MCP tools.",
        path: "scripts/saas-live-smoke.ts",
        includeInFull: false,
      },
      {
        title: "test/saas-live-smoke.test.ts",
        description:
          "Unit coverage for the live smoke harness and its failure reporting.",
        path: "test/saas-live-smoke.test.ts",
        includeInFull: false,
      },
    ],
  },
];

export const INLINE_TIPS = [
  "`cortex connect '<onboarding-url>' --client-secret '<one-time-secret>'` - connect an invited agent or owner runtime.",
  "`cortex runtime install cursor --manifest-url https://<tenant-host>/runtime-manifest.json` - configure a runtime without embedding secrets.",
  "`bun run smoke:saas-live -- --json` - verify signup, invite delivery outbox claim/result, billing reconciliation, invites, Composio ingestion, OAuth token exchange, and MCP tools on a hosted tenant.",
  "`cortex serve --http --public-url https://<tenant-host>` - run the hosted HTTP MCP server for a tenant brain.",
];

// Target ~700KB so llms-full.txt fits in ~175k-token contexts with room to spare.
// Generator prints a WARN if exceeded; ship with includeInFull=false exclusions.
export const FULL_SIZE_BUDGET = 700_000;
