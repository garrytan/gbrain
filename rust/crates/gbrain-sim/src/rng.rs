//! A small seeded PRNG (splitmix64). Same seed, same sequence, on every platform.

#[derive(Clone, Debug)]
pub struct SimRng(u64);

impl SimRng {
    pub fn new(seed: u64) -> Self {
        SimRng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (`n == 0` gives 0).
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }

    /// True with probability `per_mille / 1000`.
    pub fn chance(&mut self, per_mille: u32) -> bool {
        (self.next_u64() % 1000) < per_mille as u64
    }

    /// An independent stream derived from this one and a label, so adding a consumer of
    /// randomness in one place does not shift the numbers another place sees.
    pub fn fork(&mut self, label: u64) -> SimRng {
        SimRng::new(self.next_u64() ^ label.wrapping_mul(0xD6E8_FEB8_6659_FD93))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_numbers_and_forks_are_independent() {
        let mut a = SimRng::new(7);
        let mut b = SimRng::new(7);
        assert!((0..100).all(|_| a.next_u64() == b.next_u64()));
        let mut c = SimRng::new(7);
        let mut f1 = c.fork(1);
        let mut d = SimRng::new(7);
        let mut f2 = d.fork(2);
        assert_ne!(f1.next_u64(), f2.next_u64());
        assert_eq!(SimRng::new(1).below(0), 0);
        assert!(!SimRng::new(1).chance(0));
    }
}
