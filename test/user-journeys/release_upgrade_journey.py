#!/usr/bin/env python3
"""Exercise the published Windows updater with a real previous NSIS install.

The runner installs a previous PMBrain release into an isolated directory,
uses its real Desktop/Admin UI to create a PGLite database and import a page,
then clicks the packaged updater. The newly installed version must restart,
open the same database, and show the imported page in Admin.

This script is intentionally release-only. It requires a published newer
GitHub Release and must not be used as the routine test for small source edits.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.request import urlopen

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright


MODULE_PATH = Path(__file__).with_name("core_journeys.py")
SPEC = importlib.util.spec_from_file_location("pmbrain_core_journeys", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {MODULE_PATH}")
journeys = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(journeys)


def install_nsis(installer: Path, install_dir: Path) -> None:
    install_dir.mkdir(parents=True, exist_ok=True)
    print(f"[release upgrade] installing {installer.name} into {install_dir}", flush=True)
    subprocess.run([str(installer), "/S", f"/D={install_dir}"], check=True, timeout=300)
    executable = install_dir / "PMBrain.exe"
    if not executable.exists():
        raise RuntimeError(f"NSIS completed but {executable} is missing")


def wait_for_restarted_page(playwright, cdp_port: int, timeout_seconds: int = 300):
    endpoint = f"http://127.0.0.1:{cdp_port}"
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urlopen(f"{endpoint}/json/version", timeout=1) as response:
                if response.status != 200:
                    time.sleep(1)
                    continue
            browser = playwright.chromium.connect_over_cdp(endpoint, timeout=10_000)
            pages = [page for context in browser.contexts for page in context.pages]
            if pages:
                page = pages[0]
                page.set_default_timeout(60_000)
                page.wait_for_load_state("domcontentloaded")
                return browser, page
        except Exception as error:
            last_error = error
            time.sleep(1)
    raise RuntimeError(f"Updated PMBrain did not restart with CDP: {last_error}")


def click_real_updater(page) -> None:
    page.locator('.rail-item[data-target="updates"]').click()
    button = page.locator("#update-action")
    button.wait_for(state="visible")
    for attempt in range(10):
        if button.get_attribute("data-action") == "check" and not button.is_disabled():
            button.click()
        page.wait_for_function(
            "() => ['install', 'check'].includes(document.querySelector('#update-action')?.dataset.action || '') "
            "&& !document.querySelector('#update-action')?.disabled",
            timeout=900_000,
        )
        if page.locator("#global-error").is_visible():
            raise AssertionError(page.locator("#global-error").inner_text())
        if button.get_attribute("data-action") == "install":
            break
        if attempt == 9:
            raise AssertionError(f"GitHub Release did not produce a downloaded update: {page.locator('#update-message').inner_text()}")
        print(f"[release upgrade] release not visible yet; retry {attempt + 1}/10", flush=True)
        time.sleep(30)
    print(f"[release upgrade] {page.locator('#update-message').inner_text()}", flush=True)
    try:
        button.click(timeout=30_000)
    except Exception:
        # Expected only when quitAndInstall closes the renderer during click.
        for _ in range(30):
            try:
                if page.is_closed():
                    return
            except Exception:
                return
            time.sleep(0.5)
        raise


def verify_version_history(home: Path, expected_version: str) -> None:
    history_files = list((home / "electron-user-data").glob("version-history.json"))
    if not history_files:
        raise AssertionError("Updated Desktop did not write version-history.json")
    history = json.loads(history_files[0].read_text(encoding="utf-8"))
    serialized = json.dumps(history)
    if expected_version not in serialized:
        raise AssertionError(f"Restarted app did not report expected version {expected_version}: {history}")


def run(args: argparse.Namespace) -> None:
    old_installer = Path(args.old_installer).resolve()
    artifacts = Path(args.artifacts_dir).resolve()
    if not old_installer.is_file():
        raise FileNotFoundError(old_installer)
    artifacts.mkdir(parents=True, exist_ok=False)
    install_dir = artifacts / "installed-app"
    home = artifacts / "user-home"
    home.mkdir(parents=True)
    markdown, pdf = journeys.write_fixtures(artifacts / "fixtures")
    install_nsis(old_installer, install_dir)
    executable = install_dir / "PMBrain.exe"
    cdp_port = journeys.free_port()

    with journeys.LocalOpenAIServer() as provider, sync_playwright() as playwright:
        old_session = journeys.DesktopSession(
            playwright,
            artifacts,
            home,
            executable=executable,
            application=None,
            cdp_port=cdp_port,
        )
        page = old_session.start()
        try:
            journeys.first_launch_journey(page, artifacts, provider)
            admin_browser, admin, origin = journeys.open_admin_browser(
                playwright,
                journeys.mint_admin_login_link(page, home),
            )
            try:
                journeys.import_search_journey(admin, origin, markdown, pdf, artifacts)
            finally:
                admin_browser.close()
        finally:
            old_session.stop()

        updater_session = journeys.DesktopSession(
            playwright,
            artifacts,
            home,
            executable=executable,
            application=None,
            cdp_port=cdp_port,
        )
        page = updater_session.start()
        click_real_updater(page)
        if updater_session.process is not None:
            updater_session.process.wait(timeout=300)
        try:
            updater_session.browser.close()
        except Exception:
            pass

        browser, restarted_page = wait_for_restarted_page(playwright, cdp_port)
        try:
            admin_browser, admin, origin = journeys.open_admin_browser(
                playwright,
                journeys.mint_admin_login_link(restarted_page, home),
            )
            try:
                admin.goto(origin + "/admin/#data")
                admin.get_by_role("heading", name="知识数据").wait_for()
                admin.get_by_placeholder("搜索 slug 或标题").fill("Real User Journey Orchid")
                admin.get_by_role("row", name=re.compile("Real User Journey Orchid")).wait_for(timeout=120_000)
                verify_version_history(home, args.expected_version)
            finally:
                admin_browser.close()
        except Exception:
            restarted_page.screenshot(path=str(artifacts / "upgrade-failure.png"), full_page=True)
            raise
        finally:
            try:
                restarted_page.goto((install_dir / "resources" / "app.asar").as_uri())
            except Exception:
                pass
            browser.close()

    print(f"[passed] published release upgraded real NSIS install and preserved PGLite data: {artifacts}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the real PMBrain GitHub Release updater journey")
    parser.add_argument("--old-installer", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--artifacts-dir", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    try:
        run(parse_args())
    except Exception as error:
        print(f"[failed] {error}", file=sys.stderr)
        raise
