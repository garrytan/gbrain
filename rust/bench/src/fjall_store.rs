//! Fjall (LSM) as a plain ordered key-value store, using its non-transactional keyspaces and
//! cross-keyspace write batches. Our optimistic layer supplies the transactions; Fjall's own
//! OptimisticTxDatabase is not used in this variant. PersistMode::SyncAll = fsync per batch.

use crate::kv::*;
use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode, Readable, Snapshot as FSnap};
use std::path::Path;

pub struct FjallStore {
    db: Database,
    data: Keyspace,
    log: Keyspace,
}

impl FjallStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).map_err(store_err)?;
        let db = Database::builder(dir).open().map_err(store_err)?;
        let data = db
            .keyspace("data", KeyspaceCreateOptions::default)
            .map_err(store_err)?;
        let log = db
            .keyspace("log", KeyspaceCreateOptions::default)
            .map_err(store_err)?;
        Ok(Self { db, data, log })
    }
    fn ks(&self, t: Table) -> &Keyspace {
        match t {
            Table::Data => &self.data,
            Table::Log => &self.log,
        }
    }
}

struct FjallSnapshot {
    snap: FSnap,
    data: Keyspace,
    log: Keyspace,
}

impl Snapshot for FjallSnapshot {
    fn get(&self, table: Table, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let ks = if table == Table::Data {
            &self.data
        } else {
            &self.log
        };
        let v = self.snap.get(ks, key).map_err(store_err)?;
        Ok(v.map(|s| s.to_vec()))
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
        let ks = if table == Table::Data {
            &self.data
        } else {
            &self.log
        };
        let iter = self.snap.range(ks, start..end);
        if reverse {
            for g in iter.rev() {
                let (k, v) = g.into_inner().map_err(store_err)?;
                if !f(&k, &v) {
                    break;
                }
            }
        } else {
            for g in iter {
                let (k, v) = g.into_inner().map_err(store_err)?;
                if !f(&k, &v) {
                    break;
                }
            }
        }
        Ok(())
    }
}

impl BaseStore for FjallStore {
    fn name(&self) -> &'static str {
        "fjall"
    }
    fn snapshot(&self) -> Result<Box<dyn Snapshot>> {
        Ok(Box::new(FjallSnapshot {
            snap: self.db.snapshot(),
            data: self.data.clone(),
            log: self.log.clone(),
        }))
    }
    fn commit(&self, batch: &WriteBatch) -> Result<()> {
        let mut b = self.db.batch().durability(Some(PersistMode::SyncAll));
        for op in &batch.ops {
            let ks = self.ks(op.table);
            match &op.value {
                Some(v) => b.insert(ks, op.key.as_slice(), v.as_slice()),
                None => b.remove(ks, op.key.as_slice()),
            }
        }
        b.commit().map_err(store_err)
    }
}
