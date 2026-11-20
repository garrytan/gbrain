//! The page embedding lease (`src/core/engine-sql/page-spend.ts`, rust/docs/store/page_spend.md):
//! one `gbrain_cycle_locks` row `embed-page:<page id>`, in the cycle-lock keyspace
//! (`m LOCK id -> LockRecord`), so `listCycleLocks` and the writer admin fingerprint see it as
//! PGLite's table does.
//!
//! Lock contract: `takePageEmbeddingLease` writes the row when none exists or its TTL has passed
//! and reports whether it did; `renewPageEmbeddingLease` moves the TTL only while the row carries
//! the holder's token; `releasePageEmbeddingLease` deletes the holder's row and every
//! `embed-page:` row whose TTL has passed. None of them blocks: the holder decides when to wait.
//! Each is one `Store::write`, so a take and a competing take never both see the row free.

use super::*;

/// `PAGE_EMBEDDING_LEASE_PREFIX` (engine-sql/page-spend.ts).
const LEASE_PREFIX: &str = "embed-page:";

/// The holder a take records (`holder_pid`, `holder_host`).
#[derive(Debug, Clone, Deserialize)]
pub struct LeaseHolder {
    pub pid: i64,
    pub host: Option<String>,
}

/// `make_interval(mins => $n::int)`: the minutes round to a whole number first.
fn whole_minutes_us(minutes: f64) -> i64 {
    (minutes.round() as i64).saturating_mul(60_000_000)
}

impl Store {
    /// `takePageEmbeddingLease(id, holder, ttlMinutes, token)`: true when this holder now has the
    /// row; false while another holder's TTL runs.
    pub fn take_page_embedding_lease(
        &self,
        id: &str,
        holder: &LeaseHolder,
        ttl_minutes: f64,
        token: &str,
    ) -> Result<bool> {
        uuid_arg("takePageEmbeddingLease", token)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let key = lock_key(id);
            if let Some(held) = get_json::<LockRecord>(tx, &key)?
                && held.ttl_expires_at >= now
            {
                return Ok(false);
            }
            let record = LockRecord {
                holder_pid: holder.pid,
                holder_host: holder.host.clone(),
                acquired_at: now,
                ttl_expires_at: now + whole_minutes_us(ttl_minutes),
                last_refreshed_at: Some(now),
                acquisition_token: token.to_lowercase(),
            };
            put_json(tx, &key, &record)?;
            Ok(true)
        })
    }

    /// `renewPageEmbeddingLease(id, token, ttlMinutes)`: moves the TTL while the row carries
    /// `token`; false when no such row is left.
    pub fn renew_page_embedding_lease(
        &self,
        id: &str,
        token: &str,
        ttl_minutes: f64,
    ) -> Result<bool> {
        uuid_arg("renewPageEmbeddingLease", token)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let key = lock_key(id);
            let Some(mut held) = get_json::<LockRecord>(tx, &key)?
                .filter(|l| l.acquisition_token == token.to_lowercase())
            else {
                return Ok(false);
            };
            held.ttl_expires_at = now + whole_minutes_us(ttl_minutes);
            held.last_refreshed_at = Some(now);
            put_json(tx, &key, &held)?;
            Ok(true)
        })
    }

    /// `releasePageEmbeddingLease(id, token)`: deletes the holder's row and every page embedding
    /// lease whose TTL has passed.
    pub fn release_page_embedding_lease(&self, id: &str, token: &str) -> Result<()> {
        uuid_arg("releasePageEmbeddingLease", token)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            for (lock_id, held) in all_locks(tx)? {
                let own = lock_id == id && held.acquisition_token == token.to_lowercase();
                let expired = lock_id.starts_with(LEASE_PREFIX) && held.ttl_expires_at < now;
                if own || expired {
                    tx.delete(&lock_key(&lock_id))?;
                }
            }
            Ok(())
        })
    }
}
