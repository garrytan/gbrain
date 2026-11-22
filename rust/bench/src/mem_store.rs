//! In-memory base store for tests and the deterministic simulation. Copy-on-write snapshots:
//! simple and obviously correct, not fast. Never used in benchmarks.

use crate::kv::*;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

type Map = BTreeMap<Vec<u8>, Vec<u8>>;

#[derive(Default)]
pub struct MemStore {
    tables: RwLock<[Arc<Map>; 2]>,
}

impl MemStore {
    pub fn new() -> Self {
        Self::default()
    }
}

fn idx(t: Table) -> usize {
    match t {
        Table::Data => 0,
        Table::Log => 1,
    }
}

struct MemSnapshot {
    tables: [Arc<Map>; 2],
}

impl Snapshot for MemSnapshot {
    fn get(&self, table: Table, key: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(self.tables[idx(table)].get(key).cloned())
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
        let range = self.tables[idx(table)].range(start.to_vec()..end.to_vec());
        if reverse {
            for (k, v) in range.rev() {
                if !f(k, v) {
                    break;
                }
            }
        } else {
            for (k, v) in range {
                if !f(k, v) {
                    break;
                }
            }
        }
        Ok(())
    }
}

impl BaseStore for MemStore {
    fn name(&self) -> &'static str {
        "mem"
    }
    fn snapshot(&self) -> Result<Box<dyn Snapshot>> {
        let t = self.tables.read().unwrap();
        Ok(Box::new(MemSnapshot {
            tables: [t[0].clone(), t[1].clone()],
        }))
    }
    fn commit(&self, batch: &WriteBatch) -> Result<()> {
        let mut t = self.tables.write().unwrap();
        let mut next = [(*t[0]).clone(), (*t[1]).clone()];
        for op in &batch.ops {
            let m = &mut next[idx(op.table)];
            match &op.value {
                Some(v) => {
                    m.insert(op.key.clone(), v.clone());
                }
                None => {
                    m.remove(&op.key);
                }
            }
        }
        *t = [
            Arc::new(std::mem::take(&mut next[0])),
            Arc::new(std::mem::take(&mut next[1])),
        ];
        Ok(())
    }
}
