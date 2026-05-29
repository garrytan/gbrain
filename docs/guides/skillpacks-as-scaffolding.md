# Skillpacks And Public Runtime Skills

The Cortex SaaS runtime no longer treats every historical bundled skill as
customer-facing. Public runtime skills are a curated subset that are safe for
tenant onboarding and agent setup.

## Public Skill Requirements

A skill can enter the public runtime catalog only when it has:

- Cortex-branded copy and commands.
- Clear organization, brain, and source assumptions.
- No plaintext secret persistence.
- Agent/human parity notes for tenant-changing actions.
- Output format suitable for audit.
- Tests or conformance coverage.

## Current Public Catalog

- `setup`: tenant onboarding, invite handoff, runtime manifest, and connection.
- `schema-author`: tenant schema customization and source-aware filing rules.

Other historical skills remain internal until they are rebranded and guarded.

## Adding A Skill

1. Rebrand the skill and examples.
2. Define tenant/source scope.
3. Add skill policy behavior for mutations.
4. Add it to `skills/manifest.json`.
5. Add resolver routing in `skills/RESOLVER.md`.
6. Extend `test/skills-conformance.test.ts`.
7. Regenerate the runtime package and run public-copy guards.

## Verification

```bash
bun test test/skills-conformance.test.ts test/check-resolvable.test.ts
bun run scripts/package-cortex-runtime.ts --skip-binaries --json
```
