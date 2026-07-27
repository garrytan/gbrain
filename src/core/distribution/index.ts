// v0.38 distribution layer — shared tarball + trust + registry helpers.
//
// E2: shared helpers that both `src/core/skillpack/` (v0.37) and
// `src/core/schema-pack/` (v0.38) consume. Promoting them out of the
// skillpack module reflects what they always were: artifact-shape-
// agnostic tarball processing, TOFU trust prompts, registry HTTP,
// remote source handling. Naming them `distribution` makes the
// reuse contract legible and prevents schema-pack code from
// importing through a skillpack-named module.
//
// Physical layout (Option B from eng-review E2): the implementations
// stay at `src/core/skillpack/` for now to avoid a big-bang move that
// would touch ~15 v0.37 callers + risk breaking the just-shipped
// skillpack pipeline. This module re-exports the shared surface as
// the canonical name; schema-pack imports from here. v0.39+ may
// physically move the implementations if signal warrants it.
//
// Codex F6 (circular imports): this module MUST only import from
// `src/core/skillpack/{tarball,trust-prompt,registry-client,
// remote-source,registry-schema,scaffold-third-party}.ts`. It must
// NOT import from `commands/`, `schema-pack/`, engines, or config
// resolution. Pinned by the import-boundary test below.
//
// Codex F7 (backwards-compat): existing skillpack callers continue
// to import from `src/core/skillpack/` directly — this module does
// NOT change v0.37 behavior. Schema-pack callers use this module's
// exports to avoid the schema-pack-imports-from-skillpack semantic
// awkwardness.

// Tarball processing: extract caps, symlink rejection, magic-byte
// sniff. v0.37 used this for `.tgz` skillpacks; v0.38 extends to
// `.gbrain-schema` and `.gbrain-skillpack`. The tarball implementation
// is artifact-shape-agnostic — the manifest validator runs separately
// after extraction.
export {
  DEFAULT_EXTRACT_CAPS,
  extractTarball,
  fileSha256,
  packTarball,
  TarballError,
  type ExtractCaps,
  type TarballErrorCode,
  type TarballExtractOptions,
  type TarballExtractResult,
  type TarballPackOptions,
  type TarballPackResult,
} from '../skillpack/tarball.ts';

// TOFU trust prompts. v0.37 fingerprints by author + pinned-commit +
// tarball SHA + tier; v0.38 reuses this for schema packs (same trust
// model — community-published artifacts need explicit operator ack).
export {
  askTrust,
  renderIdentityBlock,
  type AskTrustOptions,
  type SkillpackTier,
  type TrustPromptDecision,
  type TrustPromptInput,
} from '../skillpack/trust-prompt.ts';

// Registry HTTP client (fetch + etag + soft-TTL + stale-fallback).
// Artifact-shape-agnostic — the JSON schema for the registry entry is
// the same regardless of whether it's a skillpack or schema-pack.
export {
  DEFAULT_ENDORSEMENTS_URL,
  DEFAULT_REGISTRY_URL,
  findPack,
  findPackWithTier,
  loadRegistry,
  RegistryClientError,
  resolveRegistryUrl,
  searchPacks,
  type LoadedRegistry,
  type LoadRegistryOptions,
  type RegistryClientErrorCode,
} from '../skillpack/registry-client.ts';

// Remote source resolution (git clone via git-remote.ts SSRF-hardened
// path; tarball URL download). Used by `scaffold` for both skillpack
// and schema-pack remote refs.
export {
  classifySpec,
  RemoteSourceError,
  resolveSource,
  type RemoteSourceErrorCode,
  type ResolvedSource,
  type ResolvedSourceKind,
  type ResolveSourceOptions,
  type SpecKind,
} from '../skillpack/remote-source.ts';

// Registry schema definitions for tier rubric (CORE / BADGES /
// effective_tier). v0.37 used for skillpacks; v0.38 schema-packs
// share the same tier vocabulary so users learn one quality model.
export {
  effectiveTier,
  ENDORSEMENTS_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION,
  RegistrySchemaError,
  validateEndorsementsFile,
  validateRegistryCatalog,
  validateRegistryEntry,
  type EndorsementRecord,
  type EndorsementsFile,
  type RegistryBundles,
  type RegistryCatalog,
  type RegistryEntry,
  type RegistrySchemaErrorCode,
  type RegistrySource,
  type RegistryTier,
} from '../skillpack/registry-schema.ts';

// Third-party scaffold pipeline. v0.37's `scaffold` command pattern —
// resolve spec → fetch → validate → cache → display runbook. v0.38
// schema-packs use the same pipeline with a different manifest
// validator.
export {
  defaultStatePath,
  runScaffoldThirdParty,
  ScaffoldThirdPartyError,
  type ScaffoldThirdPartyOptions,
  type ScaffoldThirdPartyResult,
  type ScaffoldThirdPartyStatus,
} from '../skillpack/scaffold-third-party.ts';
