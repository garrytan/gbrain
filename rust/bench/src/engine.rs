//! Engine selection: which base store sits under the shared optimistic layer.

use crate::fjall_store::FjallStore;
use crate::kv::{BaseStore, Result};
use crate::lmdb_store::LmdbStore;
use crate::occ::{Db, Options};
use crate::records::Records;
use crate::redb_store::RedbStore;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Redb,
    Fjall,
    Lmdb,
}

impl Engine {
    pub fn parse(s: &str) -> Option<Engine> {
        match s {
            "redb" => Some(Engine::Redb),
            "fjall" => Some(Engine::Fjall),
            "lmdb" => Some(Engine::Lmdb),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Engine::Redb => "redb",
            Engine::Fjall => "fjall",
            Engine::Lmdb => "lmdb",
        }
    }
}

pub fn open_base(engine: Engine, dir: &Path) -> Result<Arc<dyn BaseStore>> {
    Ok(match engine {
        Engine::Redb => Arc::new(RedbStore::open(dir)?),
        Engine::Fjall => Arc::new(FjallStore::open(dir)?),
        Engine::Lmdb => Arc::new(LmdbStore::open(dir)?),
    })
}

pub fn open_records(engine: Engine, dir: &Path, commit_log: bool) -> Result<Arc<Records>> {
    let base = open_base(engine, dir)?;
    let opts = Options {
        commit_log,
        ..Options::default()
    };
    let db = Arc::new(Db::open(base, opts)?);
    Ok(Arc::new(Records::open(db)?))
}
