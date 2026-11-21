**On the Rust engine, `gbrain access member rm` removes the member and ends its Wakeshift watches, as on PGLite.**

### Fixed
- On a brain with the Rust engine, `gbrain access member rm` no longer refuses: it removes the member, ends the member's open Wakeshift watches, queues a Wakeshift forget for each user it watched under and drops its terms acceptance, in one write, with the same results as PGLite.
