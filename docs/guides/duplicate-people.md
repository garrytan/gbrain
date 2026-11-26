# Duplicate people: counting the evidence

The same person often has two or three pages: a contact from Google or Apple Contacts, a page in each source, a stray
spelling. `gbrain dedupe classes` looks at every pair of person pages that might be one person and counts them by the
evidence for and against. `gbrain dedupe sample` picks a random set of pairs from one class so someone can check them
by hand. Both only read: nothing is linked, edited or removed. `gbrain dedupe auto` links or collapses the pairs of
the classes that passed such a check ([Automatic links](#automatic-links)).

## Which pairs are looked at

A pair is two person pages with the same or a close name, a shared email address or phone number, or a shared account
id (LinkedIn, GitHub or an id your schema declares). Pairs you already linked, pairs you marked as different people
with `gbrain dedupe reject` or `gbrain dedupe decide`, and names shared by more than 10 pages are left out and counted.
Google Contacts that match two or more people are decided one by one with `gbrain dedupe decide`
([Google connect](google-connect.md#decide-the-contacts-that-wait)).

A page kept under the same slug in two sources, with the same name and no company, role, email or phone that
disagrees, is one page copied, not a duplicate: the pair is left out and counted as a mirror copy. When a third page
pairs with each copy, only one of those pairs is kept, the one with the most pages in the default source; when the
pages it pairs with are not copies of each other (different emails, say), every pair is kept.

## The classes

| Class | What it means | What would happen |
|---|---|---|
| C1 | an email or phone only these two person pages hold, names agree | link |
| C2 | the same, but the names disagree (usually a handle or a contact card beside a page) | link with `gbrain dedupe auto` when the names differ only in form |
| C3 | an account id both hold, names agree | link |
| C4 | same full name and company, two or more pages that link both, no other page of that name | wait (counted first) |
| C5 | the names agree and nothing else is shared | wait, likeliest first |
| C6 | a contradiction: different account ids, a role mailbox like team@, a value a third page also holds, or an id that a page with another name also holds (ids copied between cofounders' pages) | wait |
| C7 | two pages in one source with the same name and a shared id | collapse into one with `gbrain dedupe auto` |
| M1 | a chat handle (phone or email) only one person page holds belongs, in your chats, to someone with the other page's name | link |
| X1 | a web search for each page, with a different clue, finds the same profile | link |
| X2 | the web searches find two different profiles | marked probably different |
| C5+email+messaging, C5+email+C4, C5+messaging+C4 | a name-only pair with two independent kinds of evidence | link |

A pair can be in more than one class. "What would happen" is what the evidence says; only the classes listed under
[Automatic links](#automatic-links) are linked or collapsed without you.

## How the evidence combines

A pair would link only on one id that just one person holds (C1, C3, M1, X1) with the names agreeing, or on two strong
signals of different kinds with the names agreeing. The strong kinds are your email (E1: one thread has an address
of each page, each under a name that matches its page; E4: an email that links one page was sent from the other page's
address), your chats (M3: a chat ties one page's phone or email to the other page's name), and company plus shared
history (C4). Weaker signals only change the order of the waiting list: E3 (the two addresses write to largely the
same people) and M2 (a chat name matches the page). Anything that contradicts waits, and a page marked family
(`relationship`, a `family` tag or group) or about someone under 18 (`minor: true`, an age, a birth date or a birth
year; a year alone counts through the year of the 18th birthday) never links on its own. For that hold, each
relationship value is read on its own, and a label or value that is only someone else's relative doesn't count: a
family office, family friends, "wife of a colleague", "a friend's son" or a school parent. Any other owner keeps the
hold ("mother of Emma" may be your own child), and so does one own family word beside someone else's ("spouse" next
to "sister of a colleague"). Web search still leaves all of them out. A page whose title reads as a room,
a team, a shared mailbox or a business (`Team`, `Room`, `Partners`, `Inc` and similar words) never links on its own
either.

## Email and chat evidence

Email evidence comes from the email pages already in your brain (`type: email`, with `from`, `to`, `cc` and
`participants`). Chat evidence comes from iMessage day pages (`type: imessage`) and chat exports under a
`conversations/` folder (WhatsApp and the other layouts gbrain's conversation parser reads). Both are read on your
machine and sent nowhere. A brain with no email or chat pages works the same, with fewer signals. gbrain has no Signal
reader, so Signal chats add nothing. A role or team address turns email evidence off for that pair.

A large chat page stored in segments (one over 1 MiB) is read whole up to 24 MiB. A bigger one, or one that can't be
read as one body, is set aside: its chat adds no evidence, the run carries on, and the output lists it on its own line
(`messaging.segmented_page` in `--json`, with `read`, `set_aside` and the `pages`). Reading only part of a chat could
hide speakers and make a group chat look one-to-one, so a part is never used.

## Web search (Exa)

Web search is off unless you set `EXA_API_KEY` and turn it on with `gbrain config set dedupe.exa on`. When it is
on, for pairs that would otherwise wait, Exa (a paid web search service) receives each page's name and one work clue.
The usual company or job title comes first. If both are missing, GBrain checks the frontmatter fields
`current_company`, `org`, `affiliation`, `works_at` and `headline` in that order. Next it tries `domain` and `website`,
using only the company label (for example, `acme-example` from `acme-example.com`). It accepts bare company sites
under common suffixes, with optional `www`, and skips email providers and sites with a path, query or fragment.
Finally it can use the title of a single unrestricted company from the person's `works_at` links.

The query never includes email addresses, phone numbers, page text, notes or link context. Pages that not every
reader may read (because of a privacy label such as `confidentiality: secret`, named readers, a folder rule or an
owner-only source), family pages and pages about minors are never searched.

```bash
gbrain dedupe classes --exa --dry-run   # how many searches, what they would cost; sends nothing
gbrain config set dedupe.exa on
gbrain dedupe classes --exa             # searches, within the caps
```

Each search costs $0.004 (Exa's Lite search). Every answer is kept in the brain, so the same search is never paid for
twice. A run stops at `dedupe.exa_run_cap` searches (default 2,000) or when the next search could pass
`dedupe.exa_total_cap_usd` in total (default $25), priced at the dearest search seen so far in the run, so one search
can go over by at most its own price; `dedupe.exa_spent_usd` holds what has been spent, and a search that failed after
it was sent counts as spent. Only one live run goes at a time: a second one sends nothing and reports `busy`. Each page
and any company supplying its clue are checked again just before the search goes out. If a page becomes private or
the query changes during a run, the original search is dropped, not sent.

## Sampling a class

```bash
gbrain dedupe sample --class C1 --n 100 --seed 1 --json
```

The same seed on the same brain gives the same sample. A class with fewer pairs than `--n` is sampled whole. Label each
pair same, different or unsure; a class with more than 2 wrong in 100 stays manual.

## Automatic links

`gbrain dedupe auto` lists the pairs it would join and changes nothing; `gbrain dedupe auto --apply` joins them. It
joins only classes that passed a labelled sample, today C2 and C7:

- **C2 is linked.** An email or phone that only these two person pages hold, in two sources, with names that differ only
  in form (a one-word handle or card label beside a name). Two full names that disagree are held, and so are a title
  with a digit in it and a one-word title that is a common first name, since those read as a different person as often
  as a handle.
- **C7 is collapsed.** Two person pages in one source with the same name and a shared id, email or phone are one page
  kept twice. The newer page gets `merged_into: <the older page's slug>` and a `dedupe_collapse` record; the older
  page gets the newer one's title and aliases in `aliases`. Lookups, links, search and mentions follow `merged_into`,
  and the newer page keeps its body: nothing is deleted or renamed. With a repository, both files change in one commit
  (its parent is the backup); without one, both pages are edited through the page history (`gbrain revert` works too).
  A read-only source (a mirror or a URL clone) and a file with edits not committed yet are left out.

Auto leaves out a pair with a family, minor or non-person page or a page not every reader may read (private
visibility, named readers, a privacy label, a folder rule or an owner-only source, with or without a repository), a
pair with any contradiction (including two different profiles from web searches already cached; auto sends no search),
a pair whose page is in another pair it would join (in any source, whatever `--source` names), and a pair whose page is
already in an identity group, so a third page never joins two joined ones on a second signal. A phone number with an
extension counts as its own number, and a page that names the other in `distinct_from` keeps the pair apart in any
source.

Each link is a "same" decision, recorded like your own `gbrain dedupe confirm` (in git when the brain has a
repository, in the database otherwise) with `decided_by: dedupe:auto:<class>`. Each write checks again first, so a
plan you previewed never writes over a reject, an `--off` or a page edit that landed after it. So:

- `gbrain dedupe reject <identity id or collapse id>` takes back one link or collapse and marks the pair as different
  people for good, even after a page is renamed or moved; the reject is recorded as a correction of the class;
- `gbrain dedupe undo <decision or collapse id>` takes back one without a verdict (the next `--apply` can do it again);
- `gbrain dedupe auto --off <class>` stops a class and takes back everything it did; `--on <class>` starts it again;
- `gbrain doctor` prints the last 24 hours of automatic links and collapses by class, with the reject commands
  (`dedupe_auto_links`).

Check each class weekly: `gbrain dedupe sample --class C2 --since 7d --n 20 --json` picks 20 of the links it made in
the last week, each with the reject command that keeps it apart if it is wrong, and counts the ones you already
corrected. More than one wrong in 20 means switching the class off.
