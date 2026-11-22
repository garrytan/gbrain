**On the Rust engine, a token or OAuth client can be bound to an access member, and it reads as that member.**

### Fixed
- On a brain with the Rust engine, `gbrain access member add --bind-token`, `gbrain auth rescope --client <id> --member` and `--may-act-for` (the `--token <name>` and bare-name forms still stop on Rust, row 32k), `gbrain access owner set` and the member credential lists give the same answers as PGLite instead of refusing. A token or client bound to a member reads as that member, labelled-only grant included, and as nobody once the member is disabled or removed or the credential is revoked or deleted.
- On the Rust engine, `gbrain access member rm` refuses before it writes anything, with a typed error, instead of removing the member while its Wakeshift forget fails silently.
- On the Rust engine, `gbrain auth list` and the open-page count of `gbrain access serves` refuse with a typed error once the brain holds a token, instead of listing no tokens and leaving member keys out of the count.
