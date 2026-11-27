**On the experimental Rust engine, a vector search no longer opens every page of the brain: at 50,000 pages one search takes about 29 ms instead of about 890 ms, with the same results.**

### Fixed
- `searchVector` on a Rust brain read and decoded every page and every chunk on every call, so its time grew with the brain (165 ms at 10,000 pages, 887 ms at 50,000 on 8 vCPU). It now scores the cached vectors first, on all cores, and opens only the pages whose best possible score can still reach the results: 8.6 ms and 28.5 ms. The rows, scores, tie order and filters are the ones the full scan returns; the full scan still answers when stored vectors have more than one width or a source boost is not a finite number. PGLite and Postgres are unchanged.

### Added
- `rust/bench/vector-scan.sh` measures one Rust vector search on an invented 10,000- and 50,000-page brain, before and after, and checks that both paths return the same bytes.
