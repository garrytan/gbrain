# Scaling Runtime Skills

Cortex runtime skills should scale without flooding every agent session with the
entire skill catalog. The SaaS runtime package now advertises only the active
tenant setup skills publicly; historical or operator-only skills stay internal
until they are branded, scoped, and policy-guarded.

## Three Tiers

| Tier | Description | Runtime treatment |
| --- | --- | --- |
| Always available | Setup, schema authoring, runtime connection, core tenant operations | Included in the public skills manifest. |
| Resolver routed | Useful but specialized tenant workflows | Listed in a Cortex resolver only after branding and policy review. |
| Internal or dormant | Migration notes, experiments, compatibility helpers | Not advertised to customer agents. |

## Resolver Contract

The public resolver should route by tenant-safe intent and point only at skills
that satisfy:

- Cortex-branded copy.
- Clear source-scope expectations.
- No plaintext secret handling.
- Agent/human parity notes where the skill changes tenant state.
- Output format that can be audited.

## Verification

```bash
bun test test/skills-conformance.test.ts test/check-resolvable.test.ts
bun run scripts/package-cortex-runtime.ts --skip-binaries --json
```

The runtime package scan fails if a public skill carries legacy product copy or
personal/single-user positioning.

## Adding A Public Skill

1. Rebrand the skill and examples to Cortex.
2. Define what organization, brain, source, and OAuth client it operates on.
3. Add allowed-client/source-access behavior when it can mutate tenant state.
4. Add it to `skills/manifest.json` and `skills/RESOLVER.md`.
5. Extend conformance tests and package guards.
