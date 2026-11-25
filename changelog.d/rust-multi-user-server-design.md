**A design note explains how the Rust engine can later serve many users and machines, and what small pieces can be built early.**

### Documentation
- `docs/designs/rust-engine/multi-user-server.md` describes three later steps for the Rust engine. First, one server process that many clients call. Next, per-user access that the server checks. Last, writers on several machines. It covers the conflict rules, the write journal and store format changes, and how a follower could read a commit log.
- It audits the Rust engine code that is in gbrain today and lists each place that assumes one writer or one owning process, with what it would cost to change later and a cheap step now.
- It ranks small groundwork items that stay off by default and change no output, and it outlines the multi-writer tests to write now. Nothing changes for any user.
