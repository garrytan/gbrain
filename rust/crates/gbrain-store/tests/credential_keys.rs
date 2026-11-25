//! The jobs family (`keys::JOBS`, `m`) splits its key space by the byte after the tag, one constant per record kind
//! across `src/jobs.rs` and `src/jobs/*.rs`. The credential stores own two of them: 0x2A (`oauth_clients.rs`) and 0x2B
//! (`access_tokens.rs`). This reads the sources and checks that no two record kinds share a sub-tag, that 0x2A and 0x2B
//! are each declared once and only in their own file, and that no two families share a family tag in `src/keys.rs`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Every `const NAME: u8 = 0x..;` in one source file, as (name, value).
fn sub_tags(path: &Path) -> Vec<(String, u8)> {
    let text = fs::read_to_string(path).unwrap();
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line
                .strip_prefix("const ")
                .or_else(|| line.strip_prefix("pub(super) const "))?;
            let (name, value) = rest.split_once(": u8 = 0x")?;
            let hex = value.strip_suffix(';')?;
            Some((name.to_string(), u8::from_str_radix(hex, 16).ok()?))
        })
        .collect()
}

fn jobs_sources() -> Vec<PathBuf> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![src.join("jobs.rs")];
    let mut dir: Vec<PathBuf> = fs::read_dir(src.join("jobs"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .collect();
    dir.sort();
    files.extend(dir);
    files
}

#[test]
fn no_two_jobs_record_kinds_share_a_sub_tag() {
    let mut owners: BTreeMap<u8, Vec<String>> = BTreeMap::new();
    for file in jobs_sources() {
        let label = file.file_name().unwrap().to_string_lossy().to_string();
        for (name, value) in sub_tags(&file) {
            owners
                .entry(value)
                .or_default()
                .push(format!("{label}:{name}"));
        }
    }
    assert!(
        owners.len() > 20,
        "the scan found the jobs sub-tags: {owners:?}"
    );
    let shared: Vec<_> = owners.iter().filter(|(_, v)| v.len() > 1).collect();
    assert!(
        shared.is_empty(),
        "jobs sub-tags declared more than once: {shared:?}"
    );
}

#[test]
fn the_credential_sub_tags_belong_to_their_files_only() {
    let mut found: BTreeMap<u8, Vec<String>> = BTreeMap::new();
    for file in jobs_sources() {
        let label = file.file_name().unwrap().to_string_lossy().to_string();
        for (name, value) in sub_tags(&file) {
            if value == 0x2A || value == 0x2B {
                found
                    .entry(value)
                    .or_default()
                    .push(format!("{label}:{name}"));
            }
        }
    }
    assert_eq!(
        found.get(&0x2A),
        Some(&vec!["oauth_clients.rs:CLIENT".to_string()])
    );
    assert_eq!(
        found.get(&0x2B),
        Some(&vec!["access_tokens.rs:TOKEN".to_string()])
    );
}

#[test]
fn no_two_families_share_a_family_tag() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/keys.rs");
    let text = fs::read_to_string(path).unwrap();
    let mut owners: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("pub const ") else {
            continue;
        };
        let Some((name, value)) = rest.split_once(": u8 = ") else {
            continue;
        };
        owners
            .entry(value.trim_end_matches(';').to_string())
            .or_default()
            .push(name.to_string());
    }
    assert!(
        owners.values().any(|v| v == &vec!["JOBS".to_string()]),
        "JOBS has its own family tag: {owners:?}"
    );
    let shared: Vec<_> = owners.iter().filter(|(_, v)| v.len() > 1).collect();
    assert!(
        shared.is_empty(),
        "family tags declared more than once: {shared:?}"
    );
}
