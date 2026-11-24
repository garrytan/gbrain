# Bench corpus provenance

`dbpedia.py` builds the keyword and vector bench corpora (`corpus-10k`, `corpus-200k`) from a public
dataset. The generated files hold the dataset's text and embeddings. They are never committed,
shipped or published from this repository: rebuild them with the script.

## Source

| | |
|---|---|
| Dataset | `Qdrant/dbpedia-entities-openai3-text-embedding-3-large-1536-1M` on Hugging Face |
| Page | https://huggingface.co/datasets/Qdrant/dbpedia-entities-openai3-text-embedding-3-large-1536-1M |
| Revision used | `4a9731217921bc476a0f03544f11f22ae4903fa5` (the dataset's `main` when checked on 2026-11-19) |
| Files | the six Parquet shards `0.parquet` to `5.parquet`, from https://huggingface.co/api/datasets/Qdrant/dbpedia-entities-openai3-text-embedding-3-large-1536-1M/parquet/default/train/N.parquet |
| Content | 1,000,000 rows of `title`, `text` and a 1,536-dimension `text-embedding-3-large` embedding of title plus text |
| Upstream text | the first 1,000,000 entries of https://huggingface.co/datasets/BeIR/dbpedia-entity (DBpedia entity abstracts), through https://huggingface.co/datasets/KShivendu/dbpedia-entities-openai-1M |

`dbpedia.py` cuts each vector to its first `--dims` values and renormalizes it, groups every 4
consecutive rows into one page of 4 chunks, and holds the rows after the corpus out as query
vectors. `--chunks 200000` gives the 50,000 pages and 200,000 chunks the keyword bench reads;
`--chunks 10000` gives the quick check. See the script's docstring for the exact commands.

## Licence

- The dataset card of the revision above declares `license: mit`. That covers what Qdrant added,
  the embeddings and the packaging.
- The text is DBpedia abstracts, which are extracts of Wikipedia articles. The BEIR card of the
  upstream text (`BeIR/dbpedia-entity`) declares `license: cc-by-sa-4.0`. DBpedia publishes its
  data, abstracts included, under CC BY-SA 3.0 and the GNU Free Documentation License
  (https://dbpedia.org/page/License). The attribution runs back to Wikipedia's contributors.
- The embeddings were made with OpenAI's `text-embedding-3-large`.

Because the text is share-alike material, a copy of it is not committed here, and nothing the bench
writes (stores, query files, result files) is shipped. The bench results in `rust/docs/store/keyword.md`
are timings and sizes only.

## Attribution

Text in the corpus comes from DBpedia (https://www.dbpedia.org/), an extraction of Wikipedia
(https://www.wikipedia.org/), through the BEIR benchmark's DBpedia-Entity collection and the
Qdrant and KShivendu Hugging Face datasets named above. The entity-search test collection behind BEIR's DBpedia
task is https://github.com/iai-group/DBpedia-Entity/.

The PostgreSQL and Snowball notices in `third-party/` are unrelated to this corpus and stay.
