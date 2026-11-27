---
important: security
---
**Admin credentials that lose their sources stop getting other people's job wake-ups, a NUL byte can no longer hide a secret in an uploaded page, no fact writer can knock an approved standing rule out of the rules section, and a brain host resuming someone's correction finishes and confirms it in one step.**

### Fixed
- Job wake-ups for the brain owner's admin credential check its source grant at delivery, the way a request does. A token whose write source was archived, a token narrowed to no source, or an OAuth client given the explicit no-source grant now ends its watch with `job_not_visible` instead of reporting another submitter's job. (GST-4045)
- `secrets.on_write` screens a chunked upload (`commit_page_upload`) with NUL bytes removed too, the way the page is stored. A token split by NUL bytes, even across upload parts, is refused under `block` and `redact`, and the upload is discarded. (GST-4042)
- No fact writer saves a fact onto a standing rule page, whether the fact names the rule page or a retired page that points at one. `extract_facts`, the automatic facts pipeline and subject inference keep such a fact with no entity; single-fact and fence writes, the write preparers and held-fact moves refuse (`rule_owner_only`) or leave the fact held. Before, any of them could change the rule page's revision and silently drop an approved rule from the standing-rules section. (GST-4027)
- `gbrain correct resume` on the brain host, for a correction your remote session started, now asks for the code once for the whole correction, fact change included, and confirms the rule, so no second `gbrain rules approve` is needed. It checks the fact step against the write journal instead of trusting the receipt, and a replacement of a private fact on your own memory page is saved on that page instead of stopping `partial`. (GST-4031)
- A correction step whose write ended failed, cancelled or in a conflict is sent again under a new request id, so resuming no longer replays the old failure forever. (GST-4031)
- An approval refuses a replacement whose fact was on no page when it was proposed but has since been linked to one, instead of saving the new fact on that page. (GST-4031)
- A correction whose first rule write the caller cannot make (a member limited to labelled pages proposing a team rule, for example) fails the call and leaves no receipt, instead of a stuck one that used up the connection's waiting-corrections cap. (GST-4031)
- A call carrying a guest attribution can no longer read or resume a member audience's correction receipt. (GST-4031)
- A shared credential acting for the brain owner saves the owner's `scope: me` rule private to the owner, so it loads on the brain host once approved. (GST-4031)
- On a keyless solo brain with no owner set and no members, an agent's `correct` with the default `scope: me` saves a private proposal for you to approve again, instead of refusing with `invalid_params`. A brain with members or an owner still refuses a member-less `me` rule. (GST-4031)
