**The pre-push secret check no longer flags the generated operation-loader table when an operation's name looks like a secret.**

<!-- public-surface: no-behavior-change: a repository pre-push check allowlist entry; gbrain itself is unchanged -->

### Fixed
- `.gstack/pregate.json` allows the `env.kv` finding on `src/core/operation-loaders.generated.ts` only for values shaped `[load_<module>, "<name>Operations"]`, which are a loader identifier and an export name. Any other value in that file stays flagged.
