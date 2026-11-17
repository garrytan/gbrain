//! Small shared helpers: a fast deterministic PRNG, latency statistics, machine info, time.

use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

/// xorshift64*: good enough for picking random keys; never used for anything security related.
pub struct Rng(pub u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }
    pub fn unit_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// Latency samples in microseconds.
#[derive(Default, Clone)]
pub struct Lat {
    pub micros: Vec<u32>,
}

impl Lat {
    pub fn push(&mut self, d: std::time::Duration) {
        self.micros.push(d.as_micros().min(u32::MAX as u128) as u32);
    }
    pub fn extend(&mut self, other: Lat) {
        self.micros.extend(other.micros);
    }
    pub fn len(&self) -> usize {
        self.micros.len()
    }
    pub fn is_empty(&self) -> bool {
        self.micros.is_empty()
    }
    /// Nearest-rank percentile in milliseconds.
    pub fn pct_ms(&self, p: f64) -> f64 {
        if self.micros.is_empty() {
            return 0.0;
        }
        let mut v = self.micros.clone();
        v.sort_unstable();
        let rank = ((p / 100.0) * v.len() as f64).ceil() as usize;
        v[rank.clamp(1, v.len()) - 1] as f64 / 1000.0
    }
    /// The standard metric object: n, p50_ms, p99_ms, ops_per_s (over `wall_secs`).
    pub fn metric(&self, wall_secs: f64) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert("n".into(), json!(self.len()));
        m.insert("p50_ms".into(), json!(round3(self.pct_ms(50.0))));
        m.insert("p99_ms".into(), json!(round3(self.pct_ms(99.0))));
        m.insert(
            "ops_per_s".into(),
            json!(round1(self.len() as f64 / wall_secs.max(1e-9))),
        );
        m
    }
}

pub fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}
pub fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

pub fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn machine_info() -> Value {
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
    let cpu = cpuinfo
        .lines()
        .find(|l| l.starts_with("model name"))
        .and_then(|l| l.split(':').nth(1))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let mem_kb: f64 = meminfo
        .lines()
        .find(|l| l.starts_with("MemTotal"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|n| n.parse().ok())
        .unwrap_or(0.0);
    let os = std::fs::read_to_string("/etc/os-release")
        .ok()
        .and_then(|s| {
            s.lines().find(|l| l.starts_with("PRETTY_NAME=")).map(|l| {
                l.trim_start_matches("PRETTY_NAME=")
                    .trim_matches('"')
                    .to_string()
            })
        })
        .unwrap_or_else(|| std::env::consts::OS.to_string());
    json!({
        "os": os,
        "cpu": cpu,
        "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        "mem_gb": (mem_kb / 1024.0 / 1024.0).round(),
    })
}

/// Peak resident set size so far (VmHWM) and current (VmRSS), in bytes.
pub fn rss_bytes() -> (u64, u64) {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let get = |key: &str| -> u64 {
        status
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    (get("VmHWM:"), get("VmRSS:"))
}

/// getrusage max RSS (the number the spec asks for), in bytes.
pub fn ru_maxrss_bytes() -> u64 {
    // SAFETY: getrusage fills a zeroed struct we own.
    unsafe {
        let mut ru: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut ru) == 0 {
            ru.ru_maxrss as u64 * 1024 // Linux reports kilobytes
        } else {
            0
        }
    }
}

/// Bytes allocated on disk under `dir` (st_blocks * 512, so sparse files count what they use).
pub fn dir_bytes(dir: &std::path::Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let mut total = 0;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    for e in rd.flatten() {
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            total += dir_bytes(&e.path());
        } else {
            total += md.blocks() * 512;
        }
    }
    total
}

pub fn git_sha() -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--short=10", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_use_nearest_rank() {
        let mut l = Lat::default();
        for us in 1..=100u32 {
            l.micros.push(us * 1000);
        }
        assert_eq!(l.pct_ms(50.0), 50.0);
        assert_eq!(l.pct_ms(99.0), 99.0);
        assert_eq!(l.pct_ms(100.0), 100.0);
    }

    #[test]
    fn iso_time_has_the_right_shape() {
        let t = now_iso();
        assert_eq!(t.len(), 20);
        assert!(t.starts_with("20") && t.ends_with('Z'));
    }
}
