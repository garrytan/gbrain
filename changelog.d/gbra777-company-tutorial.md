**The company brain tutorial now shows how setup labels a team in one run and how doctor spots access that no longer reaches anyone.**

### Documentation
- The company brain tutorial walks through `gbrain setup <harness> --serves several`: choosing `--labelled-only` or `--open-history` before setup opens your own history to members, how `--owner` names the brain owner, and which sources the member keys it makes can read.
- It says that `gbrain auth create --member` without `--scopes` makes a read and write key, with `--scopes read,write,admin` for a key that needs admin.
- Operating the brain now covers the doctor checks `access_shared_source_unread` and `access_disabled_member_credentials`, and what to do with a leaver's live keys.
- A new common-gotcha entry explains why a brain kept keyless on purpose reports keyword-only search instead of a degraded one, and how to turn embeddings on later.
