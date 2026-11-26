"""Replay fictional Inbox and Sent mail through a disposable upstream GBrain."""

import argparse
import difflib
import json
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path

from test_imap_capture import HTML_ONLY, PAGE_SLUG, REPLY, SENT, local_imap

EXPECTED_VERSION = "gbrain 0.60.777.0"
SOURCE = "icloud-fixture"
COLLECT_CHILD = """
import json
import sys
from pathlib import Path
from imap_capture import capture, held_count
state, host, port, certificate, sent = sys.argv[1:]
result = capture(Path(state), "alice@example.test", "fixture-password", sent,
                 (host, int(port)), certificate)
print(json.dumps({"captured_observations": result, "held_observations": held_count(Path(state))}))
"""


def cli_counts(receipt):
    return {name: receipt[name] for name in ("added", "modified", "deleted", "chunks_created", "embedded")}


def verify(bun, checkout, root):
    cli = checkout / "src" / "cli.ts"
    fixture = root / "fixture"
    fixture.mkdir()
    gbrain_home = root / "brain"
    gbrain_home.mkdir()
    database = root / "fixture.pglite"
    env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "GBRAIN_HOME": str(gbrain_home),
        "PYTHONDONTWRITEBYTECODE": "1",
    }

    def run(executable, *args, cwd=root):
        completed = subprocess.run(
            [str(executable), *map(str, args)], cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90,
        )
        if completed.returncode:
            raise RuntimeError(f"command failed with exit {completed.returncode}\n"
                               f"{completed.stdout}\n{completed.stderr}")
        return completed.stdout

    def native(*args, is_json=True):
        output = run(bun, "--no-env-file", cli, *args)
        return json.loads(output) if is_json else output.strip()

    def collect(server, certificate):
        host, port = server.server_address
        return json.loads(run(sys.executable, "-c", COLLECT_CHILD, fixture / "mail.sqlite",
                              host, port, certificate, SENT, cwd=Path(__file__).resolve().parent))

    def project_in_child():
        helper = Path(__file__).resolve().with_name("imap_capture.py")
        return json.loads(run(sys.executable, helper, "--root", fixture, "project"))

    def sync():
        response = native("sync", "--source", SOURCE, "--no-pull", "--no-embed", "--no-extract", "--json")
        assert response["source_id"] == SOURCE and response["sync_status"] == "synced", response
        return response

    def search(term, source=None):
        args = ["search", term, "--match", "keyword", "--json"]
        if source:
            args += ["--source", source]
        return native(*args)

    def read_page():
        return native("get", PAGE_SLUG, "--source", SOURCE, "--json")

    version = native("version", is_json=False)
    assert version == EXPECTED_VERSION, version
    native("init", "--pglite", "--path", database, "--no-embedding", "--non-interactive", "--json")
    settings = json.loads((gbrain_home / ".gbrain" / "config.json").read_text())
    assert settings["engine"] == "pglite" and Path(settings["database_path"]).resolve() == database

    with local_imap(fixture) as (server, certificate):
        assert collect(server, certificate) == {"captured_observations": 1, "held_observations": 0}
        assert project_in_child() == {"projected_pages": 1}
        added = native("sources", "add", SOURCE, "--path", fixture / "pages", "--force",
                       "--no-federated", "--json")
        assert added["state"] == "committed" and added["config"]["federated"] is False, added
        first = sync()
        assert first["added"] == 1 and first["chunks_created"] > 0 and first["deleted"] == 0, first
        original = read_page()
        assert original["source_id"] == SOURCE and original["type"] == "email", original
        assert original["frontmatter"]["visibility"] == "private", original
        assert original["trust_tier"] == "external_untrusted", original
        assert "basaltlantern" in original["compiled_truth"] and "cobaltquasar" not in original["compiled_truth"]

        server.mailboxes[SENT] = (22, 4, {2: HTML_ONLY, 3: REPLY})
        assert collect(server, certificate) == {"captured_observations": 1, "held_observations": 1}
        assert project_in_child() == {"projected_pages": 1}
        projected = fixture / "pages" / f"{PAGE_SLUG}.md"
        before_sync = projected.read_text()
        second = sync()
        after_sync = projected.read_text()
        reply_page = read_page()
        # Plain-directory sync counts all successful file imports as added.
        # The native page ID, old/new revisions and scoped search prove that
        # importing the changed file updates the one page in place.
        assert second["added"] == 1 and second["modified"] == second["deleted"] == 0, second
        assert second["chunks_created"] > 0, second
        assert reply_page["id"] == original["id"] and reply_page["revision"] != original["revision"]
        assert "basaltlantern" in reply_page["compiled_truth"] and "cobaltquasar" in reply_page["compiled_truth"]

        found = search("cobaltquasar", SOURCE)
        assert len(found) == 1 and found[0]["slug"] == PAGE_SLUG and found[0]["source_id"] == SOURCE, found
        assert found[0]["page_id"] == reply_page["id"], found
        assert search("cobaltquasar", "default") == []
        trusted_owner_search_match = any(row["slug"] == PAGE_SLUG for row in search("cobaltquasar"))
        assert search("privateheldcontrol", SOURCE) == []
        assert search("fixturehtmlnotice", SOURCE) == []

        assert collect(server, certificate) == {"captured_observations": 0, "held_observations": 1}
        repeated = project_in_child()
        assert repeated == {"projected_pages": 0}, "".join(difflib.unified_diff(
            before_sync.splitlines(keepends=True), after_sync.splitlines(keepends=True),
            "collector projection", "GBrain published file",
        ))
        quiet = sync()
        after = read_page()
        assert all(count == 0 for count in cli_counts(quiet).values()), quiet
        assert quiet["watermark"]["committed_through_request"] == second["watermark"]["committed_through_request"]
        assert after["id"] == reply_page["id"] and after["revision"] == reply_page["revision"]
        assert after["content_hash"] == reply_page["content_hash"]
        assert after["text_projection_revision"] == reply_page["text_projection_revision"]

        waiting = native("waiting", "--source", SOURCE, "--json")
        assert waiting["no_google_sources"] is True and waiting["sources"] == [], waiting
        return {
            "platform": platform.system(),
            "gbrain": version,
            "disposable_settings_and_database_verified": True,
            "held_message_excluded_and_later_reply_indexed": True,
            "initial_native_sync": cli_counts(first),
            "sent_reply_native_sync": cli_counts(second),
            "unchanged_native_sync": cli_counts(quiet),
            "reopened_capture_ledger_per_poll": True,
            "sent_reply_found_on_original_page": True,
            "quiet_repeat_page_revision_and_request_watermark_equal": True,
            "source_scoped_search_finds_reply_default_source_excludes_it": True,
            "unqualified_trusted_cli_search_can_find_private_page": trusted_owner_search_match,
            "page_private_and_external_untrusted": True,
            "waiting_no_google_sources": waiting["no_google_sources"],
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("--checkout", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="gbrain-icloud-fixture-") as scratch:
        result = verify(args.bun.resolve(strict=True), args.checkout.resolve(strict=True),
                        Path(scratch).resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
