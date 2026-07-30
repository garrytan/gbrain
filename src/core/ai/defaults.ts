/**
 * Leaf module holding the default embedding model + dimensions.
 *
 * Extracted so schema helpers (pglite-schema.ts, postgres-engine.ts) +
 * registry helpers (search/embedding-column.ts) can import the constants
 * without pulling the full AI gateway (which loads every provider SDK).
 *
 * gateway.ts re-exports these so existing import sites keep working.
 *
 * Single source of truth for "what does a fresh brain look like when the
 * user passes zero flags?" Touching these defaults touches every fresh
 * install AND every doctor consistency check.
 */

// The default moved OFF ZeroEntropy (its hosted API — including
// /models/embed — shuts down 2026-09-04, which would have taken semantic
// retrieval with it on every default-config brain). See the
// Default-provider policy in CLAUDE.md: a gbrain DEFAULT must be
// open-weight or from the vendor with the longest proven model-lifetime
// record. bge-m3 is open-weight (MIT), served locally through Ollama —
// nobody can sunset it — and it is the strongest open-weight multilingual
// retriever in the 8-candidate eval that drove this choice (vector
// nDCG@10 ≥ 0.89 on every language slice tested, including the
// non-Latin-script slices where hosted small models collapse).
//
// 1024 is bge-m3's NATIVE width (see the ollama recipe's model_dims).
// Do not "round up": the Matryoshka free-truncation property measured
// for other families was NOT tested for bge-m3.
export const DEFAULT_EMBEDDING_MODEL = 'ollama:bge-m3';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

// Hosted fallback when Ollama is unreachable (or bge-m3 isn't pulled) at
// `gbrain init` time. text-embedding-3-small is the key most users
// already have (OPENAI_API_KEY), cheap ($0.02/MTok), and from the vendor
// with the longest hosted-embedding lifetime record — but it is the
// WEAKEST multilingual performer among the evaluated candidates
// (nDCG@10 0.645 on the Hebrew slice vs bge-m3's 0.901). That is why the
// fallback is loud, never silent: init prints the trade-off + the path
// back to the default, and `gbrain doctor` re-checks for Ollama.
//
// 1024 (not the model's native 1536, and not the legacy 1280): OpenAI
// text-embedding-3-* is Matryoshka (`isValidOpenAITextEmbedding3Dim`
// accepts any width ≤ native), so pinning the fallback at bge-m3's width
// means a later `gbrain migrate embeddings --to ollama:bge-m3 --dim 1024`
// rebuilds VECTORS only — the vector(1024) column and its HNSW index
// stay in place, no dimension transition.
export const FALLBACK_EMBEDDING_MODEL = 'openai:text-embedding-3-small';
export const FALLBACK_EMBEDDING_DIMENSIONS = 1024;
