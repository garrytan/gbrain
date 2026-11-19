//! Jobs slice 2: the writes on one job (`queue.ts` and `watchdog-attribution.ts`), each one
//! guarded `UPDATE ... RETURNING *`: the guard reads the row, a miss is `None`/`false`.

use super::*;

/// What `delayActiveJob` does to the row (the three `delayed` releases of the worker).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelayOpts {
    pub error_text: String,
    pub delay_ms: f64,
    /// `stacktrace = COALESCE(stacktrace, '[]') || to_jsonb(errorText)`.
    #[serde(default)]
    pub append_stack: bool,
    /// `timeout_at = NULL` (otherwise it is kept).
    #[serde(default)]
    pub clear_timeout: bool,
}

/// `TokenUpdate`: what `updateTokens` adds.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TokenDelta {
    #[serde(default)]
    pub input: i64,
    #[serde(default)]
    pub output: i64,
    #[serde(default)]
    pub cache_read: i64,
}

/// The row as one guarded `UPDATE ... RETURNING *` leaves it; None when the row is missing or the
/// guard refuses.
pub(super) fn update(
    tx: &mut dyn KvWrite,
    id: i64,
    guard: impl FnOnce(&JobRecord) -> bool,
    change: impl FnOnce(&mut JobRecord),
) -> Result<Option<JobRecord>> {
    let Some(old) = load(tx, id)? else {
        return Ok(None);
    };
    if !guard(&old) {
        return Ok(None);
    }
    let mut new = old.clone();
    change(&mut new);
    save(tx, Some(&old), &new)?;
    Ok(Some(new))
}

fn held_by(token: &str) -> impl Fn(&JobRecord) -> bool + '_ {
    move |r| r.status == "active" && r.lock_token.as_deref() == Some(token)
}

pub(super) fn add_token(what: &str, have: i32, delta: impl Into<i64>) -> Result<i32> {
    i32::try_from(i64::from(have) + delta.into())
        .map_err(|_| StoreError::invalid(format!("addJobTokens: {what} is out of integer range")))
}

/// `ensure the mark is in the stacktrace`: `appendSuspectMarkSql`.
fn mark(row: &mut JobRecord, mark: &str) {
    if !row.marked(mark) {
        row.append_stack(json!(mark));
    }
}

impl Store {
    /// `removeJob`: deletes a terminal row with its cascade; false for a live or missing row.
    pub fn delete_terminal_job(&self, id: i64) -> Result<bool> {
        self.write(|tx| {
            let Some(row) = load(tx, id)?.filter(|r| is_terminal(&r.status)) else {
                return Ok(false);
            };
            delete_row(tx, &row)?;
            Ok(true)
        })
    }

    /// `pauseJob`: a `waiting`, `active` or `delayed` row to `paused`, its lock dropped.
    pub fn pause_job(&self, id: i64) -> Result<Option<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let row = update(
                tx,
                id,
                |r| ["waiting", "active", "delayed"].contains(&r.status.as_str()),
                |r| {
                    r.status = "paused".into();
                    r.lock_token = None;
                    r.lock_until = None;
                    r.updated_at = now;
                },
            )?;
            Ok(row.map(|r| r.to_json()))
        })
    }

    /// `resumeJob` (the UPDATE; the queue authorizes first): `paused` back to `waiting`.
    pub fn resume_job(&self, id: i64) -> Result<Option<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let row = update(
                tx,
                id,
                |r| r.status == "paused",
                |r| {
                    r.status = "waiting".into();
                    r.lock_token = None;
                    r.lock_until = None;
                    r.updated_at = now;
                },
            )?;
            Ok(row.map(|r| r.to_json()))
        })
    }

    /// `failParent`: a `waiting-children` parent to `failed` with `error_text` (already the full
    /// text).
    pub fn fail_parent_job(&self, parent_id: i64, error_text: &str) -> Result<Option<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let row = update(
                tx,
                parent_id,
                |r| r.status == "waiting-children",
                |r| {
                    r.status = "failed".into();
                    r.lock_token = None;
                    r.lock_until = None;
                    r.error_text = Some(error_text.into());
                    r.finished_at = Some(now);
                    r.updated_at = now;
                },
            )?;
            Ok(row.map(|r| r.to_json()))
        })
    }

    /// `resolveParent`: a `waiting-children` row with no open child back to `waiting`.
    pub fn resolve_parent_job(&self, parent_id: i64) -> Result<Option<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            if live_children(tx, parent_id)? > 0 {
                return Ok(None);
            }
            let row = update(
                tx,
                parent_id,
                |r| r.status == "waiting-children",
                |r| {
                    r.status = "waiting".into();
                    r.started_at = None;
                    r.updated_at = now;
                },
            )?;
            Ok(row.map(|r| r.to_json()))
        })
    }

    /// The stall sweep's backstop: every `waiting-children` row with no open child back to
    /// `waiting`. Returns how many changed.
    pub fn resolve_stranded_parents(&self) -> Result<usize> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut changed = 0;
            for p in rows_with_status(tx, "waiting-children")? {
                if live_children(tx, p.id)? > 0 {
                    continue;
                }
                let mut new = p.clone();
                new.status = "waiting".into();
                new.started_at = None;
                new.updated_at = now;
                save(tx, Some(&p), &new)?;
                changed += 1;
            }
            Ok(changed)
        })
    }

    /// `removeChildDependency`: no status guard; `updated_at` moves.
    pub fn detach_child_job(&self, child_id: i64) -> Result<()> {
        self.write(|tx| {
            let now = self.env.now_micros();
            update(
                tx,
                child_id,
                |_| true,
                |r| {
                    r.parent_job_id = None;
                    r.updated_at = now;
                },
            )?;
            Ok(())
        })
    }

    /// `updateProgress`: token-fenced; any JSON (JSON null is SQL NULL).
    pub fn update_job_progress(&self, id: i64, lock_token: &str, progress: &Value) -> Result<bool> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let row = update(tx, id, held_by(lock_token), |r| {
                r.progress = Some(progress.clone()).filter(|p| !p.is_null());
                r.updated_at = now;
            })?;
            Ok(row.is_some())
        })
    }

    /// `updateTokens`: adds to the counters, token-fenced.
    pub fn add_job_tokens(&self, id: i64, lock_token: &str, tokens: &TokenDelta) -> Result<bool> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = load(tx, id)?.filter(held_by(lock_token)) else {
                return Ok(false);
            };
            let mut new = old.clone();
            new.tokens_input = add_token("input", old.tokens_input, tokens.input)?;
            new.tokens_output = add_token("output", old.tokens_output, tokens.output)?;
            new.tokens_cache_read =
                add_token("cache_read", old.tokens_cache_read, tokens.cache_read)?;
            new.updated_at = now;
            save(tx, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// The three worker releases to `delayed` (`releaseLeaseFullJob`, `deferJob`-like and
    /// `releaseConfigurationJob`): `delayed`, the error, `delay_until = now + delayMs`,
    /// `started_at` NULL, the lock dropped; token-fenced on an `active` row.
    pub fn delay_active_job(
        &self,
        id: i64,
        lock_token: &str,
        opts: &DelayOpts,
    ) -> Result<Option<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let row = update(tx, id, held_by(lock_token), |r| {
                r.status = "delayed".into();
                r.error_text = Some(opts.error_text.clone());
                if opts.append_stack {
                    r.append_stack(json!(opts.error_text));
                }
                r.delay_until = Some(now + ms_to_us(opts.delay_ms));
                r.started_at = None;
                if opts.clear_timeout {
                    r.timeout_at = None;
                }
                r.lock_token = None;
                r.lock_until = None;
                r.updated_at = now;
            })?;
            Ok(row.map(|r| r.to_json()))
        })
    }

    /// `releaseWatchdogClaim`: a co-runner of a watchdog drain back to `waiting`, marked, no
    /// attempt burned, token-fenced.
    pub fn release_watchdog_claim(
        &self,
        id: i64,
        lock_token: &str,
        error_text: &str,
        suspect_mark: &str,
    ) -> Result<bool> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let row = update(tx, id, held_by(lock_token), |r| {
                r.status = "waiting".into();
                r.error_text = Some(error_text.into());
                mark(r, suspect_mark);
                r.started_at = None;
                r.timeout_at = None;
                r.lock_token = None;
                r.lock_until = None;
                r.updated_at = now;
            })?;
            Ok(row.is_some())
        })
    }

    /// `markWatchdogSuspect`: appends the mark when absent; any status; `updated_at` is left alone.
    pub fn mark_job_watchdog_suspect(&self, id: i64, suspect_mark: &str) -> Result<()> {
        self.write(|tx| {
            update(tx, id, |_| true, |r| mark(r, suspect_mark))?;
            Ok(())
        })
    }

    /// `retryJob`'s UPDATE: a `failed` or `dead` row back to a fresh `waiting` row.
    pub fn retry_job_update(&self, id: i64) -> Result<Option<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let row = update(
                tx,
                id,
                |r| r.status == "failed" || r.status == "dead",
                |r| {
                    r.status = "waiting".into();
                    r.error_text = None;
                    r.lock_token = None;
                    r.lock_until = None;
                    r.delay_until = None;
                    r.finished_at = None;
                    r.started_at = None;
                    r.attempts_made = 0;
                    r.attempts_started = 0;
                    r.stalled_counter = 0;
                    r.updated_at = now;
                },
            )?;
            Ok(row.map(|r| r.to_json()))
        })
    }
}
