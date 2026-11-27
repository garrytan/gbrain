import hashlib
import imaplib
import re
import socketserver
import sqlite3
import ssl
import subprocess
import tempfile
import threading
import unittest
from contextlib import closing, contextmanager
from email.message import EmailMessage
from pathlib import Path

from imap_capture import CaptureError, MAX_MESSAGE_BYTES, capture, project


SENT = "Sent Items"
PARENT_ID = "<question@example.test>"
REPLY_ID = "<response@example.test>"


def message(message_id, subject, body, parent=None, *, subtype="plain"):
    mail = EmailMessage()
    mail["Subject"] = subject
    mail["From"] = "alice@example.test" if parent is None else "bob@example.test"
    mail["To"] = "bob@example.test" if parent is None else "alice@example.test"
    mail["Date"] = "Thu, 26 Nov 2026 12:00:00 +0000"
    mail["Message-ID"] = message_id
    if parent:
        mail["In-Reply-To"] = parent
        mail["References"] = parent
    mail.set_content(body, subtype=subtype)
    return mail.as_bytes(policy=mail.policy.clone(linesep="\r\n"))


PARENT = message(PARENT_ID, "Synthetic approval request", "Can you confirm basaltlantern tomorrow?")
REPLY = message(REPLY_ID, "Re: Synthetic approval request",
                "Yes, I confirmed cobaltquasar. Fixture glossary: gbrain:facts is a label.",
                PARENT_ID)
EXCLUDED = message("<excluded@example.test>", "Excluded copy", "privateheldcontrol")
HTML_ONLY = message("<notice@example.test>", "HTML notice", "<p>fixturehtmlnotice</p>", subtype="html")
PAGE_SLUG = f"emails/{hashlib.sha256(PARENT_ID.encode()).hexdigest()}"


class ImapHandler(socketserver.StreamRequestHandler):
    def handle(self):
        server = self.server
        active = None
        self.wfile.write(b"* OK [CAPABILITY IMAP4rev1] synthetic IMAP ready\r\n")
        for line in self.rfile:
            tag, _, command = line.rstrip(b"\r\n").partition(b" ")
            server.commands.append(command)
            verb, _, args = command.partition(b" ")
            response = b""
            outcome = b"OK completed"
            if verb == b"CAPABILITY":
                response = b"* CAPABILITY IMAP4rev1\r\n"
            elif verb == b"LOGIN":
                if args != b'alice@example.test "fixture-password"':
                    outcome = b"NO invalid login"
            elif verb == b"EXAMINE":
                active = re.fullmatch(rb'"([^"]+)"', args).group(1).decode()
                mailbox = server.mailboxes.get(active)
                if mailbox is None:
                    outcome = b"NO mailbox unavailable"
                else:
                    generation, next_uid, messages = mailbox
                    response = (f"* {len(messages)} EXISTS\r\n* FLAGS (\\Seen)\r\n"
                                f"* OK [UIDVALIDITY {generation}] generation\r\n"
                                f"* OK [UIDNEXT {next_uid}] next UID\r\n").encode()
                    outcome = b"[READ-ONLY] examined"
                    if server.read_write:
                        outcome = b"[READ-WRITE] invalid test response"
                    outcome = b"OK " + outcome
            elif verb == b"UID":
                generation, _, messages = server.mailboxes[active]
                search = re.fullmatch(rb"SEARCH UID (\d+):(\d+)", args)
                fetch = re.fullmatch(rb"FETCH (\d+) \(UID RFC822\.SIZE BODY\.PEEK\[\]<0\.(\d+)>\)", args)
                if search:
                    low, high = (int(value) for value in search.groups())
                    uids = b" ".join(str(uid).encode() for uid in sorted(messages) if low <= uid <= high)
                    response = b"* SEARCH" + (b" " + uids if uids else b"") + b"\r\n"
                elif fetch:
                    uid, limit = (int(value) for value in fetch.groups())
                    if server.fail_uid == (active, uid):
                        outcome = b"NO injected fetch failure"
                    elif uid in messages:
                        raw = messages[uid]
                        chunk = raw[:limit]
                        returned_uid = uid + 1 if server.wrong_uid else uid
                        response = (f"* 1 FETCH (BODY[]<0> {{{len(chunk)}}}\r\n".encode()
                                    + chunk
                                    + f" RFC822.SIZE {len(raw)} UID {returned_uid})\r\n".encode())
                else:
                    outcome = b"BAD unexpected UID operation"
            elif verb == b"LOGOUT":
                self.wfile.write(b"* BYE signing off\r\n" + tag + b" OK logged out\r\n")
                return
            else:
                outcome = b"BAD unexpected operation"
            self.wfile.write(response + tag + b" " + outcome + b"\r\n")


class TlsImapServer(socketserver.ThreadingTCPServer):
    daemon_threads = True

    def __init__(self, certificate, key):
        super().__init__(("127.0.0.1", 0), ImapHandler)
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(certificate, key)
        self.commands = []
        self.mailboxes = {
            "INBOX": (11, 4, {3: PARENT}),
            SENT: (22, 1, {}),
            "Unselected": (33, 2, {1: EXCLUDED}),
        }
        self.fail_uid = None
        self.read_write = False
        self.wrong_uid = False

    def get_request(self):
        connection, address = super().get_request()
        try:
            connection.settimeout(10)
            return self.tls.wrap_socket(connection, server_side=True), address
        except OSError:
            connection.close()
            raise

    def collect(self, state, cert, username="alice@example.test", sent=SENT, host=None):
        address, port = self.server_address
        return capture(state, username, "fixture-password", sent, (host or address, port), cert)


@contextmanager
def local_imap(root):
    certificate = root / "certificate.pem"
    key = root / "key.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
         "-subj", "/CN=synthetic.example.test", "-addext", "subjectAltName=IP:127.0.0.1",
         "-keyout", str(key), "-out", str(certificate)],
        check=True, capture_output=True,
    )
    with TlsImapServer(certificate, key) as server:
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05})
        worker.start()
        try:
            yield server, certificate
        finally:
            server.shutdown()
            worker.join(timeout=10)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        fixture = local_imap(self.root)
        self.server, self.cert = fixture.__enter__()
        self.addCleanup(fixture.__exit__, None, None, None)
        self.state = self.root / "mail.sqlite"
        self.pages = self.root / "pages"

    def collect(self, **kwargs):
        return self.server.collect(self.state, self.cert, **kwargs)

    def cursors(self):
        with closing(sqlite3.connect(self.state)) as db:
            return db.execute("SELECT * FROM cursor ORDER BY mailbox").fetchall()

    def holds(self):
        with closing(sqlite3.connect(self.state)) as db:
            return db.execute("SELECT * FROM message_hold ORDER BY mailbox, uid").fetchall()

    def test_read_only_wire_scoped_projection_and_resume(self):
        self.assertEqual(self.collect(), 1)
        self.assertEqual(project(self.state, self.pages), 1)
        target = self.pages / f"{PAGE_SLUG}.md"
        self.assertIn("basaltlantern", target.read_text())
        self.server.mailboxes[SENT] = (22, 4, {3: REPLY})
        # The two folders use the same UID with different generations.
        self.assertEqual(self.collect(), 1)
        self.assertEqual(project(self.state, self.pages), 1)
        self.assertEqual(list((self.pages / "emails").iterdir()), [target])
        page = target.read_text()
        self.assertIn("cobaltquasar", page)
        self.assertNotIn("privateheldcontrol", page)
        self.assertEqual(page.count("Message-ID:"), 2)
        self.assertEqual(self.cursors(), [("INBOX", 11, 3), (SENT, 22, 3)])
        self.assertIn(b'EXAMINE "INBOX"', self.server.commands)
        self.assertIn(b'EXAMINE "Sent Items"', self.server.commands)
        self.assertEqual(sum(b"BODY.PEEK[]" in cmd for cmd in self.server.commands), 2)
        self.assertTrue(all(re.match(rb"(CAPABILITY|LOGIN|EXAMINE|UID SEARCH|UID FETCH|LOGOUT)( |$)", cmd)
                            for cmd in self.server.commands))
        self.server.commands.clear()
        before = target.stat().st_mtime_ns
        before_state = self.state.read_bytes()
        self.assertEqual(self.collect(), 0)
        self.assertEqual(project(self.state, self.pages), 0)
        self.assertEqual(before, target.stat().st_mtime_ns)
        self.assertEqual(before_state, self.state.read_bytes())
        self.assertFalse(any(cmd.startswith(b"UID") for cmd in self.server.commands))

    def test_projection_escapes_outside_notation_and_preserves_the_ledger(self):
        sample = message(PARENT_ID, "Glossary: gbrain:takes",
                         "Keep glacierbeacon.\nGBrain : facts\n[Source: example\n"
                         "\u2028## Timeline glossary")
        self.server.mailboxes["INBOX"] = (11, 4, {3: sample})
        self.assertEqual(self.collect(), 1)
        self.assertEqual(project(self.state, self.pages), 1)
        page = (self.pages / f"{PAGE_SLUG}.md").read_text()
        self.assertIn('Subject: "Glossary: gbrain\\\\:takes"', page)
        self.assertIn(r"GBrain \: facts", page)
        self.assertIn(r"[Source\: example", page)
        self.assertIn(r"\## Timeline glossary", page)
        self.assertIn("Keep glacierbeacon.", page)
        with closing(sqlite3.connect(self.state)) as db:
            subject, body = db.execute("SELECT subject, body FROM message").fetchone()
        self.assertEqual(subject, "Glossary: gbrain:takes")
        self.assertIn("GBrain : facts", body)
        self.assertEqual(project(self.state, self.pages), 0)

    def test_verified_tls_rejects_untrusted_cert_and_wrong_hostname_before_login(self):
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.server.collect(self.state, None)
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.collect(host="localhost")
        self.assertEqual(self.server.commands, [])
        self.assertEqual(self.cursors(), [])

    def test_inbox_fetch_rolls_back_if_later_sent_fetch_fails(self):
        self.collect()
        original = self.cursors()
        fresh = message("<new@example.test>", "New inbox", "Another fictional question.")
        self.server.mailboxes["INBOX"] = (11, 6, {3: PARENT, 4: HTML_ONLY, 5: fresh})
        self.server.mailboxes[SENT] = (22, 4, {3: REPLY})
        self.server.fail_uid = (SENT, 3)
        with self.assertRaisesRegex(CaptureError, "UID FETCH"):
            self.collect()
        self.assertEqual(self.cursors(), original)
        self.assertEqual(self.holds(), [])
        self.assertEqual(project(self.state, self.pages), 1)
        self.server.fail_uid = None
        self.assertEqual(self.collect(), 2)
        self.assertEqual(self.holds(), [("INBOX", 11, 4, "plain-text-missing")])
        self.assertEqual(project(self.state, self.pages), 2)
        self.assertEqual(self.collect(), 0)
        self.assertEqual(project(self.state, self.pages), 0)

    def test_uidvalidity_and_uidnext_change_hold_prior_ledger(self):
        self.collect()
        original_state = self.state.read_bytes()
        self.server.mailboxes[SENT] = (23, 5, {4: REPLY})
        with self.assertRaisesRegex(CaptureError, "UIDVALIDITY"):
            self.collect()
        self.assertEqual(self.state.read_bytes(), original_state)
        self.server.mailboxes["INBOX"] = (11, 3, {})
        with self.assertRaisesRegex(CaptureError, "UIDNEXT"):
            self.collect()
        self.assertEqual(self.state.read_bytes(), original_state)

    def test_omission_and_cross_folder_byte_identical_copy_leave_page_unchanged(self):
        self.collect()
        project(self.state, self.pages)
        self.server.mailboxes["INBOX"] = (11, 4, {})
        self.server.mailboxes[SENT] = (22, 4, {3: PARENT})
        self.assertEqual(self.collect(), 1)
        self.assertEqual(project(self.state, self.pages), 0)
        self.assertIn("basaltlantern", (self.pages / f"{PAGE_SLUG}.md").read_text())
        with closing(sqlite3.connect(self.state)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM message").fetchone(), (1,))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM observation").fetchone(), (2,))

    def test_pinned_scope_and_read_only_status(self):
        self.collect()
        self.server.commands.clear()
        with self.assertRaisesRegex(CaptureError, "differs from the ledger"):
            self.collect(username="bob@example.test")
        with self.assertRaisesRegex(CaptureError, "differs from the ledger"):
            self.collect(sent="Unselected")
        self.assertEqual(self.server.commands, [])
        self.server.read_write = True
        with self.assertRaisesRegex(CaptureError, "not read-only"):
            self.collect()
        self.assertEqual(self.cursors(), [("INBOX", 11, 3), (SENT, 22, 0)])

    def test_wrong_uid_stops_batch(self):
        self.server.wrong_uid = True
        with self.assertRaisesRegex(CaptureError, "wrong message"):
            self.collect()
        self.assertEqual(self.cursors(), [])
        self.assertEqual(self.holds(), [])

    def test_unsupported_messages_are_held_and_later_mail_syncs(self):
        oversized = message("<oversize@example.test>", "Too big", "x" * MAX_MESSAGE_BYTES)
        conflict = message(PARENT_ID, "Conflicting identity", "different content")
        self.server.mailboxes["INBOX"] = (11, 5, {1: HTML_ONLY, 2: oversized, 3: b"", 4: PARENT})
        self.server.mailboxes[SENT] = (22, 3, {1: conflict, 2: REPLY})
        self.assertEqual(self.collect(), 2)
        self.assertEqual(self.cursors(), [("INBOX", 11, 4), (SENT, 22, 2)])
        expected = [("INBOX", 11, 1, "plain-text-missing"),
                    ("INBOX", 11, 2, "size-limit"),
                    ("INBOX", 11, 3, "message-id-unusable"),
                    (SENT, 22, 1, "message-id-conflict")]
        self.assertEqual(self.holds(), expected)
        self.assertEqual(project(self.state, self.pages), 1)
        page = (self.pages / f"{PAGE_SLUG}.md").read_text()
        self.assertIn("basaltlantern", page)
        self.assertIn("cobaltquasar", page)
        self.assertNotIn("fixturehtmlnotice", page)
        self.assertNotIn("different content", page)
        self.assertEqual(self.collect(), 0)
        self.assertEqual(self.holds(), expected)
        self.assertEqual(project(self.state, self.pages), 0)

    def test_provider_accepted_projection_can_replay_offline(self):
        self.assertEqual(self.collect(), 1)
        self.server.commands.clear()
        self.assertEqual(project(self.state, self.pages), 1)
        self.assertEqual(project(self.state, self.pages), 0)
        self.assertEqual(self.server.commands, [])

    def test_bounded_checkpoint_leaves_next_batch_fetchable(self):
        backlog = {i: message(f"<backlog-{i}@example.test>", "Backlog", f"Message {i}.")
                   for i in range(1, 28)}
        self.server.mailboxes["INBOX"] = (11, 28, backlog)
        self.assertEqual(self.collect(), 25)
        self.assertIn(("INBOX", 11, 25), self.cursors())
        self.assertEqual(self.collect(), 2)
        self.assertIn(("INBOX", 11, 27), self.cursors())
        self.assertEqual(self.collect(), 0)


if __name__ == "__main__":
    unittest.main()
