//! Chunk reads the chunks capability still refuses. Nothing is built yet: every member below still
//! refuses with `engine_capability_missing` in the TypeScript engine.
//!
//! Members: getChunkPage, getChunkWindows, countChunklessPagesWithContent,
//! listChunklessPagesWithContent.
//!
//! Keys: every record of this family starts with `keys::CHUNK_QUERIES` (`c`). The bytes after the
//! tag are this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md.
