//! LMDB through heed as a plain ordered key-value store. Default env flags: fsync on every commit.

use crate::kv::*;
use heed::types::Bytes;
use heed::{CommitOrAbort, Database, Env, EnvOpenOptions, RoTxn, WithoutTls};
use std::ops::Bound;
use std::path::Path;

type Db = Database<'static, Bytes, Bytes>;

/// Virtual address space reserved for the map. The file only grows as data is written.
const MAP_SIZE: usize = 256 << 30;

pub struct LmdbStore {
    env: Env<WithoutTls>,
    data: Db,
    log: Db,
}

impl LmdbStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).map_err(store_err)?;
        // Read transactions without thread-local reader slots (MDB_NOTLS): a thread may hold several
        // snapshots at once (a transaction's snapshot plus a nested read) and a snapshot may move
        // between threads. With TLS slots LMDB fails with MDB_BAD_RSLOT.
        let mut opts = EnvOpenOptions::new().read_txn_without_tls();
        opts.map_size(MAP_SIZE).max_dbs(2).max_readers(256);
        // SAFETY: heed requires that the same environment is not opened twice in one process;
        // the harness opens each store directory once per process.
        let env = unsafe { opts.open(dir) }.map_err(store_err)?;
        let w = env.write_txn().map_err(store_err)?;
        let (data, log) = env
            .create_databases_and_commit(w, |opener, wtxn| -> std::result::Result<_, heed::Error> {
                let data = opener.create_database::<Bytes, Bytes>(wtxn, Some("data"))?;
                let log = opener.create_database::<Bytes, Bytes>(wtxn, Some("log"))?;
                Ok(CommitOrAbort::<_, ()>::Commit((data, log)))
            })
            .map_err(store_err)?
            .unwrap_commit();
        Ok(Self { env, data, log })
    }
    fn db(&self, t: Table) -> Db {
        match t {
            Table::Data => self.data,
            Table::Log => self.log,
        }
    }
}

struct LmdbSnapshot {
    tx: RoTxn<'static, WithoutTls>,
    data: Db,
    log: Db,
}

impl Snapshot for LmdbSnapshot {
    fn get(&self, table: Table, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let db = if table == Table::Data {
            self.data
        } else {
            self.log
        };
        let v = db.get(&self.tx, key).map_err(store_err)?;
        Ok(v.map(|b| b.to_vec()))
    }
    fn scan(
        &self,
        table: Table,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        if start >= end {
            return Ok(());
        }
        let db = if table == Table::Data {
            self.data
        } else {
            self.log
        };
        // LMDB rejects an empty key, so an empty start means "from the first key".
        let from = if start.is_empty() {
            Bound::Unbounded
        } else {
            Bound::Included(start)
        };
        let bounds = (from, Bound::Excluded(end));
        if reverse {
            for item in db.rev_range(&self.tx, &bounds).map_err(store_err)? {
                let (k, v) = item.map_err(store_err)?;
                if !f(k, v) {
                    break;
                }
            }
        } else {
            for item in db.range(&self.tx, &bounds).map_err(store_err)? {
                let (k, v) = item.map_err(store_err)?;
                if !f(k, v) {
                    break;
                }
            }
        }
        Ok(())
    }
}

impl BaseStore for LmdbStore {
    fn name(&self) -> &'static str {
        "lmdb"
    }
    fn snapshot(&self) -> Result<Box<dyn Snapshot>> {
        let tx = self.env.clone().static_read_txn().map_err(store_err)?;
        Ok(Box::new(LmdbSnapshot {
            tx,
            data: self.data,
            log: self.log,
        }))
    }
    fn commit(&self, batch: &WriteBatch) -> Result<()> {
        let mut w = self.env.write_txn().map_err(store_err)?;
        for op in &batch.ops {
            let db = self.db(op.table);
            match &op.value {
                Some(v) => db.put(&mut w, &op.key, v).map_err(store_err)?,
                None => {
                    db.delete(&mut w, &op.key).map_err(store_err)?;
                }
            }
        }
        w.commit().map_err(store_err)
    }
}
