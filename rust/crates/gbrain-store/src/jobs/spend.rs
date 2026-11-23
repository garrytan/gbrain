//! Jobs: `mcp_spend_reservations` (the holds a paid call places before it runs and what each settled
//! at) and `minion_lease_pressure_log` (one row per rate-lease bounce), as the members of
//! `src/core/engine-sql/jobs-spend.ts` run them (rust/docs/store/jobs-spend.md).
//!
//! Members: readJobSpendTree, insertSpendReservation, expireSpendReservations,
//! settleSpendReservation, markSpendUsageUnknown, insertLeasePressure, countLeasePressure,
//! listRecentLeasePressure. The ledger (`mcp_spend_log`) and the client caps (`oauth_clients`) are in
//! `spend_log.rs` and `oauth_clients.rs` (rust/docs/store/spend-log.md); they read the holds through
//! the helpers here (`insert_res`, `expire_res`, `settle_res`, `open_holds`).
//!
//! Keys, all under `keys::JOBS` (`m`), sub-tags 0x20 to 0x27 (this file only):
//! - `m 0x20 reservation_uuid(16) -> ResRecord`: one reservation. A UUID is stored as its 16 bytes,
//!   so any spelling the column accepts names the same row.
//! - `m 0x21 job reservation_uuid`: the reservations of a job (the foreign key's index).
//! - `m 0x22 expires_at reservation_uuid`: the `pending` reservations by expiry (the sweep).
//! - `m 0x27 kind owner \0 reservation_uuid`: the reservations that are not `settled`, by owner (`c`
//!   client id, `b` budget key), for the admissions' sums. `save_res` keeps it. A reservation written
//!   by a build before the index is not in it (no backfill).
//! - `m 0x24 id -> LogRecord`: one lease-pressure row (sequence `lease_pressure`).
//! - `m 0x25 bounced_at id`: the log in time order (the window reads, newest first by a reverse scan).
//! - `m 0x26 job id`: the log rows of a job that still exists (the foreign key's index).
//!
//! Foreign key: `job_id` names a job that exists (`constraint_violation` otherwise); deleting the
//! job sets it to NULL on both tables and leaves every other column alone (`delete_row` calls
//! `detach_job`). Checks: a reservation has a status of `pending`, `settled` or `expired`, exactly
//! one of `client_id` and `budget_key`, and a `NUMERIC(12,4)` amount (a half-away-from-zero rounding to four
//! decimals; eight integer digits at most). A refused insert changes nothing and spends no id:
//! Postgres spends a sequence value on an insert its foreign key refuses.
//!
//! Time: `now` is read once per call from the store's clock; an overdue hold is `expires_at < now`,
//! a bounce in a window is `bounced_at > now - round(ms * 1000)` µs.

use super::*;
use crate::env::parse_iso;

const RES: u8 = 0x20;
const RES_JOB: u8 = 0x21;
const RES_EXP: u8 = 0x22;
const RES_OPEN: u8 = 0x27;
const LOG: u8 = 0x24;
const LOG_AT: u8 = 0x25;
const LOG_JOB: u8 = 0x26;

/// Scaled amounts: `NUMERIC(12,4)` is an integer count of 1/10000 cent.
pub(super) const SCALE: i64 = 10_000;

fn res_key(id: &[u8; 16]) -> Vec<u8> {
    let mut k = prefix(RES);
    k.extend_from_slice(id);
    k
}

fn res_job_prefix(job: i64) -> Vec<u8> {
    let mut k = prefix(RES_JOB);
    k.extend_from_slice(&signed_key(job));
    k
}

fn res_job_key(job: i64, id: &[u8; 16]) -> Vec<u8> {
    let mut k = res_job_prefix(job);
    k.extend_from_slice(id);
    k
}

fn res_exp_key(expires_at: i64, id: &[u8; 16]) -> Vec<u8> {
    let mut k = prefix(RES_EXP);
    k.extend_from_slice(&signed_key(expires_at));
    k.extend_from_slice(id);
    k
}

/// The owner an open-hold index entry is filed under: `c` + client id, or `b` + budget key.
fn res_owner(r: &ResRecord) -> Option<(u8, &str)> {
    match (&r.client_id, &r.budget_key) {
        (Some(c), _) => Some((b'c', c.as_str())),
        (None, Some(b)) => Some((b'b', b.as_str())),
        _ => None,
    }
}

fn res_open_prefix(kind: u8, owner: &str) -> Vec<u8> {
    let mut k = prefix(RES_OPEN);
    k.push(kind);
    k.extend_from_slice(owner.as_bytes());
    k.push(0);
    k
}

fn res_open_key(kind: u8, owner: &str, id: &[u8; 16]) -> Vec<u8> {
    let mut k = res_open_prefix(kind, owner);
    k.extend_from_slice(id);
    k
}

fn log_key(id: i64) -> Vec<u8> {
    let mut k = prefix(LOG);
    k.extend_from_slice(&signed_key(id));
    k
}

fn log_at_key(bounced_at: i64, id: i64) -> Vec<u8> {
    let mut k = prefix(LOG_AT);
    k.extend_from_slice(&signed_key(bounced_at));
    k.extend_from_slice(&signed_key(id));
    k
}

fn log_job_prefix(job: i64) -> Vec<u8> {
    let mut k = prefix(LOG_JOB);
    k.extend_from_slice(&signed_key(job));
    k
}

fn log_job_key(job: i64, id: i64) -> Vec<u8> {
    let mut k = log_job_prefix(job);
    k.extend_from_slice(&signed_key(id));
    k
}

/// The `bounced_at` a `LOG_AT` key holds.
fn key_time(key: &[u8]) -> Option<i64> {
    let bytes: [u8; 8] = key.get(2..10)?.try_into().ok()?;
    Some((u64::from_be_bytes(bytes) ^ (1 << 63)) as i64)
}

/// The text of a UUID as Postgres prints it: lowercase, hyphenated, every bit kept (the reservation ids the budget
/// meter makes are version 7, so the version bits must not be rewritten).
pub(super) fn uuid_text(b: &[u8; 16]) -> String {
    let hex: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    )
}

/// The 16 bytes of a UUID in any spelling the column takes: hyphenated (8-4-4-4-12), or 32 hex digits.
pub(super) fn uuid_bytes(text: &str) -> Result<[u8; 16]> {
    let bad = || StoreError::invalid(format!("invalid input syntax for type uuid: \"{text}\""));
    let b = text.as_bytes();
    let hyphenated = b.len() == 36 && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-');
    let digits: String = if hyphenated {
        text.replace('-', "")
    } else {
        text.to_string()
    };
    if digits.len() != 32 || !digits.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad());
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digits[i * 2..i * 2 + 2], 16).map_err(|_| bad())?;
    }
    Ok(out)
}

/// `NUMERIC(12,4)` of a JavaScript number: the shortest decimal text of the double, rounded half
/// away from zero to four decimals, as a count of 1/10000.
pub(super) fn numeric_4(value: f64, what: &str) -> Result<i64> {
    numeric_fixed(value, 4, 8, what)
}

/// `NUMERIC(int_digits + decimals, decimals)` of a JavaScript number, as a count of `10^-decimals`: the
/// shortest decimal text of the double, rounded half away from zero (`overflow` past `int_digits` integer digits).
pub(super) fn numeric_fixed(
    value: f64,
    decimals: usize,
    int_digits: usize,
    what: &str,
) -> Result<i64> {
    if !value.is_finite() {
        return Err(StoreError::invalid(format!(
            "{what}: {value} is not a finite number"
        )));
    }
    let text = format!("{value}");
    let (negative, body) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.as_str()),
    };
    let (int_part, frac_part) = body.split_once('.').unwrap_or((body, ""));
    let overflow = || {
        StoreError::new(
            CONSTRAINT_VIOLATION,
            format!(
                "numeric field overflow: {what} {value} does not fit NUMERIC({},{decimals})",
                int_digits + decimals
            ),
        )
    };
    if int_part.len() > int_digits && int_part.trim_start_matches('0').len() > int_digits {
        return Err(overflow());
    }
    let mut frac: Vec<u8> = frac_part.bytes().collect();
    let round_up = frac.get(decimals).is_some_and(|d| *d >= b'5');
    frac.resize(decimals, b'0');
    let unit = 10_i64.pow(decimals as u32);
    let whole: i64 = int_part.parse().map_err(|_| overflow())?;
    let tail: i64 = if decimals == 0 {
        0
    } else {
        std::str::from_utf8(&frac[..decimals])
            .ok()
            .and_then(|t| t.parse().ok())
            .ok_or_else(overflow)?
    };
    let scaled = whole
        .checked_mul(unit)
        .and_then(|w| w.checked_add(tail + i64::from(round_up)))
        .filter(|s| *s < 10_i64.pow((int_digits + decimals) as u32))
        .ok_or_else(overflow)?;
    Ok(if negative { -scaled } else { scaled })
}

pub(super) fn cents(scaled: i64) -> f64 {
    scaled as f64 / SCALE as f64
}

/// One `mcp_spend_reservations` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ResRecord {
    pub(super) reservation_id: String,
    pub(super) client_id: Option<String>,
    pub(super) budget_key: Option<String>,
    pub(super) job_id: Option<i64>,
    pub(super) estimated: i64,
    pub(super) actual: Option<i64>,
    pub(super) model: String,
    pub(super) provider: String,
    pub(super) status: String,
    pub(super) created_at: i64,
    pub(super) settled_at: Option<i64>,
    pub(super) expires_at: i64,
    pub(super) estimate_known: bool,
    pub(super) usage_unknown_reason: Option<String>,
}

impl ResRecord {
    fn id_bytes(&self) -> [u8; 16] {
        uuid_bytes(&self.reservation_id).unwrap_or([0; 16])
    }

    /// `SELECT *`: amounts as numbers, times as µs ISO text.
    fn to_json(&self) -> Value {
        json!({
            "reservation_id": self.reservation_id,
            "client_id": self.client_id,
            "budget_key": self.budget_key.clone(),
            "job_id": self.job_id,
            "estimated_cents": cents(self.estimated),
            "actual_cents": self.actual.map(cents),
            "model": self.model,
            "provider": self.provider,
            "status": self.status,
            "created_at": iso(self.created_at),
            "settled_at": self.settled_at.map(iso),
            "expires_at": iso(self.expires_at),
            "estimate_known": self.estimate_known,
            "usage_unknown_reason": self.usage_unknown_reason,
        })
    }
}

/// `insertSpendReservation(row)`: one new `pending` reservation.
#[derive(Debug, Clone, Deserialize)]
pub struct SpendInsert {
    pub reservation_id: String,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub budget_key: Option<String>,
    #[serde(default)]
    pub job_id: Option<i64>,
    pub estimated_cents: f64,
    pub model: String,
    pub provider: String,
    /// ISO text (the TypeScript member turns the `Date`).
    pub expires_at: String,
    pub estimate_known: bool,
    #[serde(default)]
    pub usage_unknown_reason: Option<String>,
}

/// `expireSpendReservations(scope)`: every given field must match.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpireScope {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub budget_key: Option<String>,
}

/// `readJobSpendTree(spec)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendTreeSpec {
    #[serde(default)]
    pub job_ids: Vec<i64>,
    #[serde(default)]
    pub owner: Option<String>,
}

/// One `minion_lease_pressure_log` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LogRecord {
    id: i64,
    job_id: Option<i64>,
    lease_key: String,
    active_at_bounce: i32,
    max_concurrent: i32,
    bounced_at: i64,
    queue_name: Option<String>,
    job_name: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    root_owner_id: Option<i64>,
}

impl LogRecord {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "job_id": self.job_id,
            "lease_key": self.lease_key.clone(),
            "active_at_bounce": self.active_at_bounce,
            "max_concurrent": self.max_concurrent,
            "bounced_at": iso(self.bounced_at),
            "queue_name": self.queue_name,
            "job_name": self.job_name,
            "model": self.model,
            "provider": self.provider,
            "root_owner_id": self.root_owner_id,
        })
    }
}

/// `insertLeasePressure(row)`: one bounce.
#[derive(Debug, Clone, Deserialize)]
pub struct LeaseInsert {
    #[serde(default)]
    pub job_id: Option<i64>,
    pub lease_key: String,
    pub active_at_bounce: i64,
    pub max_concurrent: i64,
    #[serde(default)]
    pub queue_name: Option<String>,
    #[serde(default)]
    pub job_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub root_owner_id: Option<i64>,
}

/// `countLeasePressure(filter)`: every given field must match.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseFilter {
    #[serde(default)]
    pub window_ms: Option<f64>,
    #[serde(default)]
    pub job_id: Option<i64>,
    #[serde(default)]
    pub lease_key: Option<String>,
}

pub(super) fn load_res(read: &dyn KvRead, id: &[u8; 16]) -> Result<Option<ResRecord>> {
    get_json(read, &res_key(id))
}

/// Write a reservation and move its index entries from the old row to the new one.
pub(super) fn save_res(
    tx: &mut dyn KvWrite,
    old: Option<&ResRecord>,
    new: &ResRecord,
) -> Result<()> {
    let id = new.id_bytes();
    if res_owner(new).is_some_and(|(_, owner)| owner.contains('\0')) {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "mcp_spend_reservations owner: a NUL byte is not valid text",
        ));
    }
    if let Some(old) = old {
        if let Some(job) = old.job_id {
            tx.delete(&res_job_key(job, &id))?;
        }
        if old.status == "pending" {
            tx.delete(&res_exp_key(old.expires_at, &id))?;
        }
        if old.status != "settled"
            && let Some((kind, owner)) = res_owner(old)
        {
            tx.delete(&res_open_key(kind, owner, &id))?;
        }
    }
    if let Some(job) = new.job_id {
        tx.put(&res_job_key(job, &id), b"")?;
    }
    if new.status == "pending" {
        tx.put(&res_exp_key(new.expires_at, &id), b"")?;
    }
    if new.status != "settled"
        && let Some((kind, owner)) = res_owner(new)
    {
        tx.put(&res_open_key(kind, owner, &id), b"")?;
    }
    put_json(tx, &res_key(&id), new)
}

fn load_log(read: &dyn KvRead, id: i64) -> Result<Option<LogRecord>> {
    get_json(read, &log_key(id))
}

/// The reservation ids of a job (the `RES_JOB` index).
fn res_ids_of_job(read: &dyn KvRead, job: i64) -> Result<Vec<[u8; 16]>> {
    let mut ids = Vec::new();
    scan_prefix(read, &res_job_prefix(job), false, &mut |k, _| {
        if let Some(id) = k
            .get(k.len().saturating_sub(16)..)
            .and_then(|t| <[u8; 16]>::try_from(t).ok())
        {
            ids.push(id);
        }
        true
    })?;
    Ok(ids)
}

/// A deleted job's rows lose their job (`ON DELETE SET NULL`): both tables, every other column kept.
pub(super) fn detach_job(tx: &mut dyn KvWrite, job: i64) -> Result<()> {
    for id in res_ids_of_job(tx, job)? {
        if let Some(old) = load_res(tx, &id)? {
            let mut new = old.clone();
            new.job_id = None;
            save_res(tx, Some(&old), &new)?;
        }
    }
    for id in ids_under(tx, &log_job_prefix(job))? {
        if let Some(mut row) = load_log(tx, id)? {
            tx.delete(&log_job_key(job, id))?;
            row.job_id = None;
            put_json(tx, &log_key(id), &row)?;
        }
    }
    Ok(())
}

/// `windowMs` as the µs cutoff a bounce must be after: `now - round(ms * 1000)`.
fn cutoff(now: i64, window_ms: f64) -> Result<i64> {
    if !window_ms.is_finite() {
        return Err(StoreError::invalid(format!(
            "windowMs: {window_ms} is not a finite number"
        )));
    }
    Ok(now.saturating_sub(ms_to_us(window_ms)))
}

/// What `insertSpendReservation` checks before it opens a write: the id, the expiry time and the amount.
pub(super) struct ParsedInsert {
    id: [u8; 16],
    expires_at: i64,
    estimated: i64,
}

impl ParsedInsert {
    pub(super) fn new(row: &SpendInsert) -> Result<Self> {
        let id = uuid_bytes(&row.reservation_id)?;
        let expires_at = parse_iso(&row.expires_at).ok_or_else(|| {
            StoreError::invalid(format!(
                "expires_at: \"{}\" is not an ISO time",
                row.expires_at
            ))
        })?;
        let estimated = numeric_4(row.estimated_cents, "estimated_cents")?;
        Ok(Self {
            id,
            expires_at,
            estimated,
        })
    }
}

/// Insert one `pending` reservation inside a write (`now` is the call's one clock read).
pub(super) fn insert_res(
    tx: &mut dyn KvWrite,
    now: i64,
    row: &SpendInsert,
    parsed: &ParsedInsert,
) -> Result<()> {
    let id = parsed.id;
    if row.client_id.is_some() == row.budget_key.is_some() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "mcp_spend_reservations check: exactly one of client_id and budget_key",
        ));
    }
    if let Some(job) = row.job_id
        && load(tx, job)?.is_none()
    {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!("mcp_spend_reservations foreign key: job {job} does not exist"),
        ));
    }
    if load_res(tx, &id)?.is_some() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "duplicate key value violates unique constraint \"mcp_spend_reservations_pkey\"",
        ));
    }
    let record = ResRecord {
        reservation_id: uuid_text(&id),
        client_id: row.client_id.clone(),
        budget_key: row.budget_key.clone(),
        job_id: row.job_id,
        estimated: parsed.estimated,
        actual: None,
        model: row.model.clone(),
        provider: row.provider.clone(),
        status: "pending".to_string(),
        created_at: now,
        settled_at: None,
        expires_at: parsed.expires_at,
        estimate_known: row.estimate_known,
        usage_unknown_reason: row.usage_unknown_reason.clone(),
    };
    save_res(tx, None, &record)
}

/// One `mcp_spend_reservations` row as the shadow seed copies it. `job_id` is not here: the seed stores NULL.
pub(crate) struct SeedReservation {
    pub reservation_id: String,
    pub client_id: Option<String>,
    pub budget_key: Option<String>,
    /// `NUMERIC(12,4)`.
    pub estimated_cents: f64,
    pub actual_cents: Option<f64>,
    pub model: String,
    pub provider: String,
    pub status: String,
    pub created_at: i64,
    pub settled_at: Option<i64>,
    pub expires_at: i64,
    pub estimate_known: bool,
    pub usage_unknown_reason: Option<String>,
}

/// The shadow seed (`seed.rs`): stores a reservation with its status and times, and every index key `save_res` writes
/// for that status. The job is NULL (`minion_jobs` is not seeded). `false` when the reservation id is already stored.
pub(crate) fn seed_reservation(tx: &mut dyn KvWrite, row: SeedReservation) -> Result<bool> {
    let id = uuid_bytes(&row.reservation_id)?;
    if row.client_id.is_some() == row.budget_key.is_some() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "mcp_spend_reservations check: exactly one of client_id and budget_key",
        ));
    }
    if !["pending", "settled", "expired"].contains(&row.status.as_str()) {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!(
                "mcp_spend_reservations check: status {:?} is not pending, settled or expired",
                row.status
            ),
        ));
    }
    if load_res(&*tx, &id)?.is_some() {
        return Ok(false);
    }
    let record = ResRecord {
        reservation_id: uuid_text(&id),
        client_id: row.client_id,
        budget_key: row.budget_key,
        job_id: None,
        estimated: numeric_4(row.estimated_cents, "estimated_cents")?,
        actual: row
            .actual_cents
            .map(|c| numeric_4(c, "actual_cents"))
            .transpose()?,
        model: row.model,
        provider: row.provider,
        status: row.status,
        created_at: row.created_at,
        settled_at: row.settled_at,
        expires_at: row.expires_at,
        estimate_known: row.estimate_known,
        usage_unknown_reason: row.usage_unknown_reason,
    };
    save_res(tx, None, &record)?;
    Ok(true)
}

/// Mark every `pending` reservation past its expiry (`expires_at < now`) `expired`, among those that match the scope.
pub(super) fn expire_res(tx: &mut dyn KvWrite, now: i64, scope: &ExpireScope) -> Result<i64> {
    let mut due = Vec::new();
    scan_prefix(tx, &prefix(RES_EXP), false, &mut |k, _| match key_time(k) {
        Some(at) if at < now => {
            if let Ok(id) = <[u8; 16]>::try_from(&k[k.len() - 16..]) {
                due.push(id);
            }
            true
        }
        _ => false,
    })?;
    let mut count = 0;
    for id in due {
        let Some(old) = load_res(tx, &id)? else {
            continue;
        };
        if scope
            .client_id
            .as_ref()
            .is_some_and(|c| old.client_id.as_ref() != Some(c))
            || scope
                .budget_key
                .as_ref()
                .is_some_and(|b| old.budget_key.as_ref() != Some(b))
        {
            continue;
        }
        let mut new = old.clone();
        new.status = "expired".to_string();
        save_res(tx, Some(&old), &new)?;
        count += 1;
    }
    Ok(count)
}

/// What settling a reservation found.
pub(super) enum Settle {
    Missing,
    Already,
    /// The settled row.
    Done(Box<ResRecord>),
}

/// Settle a `pending` or `expired` reservation at `actual` (scaled), stamped `now`.
pub(super) fn settle_res(
    tx: &mut dyn KvWrite,
    now: i64,
    id: &[u8; 16],
    actual: i64,
) -> Result<Settle> {
    let Some(old) = load_res(tx, id)? else {
        return Ok(Settle::Missing);
    };
    if old.status == "settled" {
        return Ok(Settle::Already);
    }
    let mut new = old.clone();
    new.status = "settled".to_string();
    new.actual = Some(actual);
    new.usage_unknown_reason = None;
    new.settled_at = Some(now);
    save_res(tx, Some(&old), &new)?;
    Ok(Settle::Done(Box::new(new)))
}

/// The `pending` and `expired` reservations of one owner (`c` client id, `b` budget key), from the open-hold index.
pub(super) fn open_holds(read: &dyn KvRead, kind: u8, owner: &str) -> Result<Vec<ResRecord>> {
    let mut ids = Vec::new();
    scan_prefix(read, &res_open_prefix(kind, owner), false, &mut |k, _| {
        if let Some(id) = k
            .get(k.len().saturating_sub(16)..)
            .and_then(|t| <[u8; 16]>::try_from(t).ok())
        {
            ids.push(id);
        }
        true
    })?;
    let mut rows = Vec::new();
    for id in ids {
        if let Some(r) = load_res(read, &id)? {
            rows.push(r);
        }
    }
    Ok(rows)
}

impl Store {
    /// `insertSpendReservation(row)`. `constraint_violation` for a job that does not exist, for neither or both of
    /// `client_id` and `budget_key`, for a reservation id already taken, and for an amount that overflows
    /// `NUMERIC(12,4)`; `invalid_argument` for an id that is not a UUID or a time that is not ISO text.
    pub fn insert_spend_reservation(&self, row: &SpendInsert) -> Result<()> {
        let parsed = ParsedInsert::new(row)?;
        self.write(|tx| insert_res(tx, self.env.now_micros(), row, &parsed))
    }

    /// `expireSpendReservations(scope)`: how many `pending` reservations past their expiry (`expires_at < now`) were
    /// marked `expired`, among those that match every field of the scope.
    pub fn expire_spend_reservations(&self, scope: &ExpireScope) -> Result<i64> {
        self.write(|tx| expire_res(tx, self.env.now_micros(), scope))
    }

    /// `settleSpendReservation(id, actualCents)`: `{ outcome: 'settled', client_id, budget_key, model, provider }` for a
    /// `pending` or `expired` hold (now `settled` with the actual cents, the settle time and no unknown-usage reason),
    /// `{ outcome: 'already_settled' }` or `{ outcome: 'missing' }`.
    pub fn settle_spend_reservation(
        &self,
        reservation_id: &str,
        actual_cents: f64,
    ) -> Result<Value> {
        let id = uuid_bytes(reservation_id)?;
        let actual = numeric_4(actual_cents, "actual_cents")?;
        self.write(|tx| {
            Ok(match settle_res(tx, self.env.now_micros(), &id, actual)? {
                Settle::Missing => json!({ "outcome": "missing" }),
                Settle::Already => json!({ "outcome": "already_settled" }),
                Settle::Done(new) => json!({
                    "outcome": "settled", "client_id": new.client_id, "budget_key": new.budget_key,
                    "model": new.model, "provider": new.provider,
                }),
            })
        })
    }

    /// `markSpendUsageUnknown(id, reason)`: whether a `pending` or `expired` hold took the reason.
    pub fn mark_spend_usage_unknown(&self, reservation_id: &str, reason: &str) -> Result<bool> {
        let id = uuid_bytes(reservation_id)?;
        self.write(|tx| {
            let Some(old) = load_res(tx, &id)?.filter(|r| r.status != "settled") else {
                return Ok(false);
            };
            let mut new = old.clone();
            new.usage_unknown_reason = Some(reason.to_string());
            save_res(tx, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// One reservation as `SELECT *` returns it, or None. Not an engine member: the diagnostic the tests read state with.
    pub fn spend_reservation_row(&self, reservation_id: &str) -> Result<Option<Value>> {
        let id = uuid_bytes(reservation_id)?;
        Ok(load_res(&*self.read()?, &id)?.map(|r| r.to_json()))
    }

    /// `readJobSpendTree({ jobIds, owner })`: per described job that exists, the reservations of the job itself
    /// (`self: true`) and of its descendants to depth 20 (`self: false`), as `{ root, self, settled_cents, priced,
    /// unsettled }`: the settled actual cents (null with none priced), how many settled holds carry an actual amount and
    /// how many do not. An owner-fenced caller counts only the descendants whose `__owner_client_id` is the owner. A
    /// part with no reservation has no row. By job id, then the descendants before the job itself.
    pub fn read_job_spend_tree(&self, spec: &SpendTreeSpec) -> Result<Value> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for root in spec.job_ids.iter().copied().collect::<BTreeSet<i64>>() {
            let Some(top) = load(&*read, root)? else {
                continue;
            };
            // `tree`: the job and its descendants, one level at a time (a node's children are the rows naming it as their
            // parent), with no memory of a node already seen, as `UNION ALL` has none.
            let mut level = vec![(top.id, owner_text(&top))];
            let mut nodes = Vec::new();
            for depth in 0..=20 {
                nodes.extend(level.iter().cloned());
                if depth == 20 {
                    break;
                }
                let mut next = Vec::new();
                for (id, _) in &level {
                    for child in ids_under(&*read, &child_prefix(*id))? {
                        if let Some(c) = load(&*read, child)? {
                            next.push((c.id, owner_text(&c)));
                        }
                    }
                }
                if next.is_empty() {
                    break;
                }
                level = next;
            }
            // `[sum, priced, unsettled, any]` for the descendants (0) and the job itself (1).
            let mut part = [(0_i64, 0_i64, 0_i64, false), (0_i64, 0_i64, 0_i64, false)];
            for (id, owner) in nodes {
                let is_self = id == root;
                if !is_self && spec.owner.is_some() && owner != spec.owner {
                    continue;
                }
                for res_id in res_ids_of_job(&*read, id)? {
                    let Some(r) = load_res(&*read, &res_id)? else {
                        continue;
                    };
                    let slot = &mut part[usize::from(is_self)];
                    slot.3 = true;
                    match (r.status == "settled", r.actual) {
                        (true, Some(actual)) => {
                            slot.0 += actual;
                            slot.1 += 1;
                        }
                        _ => slot.2 += 1,
                    }
                }
            }
            for (is_self, (sum, priced, unsettled, any)) in part.into_iter().enumerate() {
                if any {
                    rows.push(json!({
                        "root": root, "self": is_self == 1,
                        "settled_cents": if priced > 0 { json!(cents(sum)) } else { Value::Null },
                        "priced": priced, "unsettled": unsettled,
                    }));
                }
            }
        }
        Ok(Value::Array(rows))
    }

    /// `insertLeasePressure(row)`, stamped with the store clock. `constraint_violation` for a job that does not exist;
    /// `invalid_argument` for a count outside `INTEGER`.
    pub fn insert_lease_pressure(&self, row: &LeaseInsert) -> Result<()> {
        let count = |v: i64, what: &str| {
            i32::try_from(v).map_err(|_| {
                StoreError::invalid(format!("{what}: {v} is out of range for type integer"))
            })
        };
        let (active, max) = (
            count(row.active_at_bounce, "active_at_bounce")?,
            count(row.max_concurrent, "max_concurrent")?,
        );
        self.write(|tx| {
            let now = self.env.now_micros();
            if let Some(job) = row.job_id
                && load(tx, job)?.is_none()
            {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("minion_lease_pressure_log foreign key: job {job} does not exist"),
                ));
            }
            let id = next_seq(tx, "lease_pressure")?;
            let record = LogRecord {
                id,
                job_id: row.job_id,
                lease_key: row.lease_key.clone(),
                active_at_bounce: active,
                max_concurrent: max,
                bounced_at: now,
                queue_name: row.queue_name.clone(),
                job_name: row.job_name.clone(),
                model: row.model.clone(),
                provider: row.provider.clone(),
                root_owner_id: row.root_owner_id,
            };
            put_json(tx, &log_key(id), &record)?;
            tx.put(&log_at_key(now, id), b"")?;
            if let Some(job) = row.job_id {
                tx.put(&log_job_key(job, id), b"")?;
            }
            Ok(())
        })
    }

    /// `countLeasePressure(filter)`: the bounces that match every given field (a window, a job, a lease key).
    pub fn count_lease_pressure(&self, filter: &LeaseFilter) -> Result<i64> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let after = filter.window_ms.map(|ms| cutoff(now, ms)).transpose()?;
        let mut ids = Vec::new();
        let mut bad = None;
        // Newest first, stopping at the window's edge; the rows of one job through the job index when there is no window.
        match (after, filter.job_id) {
            (None, Some(job)) => ids = ids_under(&*read, &log_job_prefix(job))?,
            _ => scan_prefix(&*read, &prefix(LOG_AT), true, &mut |k, _| match (
                key_time(k),
                last_id(k),
            ) {
                (Some(at), Some(id)) => {
                    if after.is_some_and(|a| at <= a) {
                        return false;
                    }
                    ids.push(id);
                    true
                }
                _ => {
                    bad = Some(StoreError::new(
                        crate::error::STORE_CORRUPT,
                        "a lease-pressure index key is short",
                    ));
                    false
                }
            })?,
        }
        if let Some(e) = bad {
            return Err(e);
        }
        if filter.job_id.is_none() && filter.lease_key.is_none() {
            return Ok(ids.len() as i64);
        }
        let mut n = 0;
        for id in ids {
            let Some(row) = load_log(&*read, id)? else {
                continue;
            };
            if filter.job_id.is_some_and(|j| row.job_id != Some(j))
                || filter
                    .lease_key
                    .as_ref()
                    .is_some_and(|k| &row.lease_key != k)
            {
                continue;
            }
            n += 1;
        }
        Ok(n)
    }

    /// `listRecentLeasePressure(windowMs, limit)`: the bounces after `now - windowMs`, newest first (then highest id), at
    /// most `limit`, as `SELECT` returns them (`bounced_at` as µs ISO text).
    pub fn list_recent_lease_pressure(&self, window_ms: f64, limit: i64) -> Result<Value> {
        if limit < 0 {
            return Err(StoreError::invalid("LIMIT must not be negative"));
        }
        let read = self.read()?;
        let after = cutoff(self.env.now_micros(), window_ms)?;
        let mut ids = Vec::new();
        if limit > 0 {
            scan_prefix(&*read, &prefix(LOG_AT), true, &mut |k, _| {
                if key_time(k).is_some_and(|at| at <= after) {
                    return false;
                }
                if let Some(id) = last_id(k) {
                    ids.push(id);
                }
                (ids.len() as i64) < limit
            })?;
        }
        let mut rows = Vec::new();
        for id in ids {
            if let Some(row) = load_log(&*read, id)? {
                rows.push(row.to_json());
            }
        }
        Ok(Value::Array(rows))
    }
}

/// `data->>'__owner_client_id'`.
fn owner_text(row: &JobRecord) -> Option<String> {
    row.data.get("__owner_client_id").and_then(jsonb_field_text)
}

/// The shadow follow (`seed/follow.rs`): removes the reservation `reservation_id` and its index
/// entries. `false` when there is none.
pub(crate) fn remove_reservation(tx: &mut dyn KvWrite, reservation_id: &str) -> Result<bool> {
    let id = uuid_bytes(reservation_id)?;
    let Some(old) = load_res(&*tx, &id)? else {
        return Ok(false);
    };
    if let Some(job) = old.job_id {
        tx.delete(&res_job_key(job, &id))?;
    }
    if old.status == "pending" {
        tx.delete(&res_exp_key(old.expires_at, &id))?;
    }
    if old.status != "settled"
        && let Some((kind, owner)) = res_owner(&old)
    {
        tx.delete(&res_open_key(kind, owner, &id))?;
    }
    tx.delete(&res_key(&id))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_rounds_half_away_from_zero_to_four_decimals() {
        assert_eq!(numeric_4(0.12345, "x").unwrap(), 1235);
        assert_eq!(numeric_4(-0.12345, "x").unwrap(), -1235);
        assert_eq!(numeric_4(0.00004, "x").unwrap(), 0);
        assert_eq!(numeric_4(3.1234, "x").unwrap(), 31234);
        assert_eq!(numeric_4(10.0, "x").unwrap(), 100_000);
        assert_eq!(numeric_4(99_999_999.999_9, "x").unwrap(), 999_999_999_999);
        assert!(numeric_4(100_000_000.0, "x").is_err());
        assert!(numeric_4(99_999_999.999_96, "x").is_err());
        assert!(numeric_4(f64::NAN, "x").is_err());
        assert!(numeric_4(f64::INFINITY, "x").is_err());
    }

    #[test]
    fn uuids_take_both_spellings() {
        let a = uuid_bytes("00000000-0000-4000-8000-00000000000A").unwrap();
        assert_eq!(
            a,
            uuid_bytes("00000000-0000-4000-8000-00000000000a").unwrap()
        );
        assert_eq!(a, uuid_bytes("0000000000004000800000000000000a").unwrap());
        assert_eq!(uuid_text(&a), "00000000-0000-4000-8000-00000000000a");
        // Any version: the budget meter's ids are version 7, and the text must keep its bits.
        let v7 = uuid_bytes("01A1EFA3-9EE6-701E-ADA3-D202D5776740").unwrap();
        assert_eq!(uuid_text(&v7), "01a1efa3-9ee6-701e-ada3-d202d5776740");
        assert!(uuid_bytes("not-a-uuid").is_err());
        assert!(uuid_bytes("00000000-0000-4000-8000-0000000000").is_err());
    }
}
