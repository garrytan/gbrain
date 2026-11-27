//! Port of the parts of PostgreSQL full-text search (PG 18) that gbrain's SQL uses, for the
//! `english` configuration: `to_tsvector`, `setweight`, `tsvector || tsvector`, `plainto_tsquery`,
//! `phraseto_tsquery`, `websearch_to_tsquery`, `@@` and the text output of both types. The ranker
//! (`ts_rank`, `ts_rank_cd`) is in `rank.rs` and reads the same types.
//! Derived from PostgreSQL 18.6; licence and notice: third-party/postgresql/NOTICE.md
//!
//! The C sources are `tsearch/to_tsany.c`, `tsearch/ts_parse.c`, `utils/adt/tsvector_op.c`,
//! `utils/adt/tsquery.c`, `utils/adt/tsquery_cleanup.c` and `utils/adt/tsvector_parser.c`. Each
//! function below names the C function it transcribes. Where the C code has a branch that gbrain's
//! SQL cannot reach (query weights, `:*` prefix operands, the standard `to_tsquery` syntax), the
//! port leaves the branch out and says so.
//!
//! The `english` configuration maps the default parser's token types to dictionaries as PGLite
//! does (probed with `ts_debug`): `english_stem` for asciiword, word, hword_part,
//! hword_asciipart, asciihword and hword; `simple` for numword, email, url, host, sfloat, version,
//! hword_numpart, numhword, url_path, file, float, int and uint; no dictionary (the token is
//! skipped and takes no position) for blank, tag, protocol and entity.
//!
//! Positions and weights are stored as PG stores a `WordEntryPos`: a `u16` whose low 14 bits are
//! the position and whose high 2 bits are the weight (3 = A, 2 = B, 1 = C, 0 = D).
// The keyword members (countKeywordPages, searchKeywordPages, searchTitles,
// searchKeywordChunks) and lane 4's findCandidateDuplicates call these next; until they land,
// only the golden tests use them.
#![allow(dead_code)]

use super::parser::{TokenType, parse};
use super::stem::{english_stem, pg_lower};
use super::stem_german::german_stem;
use crate::error::{Result, StoreError};
use std::cmp::Ordering;

/// `MAXSTRLEN`: the longest lexeme a tsvector or tsquery holds, in bytes.
const MAXSTRLEN: usize = (1 << 11) - 1;
/// `MAXSTRPOS`: the largest size of a tsvector's string area, in bytes.
const MAXSTRPOS: usize = (1 << 20) - 1;
/// `MAXNUMPOS`: the most positions one tsvector lexeme holds.
const MAXNUMPOS: usize = 256;
/// `MAXENTRYPOS`: one more than the largest position.
pub(super) const MAXENTRYPOS: u32 = 1 << 14;
/// `STACKDEPTH` of the tsquery parser's operator stack.
const STACKDEPTH: usize = 32;
/// The most items (operands, operators and stopword placeholders) one tsquery holds. PostgreSQL
/// walks a query recursively under `check_stack_depth()` and raises `stack depth limit exceeded`
/// (54001) past `max_stack_depth`; PGLite 0.5.16 answers 20,000 repeats of `quokka the ` (about
/// 80,000 items) and fails at 50,000 repeats. Stopword placeholders carry no lexeme bytes, so the
/// `MAXSTRPOS` check never bounds them.
const MAX_QUERY_ITEMS: usize = 1 << 17;
/// A query of more items than this is walked on a thread with `DEEP_STACK_BYTES` of stack.
const DEEP_QUERY_ITEMS: usize = 1024;
/// Stack of the thread that walks a deep query. The address space is reserved, not committed.
const DEEP_STACK_BYTES: usize = 256 << 20;

thread_local! {
    /// True on a thread `with_query_stack` started: its stack already fits the deepest query.
    static ON_DEEP_STACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Run `f`, which recurses once per item of a query of `items` items, on a thread with a stack
/// deep enough for `MAX_QUERY_ITEMS` frames when the query is large. Small queries, and calls
/// already on such a thread, run in place, so a search that wraps its whole walk starts one
/// thread, not one per page or chunk it matches.
pub(crate) fn with_query_stack<R: Send>(items: usize, f: impl FnOnce() -> R + Send) -> R {
    if items <= DEEP_QUERY_ITEMS || ON_DEEP_STACK.with(std::cell::Cell::get) {
        return f();
    }
    #[cfg(test)]
    let spawns = DEEP_SPAWNS.with(|c| c.borrow().clone());
    #[cfg(test)]
    spawns.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::thread::scope(|scope| {
        let handle = std::thread::Builder::new()
            .stack_size(DEEP_STACK_BYTES)
            .spawn_scoped(scope, move || {
                ON_DEEP_STACK.with(|on| on.set(true));
                // A spawn inside counts toward the caller's tally.
                #[cfg(test)]
                DEEP_SPAWNS.with(|c| *c.borrow_mut() = spawns);
                f()
            })
            .expect("spawn the deep-query thread");
        match handle.join() {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}

#[cfg(test)]
thread_local! {
    /// How many deep-query threads this thread and the deep threads it started have started.
    static DEEP_SPAWNS: std::cell::RefCell<std::sync::Arc<std::sync::atomic::AtomicUsize>> =
        std::cell::RefCell::new(std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)));
}

/// Resets this thread's deep-thread tally (tests).
#[cfg(test)]
pub(crate) fn reset_deep_spawns() {
    DEEP_SPAWNS
        .with(|c| *c.borrow_mut() = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)));
}

/// The deep-query threads started since `reset_deep_spawns`, nested ones included (tests).
#[cfg(test)]
pub(crate) fn deep_spawns() -> usize {
    DEEP_SPAWNS.with(|c| c.borrow().load(std::sync::atomic::Ordering::Relaxed))
}

fn too_deep() -> StoreError {
    StoreError::invalid(format!(
        "stack depth limit exceeded: a tsquery holds at most {MAX_QUERY_ITEMS} items"
    ))
}

/// `LIMITPOS`.
fn limitpos(pos: u32) -> u16 {
    if pos >= MAXENTRYPOS {
        (MAXENTRYPOS - 1) as u16
    } else {
        pos as u16
    }
}

/// `WEP_GETPOS`.
pub(super) fn wep_pos(wep: u16) -> u16 {
    wep & 0x3fff
}

/// `WEP_GETWEIGHT`.
pub(super) fn wep_weight(wep: u16) -> u16 {
    wep >> 14
}

fn wep_make(weight: u16, pos: u16) -> u16 {
    (weight << 14) | (pos & 0x3fff)
}

/// A tsvector weight label.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Weight {
    A = 3,
    B = 2,
    C = 1,
    D = 0,
}

/// One tsvector lexeme. `pos` holds `WordEntryPos` values in stored order; an empty `pos` is a
/// lexeme without positions (PG's `haspos = 0`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TsEntry {
    pub(crate) lexeme: String,
    pub(crate) pos: Vec<u16>,
}

/// A tsvector: lexemes sorted by `tsCompareString` (byte order), each once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TsVector {
    pub(crate) entries: Vec<TsEntry>,
}

/// Whether `error` is the tsvector size refusal (`check_tsvector_size`).
pub(crate) fn is_vector_overflow(error: &StoreError) -> bool {
    error
        .message
        .starts_with("string is too long for tsvector (")
}

/// The tsvector size limit check of `make_tsvector` and `tsvector_concat`: the lexeme bytes plus
/// the aligned position arrays must stay within `MAXSTRPOS`.
fn check_tsvector_size(entries: &[TsEntry]) -> Result<()> {
    let mut lenstr = 0usize;
    for e in entries {
        lenstr += e.lexeme.len();
        if !e.pos.is_empty() {
            lenstr = (lenstr + 1) & !1;
            lenstr += 2 + 2 * e.pos.len();
        }
    }
    if lenstr > MAXSTRPOS {
        return Err(StoreError::invalid(format!(
            "string is too long for tsvector ({lenstr} bytes, max {MAXSTRPOS} bytes)"
        )));
    }
    Ok(())
}

impl TsVector {
    /// Binary search for `lexeme` (`find_wordentry` / `checkcondition_str` without a prefix).
    pub(crate) fn find(&self, lexeme: &str) -> Option<usize> {
        self.entries
            .binary_search_by(|e| e.lexeme.as_bytes().cmp(lexeme.as_bytes()))
            .ok()
    }

    /// `tsvectorout`.
    pub(crate) fn to_text(&self) -> String {
        let mut out = String::new();
        for (i, e) in self.entries.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            quote_lexeme(&mut out, &e.lexeme);
            if !e.pos.is_empty() {
                out.push(':');
                for (k, &p) in e.pos.iter().enumerate() {
                    if k > 0 {
                        out.push(',');
                    }
                    out.push_str(&wep_pos(p).to_string());
                    match wep_weight(p) {
                        3 => out.push('A'),
                        2 => out.push('B'),
                        1 => out.push('C'),
                        _ => {}
                    }
                }
            }
        }
        out
    }
}

/// The quoting `tsvectorout` and the tsquery `infix` share: `'` and `\` are doubled.
fn quote_lexeme(out: &mut String, lexeme: &str) {
    out.push('\'');
    for c in lexeme.chars() {
        if c == '\'' || c == '\\' {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
}

/// One word `parsetext` emits: a lexeme and its position (already `LIMITPOS`ed).
struct ParsedWord {
    word: String,
    pos: u16,
}

/// The dictionary a configuration maps a token type to.
enum Dict {
    EnglishStem,
    GermanStem,
    Simple,
}

/// A text search configuration the store implements. `english` and `german` map the same token
/// types to their Snowball dictionary (PostgreSQL's `snowball_create.sql` gives every Latin-script
/// Snowball configuration the mapping of `english`); `simple` lowercases every one of those types.
/// Any other configuration name has no port and is refused by [`FtsConfig::parse`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum FtsConfig {
    #[default]
    English,
    German,
    Simple,
}

impl FtsConfig {
    /// The configuration `GBRAIN_FTS_LANGUAGE` names; `None` (absent) is `english`, the default.
    pub(crate) fn parse(name: Option<&str>) -> Result<FtsConfig> {
        match name.unwrap_or("english") {
            "english" => Ok(FtsConfig::English),
            "german" => Ok(FtsConfig::German),
            "simple" => Ok(FtsConfig::Simple),
            other => Err(StoreError::invalid(format!(
                "no Snowball port for the {other} text search configuration"
            ))),
        }
    }
}

fn english_dict(ty: TokenType) -> Option<Dict> {
    use TokenType::*;
    match ty {
        Asciiword | Word | HwordPart | HwordAsciipart | Asciihword | Hword => {
            Some(Dict::EnglishStem)
        }
        Numword | Email | Url | Host | Sfloat | Version | HwordNumpart | Numhword | UrlPath
        | File | Float | Int | Uint => Some(Dict::Simple),
        Blank | Tag | Protocol | Entity => None,
    }
}

/// `parsetext` for the `english` configuration. A token of `MAXSTRLEN` bytes or more is skipped
/// without taking a position; a stopword takes a position and emits no word; a lexeme longer than
/// `MAXSTRLEN` bytes (lowercasing can lengthen a token) takes its position and is dropped.
fn parsetext(text: &str) -> Vec<ParsedWord> {
    parsetext_in(text, FtsConfig::English)
}

/// [`parsetext`] under `config`: `english` or `german` stem with their Snowball dictionary; `simple`
/// sends every token type `english` maps to the `simple` dictionary (lowercased, no stemming, no
/// stopwords).
fn parsetext_in(text: &str, config: FtsConfig) -> Vec<ParsedWord> {
    let mut out = Vec::new();
    let mut pos: u32 = 0;
    for (ty, token) in parse(text) {
        // PG 18 checks `lenlemm > MAXSTRLEN`, yet PGLite skips a 2047-byte token too (no
        // position, in both tsvector and tsquery builders), so the observed bound is `>=`.
        if token.len() >= MAXSTRLEN {
            continue;
        }
        let dict = english_dict(ty).map(|d| match (config, d) {
            (FtsConfig::Simple, _) => Dict::Simple,
            (FtsConfig::German, Dict::EnglishStem) => Dict::GermanStem,
            (_, d) => d,
        });
        let lexeme = match dict {
            None => continue,
            Some(Dict::EnglishStem) => english_stem(token),
            Some(Dict::GermanStem) => german_stem(token),
            Some(Dict::Simple) => {
                let lowered = pg_lower(token);
                if lowered.is_empty() {
                    None
                } else {
                    Some(lowered)
                }
            }
        };
        pos += 1;
        if let Some(word) = lexeme {
            if word.len() > MAXSTRLEN {
                continue;
            }
            out.push(ParsedWord {
                word,
                pos: limitpos(pos),
            });
        }
    }
    out
}

/// `uniqueWORD` + `make_tsvector`: sort the words, merge duplicates and collect positions (at
/// most `MAXNUMPOS - 1`, none after position 16383, no repeats).
fn make_tsvector(mut words: Vec<ParsedWord>) -> Result<TsVector> {
    words.sort_by(|a, b| {
        a.word
            .as_bytes()
            .cmp(b.word.as_bytes())
            .then(a.pos.cmp(&b.pos))
    });
    let mut entries: Vec<TsEntry> = Vec::new();
    for w in words {
        match entries.last_mut() {
            Some(last) if last.lexeme == w.word => {
                let lastpos = *last.pos.last().expect("a merged word has a position");
                if last.pos.len() < MAXNUMPOS - 1
                    && u32::from(lastpos) != MAXENTRYPOS - 1
                    && lastpos != w.pos
                {
                    last.pos.push(w.pos);
                }
            }
            _ => entries.push(TsEntry {
                lexeme: w.word,
                pos: vec![w.pos],
            }),
        }
    }
    check_tsvector_size(&entries)?;
    Ok(TsVector { entries })
}

/// `to_tsvector('english', text)`.
pub(crate) fn to_tsvector(text: &str) -> Result<TsVector> {
    make_tsvector(parsetext(text))
}

/// `to_tsvector('simple', text)`.
pub(crate) fn to_tsvector_simple(text: &str) -> Result<TsVector> {
    make_tsvector(parsetext_in(text, FtsConfig::Simple))
}

/// `to_tsvector(config, text)`.
pub(crate) fn to_tsvector_in(config: FtsConfig, text: &str) -> Result<TsVector> {
    make_tsvector(parsetext_in(text, config))
}

/// `setweight(vector, weight)`: every position gets the weight; lexemes without positions stay
/// as they are.
pub(crate) fn setweight(mut v: TsVector, weight: Weight) -> TsVector {
    for e in &mut v.entries {
        for p in &mut e.pos {
            *p = wep_make(weight as u16, wep_pos(*p));
        }
    }
    v
}

/// `add_pos`: append `src`'s positions, shifted by `maxpos`, to `dest` while `dest` holds fewer
/// than `MAXNUMPOS` and its last position is not 16383.
fn add_pos(dest: &mut Vec<u16>, src: &[u16], maxpos: u32) {
    for &s in src {
        if dest.len() >= MAXNUMPOS {
            break;
        }
        if let Some(&last) = dest.last()
            && u32::from(wep_pos(last)) == MAXENTRYPOS - 1
        {
            break;
        }
        let pos = limitpos(u32::from(wep_pos(s)) + maxpos);
        dest.push(wep_make(wep_weight(s), pos));
    }
}

/// `tsvector_concat` (`a || b`): `b`'s positions move up by `a`'s largest position.
pub(crate) fn concat(a: &TsVector, b: &TsVector) -> Result<TsVector> {
    let maxpos = a
        .entries
        .iter()
        .flat_map(|e| e.pos.iter())
        .map(|&p| u32::from(wep_pos(p)))
        .max()
        .unwrap_or(0);
    let mut out = Vec::with_capacity(a.entries.len() + b.entries.len());
    let (mut i, mut j) = (0, 0);
    while i < a.entries.len() || j < b.entries.len() {
        let ord = match (a.entries.get(i), b.entries.get(j)) {
            (Some(x), Some(y)) => x.lexeme.as_bytes().cmp(y.lexeme.as_bytes()),
            (Some(_), None) => Ordering::Less,
            _ => Ordering::Greater,
        };
        match ord {
            Ordering::Less => {
                out.push(a.entries[i].clone());
                i += 1;
            }
            Ordering::Greater => {
                let e = &b.entries[j];
                let mut pos = Vec::new();
                add_pos(&mut pos, &e.pos, maxpos);
                out.push(TsEntry {
                    lexeme: e.lexeme.clone(),
                    pos,
                });
                j += 1;
            }
            Ordering::Equal => {
                let mut pos = a.entries[i].pos.clone();
                add_pos(&mut pos, &b.entries[j].pos, maxpos);
                out.push(TsEntry {
                    lexeme: a.entries[i].lexeme.clone(),
                    pos,
                });
                i += 1;
                j += 1;
            }
        }
    }
    check_tsvector_size(&out)?;
    Ok(TsVector { entries: out })
}

/// `gbrain_fts_input(text)` (src/schema.sql): a space at every CJK-to-ASCII-alphanumeric and
/// ASCII-alphanumeric-to-CJK boundary, in two `regexp_replace(..., 'g')` passes.
pub(crate) fn fts_input(text: &str) -> String {
    fn cjk(c: char) -> bool {
        matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3040}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}' | '\u{AC00}'..='\u{D7AF}')
    }
    fn alnum(c: char) -> bool {
        c.is_ascii_alphanumeric()
    }
    fn pass(text: &str, first: fn(char) -> bool, second: fn(char) -> bool) -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::with_capacity(text.len() + 8);
        let mut i = 0;
        while i < chars.len() {
            if i + 1 < chars.len() && first(chars[i]) && second(chars[i + 1]) {
                out.push(chars[i]);
                out.push(' ');
                out.push(chars[i + 1]);
                i += 2;
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        out
    }
    if !text.chars().any(cjk) {
        return text.to_string();
    }
    pass(&pass(text, cjk, alnum), alnum, cjk)
}

// ------------------------------------------------------------------------------------------------
// tsquery
// ------------------------------------------------------------------------------------------------

/// A tsquery operator (`OP_NOT` .. `OP_PHRASE`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Op {
    Not,
    And,
    Or,
    Phrase,
}

impl Op {
    /// `tsearch_op_priority`.
    fn priority(self) -> i32 {
        match self {
            Op::Not => 4,
            Op::And => 2,
            Op::Or => 1,
            Op::Phrase => 3,
        }
    }
}

/// One `QueryItem`. Operands carry no weight and no prefix flag: no tsquery gbrain builds has
/// either (`plainto`, `phraseto` and `websearch_to_tsquery` never set them under `english`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum QItem {
    Val(String),
    /// `QI_VALSTOP`: a stopword placeholder; `cleanup_tsquery_stopwords` removes them all.
    Stop,
    /// An operator. Its right operand is the next item; its left operand is `left` items on
    /// (unused for `Not`). `distance` is the `<N>` of a phrase operator.
    Opr {
        op: Op,
        distance: i16,
        left: u32,
    },
}

/// A tsquery in PG's layout: items in prefix order, an operator first, then its right operand,
/// then its left. An empty query (`size = 0`) has no items.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TsQuery {
    pub(crate) items: Vec<QItem>,
}

/// The tsquery parser state: `polstr` collects items in push order (PG `lcons`es them, so the
/// final array is the reverse).
struct QueryBuilder {
    pushed: Vec<QItem>,
    /// The configuration the operands parse under (`english` unless set).
    config: FtsConfig,
    /// `curop - op`: the bytes of operand text pushed so far (each operand plus its NUL).
    sumlen: usize,
}

impl QueryBuilder {
    fn new() -> Self {
        QueryBuilder {
            pushed: Vec::new(),
            config: FtsConfig::English,
            sumlen: 0,
        }
    }

    fn push_value(&mut self, word: &str) -> Result<()> {
        if word.len() > MAXSTRLEN {
            return Err(StoreError::invalid("word is too long in tsquery"));
        }
        if self.sumlen > MAXSTRPOS {
            return Err(StoreError::invalid("value is too big in tsquery"));
        }
        self.sumlen += word.len() + 1;
        self.pushed.push(QItem::Val(word.to_string()));
        Ok(())
    }

    /// The bound on the item count, checked where a query grows by a whole operand's text.
    fn check_items(&self) -> Result<()> {
        if self.pushed.len() > MAX_QUERY_ITEMS {
            return Err(too_deep());
        }
        Ok(())
    }

    fn push_stop(&mut self) {
        self.pushed.push(QItem::Stop);
    }

    fn push_operator(&mut self, op: Op, distance: i16) {
        let distance = if op == Op::Phrase { distance } else { 0 };
        self.pushed.push(QItem::Opr {
            op,
            distance,
            left: 0,
        });
    }

    /// `pushval_morph`: parse one operand's text and push its lexemes, joined by `qoperator`,
    /// with stopword placeholders for the stopwords between them.
    fn pushval_morph(&mut self, text: &str, qoperator: Op) -> Result<()> {
        let words = parsetext_in(text, self.config);
        if words.is_empty() {
            self.push_stop();
            return Ok(());
        }
        let mut pos: u32 = 0;
        let mut cntpos = 0u32;
        let mut count = 0usize;
        while count < words.len() {
            self.check_items()?;
            let wpos = u32::from(words[count].pos);
            if pos > 0 && pos + 1 < wpos {
                while pos + 1 < wpos {
                    self.check_items()?;
                    self.push_stop();
                    if cntpos > 0 {
                        self.push_operator(qoperator, 1);
                    }
                    cntpos += 1;
                    pos += 1;
                }
            }
            pos = wpos;
            // Under `english` every position holds one word of variant 0, so the variant loops
            // of the C code reduce to one push per position.
            let mut cntvar = 0u32;
            while count < words.len() && u32::from(words[count].pos) == pos {
                let mut cnt = 0u32;
                while count < words.len() && u32::from(words[count].pos) == pos {
                    self.push_value(&words[count].word)?;
                    if cnt > 0 {
                        self.push_operator(Op::And, 0);
                    }
                    cnt += 1;
                    count += 1;
                }
                if cntvar > 0 {
                    self.push_operator(Op::Or, 0);
                }
                cntvar += 1;
            }
            if cntpos > 0 {
                self.push_operator(qoperator, 1);
            }
            cntpos += 1;
        }
        Ok(())
    }

    /// The end of `parse_tsquery`: reverse into prefix order, set left offsets (`findoprnd`) and
    /// drop stopword placeholders (`cleanup_tsquery_stopwords`).
    fn finish(self) -> Result<TsQuery> {
        self.check_items()?;
        let mut items = self.pushed;
        if items.is_empty() {
            return Ok(TsQuery::default());
        }
        items.reverse();
        let count = items.len();
        with_query_stack(count, move || {
            let mut pos = 0usize;
            let mut needcleanup = false;
            findoprnd(&mut items, &mut pos, &mut needcleanup)?;
            if pos != items.len() {
                return Err(StoreError::invalid("malformed tsquery: extra nodes"));
            }
            let query = TsQuery { items };
            if needcleanup {
                return Ok(cleanup_stopwords(&query));
            }
            Ok(query)
        })
    }
}

/// `findoprnd_recurse`.
fn findoprnd(items: &mut [QItem], pos: &mut usize, needcleanup: &mut bool) -> Result<()> {
    if *pos >= items.len() {
        return Err(StoreError::invalid("malformed tsquery: operand not found"));
    }
    match items[*pos] {
        QItem::Val(_) => *pos += 1,
        QItem::Stop => {
            *needcleanup = true;
            *pos += 1;
        }
        QItem::Opr { op: Op::Not, .. } => {
            if let QItem::Opr { left, .. } = &mut items[*pos] {
                *left = 1;
            }
            *pos += 1;
            findoprnd(items, pos, needcleanup)?;
        }
        QItem::Opr { .. } => {
            let at = *pos;
            *pos += 1;
            findoprnd(items, pos, needcleanup)?;
            let offset = (*pos - at) as u32;
            if let QItem::Opr { left, .. } = &mut items[at] {
                *left = offset;
            }
            findoprnd(items, pos, needcleanup)?;
        }
    }
    Ok(())
}

/// A query tree node (`NODE` of tsquery_cleanup.c).
enum Node {
    Leaf(QItem),
    Not(Box<Node>),
    Bin {
        op: Op,
        distance: i16,
        left: Box<Node>,
        right: Box<Node>,
    },
}

/// `maketree`.
fn maketree(items: &[QItem], at: usize) -> Node {
    match &items[at] {
        QItem::Opr { op: Op::Not, .. } => Node::Not(Box::new(maketree(items, at + 1))),
        QItem::Opr { op, distance, left } => Node::Bin {
            op: *op,
            distance: *distance,
            right: Box::new(maketree(items, at + 1)),
            left: Box::new(maketree(items, at + *left as usize)),
        },
        leaf => Node::Leaf(leaf.clone()),
    }
}

/// `plainnode`.
fn plainnode(node: Node, out: &mut Vec<QItem>) {
    match node {
        Node::Leaf(item) => out.push(item),
        Node::Not(child) => {
            out.push(QItem::Opr {
                op: Op::Not,
                distance: 0,
                left: 1,
            });
            plainnode(*child, out);
        }
        Node::Bin {
            op,
            distance,
            left,
            right,
        } => {
            let at = out.len();
            out.push(QItem::Opr {
                op,
                distance,
                left: 0,
            });
            plainnode(*right, out);
            let offset = (out.len() - at) as u32;
            if let QItem::Opr { left: l, .. } = &mut out[at] {
                *l = offset;
            }
            plainnode(*left, out);
        }
    }
}

/// `clean_stopword_intree`: remove stopword placeholders, folding their width into the
/// surrounding phrase distances. Returns the node (or `None`) and `(ladd, radd)`.
fn clean_stopword_intree(node: Node) -> (Option<Node>, i32, i32) {
    match node {
        Node::Leaf(QItem::Stop) => (None, 0, 0),
        Node::Leaf(item) => (Some(Node::Leaf(item)), 0, 0),
        Node::Not(child) => {
            let (child, ladd, radd) = clean_stopword_intree(*child);
            match child {
                None => (None, ladd, radd),
                Some(c) => (Some(Node::Not(Box::new(c))), ladd, radd),
            }
        }
        Node::Bin {
            op,
            distance,
            left,
            right,
        } => {
            let (left, lladd, lradd) = clean_stopword_intree(*left);
            let (right, rladd, rradd) = clean_stopword_intree(*right);
            let isphrase = op == Op::Phrase;
            let ndistance = if isphrase { i32::from(distance) } else { 0 };
            match (left, right) {
                (None, None) => {
                    let add = if isphrase {
                        lladd + ndistance + rladd
                    } else {
                        lladd.max(rladd)
                    };
                    (None, add, add)
                }
                (None, Some(r)) => {
                    if isphrase {
                        (Some(r), lladd + ndistance + rladd, rradd)
                    } else {
                        (Some(r), rladd, rradd)
                    }
                }
                (Some(l), None) => {
                    if isphrase {
                        (Some(l), lladd, lradd + ndistance + rradd)
                    } else {
                        (Some(l), lladd, lradd)
                    }
                }
                (Some(l), Some(r)) => {
                    if isphrase {
                        // QueryOperator.distance is an int16; the C assignment truncates.
                        let distance = (i32::from(distance) + lradd + rladd) as i16;
                        (
                            Some(Node::Bin {
                                op,
                                distance,
                                left: Box::new(l),
                                right: Box::new(r),
                            }),
                            lladd,
                            rradd,
                        )
                    } else {
                        (
                            Some(Node::Bin {
                                op,
                                distance,
                                left: Box::new(l),
                                right: Box::new(r),
                            }),
                            0,
                            0,
                        )
                    }
                }
            }
        }
    }
}

/// `cleanup_tsquery_stopwords`.
fn cleanup_stopwords(query: &TsQuery) -> TsQuery {
    if query.items.is_empty() {
        return TsQuery::default();
    }
    let (root, _, _) = clean_stopword_intree(maketree(&query.items, 0));
    let mut items = Vec::new();
    if let Some(root) = root {
        plainnode(root, &mut items);
    }
    TsQuery { items }
}

/// `plainto_tsquery('english', text)`.
pub(crate) fn plainto_tsquery(text: &str) -> Result<TsQuery> {
    let mut b = QueryBuilder::new();
    if !text.is_empty() {
        b.pushval_morph(text, Op::And)?;
    }
    b.finish()
}

/// `plainto_tsquery('simple', text)`.
pub(crate) fn plainto_tsquery_simple(text: &str) -> Result<TsQuery> {
    plainto_tsquery_in(FtsConfig::Simple, text)
}

/// `plainto_tsquery(config, text)`.
pub(crate) fn plainto_tsquery_in(config: FtsConfig, text: &str) -> Result<TsQuery> {
    let mut b = QueryBuilder::new();
    b.config = config;
    if !text.is_empty() {
        b.pushval_morph(text, Op::And)?;
    }
    b.finish()
}

/// `phraseto_tsquery('english', text)`.
pub(crate) fn phraseto_tsquery(text: &str) -> Result<TsQuery> {
    let mut b = QueryBuilder::new();
    if !text.is_empty() {
        b.pushval_morph(text, Op::Phrase)?;
    }
    b.finish()
}

/// C `isspace` in the C locale.
fn c_isspace(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// `t_isspace` at a character boundary, as PGLite (PostgreSQL 17, UTF-8, ctype `C.UTF-8`) reads it:
/// a one-byte character by C `isspace`, a longer one by `iswspace`, which is the `[[:space:]]`
/// class. So U+0085, U+2000-U+200A (not U+2007), U+2028, U+2029, U+205F and U+3000 separate
/// websearch words, as they do on PGLite. (PostgreSQL 18 reads only ASCII here; PGLite is the
/// engine a Rust brain must answer like.)
fn space_at(s: &[u8], at: usize) -> bool {
    let len = mblen(s, at);
    if len == 1 {
        return c_isspace(s[at]);
    }
    std::str::from_utf8(&s[at..(at + len).min(s.len())])
        .ok()
        .and_then(|t| t.chars().next())
        .is_some_and(crate::cli_reads::pg_text::is_pg_space)
}

/// `ISOPERATOR`.
fn is_operator(b: u8) -> bool {
    matches!(b, b'!' | b'&' | b'|' | b'(' | b')' | b'<')
}

/// `pg_mblen` for UTF-8 text at a character boundary.
fn mblen(s: &[u8], at: usize) -> usize {
    match s[at] {
        b if b < 0x80 => 1,
        b if b >= 0xf0 => 4,
        b if b >= 0xe0 => 3,
        b if b >= 0xc0 => 2,
        _ => 1,
    }
}

// The names follow the C enum (WAITFIRSTOPERAND, WAITOPERAND, WAITOPERATOR).
#[derive(Clone, Copy, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
enum WebState {
    WaitFirstOperand,
    WaitOperand,
    WaitOperator,
}

enum WebToken<'a> {
    Val(&'a str),
    Opr(Op),
    End,
}

/// `parse_or_operator`: `or` (any case) followed by a non-word character and, later, an operand.
fn parse_or_operator(s: &[u8], at: usize) -> bool {
    if s.len() < at + 2 || !s[at..at + 2].eq_ignore_ascii_case(b"or") {
        return false;
    }
    let mut p = at + 2;
    if p >= s.len() {
        return false;
    }
    // t_isalnum on the next character: a letter or digit by the parser's classes (ASCII here,
    // and any non-ASCII letter counts as part of a word too).
    let next = std::str::from_utf8(&s[p..])
        .ok()
        .and_then(|t| t.chars().next());
    if s[p] == b'-' || s[p] == b'_' || next.is_some_and(super::parser::is_alnum_char) {
        return false;
    }
    loop {
        p += mblen(s, p);
        if p >= s.len() {
            return false;
        }
        if !space_at(s, p) {
            break;
        }
    }
    true
}

/// `gettoken_tsvector` in websearch mode (`oprisdelim`, `is_web`): one word, ending at
/// whitespace, an operator character, `"`, `:` or the end. The caller has already checked that
/// the first byte starts a word.
fn web_word(s: &[u8], at: usize) -> usize {
    let mut p = at + mblen(s, at);
    while p < s.len() {
        let b = s[p];
        if space_at(s, p) || is_operator(b) || b == b'"' || b == b':' {
            break;
        }
        p += mblen(s, p);
    }
    p
}

/// `gettoken_query_websearch`.
fn web_token<'a>(
    text: &'a str,
    at: &mut usize,
    state: &mut WebState,
    b: &mut QueryBuilder,
) -> WebToken<'a> {
    let s = text.as_bytes();
    loop {
        match *state {
            WebState::WaitFirstOperand | WebState::WaitOperand => {
                if *at >= s.len() {
                    // gettoken_tsvector reports the end of the input.
                    if *state == WebState::WaitOperand {
                        b.push_stop();
                    }
                    return WebToken::End;
                }
                let c = s[*at];
                if c == b'-' {
                    *at += 1;
                    *state = WebState::WaitOperand;
                    return WebToken::Opr(Op::Not);
                } else if c == b'"' {
                    *at += 1;
                    let start = *at;
                    while *at < s.len() && s[*at] != b'"' {
                        *at += 1;
                    }
                    let val = &text[start..*at];
                    if *at < s.len() {
                        *at += 1;
                    }
                    *state = WebState::WaitOperator;
                    return WebToken::Val(val);
                } else if is_operator(c) {
                    *at += 1;
                    *state = WebState::WaitOperand;
                    continue;
                } else if !space_at(s, *at) {
                    let start = *at;
                    let end = web_word(s, start);
                    *at = end;
                    *state = WebState::WaitOperator;
                    return WebToken::Val(&text[start..end]);
                }
            }
            WebState::WaitOperator => {
                if *at >= s.len() {
                    return WebToken::End;
                }
                let c = s[*at];
                if parse_or_operator(s, *at) {
                    *at += 2;
                    *state = WebState::WaitOperand;
                    return WebToken::Opr(Op::Or);
                } else if is_operator(c) {
                    *at += 1;
                    continue;
                } else if !space_at(s, *at) {
                    *state = WebState::WaitOperand;
                    return WebToken::Opr(Op::And);
                }
            }
        }
        *at += mblen(s, *at);
    }
}

/// `websearch_to_tsquery('english', text)`: `makepol` over the websearch tokenizer.
pub(crate) fn websearch_to_tsquery(text: &str) -> Result<TsQuery> {
    let mut b = QueryBuilder::new();
    let mut at = 0usize;
    let mut state = WebState::WaitFirstOperand;
    let mut stack: Vec<Op> = Vec::new();
    loop {
        match web_token(text, &mut at, &mut state, &mut b) {
            WebToken::End => break,
            WebToken::Val(v) => b.pushval_morph(v, Op::Phrase)?,
            WebToken::Opr(op) => {
                // cleanOpStack: NOT is right-associative.
                let prio = op.priority();
                while let Some(&top) = stack.last() {
                    if (op != Op::Not && prio > top.priority())
                        || (op == Op::Not && prio >= top.priority())
                    {
                        break;
                    }
                    stack.pop();
                    b.push_operator(top, 0);
                }
                if stack.len() >= STACKDEPTH {
                    return Err(StoreError::invalid("tsquery is too complex"));
                }
                stack.push(op);
            }
        }
    }
    while let Some(top) = stack.pop() {
        b.push_operator(top, 0);
    }
    b.finish()
}

/// `NULLIF(replace(plainto_tsquery(q)::text, ' & ', ' | '), '')::tsquery` (the facts keyword
/// arm): the operands of `q` in their text order, joined by a left-deep OR. `None` for an empty
/// query (SQL NULL, which matches nothing).
pub(crate) fn or_of_lexemes(q: &TsQuery) -> Option<TsQuery> {
    fn collect(items: &[QItem], at: usize, out: &mut Vec<String>) {
        match &items[at] {
            QItem::Val(v) => out.push(v.clone()),
            QItem::Stop => {}
            QItem::Opr { op: Op::Not, .. } => collect(items, at + 1, out),
            QItem::Opr { left, .. } => {
                collect(items, at + *left as usize, out);
                collect(items, at + 1, out);
            }
        }
    }
    if q.items.is_empty() {
        return None;
    }
    let mut words = Vec::new();
    with_query_stack(q.items.len(), || collect(&q.items, 0, &mut words));
    let mut b = QueryBuilder::new();
    for (i, w) in words.iter().enumerate() {
        b.push_value(w).ok()?;
        if i > 0 {
            b.push_operator(Op::Or, 0);
        }
    }
    b.finish().ok()
}

/// The item bound on the whole of `items` items of a query that grows by whole queries (`tsquery_or_all`): the error
/// `check_items` raises while one query is parsed.
pub(super) fn check_query_items(items: usize) -> Result<()> {
    if items > MAX_QUERY_ITEMS {
        return Err(too_deep());
    }
    Ok(())
}

/// `q1 || q2 || ... || qn` on tsqueries (`tsquery_or`, folded from the left): an empty query is skipped (`b` when `a`
/// is empty, `a` when `b` is empty), else an OR whose left operand is what came before and whose right operand is the
/// next query. `join_tsqueries` puts `b` in `child[0]` and `QTN2QT` writes the operator, then `child[0]` (the right
/// operand), then `child[1]`, so the items run last operator, last query, ..., first query. They are laid out once,
/// not copied for every `||`, and the whole is held to the item bound of a single query.
pub(crate) fn tsquery_or_all(queries: Vec<TsQuery>) -> Result<TsQuery> {
    let queries: Vec<TsQuery> = queries
        .into_iter()
        .filter(|q| !q.items.is_empty())
        .collect();
    let total =
        queries.iter().map(|q| q.items.len()).sum::<usize>() + queries.len().saturating_sub(1);
    check_query_items(total)?;
    let mut items = Vec::with_capacity(total);
    let mut left_len = total;
    for next in queries.into_iter().rev() {
        left_len -= next.items.len();
        if left_len > 0 {
            // `left_len` items remain after `next`: the operator joins them, and `next` sits between.
            left_len -= 1;
            items.push(QItem::Opr {
                op: Op::Or,
                distance: 0,
                left: 1 + next.items.len() as u32,
            });
        }
        items.extend(next.items);
    }
    Ok(TsQuery { items })
}

/// `ts_filter(v, weights)` (`tsvector_filter`): each lexeme keeps its positions whose weight is
/// one of `weights`; a lexeme without positions, or left with none, is dropped.
pub(crate) fn ts_filter(v: &TsVector, weights: &[Weight]) -> TsVector {
    let mask = weights.iter().fold(0u16, |m, w| m | (1 << (*w as u16)));
    TsVector {
        entries: v
            .entries
            .iter()
            .filter_map(|e| {
                let pos: Vec<u16> = e
                    .pos
                    .iter()
                    .copied()
                    .filter(|p| mask & (1 << wep_weight(*p)) != 0)
                    .collect();
                (!pos.is_empty()).then(|| TsEntry {
                    lexeme: e.lexeme.clone(),
                    pos,
                })
            })
            .collect(),
    }
}

impl TsQuery {
    /// `tsqueryout` (`infix`).
    pub(crate) fn to_text(&self) -> String {
        let mut out = String::new();
        if !self.items.is_empty() {
            let mut at = 0usize;
            infix(&self.items, &mut at, -1, false, &mut out);
        }
        out
    }
}

/// `infix`.
fn infix(
    items: &[QItem],
    at: &mut usize,
    parent_priority: i32,
    right_phrase_op: bool,
    out: &mut String,
) {
    match &items[*at] {
        QItem::Val(v) => {
            quote_lexeme(out, v);
            *at += 1;
        }
        QItem::Stop => {
            *at += 1;
        }
        QItem::Opr { op: Op::Not, .. } => {
            let priority = Op::Not.priority();
            if priority < parent_priority {
                out.push_str("( ");
            }
            out.push('!');
            *at += 1;
            infix(items, at, priority, false, out);
            if priority < parent_priority {
                out.push_str(" )");
            }
        }
        QItem::Opr { op, distance, .. } => {
            let (op, distance) = (*op, *distance);
            let priority = op.priority();
            *at += 1;
            let need_paren = priority < parent_priority || (op == Op::Phrase && right_phrase_op);
            if need_paren {
                out.push_str("( ");
            }
            let mut right = String::new();
            infix(items, at, priority, op == Op::Phrase, &mut right);
            infix(items, at, priority, false, out);
            match op {
                Op::Or => out.push_str(" | "),
                Op::And => out.push_str(" & "),
                _ => {
                    if distance != 1 {
                        out.push_str(&format!(" <{distance}> "));
                    } else {
                        out.push_str(" <-> ");
                    }
                }
            }
            out.push_str(&right);
            if need_paren {
                out.push_str(" )");
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------
// Execution (`TS_execute`)
// ------------------------------------------------------------------------------------------------

/// `TSTernaryValue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Tern {
    No,
    Yes,
    Maybe,
}

/// `ExecPhraseData`: matched positions (`WordEntryPos` values), the negate flag and the phrase
/// width.
#[derive(Debug, Default)]
pub(super) struct PhraseData {
    pub(super) pos: Vec<u16>,
    pub(super) negate: bool,
    pub(super) width: i32,
}

/// A `TSExecuteCallback`: decide one operand. With `data`, also report its positions.
pub(super) trait CheckCondition {
    fn check(&self, item: usize, data: Option<&mut PhraseData>) -> Tern;
}

const TSPO_L_ONLY: u8 = 0x01;
const TSPO_R_ONLY: u8 = 0x02;
const TSPO_BOTH: u8 = 0x04;

/// `TS_phrase_output`.
fn phrase_output(
    data: Option<&mut PhraseData>,
    l: &PhraseData,
    r: &PhraseData,
    emit: u8,
    loffset: i32,
    roffset: i32,
) -> Tern {
    let mut data = data;
    let (mut li, mut ri) = (0usize, 0usize);
    while li < l.pos.len() || ri < r.pos.len() {
        let lpos = if li < l.pos.len() {
            i32::from(wep_pos(l.pos[li])) + loffset
        } else {
            if emit & TSPO_R_ONLY == 0 {
                break;
            }
            i32::MAX
        };
        let rpos = if ri < r.pos.len() {
            i32::from(wep_pos(r.pos[ri])) + roffset
        } else {
            if emit & TSPO_L_ONLY == 0 {
                break;
            }
            i32::MAX
        };
        let mut output_pos = 0i32;
        match lpos.cmp(&rpos) {
            Ordering::Less => {
                if emit & TSPO_L_ONLY != 0 {
                    output_pos = lpos;
                }
                li += 1;
            }
            Ordering::Equal => {
                if emit & TSPO_BOTH != 0 {
                    output_pos = rpos;
                }
                li += 1;
                ri += 1;
            }
            Ordering::Greater => {
                if emit & TSPO_R_ONLY != 0 {
                    output_pos = rpos;
                }
                ri += 1;
            }
        }
        if output_pos > 0 {
            match data.as_deref_mut() {
                // The C code stores the int into a WordEntryPos (uint16).
                Some(d) => d.pos.push(output_pos as u16),
                None => return Tern::Yes,
            }
        }
    }
    match data {
        Some(d) if !d.pos.is_empty() => Tern::Yes,
        _ => Tern::No,
    }
}

/// `TS_phrase_execute`.
fn phrase_execute(
    items: &[QItem],
    at: usize,
    chk: &dyn CheckCondition,
    data: Option<&mut PhraseData>,
) -> Tern {
    match &items[at] {
        QItem::Val(_) => chk.check(at, data),
        QItem::Stop => Tern::No,
        QItem::Opr { op: Op::Not, .. } => {
            let mut local = PhraseData::default();
            let data = match data {
                Some(d) => d,
                None => &mut local,
            };
            match phrase_execute(items, at + 1, chk, Some(data)) {
                Tern::No => {
                    data.negate = true;
                    Tern::Yes
                }
                Tern::Yes => {
                    if !data.pos.is_empty() {
                        data.negate = !data.negate;
                        Tern::Yes
                    } else if data.negate {
                        data.negate = false;
                        Tern::No
                    } else {
                        Tern::No
                    }
                }
                Tern::Maybe => Tern::Maybe,
            }
        }
        QItem::Opr { op, distance, left } => {
            let (op, distance, left) = (*op, i32::from(*distance), *left as usize);
            let mut ldata = PhraseData::default();
            let mut rdata = PhraseData::default();
            if op == Op::Or {
                let lmatch = phrase_execute(items, at + left, chk, Some(&mut ldata));
                let rmatch = phrase_execute(items, at + 1, chk, Some(&mut rdata));
                if lmatch == Tern::No && rmatch == Tern::No {
                    return Tern::No;
                }
                if lmatch == Tern::Maybe || rmatch == Tern::Maybe {
                    return Tern::Maybe;
                }
                if lmatch == Tern::No {
                    ldata.width = 0;
                }
                if rmatch == Tern::No {
                    rdata.width = 0;
                }
                let maxwidth = ldata.width.max(rdata.width);
                let loffset = maxwidth - ldata.width;
                let roffset = maxwidth - rdata.width;
                let mut data = data;
                if let Some(d) = data.as_deref_mut() {
                    d.width = maxwidth;
                }
                return if ldata.negate && rdata.negate {
                    phrase_output(
                        data.as_deref_mut(),
                        &ldata,
                        &rdata,
                        TSPO_BOTH,
                        loffset,
                        roffset,
                    );
                    if let Some(d) = data {
                        d.negate = true;
                    }
                    Tern::Yes
                } else if ldata.negate {
                    phrase_output(
                        data.as_deref_mut(),
                        &ldata,
                        &rdata,
                        TSPO_L_ONLY,
                        loffset,
                        roffset,
                    );
                    if let Some(d) = data {
                        d.negate = true;
                    }
                    Tern::Yes
                } else if rdata.negate {
                    phrase_output(
                        data.as_deref_mut(),
                        &ldata,
                        &rdata,
                        TSPO_R_ONLY,
                        loffset,
                        roffset,
                    );
                    if let Some(d) = data {
                        d.negate = true;
                    }
                    Tern::Yes
                } else {
                    phrase_output(
                        data,
                        &ldata,
                        &rdata,
                        TSPO_BOTH | TSPO_L_ONLY | TSPO_R_ONLY,
                        loffset,
                        roffset,
                    )
                };
            }
            // OP_PHRASE and OP_AND.
            let lmatch = phrase_execute(items, at + left, chk, Some(&mut ldata));
            if lmatch == Tern::No {
                return Tern::No;
            }
            let rmatch = phrase_execute(items, at + 1, chk, Some(&mut rdata));
            if rmatch == Tern::No {
                return Tern::No;
            }
            if lmatch == Tern::Maybe || rmatch == Tern::Maybe {
                return Tern::Maybe;
            }
            let mut data = data;
            let (loffset, roffset);
            if op == Op::Phrase {
                loffset = distance + rdata.width;
                roffset = 0;
                if let Some(d) = data.as_deref_mut() {
                    d.width = distance + ldata.width + rdata.width;
                }
            } else {
                let maxwidth = ldata.width.max(rdata.width);
                loffset = maxwidth - ldata.width;
                roffset = maxwidth - rdata.width;
                if let Some(d) = data.as_deref_mut() {
                    d.width = maxwidth;
                }
            }
            if ldata.negate && rdata.negate {
                phrase_output(
                    data.as_deref_mut(),
                    &ldata,
                    &rdata,
                    TSPO_BOTH | TSPO_L_ONLY | TSPO_R_ONLY,
                    loffset,
                    roffset,
                );
                if let Some(d) = data {
                    d.negate = true;
                }
                Tern::Yes
            } else if ldata.negate {
                phrase_output(data, &ldata, &rdata, TSPO_R_ONLY, loffset, roffset)
            } else if rdata.negate {
                phrase_output(data, &ldata, &rdata, TSPO_L_ONLY, loffset, roffset)
            } else {
                phrase_output(data, &ldata, &rdata, TSPO_BOTH, loffset, roffset)
            }
        }
    }
}

/// `TS_execute_recurse` with `TS_EXEC_EMPTY`.
fn execute_recurse(items: &[QItem], at: usize, chk: &dyn CheckCondition) -> Tern {
    match &items[at] {
        QItem::Val(_) => chk.check(at, None),
        QItem::Stop => Tern::No,
        QItem::Opr { op: Op::Not, .. } => match execute_recurse(items, at + 1, chk) {
            Tern::No => Tern::Yes,
            Tern::Yes => Tern::No,
            Tern::Maybe => Tern::Maybe,
        },
        QItem::Opr {
            op: Op::And, left, ..
        } => {
            let lmatch = execute_recurse(items, at + *left as usize, chk);
            if lmatch == Tern::No {
                return Tern::No;
            }
            match execute_recurse(items, at + 1, chk) {
                Tern::No => Tern::No,
                Tern::Yes => lmatch,
                Tern::Maybe => Tern::Maybe,
            }
        }
        QItem::Opr {
            op: Op::Or, left, ..
        } => {
            let lmatch = execute_recurse(items, at + *left as usize, chk);
            if lmatch == Tern::Yes {
                return Tern::Yes;
            }
            match execute_recurse(items, at + 1, chk) {
                Tern::No => lmatch,
                Tern::Yes => Tern::Yes,
                Tern::Maybe => Tern::Maybe,
            }
        }
        QItem::Opr { op: Op::Phrase, .. } => match phrase_execute(items, at, chk, None) {
            Tern::Yes => Tern::Yes,
            // Without TS_EXEC_PHRASE_NO_POS a MAYBE phrase is a NO.
            _ => Tern::No,
        },
    }
}

/// `TS_execute(..., TS_EXEC_EMPTY, chk)`.
pub(super) fn ts_execute(q: &TsQuery, chk: &dyn CheckCondition) -> bool {
    execute_recurse(&q.items, 0, chk) != Tern::No
}

/// `checkcondition_str` + `checkclass_str` for an operand without weight or prefix.
struct VectorCheck<'a> {
    v: &'a TsVector,
    q: &'a TsQuery,
}

impl CheckCondition for VectorCheck<'_> {
    fn check(&self, item: usize, data: Option<&mut PhraseData>) -> Tern {
        let QItem::Val(word) = &self.q.items[item] else {
            return Tern::No;
        };
        let Some(idx) = self.v.find(word) else {
            return Tern::No;
        };
        let entry = &self.v.entries[idx];
        match data {
            Some(d) if !entry.pos.is_empty() => {
                d.pos = entry.pos.clone();
                Tern::Yes
            }
            Some(_) => Tern::Maybe,
            None => Tern::Yes,
        }
    }
}

/// `vector @@ query` (`ts_match_vq`). An empty query matches nothing.
pub(crate) fn ts_matches(v: &TsVector, q: &TsQuery) -> bool {
    if q.items.is_empty() {
        return false;
    }
    with_query_stack(q.items.len(), || ts_execute(q, &VectorCheck { v, q }))
}

#[cfg(test)]
mod tests {
    //! Golden tests against PGLite 0.5.16 (PG 18.6). `tests/fixtures/tsearch.json` holds, for a
    //! fixed and a seeded random corpus, the outputs of `to_tsvector('english', t)::text`,
    //! `gbrain_fts_input(t)`, the three tsquery builders' `::text`, the facts OR query, and for
    //! A/B/C-weighted documents `@@`, `ts_rank` and `ts_rank_cd`.
    use super::super::rank::{ts_rank, ts_rank_cd};
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../tests/fixtures/tsearch.json")).expect("fixture")
    }

    fn expand(t: &str) -> String {
        let Some(spec) = t.strip_prefix("@rep:") else {
            return t.to_string();
        };
        // "<unit>:<count>:<suffix>"; the unit holds no ':'.
        let (unit, rest) = spec.split_once(':').expect("unit");
        let (n, suffix) = rest.split_once(':').expect("count");
        unit.repeat(n.parse().expect("n")) + suffix
    }

    fn s<'a>(v: &'a Value, k: &str) -> &'a str {
        v[k].as_str().unwrap_or_else(|| panic!("{k}"))
    }

    #[test]
    fn to_tsvector_and_fts_input_match_pglite() {
        let f = fixture();
        let mut bad = Vec::new();
        for v in f["vectors"].as_array().expect("vectors") {
            let text = s(v, "text");
            let got = to_tsvector(text).expect("tsvector").to_text();
            if got != s(v, "tsv") {
                bad.push(format!(
                    "to_tsvector({text:?})\n  rust {got}\n  pg   {}",
                    s(v, "tsv")
                ));
            }
            let got = fts_input(text);
            if got != s(v, "fts_input") {
                bad.push(format!(
                    "fts_input({text:?}) rust {got:?} pg {:?}",
                    s(v, "fts_input")
                ));
            }
        }
        assert!(
            bad.is_empty(),
            "{} mismatches:\n{}",
            bad.len(),
            bad.join("\n")
        );
    }

    #[test]
    fn websearch_splits_on_pglite_non_ascii_spaces() {
        // PGLite 0.4.3 (PostgreSQL 17.5, the repository's PGLite) answers, captured from
        // `websearch_to_tsquery('english', q)::text`. The goldens above come from PostgreSQL 18.6,
        // which reads only ASCII whitespace here; they hold none of these characters.
        let separators = [
            0x85, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a,
            0x2028, 0x2029, 0x205f, 0x3000,
        ];
        let shapes = [
            ("cat{w}dog", "'cat' & 'dog'"),
            ("cats{w}or{w}dogs", "'cat' | 'dog'"),
            ("cats{w}-dogs", "'cat' & !'dog'"),
            ("-{w}cats", "!'cat'"),
            ("{w}-dogs", "!'dog'"),
            ("cats{w}or", "'cat'"),
            (
                "running{w}\"quick{w}fox\"{w}or{w}jumps",
                "'run' & 'quick' <-> 'fox' | 'jump'",
            ),
        ];
        let mut bad = Vec::new();
        for cp in separators {
            let w = char::from_u32(cp).expect("scalar").to_string();
            for (shape, want) in shapes {
                let q = shape.replace("{w}", &w);
                let got = websearch_to_tsquery(&q).expect("web").to_text();
                if got != want {
                    bad.push(format!("U+{cp:04X} {shape}: rust {got} pglite {want}"));
                }
            }
        }
        // Not in PGLite's class: the word stays whole and the parser splits it into a phrase.
        for cp in [0x1680, 0x2007, 0xa0, 0x202f] {
            let w = char::from_u32(cp).expect("scalar").to_string();
            let got = websearch_to_tsquery(&format!("cats{w}-dogs"))
                .expect("web")
                .to_text();
            if got != "'cat' <-> 'dog'" {
                bad.push(format!("U+{cp:04X} cats-dogs: rust {got}"));
            }
        }
        assert!(
            bad.is_empty(),
            "{} mismatches:\n{}",
            bad.len(),
            bad.join("\n")
        );
    }

    #[test]
    fn tsquery_builders_match_pglite() {
        let f = fixture();
        let mut bad = Vec::new();
        for v in f["queries"].as_array().expect("queries") {
            let text = s(v, "text");
            let plain = plainto_tsquery(text).expect("plain");
            let checks = [
                ("plainto", plain.to_text(), s(v, "plain")),
                (
                    "phraseto",
                    phraseto_tsquery(text).expect("phrase").to_text(),
                    s(v, "phrase"),
                ),
                (
                    "websearch",
                    websearch_to_tsquery(text).expect("web").to_text(),
                    s(v, "web"),
                ),
                (
                    "or",
                    or_of_lexemes(&plain).map_or("<null>".to_string(), |q| q.to_text()),
                    s(v, "or"),
                ),
            ];
            for (name, got, want) in checks {
                if got != want {
                    bad.push(format!("{name}({text:?})\n  rust {got}\n  pg   {want}"));
                }
            }
        }
        assert!(
            bad.is_empty(),
            "{} mismatches:\n{}",
            bad.len(),
            bad.join("\n")
        );
    }

    #[test]
    fn token_of_maxstrlen_bytes_is_skipped_without_a_position() {
        // PGLite: 'x ' || repeat('a', n) || ' y'.
        let doc = |n: usize| format!("x {} y", "a".repeat(n));
        assert_eq!(to_tsvector(&doc(2047)).unwrap().to_text(), "'x':1 'y':2");
        assert_eq!(to_tsvector(&doc(2048)).unwrap().to_text(), "'x':1 'y':2");
        assert!(
            to_tsvector(&doc(2046))
                .unwrap()
                .to_text()
                .ends_with(":2 'x':1 'y':3")
        );
        assert_eq!(
            phraseto_tsquery(&doc(2047)).unwrap().to_text(),
            "'x' <-> 'y'"
        );
        assert_eq!(plainto_tsquery(&doc(2047)).unwrap().to_text(), "'x' & 'y'");
        assert_eq!(
            websearch_to_tsquery(&doc(2047)).unwrap().to_text(),
            "'x' & 'y'"
        );
        assert_eq!(phraseto_tsquery(&doc(2046)).unwrap().to_text().len(), 2064);
    }

    fn pg_f32(t: &str) -> f32 {
        t.parse().unwrap_or_else(|_| panic!("float {t}"))
    }

    #[test]
    fn match_and_rank_match_pglite() {
        let f = fixture();
        let mut bad = Vec::new();
        let ranks = f["ranks"].as_array().expect("ranks");
        for v in ranks {
            let (a, b, c, qt) = (
                expand(s(v, "a")),
                expand(s(v, "b")),
                expand(s(v, "c")),
                s(v, "q"),
            );
            let vec = concat(
                &concat(
                    &setweight(to_tsvector(&fts_input(&a)).unwrap(), Weight::A),
                    &setweight(to_tsvector(&fts_input(&b)).unwrap(), Weight::B),
                )
                .unwrap(),
                &setweight(to_tsvector(&fts_input(&c)).unwrap(), Weight::C),
            )
            .unwrap();
            let q = match s(v, "kind") {
                "plain" => Some(plainto_tsquery(qt).unwrap()),
                "phrase" => Some(phraseto_tsquery(qt).unwrap()),
                "web" => Some(websearch_to_tsquery(qt).unwrap()),
                _ => or_of_lexemes(&plainto_tsquery(qt).unwrap()),
            };
            let label = format!(
                "{} q={qt:?} a={:.40?} b={:.60?} c={:.40?}",
                s(v, "kind"),
                a,
                b,
                c
            );
            if v["nlex"].as_u64() != Some(vec.entries.len() as u64) {
                bad.push(format!(
                    "{label}: lexeme count rust {} pg {}",
                    vec.entries.len(),
                    v["nlex"]
                ));
                continue;
            }
            let Some(q) = q else {
                if s(v, "match") != "<null>" {
                    bad.push(format!("{label}: rust NULL query, pg {}", s(v, "match")));
                }
                continue;
            };
            let m = ts_matches(&vec, &q).to_string();
            if m != s(v, "match") {
                bad.push(format!(
                    "{label}: @@ rust {m} pg {} (query {})",
                    s(v, "match"),
                    q.to_text()
                ));
            }
            let r = ts_rank(&vec, &q);
            if r.to_bits() != pg_f32(s(v, "rank")).to_bits() {
                bad.push(format!(
                    "{label}: ts_rank rust {r:?} pg {} (query {})",
                    s(v, "rank"),
                    q.to_text()
                ));
            }
            let r = ts_rank_cd(&vec, &q);
            if r.to_bits() != pg_f32(s(v, "rank_cd")).to_bits() {
                bad.push(format!(
                    "{label}: ts_rank_cd rust {r:?} pg {} (query {})",
                    s(v, "rank_cd"),
                    q.to_text()
                ));
            }
        }
        assert!(ranks.len() > 700);
        assert!(
            bad.is_empty(),
            "{} mismatches:\n{}",
            bad.len(),
            bad.join("\n")
        );
    }

    /// Run `f` on a thread with a 1 MiB stack, smaller than any thread the N-API host runs a
    /// search on, so a recursion that depends on the query size overflows it.
    fn on_small_stack<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> R {
        std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(f)
            .expect("spawn")
            .join()
            .expect("the query code must not panic")
    }

    #[test]
    fn a_query_of_many_operands_is_built_matched_and_ranked_without_deep_recursion() {
        // GBRAIN-REVIEW 4: 'quokka the ' repeated builds a left-deep tree whose depth follows the
        // operand count, and the recursive cleanup, matcher and ranker overflowed the stack.
        // PGLite answers 20,000 repeats (about 80,000 items) with the match.
        let (matched, rank, or_text) = on_small_stack(|| {
            let text = "quokka the ".repeat(20_000);
            let q = websearch_to_tsquery(&text).expect("web");
            let doc = to_tsvector("quokka here").expect("doc");
            let plain = plainto_tsquery(&text).expect("plain");
            let phrase = phraseto_tsquery(&text).expect("phrase");
            (
                (
                    ts_matches(&doc, &q),
                    ts_matches(&doc, &phrase),
                    q.items.len(),
                ),
                super::super::rank::ts_rank_cd(&doc, &q),
                or_of_lexemes(&plain).map(|o| o.items.len()),
            )
        });
        assert!(matched.0, "the AND of twenty thousand quokkas matches");
        assert!(!matched.1, "the phrase of them does not");
        assert!(matched.2 > 20_000);
        assert!(rank >= 0.0);
        assert_eq!(or_text, Some(39_999));
    }

    #[test]
    fn a_query_at_the_item_bound_fits_the_deep_stack() {
        // The deepest query the bound admits, in a debug build (the largest frames).
        let items = on_small_stack(|| {
            // Grow the query until the next step is refused, then keep the last one admitted.
            let mut n = 1_000;
            let mut last = websearch_to_tsquery(&"quokka the ".repeat(n)).expect("web");
            while let Ok(q) = websearch_to_tsquery(&"quokka the ".repeat(n + 500)) {
                n += 500;
                last = q;
            }
            assert!(n > 20_000, "the bound admits what PGLite answers: {n}");
            let q = last;
            let doc = to_tsvector("quokka here").expect("doc");
            assert!(ts_matches(&doc, &q));
            assert!(super::super::rank::ts_rank_cd(&doc, &q) >= 0.0);
            q.items.len()
        });
        assert!(items > 10_000);
    }

    #[test]
    fn a_query_past_the_item_bound_is_refused_not_recursed_into() {
        // Repeated stopwords add placeholder items but no lexeme bytes, so the byte counter
        // never trips; the item bound does. (plainto/phraseto of a text of only stopwords is the
        // one-placeholder empty query, so only the websearch parser grows with it.)
        let refused = |e: Option<StoreError>, len: usize| {
            let e = e.unwrap_or_else(|| panic!("a query of {len} bytes was not refused"));
            assert!(
                e.message.starts_with("stack depth limit exceeded"),
                "{}",
                e.message
            );
        };
        let stop = "the ".repeat(400_000);
        let len = stop.len();
        refused(
            on_small_stack(move || websearch_to_tsquery(&stop).err()),
            len,
        );
        let mixed = "quokka the ".repeat(100_000);
        let len = mixed.len();
        let errs = on_small_stack(move || {
            [
                websearch_to_tsquery(&mixed).err(),
                plainto_tsquery(&mixed).err(),
                phraseto_tsquery(&mixed).err(),
            ]
        });
        for e in errs {
            refused(e, len);
        }
    }
}
