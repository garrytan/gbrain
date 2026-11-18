//! Port of PostgreSQL's text-search rankers (`utils/adt/tsrank.c`, PG 18): `ts_rank(vector,
//! query)` (`calc_rank`, normalization 0) and `ts_rank_cd(vector, query)` (`calc_rank_cd`,
//! normalization 0), both with the default weights `{D 0.1, C 0.2, B 0.4, A 1.0}`.
//! Derived from PostgreSQL 18.6; licence and notice: third-party/postgresql/NOTICE.md
//!
//! Every intermediate keeps the C type: `float` (f32) where the C code holds a `float`, `double`
//! (f64) where it computes in `double`. The final value is a `float4`, so the callers get the f32
//! PG returns. The SQL that multiplies the rank by a `numeric` or `float8` factor widens it after
//! this point.
// The keyword members (countKeywordPages, searchKeywordPages, searchTitles,
// searchKeywordChunks) and lane 4's findCandidateDuplicates call these next; until they land,
// only the golden tests use them.
#![allow(dead_code)]

use super::tsearch::{
    CheckCondition, MAXENTRYPOS, PhraseData, QItem, Tern, TsQuery, TsVector, ts_execute, wep_pos,
    wep_weight, with_query_stack,
};

/// `default_weights`, indexed by weight code (0 = D .. 3 = A).
const DEFAULT_WEIGHTS: [f32; 4] = [0.1, 0.2, 0.4, 1.0];

/// `wpos`.
fn wpos(wep: u16) -> f32 {
    DEFAULT_WEIGHTS[usize::from(wep_weight(wep))]
}

/// `word_distance`.
fn word_distance(w: i32) -> f32 {
    if w > 100 {
        return 1e-30;
    }
    (1.0 / (1.005 + 0.05 * (f64::from(w as f32) / 1.5 - 2.0).exp())) as f32
}

/// `SortAndUniqItems`: every operand of the query (those under `!` too), sorted by bytes, each
/// lexeme once.
fn sort_and_uniq_items(q: &TsQuery) -> Vec<&str> {
    let mut items: Vec<&str> = q
        .items
        .iter()
        .filter_map(|i| match i {
            QItem::Val(v) => Some(v.as_str()),
            _ => None,
        })
        .collect();
    items.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    items.dedup();
    items
}

/// The position vector `calc_rank_and` uses for a lexeme stored without positions.
const POSNULL_AND: [u16; 1] = [(MAXENTRYPOS - 1) as u16];
/// The position vector `calc_rank_or` uses for a lexeme stored without positions.
const POSNULL_OR: [u16; 1] = [0];

/// `calc_rank_and`.
fn calc_rank_and(t: &TsVector, q: &TsQuery) -> f32 {
    let items = sort_and_uniq_items(q);
    if items.len() < 2 {
        return calc_rank_or(t, q);
    }
    let mut res: f32 = -1.0;
    // (positions, is POSNULL) per unique item; None when the lexeme is absent.
    let mut pos: Vec<Option<(&[u16], bool)>> = vec![None; items.len()];
    for i in 0..items.len() {
        let Some(idx) = t.find(items[i]) else {
            continue;
        };
        let entry = &t.entries[idx];
        pos[i] = Some(if entry.pos.is_empty() {
            (&POSNULL_AND[..], true)
        } else {
            (&entry.pos[..], false)
        });
        let (post, inull) = pos[i].expect("just set");
        for &slot in &pos[..i] {
            let Some((ct, knull)) = slot else {
                continue;
            };
            for &pl in post {
                for &cp in ct {
                    let mut dist = (i32::from(wep_pos(pl)) - i32::from(wep_pos(cp))).abs();
                    if dist != 0 || inull || knull {
                        if dist == 0 {
                            dist = MAXENTRYPOS as i32;
                        }
                        let curw =
                            f64::from(wpos(pl) * wpos(cp) * word_distance(dist)).sqrt() as f32;
                        res = if res < 0.0 {
                            curw
                        } else {
                            (1.0 - (1.0 - f64::from(res)) * (1.0 - f64::from(curw))) as f32
                        };
                    }
                }
            }
        }
    }
    res
}

/// `calc_rank_or`.
fn calc_rank_or(t: &TsVector, q: &TsQuery) -> f32 {
    let items = sort_and_uniq_items(q);
    let mut res: f32 = 0.0;
    for item in &items {
        let Some(idx) = t.find(item) else {
            continue;
        };
        let entry = &t.entries[idx];
        let post: &[u16] = if entry.pos.is_empty() {
            &POSNULL_OR
        } else {
            &entry.pos
        };
        let mut resj: f32 = 0.0;
        let mut wjm: f32 = -1.0;
        let mut jm: i32 = 0;
        for (j, &p) in post.iter().enumerate() {
            let j = j as i32;
            resj += wpos(p) / ((j + 1) * (j + 1)) as f32;
            if wpos(p) > wjm {
                wjm = wpos(p);
                jm = j;
            }
        }
        let term = wjm + resj - wjm / ((jm + 1) * (jm + 1)) as f32;
        res = (f64::from(res) + f64::from(term) / 1.64493406685) as f32;
    }
    if !items.is_empty() {
        res /= items.len() as f32;
    }
    res
}

/// `ts_rank(vector, query)`.
pub(crate) fn ts_rank(t: &TsVector, q: &TsQuery) -> f32 {
    if t.entries.is_empty() || q.items.is_empty() {
        return 0.0;
    }
    let and_like = matches!(
        q.items[0],
        QItem::Opr {
            op: super::tsearch::Op::And | super::tsearch::Op::Phrase,
            ..
        }
    );
    let res = if and_like {
        calc_rank_and(t, q)
    } else {
        calc_rank_or(t, q)
    };
    if res < 0.0 { 1e-20 } else { res }
}

/// One `DocRepresentation` row after merging: a stored position, the vector entry it belongs to
/// and the query items (by index) that matched it.
struct DocRow {
    pos: u16,
    entry: usize,
    items: Vec<usize>,
}

/// `get_docrep`.
fn get_docrep(t: &TsVector, q: &TsQuery) -> Vec<DocRow> {
    let mut rows: Vec<(u16, usize, usize)> = Vec::new();
    for (i, item) in q.items.iter().enumerate() {
        let QItem::Val(word) = item else {
            continue;
        };
        let Some(idx) = t.find(word) else {
            continue;
        };
        for &p in &t.entries[idx].pos {
            rows.push((p, idx, i));
        }
    }
    if rows.is_empty() {
        return Vec::new();
    }
    // compareDocR: position, then weight, then entry. The C qsort is not stable, but rows that
    // compare equal (same position, weight and entry) are merged below, and the merge keeps the
    // items in the order the sort leaves them; only `nitem` matters downstream.
    rows.sort_by(|a, b| {
        wep_pos(a.0)
            .cmp(&wep_pos(b.0))
            .then(wep_weight(a.0).cmp(&wep_weight(b.0)))
            .then(a.1.cmp(&b.1))
    });
    let size = q.items.len();
    let mut doc: Vec<DocRow> = Vec::new();
    let mut prev: Option<(u16, usize)> = None;
    for (p, entry, item) in rows {
        match (prev, doc.last_mut()) {
            (Some((pp, pe)), Some(last)) if pp == p && pe == entry => {
                if last.items.len() < size {
                    last.items.push(item);
                }
            }
            _ => doc.push(DocRow {
                pos: p,
                entry,
                items: vec![item],
            }),
        }
        prev = Some((p, entry));
    }
    doc
}

/// `QueryRepresentationOperand` per query item. Positions are kept ascending in both scan
/// directions, which is the order the C code's reverse insertion leaves them in.
#[derive(Clone, Default)]
struct OperandData {
    exists: bool,
    pos: Vec<u16>,
}

struct QueryRepr {
    ops: Vec<OperandData>,
    reverse: bool,
}

impl QueryRepr {
    /// `resetQueryRepresentation`.
    fn reset(&mut self, reverse: bool) {
        for o in &mut self.ops {
            o.exists = false;
            o.pos.clear();
        }
        self.reverse = reverse;
    }

    /// `fillQueryRepresentationData`.
    fn fill(&mut self, row: &DocRow) {
        for &i in &row.items {
            let o = &mut self.ops[i];
            o.exists = true;
            if o.pos.is_empty() {
                o.pos.push(row.pos);
                continue;
            }
            let last = if self.reverse {
                o.pos[0]
            } else {
                o.pos[o.pos.len() - 1]
            };
            if wep_pos(last) != wep_pos(row.pos) {
                if self.reverse {
                    o.pos.insert(0, row.pos);
                } else {
                    o.pos.push(row.pos);
                }
            }
        }
    }
}

impl CheckCondition for QueryRepr {
    /// `checkcondition_QueryOperand`.
    fn check(&self, item: usize, data: Option<&mut PhraseData>) -> Tern {
        let o = &self.ops[item];
        if !o.exists {
            return Tern::No;
        }
        if let Some(d) = data {
            d.pos = o.pos.clone();
        }
        Tern::Yes
    }
}

/// `CoverExt`.
struct CoverExt {
    pos: usize,
    p: i32,
    q: i32,
    begin: usize,
    end: usize,
}

/// `Cover` (its tail recursion as a loop).
fn cover(doc: &[DocRow], qr: &mut QueryRepr, q: &TsQuery, ext: &mut CoverExt) -> bool {
    loop {
        let mut lastpos = ext.pos;
        let mut found = false;
        qr.reset(false);
        ext.p = i32::MAX;
        ext.q = 0;
        let mut ptr = ext.pos;
        while ptr < doc.len() {
            qr.fill(&doc[ptr]);
            if ts_execute(q, qr) {
                let gp = i32::from(wep_pos(doc[ptr].pos));
                if gp > ext.q {
                    ext.q = gp;
                    ext.end = ptr;
                    lastpos = ptr;
                    found = true;
                }
                break;
            }
            ptr += 1;
        }
        if !found {
            return false;
        }
        qr.reset(true);
        let mut ptr = lastpos as isize;
        while ptr >= ext.pos as isize {
            let row = &doc[ptr as usize];
            qr.fill(row);
            if ts_execute(q, qr) {
                let gp = i32::from(wep_pos(row.pos));
                if gp < ext.p {
                    ext.begin = ptr as usize;
                    ext.p = gp;
                }
                break;
            }
            ptr -= 1;
        }
        if ext.p <= ext.q {
            ext.pos = (ptr + 1) as usize;
            return true;
        }
        ext.pos += 1;
    }
}

/// `ts_rank_cd(vector, query)`.
pub(crate) fn ts_rank_cd(t: &TsVector, q: &TsQuery) -> f32 {
    with_query_stack(q.items.len(), || ts_rank_cd_walk(t, q))
}

fn ts_rank_cd_walk(t: &TsVector, q: &TsQuery) -> f32 {
    let invws: [f64; 4] = DEFAULT_WEIGHTS.map(|w| 1.0 / f64::from(w));
    let doc = get_docrep(t, q);
    if doc.is_empty() {
        return 0.0;
    }
    let mut qr = QueryRepr {
        ops: vec![OperandData::default(); q.items.len()],
        reverse: false,
    };
    let mut ext = CoverExt {
        pos: 0,
        p: 0,
        q: 0,
        begin: 0,
        end: 0,
    };
    let mut wdoc: f64 = 0.0;
    while cover(&doc, &mut qr, q, &mut ext) {
        let mut inv_sum: f64 = 0.0;
        for row in &doc[ext.begin..=ext.end] {
            inv_sum += invws[usize::from(wep_weight(row.pos))];
        }
        let span = ext.end as i32 - ext.begin as i32;
        let cpos = f64::from(span + 1) / inv_sum;
        let mut n_noise = (ext.q - ext.p) - span;
        if n_noise < 0 {
            n_noise = span / 2;
        }
        wdoc += cpos / f64::from(1 + n_noise);
    }
    wdoc as f32
}
