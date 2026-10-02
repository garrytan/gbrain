// Façade (CLAUDE.md "peeled façades keep their surface"): the forward-reference
// bootstrap has one implementation for both engines in
// src/core/engine-sql/bootstrap.ts (refactor wave 1, E1). Import from there.
export { applyPostgresForwardReferenceBootstrap } from '../engine-sql/bootstrap.ts';
