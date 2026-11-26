"""Minimal iCloud Mail capture proof. Python standard library only."""

import argparse
import hashlib
import imaplib
import json
import os
import re
import sqlite3
import ssl
from contextlib import closing
from email import policy
from email.parser import BytesParser
from pathlib import Path
from tempfile import NamedTemporaryFile

APPLE_IMAP = ("imap.mail.me.com", 993)
MAX_MESSAGE_BYTES = 256 * 1024
MAX_MESSAGES_PER_MAILBOX = 25
MAX_UID_SPAN = 4096
MAX_UID = 2**32 - 1
MESSAGE_ID = re.compile(r"<[^<>\s@]+@[^<>\s@]+>", re.ASCII)

SCHEMA = """
CREATE TABLE IF NOT EXISTS scope (binding TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursor (
    mailbox TEXT PRIMARY KEY, generation INTEGER NOT NULL, high_uid INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY, digest TEXT NOT NULL, thread_id TEXT NOT NULL,
    subject TEXT NOT NULL, sender TEXT NOT NULL, sent_date TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_thread ON message (thread_id);
CREATE TABLE IF NOT EXISTS observation (
    mailbox TEXT NOT NULL, generation INTEGER NOT NULL, uid INTEGER NOT NULL,
    message_id TEXT NOT NULL, PRIMARY KEY (mailbox, generation, uid)
);
CREATE TABLE IF NOT EXISTS message_hold (
    mailbox TEXT NOT NULL, generation INTEGER NOT NULL, uid INTEGER NOT NULL,
    reason TEXT NOT NULL, PRIMARY KEY (mailbox, generation, uid)
);
"""


class CaptureError(Exception):
    """A safe reason to stop before advancing a provider cursor."""


class MessageHold(Exception):
    """A confirmed message that cannot be admitted by this reader."""


def require(condition, reason):
    if not condition:
        raise CaptureError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def mailbox_argument(name):
    require(bool(name) and all(" " <= char <= "~" for char in name),
            "mailbox name outside the printable ASCII proof scope")
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def imap_number(value, *, minimum=1):
    require(isinstance(value, bytes) and re.fullmatch(rb"[0-9]{1,10}", value),
            "invalid IMAP numeric response")
    number = int(value)
    require(minimum <= number <= MAX_UID, "invalid IMAP numeric response")
    return number


def select_readonly(client, mailbox):
    status, _ = client.select(mailbox_argument(mailbox), readonly=True)
    require(status == "OK", "EXAMINE failed")
    _, read_only = client.response("READ-ONLY")
    _, read_write = client.response("READ-WRITE")
    require(read_only != [None] and read_write == [None], "mailbox is not read-only")
    _, generation = client.response("UIDVALIDITY")
    _, next_uid = client.response("UIDNEXT")
    require(len(generation) == len(next_uid) == 1, "ambiguous mailbox cursor")
    return imap_number(generation[0]), imap_number(next_uid[0])


def discover_uids(client, lower, upper):
    status, data = client.uid("SEARCH", "UID", f"{lower}:{upper}")
    require(status == "OK" and len(data) == 1 and isinstance(data[0], bytes),
            "UID SEARCH failed")
    uids = [imap_number(value) for value in data[0].split()]
    require(len(uids) == len(set(uids)) and all(lower <= uid <= upper for uid in uids),
            "UID SEARCH returned UIDs outside its exact range")
    return sorted(uids)


def fetch_message(client, uid):
    # Partial PEEK bounds transfer and avoids setting the Seen flag. Verify
    # the exact response before deciding whether this message is oversized.
    request = f"(UID RFC822.SIZE BODY.PEEK[]<0.{MAX_MESSAGE_BYTES}>)"
    status, data = client.uid("FETCH", str(uid), request)
    require(status == "OK" and len(data) == 2 and isinstance(data[0], tuple)
            and isinstance(data[1], bytes), "UID FETCH missing or ambiguous")
    meta, raw = data[0]
    require(isinstance(meta, bytes) and isinstance(raw, bytes),
            "UID FETCH returned an invalid literal")
    outer = re.fullmatch(rb"[0-9]+ \((.*)\)", meta + data[1])
    require(outer, "UID FETCH literal metadata is unsupported")
    tokens = outer.group(1).split()
    require(len(tokens) == 6, "UID FETCH literal metadata is unsupported")
    attributes = dict(zip(tokens[::2], tokens[1::2]))
    require(attributes.keys() == {b"UID", b"RFC822.SIZE", b"BODY[]<0>"}
            and imap_number(attributes[b"UID"]) == uid,
            "UID FETCH returned the wrong message")
    literal = re.fullmatch(rb"\{([0-9]{1,10})\}", attributes[b"BODY[]<0>"])
    size = imap_number(attributes[b"RFC822.SIZE"], minimum=0)
    require(literal and len(raw) == imap_number(literal.group(1), minimum=0) == min(size, MAX_MESSAGE_BYTES),
            "UID FETCH returned an incomplete or inconsistent body")
    if size > MAX_MESSAGE_BYTES:
        raise MessageHold("size-limit")
    return raw


def parse_message(raw):
    try:
        parsed = BytesParser(policy=policy.default).parsebytes(raw)
        message_ids = parsed.get_all("Message-ID", [])
        message_id = str(message_ids[0]).strip() if len(message_ids) == 1 else ""
        if not MESSAGE_ID.fullmatch(message_id):
            raise MessageHold("message-id-unusable")
        # Direct parent first, then nearest known References ancestor.
        parents = MESSAGE_ID.findall(str(parsed.get("In-Reply-To", "")))
        parents += list(reversed(MESSAGE_ID.findall(str(parsed.get("References", "")))))
        part = parsed.get_body(preferencelist=("plain",))
        if part is None:
            raise MessageHold("plain-text-missing")
        headers = (str(parsed.get("Subject", "(no subject)")), str(parsed.get("From", "")),
                   str(parsed.get("Date", "")))
        return message_id, parents, headers, part.get_content()
    except (LookupError, ValueError, TypeError, RecursionError) as error:
        raise MessageHold("mime-unreadable") from error


def store_message(db, mailbox, generation, uid, raw):
    message_id, parents, headers, body = parse_message(raw)
    raw_digest = digest(raw)
    known = db.execute("SELECT digest FROM message WHERE id = ?", (message_id,)).fetchone()
    if known:
        if known[0] != raw_digest:
            raise MessageHold("message-id-conflict")
    else:
        # An unknown parent starts a separate thread and never re-keys old pages.
        thread = message_id
        for parent in parents:
            known_parent = db.execute("SELECT thread_id FROM message WHERE id = ?", (parent,)).fetchone()
            if known_parent:
                thread = known_parent[0]
                break
        db.execute("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?)",
                   (message_id, raw_digest, thread, *headers, body))
    db.execute("INSERT INTO observation VALUES (?, ?, ?, ?)", (mailbox, generation, uid, message_id))


def capture(state, username, password, sent_mailbox, endpoint=APPLE_IMAP, ca_file=None):
    require(sent_mailbox.casefold() != "inbox", "Sent mailbox must differ from INBOX")
    for mailbox in ("INBOX", sent_mailbox):
        mailbox_argument(mailbox)
    require(bool(username) and bool(password), "credentials are required")
    require(re.fullmatch(r"[A-Za-z0-9@._+%-]+", username), "unsupported login name")
    binding = digest(json.dumps([1, endpoint, username, "INBOX", sent_mailbox]).encode())
    context = ssl.create_default_context(cafile=ca_file)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    with closing(sqlite3.connect(state, timeout=5)) as db, db:
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        pinned = db.execute("SELECT binding FROM scope").fetchone()
        require(pinned is None or pinned[0] == binding,
                "account, endpoint or folder selection differs from the ledger")
        if pinned is None:
            db.execute("INSERT INTO scope VALUES (?)", (binding,))
        collected = 0
        with imaplib.IMAP4_SSL(*endpoint, ssl_context=context, timeout=15) as client:
            client.login(username, password)
            for mailbox in ("INBOX", sent_mailbox):
                generation, next_uid = select_readonly(client, mailbox)
                saved = db.execute("SELECT generation, high_uid FROM cursor WHERE mailbox = ?",
                                   (mailbox,)).fetchone()
                high_uid = 0 if saved is None else saved[1]
                require(saved is None or saved[0] == generation, "UIDVALIDITY changed; stop for review")
                require(high_uid < next_uid, "UIDNEXT regressed; stop for review")
                if saved is not None and high_uid == next_uid - 1:
                    continue
                upper = min(high_uid + MAX_UID_SPAN, next_uid - 1)
                uids = discover_uids(client, high_uid + 1, upper) if high_uid < upper else []
                for uid in uids[:MAX_MESSAGES_PER_MAILBOX]:
                    try:
                        store_message(db, mailbox, generation, uid, fetch_message(client, uid))
                    except MessageHold as hold:
                        db.execute("INSERT INTO message_hold VALUES (?, ?, ?, ?)",
                                   (mailbox, generation, uid, str(hold)))
                    else:
                        collected += 1
                if len(uids) > MAX_MESSAGES_PER_MAILBOX:
                    upper = uids[MAX_MESSAGES_PER_MAILBOX - 1]
                db.execute("INSERT INTO cursor VALUES (?, ?, ?) ON CONFLICT (mailbox) "
                           "DO UPDATE SET high_uid = excluded.high_uid", (mailbox, generation, upper))
        return collected


def held_count(state):
    with closing(sqlite3.connect(state, timeout=5)) as db:
        return db.execute("SELECT COUNT(*) FROM message_hold").fetchone()[0]


def project(state, pages):
    """Replay the accepted ledger without contacting iCloud or rewriting equal files."""
    require(state.is_file(), "capture ledger does not exist")
    directory = pages / "emails"
    require(not pages.is_symlink() and not directory.is_symlink(), "unexpected source symlink")
    count = 0
    with closing(sqlite3.connect(state, timeout=5)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        directory.mkdir(parents=True, exist_ok=True)
        roots = db.execute("SELECT id, subject FROM message WHERE thread_id = id").fetchall()
        for thread_id, title in roots:
            stable_id = digest(thread_id.encode())
            # A plain YAML scalar in GBrain's canonical field order avoids
            # a format-only rewrite on import. Each full subject stays below.
            title_words = re.sub(r"[^a-zA-Z0-9 -]", " ", title)
            title_summary = " ".join(title_words.split())[:96].rstrip()
            page_title = f"iCloud Mail - {title_summary}" if title_summary else "iCloud Mail thread"
            parts = ["---", "type: email", f"title: {page_title}", "visibility: private",
                     "trust_tier: external_untrusted", f"id: icloud-thread-{stable_id}", "---",
                     "", "Archived email from an external sender or mailbox.", ""]
            messages = db.execute(
                "SELECT id, subject, sender, sent_date, body FROM message WHERE thread_id = ? ORDER BY rowid",
                (thread_id,),
            )
            for message_id, subject, sender, date, body in messages:
                parts.extend(("## Message", "", f"    Message-ID: {message_id}",
                              f"    Subject: {json.dumps(subject, ensure_ascii=False)}",
                              f"    From: {json.dumps(sender, ensure_ascii=False)}",
                              f"    Date: {json.dumps(date, ensure_ascii=False)}", "",
                              *(f"    {line}" for line in body.splitlines()), ""))
            path = directory / f"{stable_id}.md"
            require(not path.is_symlink(), "unexpected page symlink")
            content = "\n".join(parts).encode()
            if path.is_file() and path.read_bytes() == content:
                continue
            with NamedTemporaryFile(dir=directory, prefix=".icloud-", delete=False) as tmp:
                temporary_path = Path(tmp.name)
                try:
                    tmp.write(content)
                    tmp.flush()
                    os.fsync(tmp.fileno())
                    temporary_path.replace(path)
                finally:
                    temporary_path.unlink(missing_ok=True)
            count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="dedicated private working directory")
    action = parser.add_subparsers(dest="action", required=True)
    poll = action.add_parser("capture")
    poll.add_argument("--username", required=True)
    poll.add_argument("--sent-mailbox", required=True)
    action.add_parser("project")
    args = parser.parse_args()
    os.umask(0o077)
    state = args.root / "mail.sqlite"
    try:
        require(not args.root.is_symlink() and not state.is_symlink(), "unexpected workspace symlink")
        if args.action == "capture":
            args.root.mkdir(parents=True, exist_ok=True)
            captures = capture(state, args.username, os.environ.get("ICLOUD_MAIL_APP_PASSWORD", ""),
                               args.sent_mailbox)
            print(json.dumps({"captured_observations": captures, "held_observations": held_count(state)}))
        else:
            print(json.dumps({"projected_pages": project(state, args.root / "pages")}))
    except CaptureError as error:
        parser.exit(1, f"capture stopped: {error}\n")
    except (imaplib.IMAP4.error, OSError, sqlite3.Error, ValueError):
        # A server response or library error can include mailbox data. Give a
        # generic failure here and leave the provider transaction uncommitted.
        parser.exit(1, "capture stopped: transport, message decoding or local state failure\n")


if __name__ == "__main__":
    main()
