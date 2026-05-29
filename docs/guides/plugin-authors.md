# Runtime Plugin Authors

Cortex runtime plugins package the small amount of client-side behavior needed
to connect agent runtimes to a hosted tenant. They should not become a second
control plane and should never carry plaintext tenant secrets.

## Minimum Plugin Shape

```text
cortex.plugin.json
skills/
  manifest.json
  RESOLVER.md
  setup/SKILL.md
  schema-author/SKILL.md
```

`cortex.plugin.json` identifies the Cortex runtime package and the public skills
an agent may load. The packaged skills must be Cortex-branded and scoped to
tenant onboarding, runtime setup, or schema customization.

## Trust Rules

- Plugins may point clients at the hosted MCP URL.
- Plugins may install runtime config snippets for supported clients.
- Plugins must not store one-time client secrets in generated runtime config.
- Plugins must not expose historical or internal skills unless they pass the
  Cortex public-copy guard.
- Plugins must respect source scoping and skill policy annotations.

## Publishing

Use the runtime packager:

```bash
bun run scripts/package-cortex-runtime.ts --skip-binaries --json
```

Production publishing should include Cortex CLI binaries, runtime manifests,
plugin metadata, active public skills, checksums, and install docs. The package
scan fails when public files include legacy product copy or single-user
positioning.

## Agent Parity

If a plugin exposes a console workflow, document the matching MCP operation or
CLI command. Agents should be able to create orgs, invite teammates, register
clients, inspect plans, update skill policies, and connect runtimes through the
same guarded control plane humans use.
