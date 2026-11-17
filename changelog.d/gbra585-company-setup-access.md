**`gbrain setup --serves several` now makes a company brain that is safe to share: it names an owner, gives each member a key that reads the company pages, and asks before it shares a personal brain's history.**

<!-- behavior-change: setup_names_owner_gbra585 -->
<!-- behavior-change: auth_create_member_read_write_gbra585 -->
<!-- behavior-change: setup_member_keys_read_company_gbra585 -->
<!-- behavior-change: setup_history_choice_gbra585 -->
<!-- behavior-change: serves_labelled_only_needs_owner_gbra585 -->

### Changed
- `gbrain setup <harness> --serves several` names the brain owner when the brain has none: `--owner <id>`, or by default your login name as a member id. The preview shows it first, an owner already set is kept, and the receipt lists each live key or OAuth client bound to no member with the `gbrain auth rescope` command that binds it.
- Member keys that setup mints read a fixed list of sources. The list holds the run's source, the `company` source when it exists, and every source federated at mint time. Members read the company pages and imported calls without federating `company`. A setup re-run adds sources to such a key and never removes one; keys minted before this release are not changed.
- `gbrain auth create <name> --member <id>` without `--scopes` mints a key with read and write only, not admin. Pass `--scopes read,write,admin` for the old full access.
- On a brain that serves one person and already holds pages no rule restricts (a journal, DMs, chat, mail, the conversation archive), `--serves several` refuses with `setup_history_choice_required` and writes nothing. It names how many pages members would read and suggests two commands: `--labelled-only` keeps that history private, and `--open-history` lets every member read it. It also refuses when it cannot count those pages. The suggested `--labelled-only` command leaves out the brain's owner, who reads the whole brain, and pins `--owner`.

### Added
- `--open-history` on `gbrain setup`. On a brain with the company source, a `--labelled-only` run adds one folder rule, `company/` in source `company`, readable by the owner and the members, so they still read the company pages. A re-run adds new members to that rule and waits for `gbrain access apply`, because it widens the rule.
- The layout's readers line now names who actually reads imported calls on a shared brain.
