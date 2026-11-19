//! A run's trace: every event the simulation chooses to record is folded into a 64-bit FNV-1a
//! hash. Two runs of the same seed must end with the same hash; a difference is a determinism bug.

#[derive(Clone, Debug)]
pub struct Trace {
    hash: u64,
    events: u64,
    lines: Option<Vec<String>>,
}

impl Default for Trace {
    fn default() -> Self {
        Self::new()
    }
}

impl Trace {
    pub fn new() -> Self {
        Trace {
            hash: 0xcbf2_9ce4_8422_2325,
            events: 0,
            lines: None,
        }
    }

    /// Also keep the event text (for printing a failing run).
    pub fn keeping_lines() -> Self {
        Trace {
            lines: Some(Vec::new()),
            ..Self::new()
        }
    }

    pub fn event(&mut self, text: &str) {
        self.bytes(text.as_bytes());
        self.bytes(&[0xff]);
        self.events += 1;
        if let Some(l) = &mut self.lines {
            l.push(text.to_string());
        }
    }

    pub fn bytes(&mut self, data: &[u8]) {
        for b in data {
            self.hash ^= *b as u64;
            self.hash = self.hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }

    pub fn hash(&self) -> u64 {
        self.hash
    }
    pub fn events(&self) -> u64 {
        self.events
    }
    pub fn lines(&self) -> &[String] {
        self.lines.as_deref().unwrap_or(&[])
    }
}

/// FNV-1a over a byte slice, for hashing observed data.
pub fn fnv1a(data: &[u8]) -> u64 {
    let mut t = Trace::new();
    t.bytes(data);
    t.hash()
}
