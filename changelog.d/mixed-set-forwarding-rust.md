**On a Rust-engine brain, a list of readers or folder rules that holds one invalid entry now reads as empty, the same as on PGLite and Postgres.**

### Fixed
- Two access reads of the Rust engine (the page checks behind `gbrain access who-can-read`) and the page read a remote write makes before rewriting links passed such a list to the store as given. The store then matched the valid entries one by one and could show a page that PGLite and Postgres hide. They now send the store the list the SQL engines use: the whole list is emptied when any entry is invalid.
- Nothing in gbrain can build such a list today, because member and group ids are checked when they are written, so no brain was affected. This closes the gap before anything can.

### Known gap
- A writer whose single identity holds an invalid entry beside valid folder rules is refused on a Rust-engine brain with `engine_capability_missing` instead of being answered. No stored writer can hold such a combination.
