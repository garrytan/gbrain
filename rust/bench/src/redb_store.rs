//! redb as a plain ordered key-value store. Durability::Immediate = one fsync per commit.

use crate::kv::*;
use redb::{Database, Durability, ReadTransaction, ReadableDatabase, TableDefinition};
use std::path::Path;

const DATA: TableDefinition<&[u8], &[u8]> = TableDefinition::new("data");
const LOG: TableDefinition<&[u8], &[u8]> = TableDefinition::new("log");

fn def(t: Table) -> TableDefinition<'static, &'static [u8], &'static [u8]> {
    match t {
        Table::Data => DATA,
        Table::Log => LOG,
    }
}

pub struct RedbStore {
    db: Database,
}

impl RedbStore {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir).map_err(store_err)?;
        let db = Database::builder()
            .create(dir.join("records.redb"))
            .map_err(store_err)?;
        // Make sure both tables exist so read snapshots can always open them.
        let w = db.begin_write().map_err(store_err)?;
        w.open_table(DATA).map_err(store_err)?;
        w.open_table(LOG).map_err(store_err)?;
        w.commit().map_err(store_err)?;
        Ok(Self { db })
    }
}

struct RedbSnapshot {
    tx: ReadTransaction,
}

impl Snapshot for RedbSnapshot {
    fn get(&self, table: Table, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let t = self.tx.open_table(def(table)).map_err(store_err)?;
        let v = t.get(key).map_err(store_err)?;
        Ok(v.map(|g| g.value().to_vec()))
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
        let t = self.tx.open_table(def(table)).map_err(store_err)?;
        let range = t.range::<&[u8]>(start..end).map_err(store_err)?;
        if reverse {
            for item in range.rev() {
                let (k, v) = item.map_err(store_err)?;
                if !f(k.value(), v.value()) {
                    break;
                }
            }
        } else {
            for item in range {
                let (k, v) = item.map_err(store_err)?;
                if !f(k.value(), v.value()) {
                    break;
                }
            }
        }
        Ok(())
    }
}

impl BaseStore for RedbStore {
    fn name(&self) -> &'static str {
        "redb"
    }
    fn snapshot(&self) -> Result<Box<dyn Snapshot>> {
        let tx = self.db.begin_read().map_err(store_err)?;
        Ok(Box::new(RedbSnapshot { tx }))
    }
    fn commit(&self, batch: &WriteBatch) -> Result<()> {
        let mut w = self.db.begin_write().map_err(store_err)?;
        w.set_durability(Durability::Immediate).map_err(store_err)?;
        {
            let mut data = w.open_table(DATA).map_err(store_err)?;
            let mut log = w.open_table(LOG).map_err(store_err)?;
            for op in &batch.ops {
                let t = match op.table {
                    Table::Data => &mut data,
                    Table::Log => &mut log,
                };
                match &op.value {
                    Some(v) => {
                        t.insert(op.key.as_slice(), v.as_slice())
                            .map_err(store_err)?;
                    }
                    None => {
                        t.remove(op.key.as_slice()).map_err(store_err)?;
                    }
                }
            }
        }
        w.commit().map_err(store_err)
    }
}
