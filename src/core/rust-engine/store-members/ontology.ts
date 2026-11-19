/**
 * Ontology dimensions over facts. Nothing is served yet: each member below refuses with `engine_capability_missing`
 * until this file exports it (docs/designs/RUST_ENGINE_INTERFACES.md). Open to build now.
 *
 * Members: mergeOntologyFact, getOntology, discoverOntologyDimensions, findOntologyConflicts.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
export {};
