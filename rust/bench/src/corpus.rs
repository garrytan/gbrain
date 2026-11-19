//! Reader for the `gbrain-bench-corpus/1` directory format (see the shared bake-off spec).

use crate::records::{Chunk, Page, DIMS};
use serde::Deserialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Debug, Clone)]
pub struct Manifest {
    pub format: String,
    pub dims: usize,
    pub pages: usize,
    pub chunks: usize,
    pub queries: usize,
}

#[derive(Deserialize)]
struct PageLine {
    i: u64,
    source_id: String,
    slug: String,
    #[serde(rename = "type")]
    page_type: String,
    title: String,
    frontmatter: serde_json::Value,
    body: String,
    chunk_count: u32,
}

#[derive(Deserialize)]
struct ChunkLine {
    text: String,
}

pub struct Corpus {
    pub dir: PathBuf,
    pub manifest: Manifest,
}

impl Corpus {
    pub fn open(dir: &Path) -> Result<Corpus, String> {
        let text = std::fs::read_to_string(dir.join("manifest.json"))
            .map_err(|e| format!("cannot read {}/manifest.json: {e}", dir.display()))?;
        let manifest: Manifest =
            serde_json::from_str(&text).map_err(|e| format!("manifest.json: {e}"))?;
        if manifest.format != "gbrain-bench-corpus/1" {
            return Err(format!("unsupported corpus format {}", manifest.format));
        }
        if manifest.dims != DIMS {
            return Err(format!(
                "corpus has {} dims, harness is built for {DIMS}",
                manifest.dims
            ));
        }
        Ok(Corpus {
            dir: dir.to_path_buf(),
            manifest,
        })
    }

    /// Stream pages with their chunks (text + vector) in corpus order, without holding the corpus
    /// in memory. Page ids are `i + 1`. The callback gets one page at a time.
    pub fn stream_pages(
        &self,
        mut f: impl FnMut(Page, Vec<Chunk>) -> Result<(), String>,
    ) -> Result<(), String> {
        let open = |name: &str| File::open(self.dir.join(name)).map_err(|e| format!("{name}: {e}"));
        let pages = BufReader::with_capacity(1 << 20, open("pages.jsonl")?);
        let mut chunk_lines = BufReader::with_capacity(1 << 20, open("chunks.jsonl")?).lines();
        let mut vectors = BufReader::with_capacity(4 << 20, open("vectors.f32")?);
        let mut vbuf = vec![0u8; DIMS * 4];
        for line in pages.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let p: PageLine =
                serde_json::from_str(&line).map_err(|e| format!("pages.jsonl: {e}"))?;
            let mut chunks = Vec::with_capacity(p.chunk_count as usize);
            for idx in 0..p.chunk_count {
                let cl = chunk_lines
                    .next()
                    .ok_or("chunks.jsonl ended early")?
                    .map_err(|e| e.to_string())?;
                let c: ChunkLine =
                    serde_json::from_str(&cl).map_err(|e| format!("chunks.jsonl: {e}"))?;
                vectors
                    .read_exact(&mut vbuf)
                    .map_err(|e| format!("vectors.f32: {e}"))?;
                let vector = vbuf
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                chunks.push(Chunk {
                    idx,
                    text: c.text,
                    vector,
                });
            }
            let page = Page {
                id: p.i + 1,
                source_id: p.source_id,
                slug: p.slug,
                page_type: p.page_type,
                title: p.title,
                frontmatter: p.frontmatter.to_string(),
                body: p.body,
                chunk_count: p.chunk_count,
            };
            f(page, chunks)?;
        }
        Ok(())
    }

    /// Read an `N x DIMS` little-endian f32 file entirely.
    pub fn read_f32_file(&self, name: &str) -> Result<Vec<f32>, String> {
        let bytes = std::fs::read(self.dir.join(name)).map_err(|e| format!("{name}: {e}"))?;
        if bytes.len() % (DIMS * 4) != 0 {
            return Err(format!("{name}: size is not a multiple of {}", DIMS * 4));
        }
        Ok(bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect())
    }

    pub fn queries(&self) -> Result<Vec<f32>, String> {
        self.read_f32_file("queries.f32")
    }

    pub fn truth_path(&self) -> PathBuf {
        self.dir.join("truth_top10.json")
    }
}
