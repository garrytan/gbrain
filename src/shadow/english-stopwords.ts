/**
 * The English stopword list of the Rust engine's keyword search: `ENGLISH_STOPWORDS` in
 * rust/crates/gbrain-store/src/keyword/stem.rs (`english.stop` from PostgreSQL 18). The engine drops these words before
 * indexing and before searching, so a search for one never hits. The addon does not export the list (a new export would
 * change the addon and restart the swap evidence epoch), so it is copied here, in the same order;
 * test/shadow-drill.test.ts reads stem.rs and fails when the two differ.
 */
export const ENGLISH_STOPWORDS: readonly string[] = [
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
  'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the',
  'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against',
  'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in',
  'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now',
];

/** Whether the engine drops `word` (any case) as a stopword. */
export const isEnglishStopword = (word: string): boolean => STOPWORD_SET.has(word.toLowerCase());
const STOPWORD_SET: ReadonlySet<string> = new Set(ENGLISH_STOPWORDS);
