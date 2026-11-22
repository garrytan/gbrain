//! A minimal owner socket: the design for a second process (decision D20). One process owns the
//! store; any other process is a client over a Unix socket and never opens the store files, so it
//! never meets a lock, a busy error or a refused open. This is the smallest version that can be
//! measured: framed requests (u32 length + payload), thread per connection, three operations.
//!
//! Request payload: op byte, then
//!   1 GET_PAGE  source (u32 len + bytes), slug (u32 len + bytes)
//!   2 PUT_PAGE  encoded page (u32 len + bytes; id 0 = owner allocates), chunk count u32,
//!               then per chunk: idx u32, encoded chunk (u32 len + bytes)
//!   3 PING
//! Response payload: status byte (0 ok, 1 not found, 2 error), then the body
//! (GET_PAGE: encoded page; PUT_PAGE: commit version u64 + page id u64; error: message).

use crate::records::*;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

const OP_GET_PAGE: u8 = 1;
const OP_PUT_PAGE: u8 = 2;
const OP_PING: u8 = 3;

fn write_frame(s: &mut UnixStream, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(4 + payload.len());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    s.write_all(&buf)
}

fn read_frame(s: &mut UnixStream) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match s.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut buf = vec![0u8; u32::from_le_bytes(len) as usize];
    s.read_exact(&mut buf)?;
    Ok(Some(buf))
}

fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&(b.len() as u32).to_le_bytes());
    out.extend_from_slice(b);
}

struct Cursor<'a>(&'a [u8]);
impl<'a> Cursor<'a> {
    fn u32(&mut self) -> Option<u32> {
        let (h, t) = self.0.split_first_chunk::<4>()?;
        self.0 = t;
        Some(u32::from_le_bytes(*h))
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let n = self.u32()? as usize;
        if self.0.len() < n {
            return None;
        }
        let (h, t) = self.0.split_at(n);
        self.0 = t;
        Some(h)
    }
}

fn handle(records: &Records, req: &[u8]) -> Vec<u8> {
    let err = |m: String| {
        let mut r = vec![2u8];
        r.extend_from_slice(m.as_bytes());
        r
    };
    let Some((&op, body)) = req.split_first() else {
        return err("empty request".into());
    };
    let mut c = Cursor(body);
    match op {
        OP_PING => vec![0],
        OP_GET_PAGE => {
            let (Some(source), Some(slug)) = (c.bytes(), c.bytes()) else {
                return err("bad GET_PAGE".into());
            };
            let (Ok(source), Ok(slug)) = (std::str::from_utf8(source), std::str::from_utf8(slug))
            else {
                return err("not utf-8".into());
            };
            match records.get_page(source, slug) {
                Ok(Some(p)) => {
                    let mut r = vec![0u8];
                    r.extend_from_slice(&encode_page(&p));
                    r
                }
                Ok(None) => vec![1],
                Err(e) => err(e.to_string()),
            }
        }
        OP_PUT_PAGE => {
            let parsed = (|| -> Option<(Page, Vec<Chunk>)> {
                let mut page = decode_page(c.bytes()?).ok()?;
                let n = c.u32()?;
                let mut chunks = Vec::new();
                for _ in 0..n {
                    let idx = c.u32()?;
                    chunks.push(decode_chunk(idx, c.bytes()?).ok()?);
                }
                if page.id == 0 {
                    page.id = records.alloc_page_id();
                }
                Some((page, chunks))
            })();
            let Some((page, chunks)) = parsed else {
                return err("bad PUT_PAGE".into());
            };
            match records.put_page_with_chunks(&page, &chunks) {
                Ok(v) => {
                    let mut r = vec![0u8];
                    r.extend_from_slice(&v.to_le_bytes());
                    r.extend_from_slice(&page.id.to_le_bytes());
                    r
                }
                Err(e) => err(e.to_string()),
            }
        }
        _ => err(format!("unknown op {op}")),
    }
}

pub struct OwnerServer {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    path: PathBuf,
}

impl OwnerServer {
    pub fn start(records: Arc<Records>, path: &Path) -> std::io::Result<OwnerServer> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        listener.set_nonblocking(true)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stop2.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let records = records.clone();
                        std::thread::spawn(move || {
                            while let Ok(Some(req)) = read_frame(&mut stream) {
                                let resp = handle(&records, &req);
                                if write_frame(&mut stream, &resp).is_err() {
                                    break;
                                }
                            }
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(OwnerServer {
            stop,
            thread: Some(thread),
            path: path.to_path_buf(),
        })
    }
}

impl Drop for OwnerServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

pub struct OwnerClient {
    s: UnixStream,
}

impl OwnerClient {
    pub fn connect(path: &Path) -> std::io::Result<Self> {
        Ok(Self {
            s: UnixStream::connect(path)?,
        })
    }

    fn call(&mut self, req: &[u8]) -> Result<Vec<u8>, String> {
        write_frame(&mut self.s, req).map_err(|e| e.to_string())?;
        let resp = read_frame(&mut self.s)
            .map_err(|e| e.to_string())?
            .ok_or("owner closed the connection")?;
        match resp.first() {
            Some(2) => Err(String::from_utf8_lossy(&resp[1..]).into_owned()),
            Some(_) => Ok(resp),
            None => Err("empty response".into()),
        }
    }

    pub fn ping(&mut self) -> Result<(), String> {
        self.call(&[OP_PING]).map(|_| ())
    }

    pub fn get_page(&mut self, source: &str, slug: &str) -> Result<Option<Page>, String> {
        let mut req = vec![OP_GET_PAGE];
        put_bytes(&mut req, source.as_bytes());
        put_bytes(&mut req, slug.as_bytes());
        let resp = self.call(&req)?;
        if resp[0] == 1 {
            return Ok(None);
        }
        decode_page(&resp[1..]).map(Some).map_err(|e| e.to_string())
    }

    /// Returns (commit version, page id).
    pub fn put_page(&mut self, page: &Page, chunks: &[Chunk]) -> Result<(u64, u64), String> {
        let mut req = vec![OP_PUT_PAGE];
        put_bytes(&mut req, &encode_page(page));
        req.extend_from_slice(&(chunks.len() as u32).to_le_bytes());
        for c in chunks {
            req.extend_from_slice(&c.idx.to_le_bytes());
            put_bytes(&mut req, &encode_chunk(c));
        }
        let resp = self.call(&req)?;
        if resp.len() != 17 {
            return Err("bad PUT_PAGE response".into());
        }
        Ok((
            u64::from_le_bytes(resp[1..9].try_into().unwrap()),
            u64::from_le_bytes(resp[9..17].try_into().unwrap()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mem_store::MemStore;
    use crate::occ::{Db, Options};

    #[test]
    fn a_client_process_style_connection_reads_and_writes_through_the_owner() {
        let db = Arc::new(Db::open(Arc::new(MemStore::new()), Options::default()).unwrap());
        let records = Arc::new(Records::open(db).unwrap());
        let path = crate::contract_tests::test_dir("owner").join("o.sock");
        let server = OwnerServer::start(records.clone(), &path).unwrap();
        let mut c = OwnerClient::connect(&path).unwrap();
        c.ping().unwrap();
        let page = Page {
            id: 0,
            source_id: "s".into(),
            slug: "a".into(),
            page_type: "note".into(),
            title: "A".into(),
            frontmatter: "{}".into(),
            body: "hello".into(),
            chunk_count: 0,
        };
        let chunk = Chunk {
            idx: 0,
            text: "t".into(),
            vector: vec![0.5; 8],
        };
        let (version, id) = c.put_page(&page, std::slice::from_ref(&chunk)).unwrap();
        assert!(version >= 1 && id >= 1);
        let got = c.get_page("s", "a").unwrap().unwrap();
        assert_eq!((got.body.as_str(), got.id), ("hello", id));
        assert_eq!(c.get_page("s", "missing").unwrap(), None);
        assert_eq!(records.get_chunks(id).unwrap(), vec![chunk]);
        drop(server);
    }
}
