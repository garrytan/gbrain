//! Port of the PostgreSQL default text-search parser (`src/backend/tsearch/wparser_def.c`, PG 18),
//! so the Rust engine tokenizes exactly as `select tokid, token from ts_parse('default', $1)` does
//! in PGLite.
//! Derived from PostgreSQL 18.6; licence and notice: third-party/postgresql/NOTICE.md
//!
//! The state machine is a literal transcription: `actions.rs` holds the `actionTPS_*` tables
//! (generated from the C source, one item per C row), and `Parser::get` below is `TParserGet`.
//! The parse position stack, `A_PUSH`/`A_POP`/`A_CLEAR`/`A_CLRALL`/`A_MERGE`/`A_RERUN` and the
//! look-ahead sub-parsers (`p_ishost`, `p_isURLPath`) behave as in C.
//!
//! Character classes. PGLite's database is UTF-8 with datctype `C.UTF-8` (not plain `C`), so PG
//! takes the wide-character path (`char2wchar` + `isw*`) and non-ASCII letters are classified by
//! the platform's `iswalpha`, not "everything above 0x7f is a letter" (the plain-`C` rule). The
//! classes below were measured against PGLite for every Unicode scalar value (see
//! `charclass.rs`): `café`, `Привет` and `日本語` are one `word`; emoji, NBSP and U+2003 are not
//! letters (they come out as `blank`); the digit and hex-digit classes are ASCII only; `isspace` is
//! ASCII whitespace plus U+0085, U+2000-2006, U+2008-200A, U+2028-2029, U+205F and U+3000.
//! `p_isspecial` (zero display width or a spacing mark: combining accents and the like) keeps a
//! word going without being a letter, and is the table in `charclass::SPECIAL`.
//!
//! Token types are numbered as PG numbers them (`TokenType::tokid`).

mod actions;
mod charclass;

use actions::{
    A_BINGO, A_CLEAR, A_CLRALL, A_MERGE, A_POP, A_PUSH, A_RERUN, Class, Item, Special, State,
    actions,
};

/// The 23 token types of the default parser. Discriminants are PG's `tokid`.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokenType {
    Asciiword = 1,
    Word = 2,
    Numword = 3,
    Email = 4,
    Url = 5,
    Host = 6,
    Sfloat = 7,
    Version = 8,
    HwordNumpart = 9,
    HwordPart = 10,
    HwordAsciipart = 11,
    Blank = 12,
    Tag = 13,
    Protocol = 14,
    Numhword = 15,
    Asciihword = 16,
    Hword = 17,
    UrlPath = 18,
    File = 19,
    Float = 20,
    Int = 21,
    Uint = 22,
    Entity = 23,
}

#[allow(dead_code)]
impl TokenType {
    /// PG's `tokid` (the first column of `ts_parse`).
    pub(crate) fn tokid(self) -> u8 {
        self as u8
    }

    /// PG's token alias (`ts_token_type('default')`).
    pub(crate) fn alias(self) -> &'static str {
        match self {
            TokenType::Asciiword => "asciiword",
            TokenType::Word => "word",
            TokenType::Numword => "numword",
            TokenType::Email => "email",
            TokenType::Url => "url",
            TokenType::Host => "host",
            TokenType::Sfloat => "sfloat",
            TokenType::Version => "version",
            TokenType::HwordNumpart => "hword_numpart",
            TokenType::HwordPart => "hword_part",
            TokenType::HwordAsciipart => "hword_asciipart",
            TokenType::Blank => "blank",
            TokenType::Tag => "tag",
            TokenType::Protocol => "protocol",
            TokenType::Numhword => "numhword",
            TokenType::Asciihword => "asciihword",
            TokenType::Hword => "hword",
            TokenType::UrlPath => "url_path",
            TokenType::File => "file",
            TokenType::Float => "float",
            TokenType::Int => "int",
            TokenType::Uint => "uint",
            TokenType::Entity => "entity",
        }
    }
}

/// Look-ahead sub-parsers nest once per `@` in `a@b@c@...` (PG bounds this with
/// `check_stack_depth`, which raises an error). Past this depth the look-ahead just fails.
const MAX_LOOKAHEAD_DEPTH: usize = 256;

#[derive(Clone, Copy)]
struct Position {
    posbyte: usize,
    poschar: usize,
    charlen: usize,
    lenbytetoken: usize,
    lenchartoken: usize,
    state: State,
    /// Index of the `A_PUSH` item this position pushed at, in `actions(state)`.
    pushed_at: Option<usize>,
}

impl Position {
    fn base() -> Position {
        Position {
            posbyte: 0,
            poschar: 0,
            charlen: 0,
            lenbytetoken: 0,
            lenchartoken: 0,
            state: State::Base,
            pushed_at: None,
        }
    }
}

struct Parser<'a> {
    /// `prs->str`: the bytes from this parser's start to the end of the text.
    bytes: &'a [u8],
    /// `prs->pgwstr`: one entry per character, aligned with `bytes`.
    wstr: &'a [char],
    /// `prs->state` and its `prev` chain: the last element is the current position.
    stack: Vec<Position>,
    ignore: bool,
    wanthost: bool,
    /// `prs->c`, the "silly char" of `p_iseqC`.
    c: u8,
    depth: usize,
    // out
    token_start: usize,
    lenbytetoken: usize,
    lenchartoken: usize,
    ty: Option<TokenType>,
}

fn in_ranges(table: &[(u32, u32)], c: u32) -> bool {
    table
        .binary_search_by(|&(lo, hi)| {
            if c < lo {
                std::cmp::Ordering::Greater
            } else if c > hi {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn utf8_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead < 0xE0 {
        2
    } else if lead < 0xF0 {
        3
    } else {
        4
    }
}

fn w_alpha(c: u32) -> bool {
    if c < 0x80 {
        (c as u8).is_ascii_alphabetic()
    } else {
        in_ranges(charclass::ALPHA, c)
    }
}

/// `t_isalnum` for one character (`iswalnum` under the C.UTF-8 ctype): the parser's letter
/// class or an ASCII digit. The websearch `or` check uses it.
pub(crate) fn is_alnum_char(c: char) -> bool {
    w_alpha(c as u32) || w_digit(c as u32)
}

fn w_digit(c: u32) -> bool {
    (0x30..=0x39).contains(&c)
}

fn w_space(c: u32) -> bool {
    if c < 0x80 {
        c == 0x20 || (0x09..=0x0D).contains(&c)
    } else {
        in_ranges(charclass::SPACE, c)
    }
}

impl<'a> Parser<'a> {
    fn new(bytes: &'a [u8], wstr: &'a [char]) -> Parser<'a> {
        Parser {
            bytes,
            wstr,
            stack: vec![Position::base()],
            ignore: false,
            wanthost: false,
            c: 0,
            depth: 0,
            token_start: 0,
            lenbytetoken: 0,
            lenchartoken: 0,
            ty: None,
        }
    }

    /// `TParserCopyInit`: a parser over the same text starting at the current position.
    fn copy_init(&self) -> Parser<'a> {
        let st = self.state();
        let mut p = Parser::new(&self.bytes[st.posbyte..], &self.wstr[st.poschar..]);
        p.depth = self.depth + 1;
        p
    }

    fn state(&self) -> &Position {
        self.stack.last().expect("parser stack is never empty")
    }

    fn state_mut(&mut self) -> &mut Position {
        self.stack.last_mut().expect("parser stack is never empty")
    }

    /// `newTParserPosition(prs->state)`: push a copy of the current position.
    fn push_position(&mut self) {
        let mut p = *self.state();
        p.pushed_at = None;
        self.stack.push(p);
    }

    /// The wide character at the current position; 0 at EOF (the C string is NUL terminated).
    fn cur(&self) -> u32 {
        self.wstr.get(self.state().poschar).map_or(0, |&c| c as u32)
    }

    fn cur_byte(&self) -> u8 {
        self.bytes.get(self.state().posbyte).copied().unwrap_or(0)
    }

    fn test(&mut self, class: Class) -> bool {
        match class {
            Class::Always => true,
            Class::Eof => {
                let st = self.state();
                st.posbyte == self.bytes.len() || st.charlen == 0
            }
            Class::Eq => self.state().charlen == 1 && self.cur_byte() == self.c,
            Class::Asclet => {
                self.state().charlen == 1 && self.cur_byte().is_ascii() && w_alpha(self.cur())
            }
            Class::Alpha => w_alpha(self.cur()),
            Class::Digit => w_digit(self.cur()),
            Class::Alnum => w_alpha(self.cur()) || w_digit(self.cur()),
            Class::NotAlnum => !(w_alpha(self.cur()) || w_digit(self.cur())),
            Class::Special => {
                let c = self.cur();
                c == 0 || in_ranges(charclass::SPECIAL, c)
            }
            Class::Space => w_space(self.cur()),
            Class::Xdigit => {
                let c = self.cur();
                c < 0x80 && (c as u8).is_ascii_hexdigit()
            }
            Class::Ignore => self.ignore,
            Class::StopHost => {
                if self.wanthost {
                    self.wanthost = false;
                    true
                } else {
                    false
                }
            }
            Class::Host => self.lookahead(None, TokenType::Host),
            Class::UrlPath => self.lookahead(Some(State::InURLPathFirst), TokenType::UrlPath),
            Class::UrlChar => {
                if self.state().charlen != 1 {
                    return false;
                }
                let ch = self.cur_byte();
                if ch <= 0x20 || ch >= 0x7F {
                    return false;
                }
                !matches!(
                    ch,
                    b'"' | b'<' | b'>' | b'\\' | b'^' | b'`' | b'{' | b'|' | b'}'
                )
            }
        }
    }

    /// `p_ishost` (`start` None, wants a HOST) and `p_isURLPath` (`start` the first URL path
    /// state, wants a URLPATH): run a sub-parser from here and, when it yields the wanted type,
    /// swallow its token into the current position.
    fn lookahead(&mut self, start: Option<State>, want: TokenType) -> bool {
        if self.depth >= MAX_LOOKAHEAD_DEPTH {
            return false;
        }
        let mut tmp = self.copy_init();
        match start {
            None => tmp.wanthost = true,
            Some(state) => {
                tmp.push_position();
                tmp.state_mut().state = state;
            }
        }
        if tmp.get() && tmp.ty == Some(want) {
            let (lb, lc, charlen) = (tmp.lenbytetoken, tmp.lenchartoken, tmp.state().charlen);
            let st = self.state_mut();
            st.posbyte += lb;
            st.poschar += lc;
            st.lenbytetoken += lb;
            st.lenchartoken += lc;
            st.charlen = charlen;
            true
        } else {
            false
        }
    }

    fn special(&mut self, special: Special) {
        match special {
            Special::None => {}
            Special::Tags => {
                let st = *self.state();
                let tok = &self.bytes[self.token_start..];
                let starts = |s: &str| {
                    tok.len() >= s.len() && tok[..s.len()].eq_ignore_ascii_case(s.as_bytes())
                };
                match st.lenchartoken {
                    8 if starts("</script") => self.ignore = false,
                    7 => {
                        if starts("</style") {
                            self.ignore = false;
                        } else if starts("<script") {
                            self.ignore = true;
                        }
                    }
                    6 if starts("<style") => self.ignore = true,
                    _ => {}
                }
            }
            Special::Furl => {
                self.wanthost = true;
                let st = self.state_mut();
                st.posbyte -= st.lenbytetoken;
                st.poschar -= st.lenchartoken;
            }
            Special::Hyphen => {
                let st = self.state_mut();
                st.posbyte -= st.lenbytetoken;
                st.poschar -= st.lenchartoken;
            }
            Special::VerVersion => {
                let st = self.state_mut();
                st.posbyte -= st.lenbytetoken;
                st.poschar -= st.lenchartoken;
                st.lenbytetoken = 0;
                st.lenchartoken = 0;
            }
        }
    }

    /// `TParserGet`: find the next token. `false` when the text is used up (or, as in C, when the
    /// machine runs out of input without completing a token).
    fn get(&mut self) -> bool {
        let lenstr = self.bytes.len();
        if self.state().posbyte >= lenstr {
            return false;
        }
        self.token_start = self.state().posbyte;
        self.state_mut().pushed_at = None;

        let mut last: Option<Item> = None;
        while self.state().posbyte <= lenstr {
            let posbyte = self.state().posbyte;
            let charlen = if posbyte == lenstr {
                0
            } else {
                utf8_len(self.bytes[posbyte])
            };
            self.state_mut().charlen = charlen;

            let table = actions(self.state().state);
            let mut idx = match self.state_mut().pushed_at.take() {
                // After a POP, pick up at the next test.
                Some(at) => at + 1,
                None => 0,
            };
            while table[idx].class != Class::Always {
                self.c = table[idx].c;
                if self.test(table[idx].class) {
                    break;
                }
                idx += 1;
            }
            let item = table[idx];
            last = Some(item);

            if item.special != Special::None {
                self.special(item.special);
            }

            if item.flags & A_BINGO != 0 {
                let st = self.state_mut();
                let (lb, lc) = (st.lenbytetoken, st.lenchartoken);
                st.lenbytetoken = 0;
                st.lenchartoken = 0;
                self.lenbytetoken = lb;
                self.lenchartoken = lc;
                self.ty = item.ty;
            }

            if item.flags & A_POP != 0 {
                self.stack.pop();
            } else if item.flags & A_PUSH != 0 {
                self.state_mut().pushed_at = Some(idx);
                self.push_position();
            } else if item.flags & A_CLEAR != 0 {
                let n = self.stack.len();
                self.stack.remove(n - 2);
            } else if item.flags & A_CLRALL != 0 {
                let top = *self.state();
                self.stack.clear();
                self.stack.push(top);
            } else if item.flags & A_MERGE != 0 {
                let cur = self.stack.pop().expect("parser stack is never empty");
                let st = self.state_mut();
                st.posbyte = cur.posbyte;
                st.poschar = cur.poschar;
                st.charlen = cur.charlen;
                st.lenbytetoken = cur.lenbytetoken;
                st.lenchartoken = cur.lenchartoken;
            }

            if item.tostate != State::Null {
                self.state_mut().state = item.tostate;
            }

            // check for go away
            if item.flags & A_BINGO != 0
                || (self.state().posbyte >= lenstr && item.flags & A_RERUN == 0)
            {
                break;
            }

            // rerun, or just restored a state: back to the top of the loop
            if item.flags & (A_RERUN | A_POP) != 0 {
                continue;
            }

            // move forward
            let st = self.state_mut();
            if st.charlen != 0 {
                st.posbyte += st.charlen;
                st.lenbytetoken += st.charlen;
                st.poschar += 1;
                st.lenchartoken += 1;
            }
        }

        last.is_some_and(|i| i.flags & A_BINGO != 0)
    }
}

/// The rows of `select tokid, token from ts_parse('default', $1)`, in order, blanks included.
#[allow(dead_code)]
pub(crate) fn parse(text: &str) -> Vec<(TokenType, &str)> {
    let wstr: Vec<char> = text.chars().collect();
    let mut prs = Parser::new(text.as_bytes(), &wstr);
    let mut out = Vec::new();
    while prs.get() {
        let Some(ty) = prs.ty else { break };
        let start = prs.token_start;
        let token = text.get(start..start + prs.lenbytetoken).unwrap_or("");
        out.push((ty, token));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden rows from PGLite (PG 18.6): `select tokid, token from ts_parse('default', $1)` for
    /// hand-written inputs and seeded random strings, written by the probe script.
    #[test]
    fn matches_pglite_ts_parse() {
        let cases: Vec<(String, Vec<(u8, String)>)> =
            serde_json::from_str(include_str!("../../tests/fixtures/ts_parse.json"))
                .expect("ts_parse fixture is valid JSON");
        assert!(cases.len() > 5000);
        let mut failures = Vec::new();
        for (input, want) in &cases {
            let got: Vec<(u8, String)> = parse(input)
                .into_iter()
                .map(|(ty, tok)| (ty.tokid(), tok.to_string()))
                .collect();
            if &got != want {
                failures.push(format!("{input:?}\n  want {want:?}\n  got  {got:?}"));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} cases differ; first: {}",
            failures.len(),
            cases.len(),
            failures
                .iter()
                .take(5)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn token_types_are_numbered_like_pg() {
        assert_eq!(TokenType::Asciiword.tokid(), 1);
        assert_eq!(TokenType::Blank.tokid(), 12);
        assert_eq!(TokenType::Entity.tokid(), 23);
        assert_eq!(TokenType::HwordAsciipart.alias(), "hword_asciipart");
    }

    #[test]
    fn simple_rows() {
        assert_eq!(
            parse("foo-bar x"),
            vec![
                (TokenType::Asciihword, "foo-bar"),
                (TokenType::HwordAsciipart, "foo"),
                (TokenType::Blank, "-"),
                (TokenType::HwordAsciipart, "bar"),
                (TokenType::Blank, " "),
                (TokenType::Asciiword, "x"),
            ]
        );
        assert!(parse("").is_empty());
        assert_eq!(parse("café"), vec![(TokenType::Word, "café")]);
    }
}
