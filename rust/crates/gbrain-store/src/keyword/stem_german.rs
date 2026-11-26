//! A port of PostgreSQL's `german_stem` text search dictionary (`ts_lexize('german_stem', word)`) as
//! the parity reference (PGLite) builds it: `dict_snowball.c` around the generated Snowball 3.0.0
//! `stem_UTF_8_german.c` (runtime in `utilities.c`) and the `german.stop` stopword list.
//! Derived from PostgreSQL (master, Snowball 3.0.0); licence and notice: third-party/postgresql/NOTICE.md
//! Also derived from Snowball 3.0.0; licence and notice: third-party/snowball/NOTICE.md
//!
//! The `dsnowball_lexize` steps are those of [`super::stem::english_stem`]: lowercase with
//! `str_tolower`, skip the stemmer for a word over 1000 bytes, drop an empty word or a stopword, run
//! the stemmer on the UTF-8 bytes, and return the lowercased word when the stemmer leaves nothing.
//!
//! Postgres 16 builds an older Snowball German, which keeps the feminine `-in` / `-innen` endings
//! (`lehrerin`) where Snowball 3.0 strips them (`lehr`). The parity reference is PGLite, so this port
//! follows Snowball 3.0; parity fixtures avoid the words where the two SQL engines differ.
//!
//! The stemmer is a line-by-line port of the generated C, with its byte-level UTF-8 handling and
//! the Snowball 3.0 `among` tables (relative `substring_i`).

use super::stem::pg_lower;

/// `german.stop` from PostgreSQL (`src/backend/snowball/stopwords/german.stop`), in file order.
const GERMAN_STOPWORDS: [&str; 231] = [
    "aber",
    "alle",
    "allem",
    "allen",
    "aller",
    "alles",
    "als",
    "also",
    "am",
    "an",
    "ander",
    "andere",
    "anderem",
    "anderen",
    "anderer",
    "anderes",
    "anderm",
    "andern",
    "anderr",
    "anders",
    "auch",
    "auf",
    "aus",
    "bei",
    "bin",
    "bis",
    "bist",
    "da",
    "damit",
    "dann",
    "der",
    "den",
    "des",
    "dem",
    "die",
    "das",
    "daß",
    "derselbe",
    "derselben",
    "denselben",
    "desselben",
    "demselben",
    "dieselbe",
    "dieselben",
    "dasselbe",
    "dazu",
    "dein",
    "deine",
    "deinem",
    "deinen",
    "deiner",
    "deines",
    "denn",
    "derer",
    "dessen",
    "dich",
    "dir",
    "du",
    "dies",
    "diese",
    "diesem",
    "diesen",
    "dieser",
    "dieses",
    "doch",
    "dort",
    "durch",
    "ein",
    "eine",
    "einem",
    "einen",
    "einer",
    "eines",
    "einig",
    "einige",
    "einigem",
    "einigen",
    "einiger",
    "einiges",
    "einmal",
    "er",
    "ihn",
    "ihm",
    "es",
    "etwas",
    "euer",
    "eure",
    "eurem",
    "euren",
    "eurer",
    "eures",
    "für",
    "gegen",
    "gewesen",
    "hab",
    "habe",
    "haben",
    "hat",
    "hatte",
    "hatten",
    "hier",
    "hin",
    "hinter",
    "ich",
    "mich",
    "mir",
    "ihr",
    "ihre",
    "ihrem",
    "ihren",
    "ihrer",
    "ihres",
    "euch",
    "im",
    "in",
    "indem",
    "ins",
    "ist",
    "jede",
    "jedem",
    "jeden",
    "jeder",
    "jedes",
    "jene",
    "jenem",
    "jenen",
    "jener",
    "jenes",
    "jetzt",
    "kann",
    "kein",
    "keine",
    "keinem",
    "keinen",
    "keiner",
    "keines",
    "können",
    "könnte",
    "machen",
    "man",
    "manche",
    "manchem",
    "manchen",
    "mancher",
    "manches",
    "mein",
    "meine",
    "meinem",
    "meinen",
    "meiner",
    "meines",
    "mit",
    "muss",
    "musste",
    "nach",
    "nicht",
    "nichts",
    "noch",
    "nun",
    "nur",
    "ob",
    "oder",
    "ohne",
    "sehr",
    "sein",
    "seine",
    "seinem",
    "seinen",
    "seiner",
    "seines",
    "selbst",
    "sich",
    "sie",
    "ihnen",
    "sind",
    "so",
    "solche",
    "solchem",
    "solchen",
    "solcher",
    "solches",
    "soll",
    "sollte",
    "sondern",
    "sonst",
    "über",
    "um",
    "und",
    "uns",
    "unse",
    "unsem",
    "unsen",
    "unser",
    "unses",
    "unter",
    "viel",
    "vom",
    "von",
    "vor",
    "während",
    "war",
    "waren",
    "warst",
    "was",
    "weg",
    "weil",
    "weiter",
    "welche",
    "welchem",
    "welchen",
    "welcher",
    "welches",
    "wenn",
    "werde",
    "werden",
    "wie",
    "wieder",
    "will",
    "wir",
    "wird",
    "wirst",
    "wo",
    "wollen",
    "wollte",
    "würde",
    "würden",
    "zu",
    "zum",
    "zur",
    "zwar",
    "zwischen",
];

/// Strings longer than this many bytes skip the stemmer and the stopword check.
const MAX_STEM_INPUT_BYTES: usize = 1000;

/// What `ts_lexize('german_stem', word)` returns: `None` for a stopword (or the empty string), else
/// the lexeme.
pub(crate) fn german_stem(word: &str) -> Option<String> {
    let lowered = pg_lower(word);
    if word.len() > MAX_STEM_INPUT_BYTES {
        return Some(lowered);
    }
    if lowered.is_empty() || is_german_stopword(&lowered) {
        return None;
    }
    let mut env = Env::new(lowered.as_bytes());
    env.stem();
    if env.p.is_empty() {
        return Some(lowered);
    }
    // The stemmer swaps whole characters and cuts at character boundaries, so UTF-8 stays valid.
    Some(String::from_utf8_lossy(&env.p).into_owned())
}

/// Whether `lowercased` is in PostgreSQL's German stopword list.
pub(crate) fn is_german_stopword(lowercased: &str) -> bool {
    GERMAN_STOPWORDS.contains(&lowercased)
}

/// One entry of a Snowball 3.0 `among` table: `substring_i` is relative to the entry (0: none).
struct Among {
    s: &'static [u8],
    substring_i: i32,
    result: i32,
}

const fn am(s: &'static [u8], substring_i: i32, result: i32) -> Among {
    Among {
        s,
        substring_i,
        result,
    }
}

const A_0: [Among; 6] = [
    am(b"", 0, 5),
    am(b"ae", -1, 2),
    am(b"oe", -2, 3),
    am(b"qu", -3, -1),
    am(b"ue", -4, 4),
    am("\u{df}".as_bytes(), -5, 1),
];

const A_1: [Among; 6] = [
    am(b"", 0, 5),
    am(b"U", -1, 2),
    am(b"Y", -2, 1),
    am("\u{e4}".as_bytes(), -3, 3),
    am("\u{f6}".as_bytes(), -4, 4),
    am("\u{fc}".as_bytes(), -5, 2),
];

const A_2: [Among; 11] = [
    am(b"e", 0, 3),
    am(b"em", 0, 1),
    am(b"en", 0, 3),
    am(b"erinnen", -1, 2),
    am(b"erin", 0, 2),
    am(b"ln", 0, 5),
    am(b"ern", 0, 2),
    am(b"er", 0, 2),
    am(b"s", 0, 4),
    am(b"es", -1, 3),
    am(b"lns", -2, 5),
];

const A_3: [Among; 5] = [
    am(b"tick", 0, -1),
    am(b"plan", 0, -1),
    am(b"geordn", 0, -1),
    am(b"intern", 0, -1),
    am(b"tr", 0, -1),
];

const A_4: [Among; 5] = [
    am(b"en", 0, 1),
    am(b"er", 0, 1),
    am(b"et", 0, 3),
    am(b"st", 0, 2),
    am(b"est", -1, 1),
];

const A_5: [Among; 2] = [am(b"ig", 0, 1), am(b"lich", 0, 1)];

const A_6: [Among; 8] = [
    am(b"end", 0, 1),
    am(b"ig", 0, 2),
    am(b"ung", 0, 1),
    am(b"lich", 0, 3),
    am(b"isch", 0, 2),
    am(b"ik", 0, 2),
    am(b"heit", 0, 3),
    am(b"keit", 0, 4),
];

const G_V: &[u8] = &[
    17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32, 8,
];
const G_ET_ENDING: &[u8] = &[
    1, 128, 198, 227, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128,
];
const G_S_ENDING: &[u8] = &[117, 30, 5];
const G_ST_ENDING: &[u8] = &[117, 30, 4];

/// `skip_utf8`: `n` characters forwards from `c`; `None` on failure.
fn skip_utf8(p: &[u8], mut c: i32, limit: i32, n: i32) -> Option<i32> {
    if n < 0 {
        return None;
    }
    for _ in 0..n {
        if c >= limit {
            return None;
        }
        let b = p[c as usize];
        c += 1;
        if b >= 0xC0 {
            while c < limit {
                // A continuation byte is `0x80..0xC0`; any other byte starts the next character.
                if !(0x80..0xC0).contains(&p[c as usize]) {
                    break;
                }
                c += 1;
            }
        }
    }
    Some(c)
}

/// `skip_b_utf8`: `n` characters backwards from `c`; `None` on failure.
fn skip_b_utf8(p: &[u8], mut c: i32, limit: i32, n: i32) -> Option<i32> {
    if n < 0 {
        return None;
    }
    for _ in 0..n {
        if c <= limit {
            return None;
        }
        c -= 1;
        let b = p[c as usize];
        if b >= 0x80 {
            while c > limit {
                let b = p[c as usize];
                if b >= 0xC0 {
                    break;
                }
                c -= 1;
            }
        }
    }
    Some(c)
}

/// `get_utf8`: the character at `c` and its width (0 at the end).
fn get_utf8(p: &[u8], mut c: i32, l: i32) -> (i32, i32) {
    if c >= l {
        return (0, 0);
    }
    let b0 = p[c as usize] as i32;
    c += 1;
    if b0 < 0xC0 || c == l {
        return (1, b0);
    }
    let b1 = p[c as usize] as i32 & 0x3F;
    c += 1;
    if b0 < 0xE0 || c == l {
        return (2, (b0 & 0x1F) << 6 | b1);
    }
    let b2 = p[c as usize] as i32 & 0x3F;
    c += 1;
    if b0 < 0xF0 || c == l {
        return (3, (b0 & 0xF) << 12 | b1 << 6 | b2);
    }
    (
        4,
        (b0 & 0x7) << 18 | b1 << 12 | b2 << 6 | (p[c as usize] as i32 & 0x3F),
    )
}

/// `get_b_utf8`: the character before `c` and its width (0 at `lb`).
fn get_b_utf8(p: &[u8], mut c: i32, lb: i32) -> (i32, i32) {
    if c <= lb {
        return (0, 0);
    }
    c -= 1;
    let mut b = p[c as usize] as i32;
    if b < 0x80 || c == lb {
        return (1, b);
    }
    let mut a = b & 0x3F;
    c -= 1;
    b = p[c as usize] as i32;
    if b >= 0xC0 || c == lb {
        return (2, (b & 0x1F) << 6 | a);
    }
    a |= (b & 0x3F) << 6;
    c -= 1;
    b = p[c as usize] as i32;
    if b >= 0xE0 || c == lb {
        return (3, (b & 0xF) << 12 | a);
    }
    c -= 1;
    (4, (p[c as usize] as i32 & 0x7) << 18 | (b & 0x3F) << 12 | a)
}

/// Whether `ch` is in the grouping `s` over `min..=max` (the test the `*_grouping_U` functions share).
fn in_group(s: &[u8], ch: i32, min: i32, max: i32) -> bool {
    if !(min..=max).contains(&ch) {
        return false;
    }
    let ch = ch - min;
    (s[(ch >> 3) as usize] & (1 << (ch & 7))) != 0
}

/// Snowball's `SN_env` with the German locals `p1` and `p2`.
struct Env {
    p: Vec<u8>,
    c: i32,
    l: i32,
    lb: i32,
    bra: i32,
    ket: i32,
    p1: i32,
    p2: i32,
}

impl Env {
    fn new(word: &[u8]) -> Env {
        Env {
            p: word.to_vec(),
            c: 0,
            l: word.len() as i32,
            lb: 0,
            bra: 0,
            ket: word.len() as i32,
            p1: 0,
            p2: 0,
        }
    }

    fn byte(&self, at: i32) -> u8 {
        self.p[at as usize]
    }

    /// `in_grouping_U`: 0 when it moved (or matched), the width of a non-member, -1 at the end.
    fn in_grouping_u(&mut self, s: &[u8], min: i32, max: i32, repeat: bool) -> i32 {
        loop {
            let (w, ch) = get_utf8(&self.p, self.c, self.l);
            if w == 0 {
                return -1;
            }
            if !in_group(s, ch, min, max) {
                return w;
            }
            self.c += w;
            if !repeat {
                return 0;
            }
        }
    }

    fn in_grouping_b_u(&mut self, s: &[u8], min: i32, max: i32, repeat: bool) -> i32 {
        loop {
            let (w, ch) = get_b_utf8(&self.p, self.c, self.lb);
            if w == 0 {
                return -1;
            }
            if !in_group(s, ch, min, max) {
                return w;
            }
            self.c -= w;
            if !repeat {
                return 0;
            }
        }
    }

    fn out_grouping_u(&mut self, s: &[u8], min: i32, max: i32, repeat: bool) -> i32 {
        loop {
            let (w, ch) = get_utf8(&self.p, self.c, self.l);
            if w == 0 {
                return -1;
            }
            if in_group(s, ch, min, max) {
                return w;
            }
            self.c += w;
            if !repeat {
                return 0;
            }
        }
    }

    fn eq_s_b(&mut self, s: &[u8]) -> bool {
        let n = s.len() as i32;
        if self.c - self.lb < n || &self.p[(self.c - n) as usize..self.c as usize] != s {
            return false;
        }
        self.c -= n;
        true
    }

    fn replace_s(&mut self, c_bra: i32, c_ket: i32, s: &[u8]) {
        let adjustment = s.len() as i32 - (c_ket - c_bra);
        self.p
            .splice(c_bra as usize..c_ket as usize, s.iter().copied());
        if adjustment != 0 {
            self.l += adjustment;
            if self.c >= c_ket {
                self.c += adjustment;
            } else if self.c > c_bra {
                self.c = c_bra;
            }
        }
    }

    fn slice_from_s(&mut self, s: &[u8]) {
        debug_assert!(self.bra >= 0 && self.bra <= self.ket && self.ket <= self.l);
        self.replace_s(self.bra, self.ket, s);
        self.ket = self.bra + s.len() as i32;
    }

    fn slice_del(&mut self) {
        self.slice_from_s(b"");
    }

    /// `find_among` (Snowball 3.0): forwards from `c`.
    fn find_among(&mut self, v: &[Among]) -> i32 {
        let (mut i, mut j) = (0i32, v.len() as i32);
        let (c, l) = (self.c, self.l);
        let (mut common_i, mut common_j) = (0i32, 0i32);
        let mut first_key_inspected = false;
        loop {
            let k = i + ((j - i) >> 1);
            let mut diff = 0i32;
            let mut common = common_i.min(common_j);
            let w = &v[k as usize];
            let mut i2 = common;
            while i2 < w.s.len() as i32 {
                if c + common == l {
                    diff = -1;
                    break;
                }
                diff = self.p[(c + common) as usize] as i32 - w.s[i2 as usize] as i32;
                if diff != 0 {
                    break;
                }
                common += 1;
                i2 += 1;
            }
            if diff < 0 {
                j = k;
                common_j = common;
            } else {
                i = k;
                common_i = common;
            }
            if j - i <= 1 {
                if i > 0 || j == i || first_key_inspected {
                    break;
                }
                first_key_inspected = true;
            }
        }
        let mut w = i;
        loop {
            let e = &v[w as usize];
            if common_i >= e.s.len() as i32 {
                self.c = c + e.s.len() as i32;
                return e.result;
            }
            if e.substring_i == 0 {
                return 0;
            }
            w += e.substring_i;
        }
    }

    /// `find_among_b` (Snowball 3.0): backwards from `c`.
    fn find_among_b(&mut self, v: &[Among]) -> i32 {
        let (mut i, mut j) = (0i32, v.len() as i32);
        let (c, lb) = (self.c, self.lb);
        let (mut common_i, mut common_j) = (0i32, 0i32);
        let mut first_key_inspected = false;
        loop {
            let k = i + ((j - i) >> 1);
            let mut diff = 0i32;
            let mut common = common_i.min(common_j);
            let w = &v[k as usize];
            let mut i2 = w.s.len() as i32 - 1 - common;
            while i2 >= 0 {
                if c - common == lb {
                    diff = -1;
                    break;
                }
                diff = self.p[(c - 1 - common) as usize] as i32 - w.s[i2 as usize] as i32;
                if diff != 0 {
                    break;
                }
                common += 1;
                i2 -= 1;
            }
            if diff < 0 {
                j = k;
                common_j = common;
            } else {
                i = k;
                common_i = common;
            }
            if j - i <= 1 {
                if i > 0 || j == i || first_key_inspected {
                    break;
                }
                first_key_inspected = true;
            }
        }
        let mut w = i;
        loop {
            let e = &v[w as usize];
            if common_i >= e.s.len() as i32 {
                self.c = c - e.s.len() as i32;
                return e.result;
            }
            if e.substring_i == 0 {
                return 0;
            }
            w += e.substring_i;
        }
    }

    /// The byte test the generated C runs before a backward `among`: the last byte's top three
    /// bits are 3 (`0x60..=0x7f`) and its low five bits are set in `mask`; `min_len` is 1 for the
    /// `z->c <= z->lb` form and 2 for `z->c - 1 <= z->lb`.
    fn last_byte_in(&self, min_len: i32, mask: u32) -> bool {
        if self.c - (min_len - 1) <= self.lb {
            return false;
        }
        let b = self.byte(self.c - 1);
        b >> 5 == 3 && (mask >> (b & 0x1f)) & 1 == 1
    }

    fn r_prelude(&mut self) {
        let v_1 = self.c;
        // Mark `u` and `y` between vowels as `U` and `Y`.
        loop {
            let v_2 = self.c;
            let found = loop {
                let v_3 = self.c;
                let matched = 'lab1: {
                    if self.in_grouping_u(G_V, 97, 252, false) != 0 {
                        break 'lab1 false;
                    }
                    self.bra = self.c;
                    let v_4 = self.c;
                    let first = 'lab2: {
                        if self.c == self.l || self.byte(self.c) != b'u' {
                            break 'lab2 false;
                        }
                        self.c += 1;
                        self.ket = self.c;
                        if self.in_grouping_u(G_V, 97, 252, false) != 0 {
                            break 'lab2 false;
                        }
                        self.slice_from_s(b"U");
                        true
                    };
                    if !first {
                        self.c = v_4;
                        if self.c == self.l || self.byte(self.c) != b'y' {
                            break 'lab1 false;
                        }
                        self.c += 1;
                        self.ket = self.c;
                        if self.in_grouping_u(G_V, 97, 252, false) != 0 {
                            break 'lab1 false;
                        }
                        self.slice_from_s(b"Y");
                    }
                    true
                };
                if matched {
                    self.c = v_3;
                    break true;
                }
                self.c = v_3;
                match skip_utf8(&self.p, self.c, self.l, 1) {
                    Some(c) => self.c = c,
                    None => break false,
                }
            };
            if !found {
                self.c = v_2;
                break;
            }
        }
        self.c = v_1;
        // `ß` to `ss`, `ae`/`oe`/`ue` to the umlaut, `qu` kept.
        loop {
            let v_5 = self.c;
            self.bra = self.c;
            let among_var = self.find_among(&A_0);
            self.ket = self.c;
            match among_var {
                1 => self.slice_from_s(b"ss"),
                2 => self.slice_from_s("\u{e4}".as_bytes()),
                3 => self.slice_from_s("\u{f6}".as_bytes()),
                4 => self.slice_from_s("\u{fc}".as_bytes()),
                5 => match skip_utf8(&self.p, self.c, self.l, 1) {
                    Some(c) => self.c = c,
                    None => {
                        self.c = v_5;
                        break;
                    }
                },
                _ => {}
            }
        }
    }

    fn r_mark_regions(&mut self) -> bool {
        self.p1 = self.l;
        self.p2 = self.l;
        let v_1 = self.c;
        let Some(x) = skip_utf8(&self.p, self.c, self.l, 3) else {
            return false;
        };
        self.c = v_1;
        let r = self.out_grouping_u(G_V, 97, 252, true);
        if r < 0 {
            return false;
        }
        self.c += r;
        let r = self.in_grouping_u(G_V, 97, 252, true);
        if r < 0 {
            return false;
        }
        self.c += r;
        self.p1 = self.c;
        if self.p1 < x {
            self.p1 = x;
        }
        let r = self.out_grouping_u(G_V, 97, 252, true);
        if r < 0 {
            return false;
        }
        self.c += r;
        let r = self.in_grouping_u(G_V, 97, 252, true);
        if r < 0 {
            return false;
        }
        self.c += r;
        self.p2 = self.c;
        true
    }

    fn r_postlude(&mut self) {
        loop {
            let v_1 = self.c;
            self.bra = self.c;
            let among_var = self.find_among(&A_1);
            self.ket = self.c;
            match among_var {
                1 => self.slice_from_s(b"y"),
                2 => self.slice_from_s(b"u"),
                3 => self.slice_from_s(b"a"),
                4 => self.slice_from_s(b"o"),
                5 => match skip_utf8(&self.p, self.c, self.l, 1) {
                    Some(c) => self.c = c,
                    None => {
                        self.c = v_1;
                        break;
                    }
                },
                _ => {}
            }
        }
    }

    fn r_r1(&self) -> bool {
        self.p1 <= self.c
    }

    fn r_r2(&self) -> bool {
        self.p2 <= self.c
    }

    fn r_standard_suffix(&mut self) {
        // Step 1.
        let v_1 = self.l - self.c;
        'lab0: {
            self.ket = self.c;
            if !self.last_byte_in(1, 811040) {
                break 'lab0;
            }
            let among_var = self.find_among_b(&A_2);
            if among_var == 0 {
                break 'lab0;
            }
            self.bra = self.c;
            if !self.r_r1() {
                break 'lab0;
            }
            match among_var {
                1 => {
                    let v_2 = self.l - self.c;
                    if self.eq_s_b(b"syst") {
                        break 'lab0;
                    }
                    self.c = self.l - v_2;
                    self.slice_del();
                }
                2 => self.slice_del(),
                3 => {
                    self.slice_del();
                    let v_3 = self.l - self.c;
                    self.ket = self.c;
                    if self.c <= self.lb || self.byte(self.c - 1) != b's' {
                        self.c = self.l - v_3;
                    } else {
                        self.c -= 1;
                        self.bra = self.c;
                        if self.eq_s_b(b"nis") {
                            self.slice_del();
                        } else {
                            self.c = self.l - v_3;
                        }
                    }
                }
                4 => {
                    if self.in_grouping_b_u(G_S_ENDING, 98, 116, false) != 0 {
                        break 'lab0;
                    }
                    self.slice_del();
                }
                5 => self.slice_from_s(b"l"),
                _ => {}
            }
        }
        self.c = self.l - v_1;
        // Step 2.
        let v_4 = self.l - self.c;
        'lab3: {
            self.ket = self.c;
            if !self.last_byte_in(2, 1327104) {
                break 'lab3;
            }
            let among_var = self.find_among_b(&A_4);
            if among_var == 0 {
                break 'lab3;
            }
            self.bra = self.c;
            if !self.r_r1() {
                break 'lab3;
            }
            match among_var {
                1 => self.slice_del(),
                2 => {
                    if self.in_grouping_b_u(G_ST_ENDING, 98, 116, false) != 0 {
                        break 'lab3;
                    }
                    match skip_b_utf8(&self.p, self.c, self.lb, 3) {
                        Some(c) => self.c = c,
                        None => break 'lab3,
                    }
                    self.slice_del();
                }
                3 => {
                    let v_5 = self.l - self.c;
                    if self.in_grouping_b_u(G_ET_ENDING, 85, 228, false) != 0 {
                        break 'lab3;
                    }
                    self.c = self.l - v_5;
                    let v_6 = self.l - self.c;
                    if self.last_byte_in(2, 280576) && self.find_among_b(&A_3) != 0 {
                        break 'lab3;
                    }
                    self.c = self.l - v_6;
                    self.slice_del();
                }
                _ => {}
            }
        }
        self.c = self.l - v_4;
        // Step 3: derivational suffixes.
        let v_7 = self.l - self.c;
        'lab5: {
            self.ket = self.c;
            if !self.last_byte_in(2, 1051024) {
                break 'lab5;
            }
            let among_var = self.find_among_b(&A_6);
            if among_var == 0 {
                break 'lab5;
            }
            self.bra = self.c;
            if !self.r_r2() {
                break 'lab5;
            }
            match among_var {
                1 => {
                    self.slice_del();
                    let v_8 = self.l - self.c;
                    'lab6: {
                        self.ket = self.c;
                        if !self.eq_s_b(b"ig") {
                            self.c = self.l - v_8;
                            break 'lab6;
                        }
                        self.bra = self.c;
                        let v_9 = self.l - self.c;
                        if self.c > self.lb && self.byte(self.c - 1) == b'e' {
                            self.c -= 1;
                            self.c = self.l - v_8;
                            break 'lab6;
                        }
                        self.c = self.l - v_9;
                        if !self.r_r2() {
                            self.c = self.l - v_8;
                            break 'lab6;
                        }
                        self.slice_del();
                    }
                }
                2 => {
                    let v_10 = self.l - self.c;
                    if self.c > self.lb && self.byte(self.c - 1) == b'e' {
                        break 'lab5;
                    }
                    self.c = self.l - v_10;
                    self.slice_del();
                }
                3 => {
                    self.slice_del();
                    let v_11 = self.l - self.c;
                    'lab9: {
                        self.ket = self.c;
                        let v_12 = self.l - self.c;
                        if !self.eq_s_b(b"er") {
                            self.c = self.l - v_12;
                            if !self.eq_s_b(b"en") {
                                self.c = self.l - v_11;
                                break 'lab9;
                            }
                        }
                        self.bra = self.c;
                        if !self.r_r1() {
                            self.c = self.l - v_11;
                            break 'lab9;
                        }
                        self.slice_del();
                    }
                }
                4 => {
                    self.slice_del();
                    let v_13 = self.l - self.c;
                    'lab11: {
                        self.ket = self.c;
                        if self.c - 1 <= self.lb
                            || (self.byte(self.c - 1) != b'g' && self.byte(self.c - 1) != b'h')
                        {
                            self.c = self.l - v_13;
                            break 'lab11;
                        }
                        if self.find_among_b(&A_5) == 0 {
                            self.c = self.l - v_13;
                            break 'lab11;
                        }
                        self.bra = self.c;
                        if !self.r_r2() {
                            self.c = self.l - v_13;
                            break 'lab11;
                        }
                        self.slice_del();
                    }
                }
                _ => {}
            }
        }
        self.c = self.l - v_7;
    }

    /// `german_UTF_8_stem`.
    fn stem(&mut self) {
        let v_1 = self.c;
        self.r_prelude();
        self.c = v_1;
        let v_2 = self.c;
        self.r_mark_regions();
        self.c = v_2;
        self.lb = self.c;
        self.c = self.l;
        self.r_standard_suffix();
        self.c = self.lb;
        let v_3 = self.c;
        self.r_postlude();
        self.c = v_3;
    }
}

#[cfg(test)]
mod tests;
