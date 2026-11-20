# When someone leaves: hand over their pages

When a teammate leaves a company brain, switch their member off and give the pages they kept to themselves to
someone who still reads them. Without this step, a page whose `readable_by` names only the leaver is read by no
member: it stays on the brain, the owner still reads it on the brain host, and no teammate's key can find it.

```bash
gbrain access member disable bob-example           # their keys stop working on the next request
gbrain access member handover bob-example           # preview: writes nothing
gbrain access member handover bob-example --yes --expect <plan_hash>
```

It works the same on a brain with no Git repository (labels and rules are written to the database) and on a Git-backed
source (page files and `.gbrain/access.yml` are committed through the usual writers).

## What the preview shows

Every page that names the leaver, directly or through a group, is put in one group:

| Group | What it holds | Default |
|---|---|---|
| `kept` | pages no other enabled member, live group or the owner reads | given to the owner |
| `folder` | folder rules whose readers name only the leaver, and the leaver-only pages under them | given to the owner |
| `shared` | pages someone else reads too (a call with two attendees, a team page) | left as they are |
| `source` | personal sources bound to the leaver | left as they are |
| `memory` | the leaver's member page (`memory/members/<id>`) and its facts | listed only, never changed |

The preview also lists the members who gain and lose access, the owner's gains, the leaver's bound credentials and
groups, and a `plan_hash`. Opening pages to every reader of the source is never a default.

## Choosing a different target

`--set <group>=<choice>`, once per group:

- `--set kept=alice-example` gives the kept pages to alice-example and the owner.
- `--set folder=everyone` removes the leaver's folder rule, so the pages under it read like any other page.
- `--set kept=keep` or `--set folder=keep` leaves that group as it is.
- `--set shared=drop` removes the leaver from each shared page's list; every other reader stays.
- `--set source=alice-example` binds the leaver's personal sources to alice-example instead.

A member target must be an enabled person, not an audience member, and not the leaver.

## Apply, resume and status

`--yes --expect <plan_hash>` writes exactly the items the preview showed. Each item is checked again first: a page
that changed since the preview is skipped and listed, and the rest are written. The run is recorded as a handover
(`ho-…`, in the `access_handovers` table) with every item's old and new readers.

- A run that skipped or failed an item exits 1 with `handover_partial`. Run the same command again: it resumes, and
  items already written count as done.
- On a Git-backed source the page files are committed in the background. The handover reads `publishing` until they
  are; `gbrain access member handover --status <id>` settles it to `applied` (or `partial`).

## Undo

Once the member is enabled again (`gbrain access member enable bob-example`):

```bash
gbrain access member handover bob-example --undo <handover id>             # preview
gbrain access member handover bob-example --undo <handover id> --yes --expect <plan_hash>
```

Undo puts back each page's and rule's recorded readers and reverses rebinds. A page edited since the handover keeps
its current readers and is counted as skipped. A handover can be undone once. A removed member's handover cannot be
undone, because removed ids are never reused.

## Finding pages no member reads

`gbrain doctor` runs `access_pages_read_by_nobody`. It lists pages no enabled member reads remotely: a leaver's own
pages, a page that names only a group whose members are all off, and a page written before its folder's rule named
other readers. It names the handover command when the pages name a disabled or removed member.

## Refusals

Every refusal writes nothing and carries the command that fixes it.

| Code | When | Fix |
|---|---|---|
| `handover_member_enabled` | the leaver is still enabled | `gbrain access member disable <id>`, then preview |
| `handover_owner_unset` | a group goes to the owner and no owner is set | `gbrain access owner set <member>`, or `--set kept=<member>` |
| `handover_rules_held` | a source the handover changes has a rule change waiting for approval | `gbrain access apply --source <id>`, then preview again |
| `handover_partial` | items were skipped or failed (exit 1) | run the same apply command; it resumes |
| `handover_undo_member_disabled` | undo while the member is disabled or removed | `gbrain access member enable <id>`, then preview the undo |
| `preview_changed` | the approved preview expired or its items moved | preview again |
| `access_member_invalid` | a target is unknown, off, an audience member, or the leaver | pick an enabled person |

## Related

- [Access designations](access-designations.md): who reads what.
- [Company brain](../tutorials/company-brain.md): members, groups and `readable_by`.
