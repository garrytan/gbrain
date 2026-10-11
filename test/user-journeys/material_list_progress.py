import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect
import background_tasks as tasks


def run(args):
    artifacts = Path(args.artifacts_dir).resolve()
    artifacts.mkdir(parents=True, exist_ok=False)
    home = artifacts / 'home'
    materials = home / 'materials'
    materials.mkdir(parents=True)
    config_dir = home / '.pmbrain'
    config_dir.mkdir()
    provider = ThreadingHTTPServer(('127.0.0.1', 0), tasks.Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    config = {'engine': 'pglite', 'database_path': str(home / 'database'), 'embedding_model': 'custom-openai:task-test', 'embedding_dimensions': 1024, 'chat_model': 'custom-openai:task-test', 'custom_openai_api_key': 'task-only', 'provider_base_urls': {'custom-openai': f'http://127.0.0.1:{provider.server_port}/v1'}, 'model_usage': {'embedding_enabled': True, 'generative_enabled': True}, 'desktop': {'setup_completed': True, 'main_source_path_repair_completed': True, 'knowledge_directory': str(materials)}}
    config['desktop']['last_migrated_version'] = json.loads((tasks.ROOT / 'desktop/package.json').read_text(encoding='utf-8'))['version']
    (config_dir / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PMBRAIN_', 'GBRAIN_')) and not key.endswith('_API_KEY')}
    env.update({'PMBRAIN_HOME': str(home), 'GBRAIN_HOME': str(home), 'PMBRAIN_ADMIN_BOOTSTRAP_TOKEN': tasks.TOKEN, 'PMBRAIN_DIAGNOSTIC_MODE': '1'})
    for key in ['DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
        env.pop(key, None)
    init = 'import {PGLiteEngine} from "./src/core/pglite-engine.ts"; import {loadConfig} from "./src/core/config.ts"; import {configureGateway} from "./src/core/ai/gateway.ts"; configureGateway({embedding_model:"custom-openai:task-test",embedding_dimensions:1024,env:{}}); const e=new PGLiteEngine(); await e.connect(loadConfig()); await e.initSchema(); await e.executeRaw("INSERT INTO sources(id,name) VALUES ($1,$2),($3,$4)",["import-main","主资料库","import-other","项目资料"]); await e.setConfig("sources.default","import-main"); await e.disconnect();'
    subprocess.run([shutil.which('bun'), '--eval', init], cwd=tasks.ROOT, env=env, check=True, stdout=(artifacts / 'init.log').open('w', encoding='utf-8'), stderr=subprocess.STDOUT, timeout=60)
    process = None
    session = None
    browser = None
    try:
        with sync_playwright() as playwright:
            if args.desktop:
                from core_journeys import DesktopSession
                session = DesktopSession(playwright, artifacts, home)
                page = session.start()
                page.locator('.product-nav').wait_for(timeout=120000)
                page.evaluate("""async () => {
                  const deadline = Date.now() + 120000;
                  while (Date.now() < deadline) {
                    const state = await window.pmbrainDesktop.getState();
                    if (state?.phase === 'ready') return;
                    if (state?.phase === 'failed') throw new Error(state.message);
                    await new Promise(resolve => setTimeout(resolve, 100));
                  }
                  throw new Error('Desktop service did not become ready');
                }""")
                page.get_by_role('button', name='知识库', exact=True).click()
            else:
                service_port = tasks.port()
                origin = f'http://127.0.0.1:{service_port}'
                runtime = tasks.ROOT / 'desktop/build/extraResources/pmbrain-runtime'
                entry = [str(runtime / 'bun.exe'), str(runtime / 'pmbrain-sidecar.js')] if args.runtime == 'bundled' else [shutil.which('bun'), str(tasks.ROOT / 'src/cli.ts')]
                log = (artifacts / 'service.log').open('w', encoding='utf-8')
                process = subprocess.Popen(entry + ['serve', '--http', '--port', str(service_port), '--suppress-bootstrap-token'], cwd=tasks.ROOT, env=env, stdout=log, stderr=log)
                browser = playwright.chromium.launch(channel='msedge', headless=True)
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                context.add_init_script("localStorage.setItem('pmbrain.admin.theme-mode','dark')")
                deadline = time.time() + 90
                while True:
                    try:
                        response = context.request.post(origin + '/admin/login', data={'token': tasks.TOKEN}, timeout=1500)
                        if response.status < 400:
                            break
                    except Exception:
                        pass
                    if time.time() >= deadline or process.poll() is not None:
                        raise AssertionError('Synthetic service did not start')
                    time.sleep(.1)
                page = context.new_page()
                page.goto(origin + '/admin/#data')
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.get_by_role('heading', name='知识库', exact=True).wait_for()
            page.get_by_role('button', name='添加资料', exact=True).click()
            source = page.get_by_label('导入到数据源', exact=True)
            expect(source).to_have_value('import-main', timeout=10000)
            assert page.get_by_label('文件或文件夹路径', exact=True).count() == 0
            source.select_option('import-other')
            tasks.waiting.clear()
            tasks.release.clear()
            tasks.delay = True
            page.locator('.materials-drawer input[type=file]').set_input_files({'name': 'visible-progress.md', 'mimeType': 'text/markdown', 'buffer': b'# Imported heading\n\nDelayed synthetic embedding makes the material visible while the model is pending.'})
            page.get_by_role('button', name='导入 1 项', exact=True).click()
            assert tasks.waiting.wait(20), 'Model wait was not reached'
            page.get_by_role('button', name='关闭添加资料', exact=True).click()
            pending = page.locator('.material-import-row').first
            pending.wait_for()
            expect(pending).to_contain_text('项目资料', timeout=10000)
            assert pending.locator('[aria-label="知识分块处理中"]').count() == 1
            assert pending.locator('[aria-label="向量化处理中"]').count() == 1
            assert pending.locator('td').last.inner_text() == '—'
            page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
            expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
            page.screenshot(path=str(artifacts / 'pending-dark.png'), full_page=True)
            page.reload()
            pending = page.locator('.material-import-row').first
            pending.wait_for()
            assert 'visible-progress.md' in pending.inner_text()
            expect(pending).to_contain_text('项目资料', timeout=10000)
            page.evaluate("document.documentElement.setAttribute('data-theme','light')")
            expect(page.locator('html')).to_have_attribute('data-theme', 'light')
            page.set_viewport_size({'width': 1100, 'height': 850})
            page.screenshot(path=str(artifacts / 'pending-light.png'), full_page=True)
            tasks.delay = False
            tasks.release.set()
            expect(page.locator('.material-import-row')).to_have_count(0, timeout=45000)
            actual = page.get_by_role('row', name='查看 Imported heading', exact=True)
            actual.wait_for()
            assert 'import-other' in actual.inner_text()
            chunks = int(actual.locator('td').nth(3).inner_text())
            embedded, total = map(int, actual.locator('td').nth(4).inner_text().split('/'))
            assert chunks > 0 and embedded == total == chunks
            assert actual.locator('td').last.inner_text() != '—'
            page.screenshot(path=str(artifacts / 'completed.png'), full_page=True)
            page.reload()
            page.get_by_role('row', name='查看 Imported heading', exact=True).wait_for()
            assert page.locator('.material-import-row').count() == 0
            page.get_by_role('button', name='添加资料', exact=True).click()
            page.get_by_label('导入到数据源', exact=True).select_option('import-other')
            page.locator('.materials-drawer input[type=file]').set_input_files({'name': 'empty.md', 'mimeType': 'text/markdown', 'buffer': b''})
            page.get_by_role('button', name='导入 1 项', exact=True).click()
            page.locator('.materials-drawer [role=alert]').wait_for()
            page.get_by_role('button', name='关闭添加资料', exact=True).click()
            failed = page.get_by_role('row', name='导入 empty.md', exact=True)
            failed.wait_for()
            assert failed.locator('.material-cell-progress').count() == 0
            assert 'Upload body is required' in failed.inner_text()
            page.screenshot(path=str(artifacts / 'failed-upload.png'), full_page=True)
            assert not errors, errors
            (artifacts / 'result.json').write_text(json.dumps({'passed': True, 'desktop': args.desktop, 'runtime': args.runtime, 'checks': ['configured_main_source_default', 'selected_source_upload', 'visible_pending_row', 'chunk_and_embedding_spinners', 'pending_after_reload', 'completed_counts_and_update_time', 'completed_after_reload', 'failed_upload_stops_spinners', 'dark_light_1440_1100']}, ensure_ascii=False), encoding='utf-8')
            print('Material list progress journey passed')
    finally:
        tasks.delay = False
        tasks.release.set()
        if session:
            try:
                session.stop()
            except subprocess.TimeoutExpired:
                if session.process and session.process.poll() is None:
                    subprocess.run(['taskkill', '/PID', str(session.process.pid), '/T', '/F'], capture_output=True)
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
        provider.shutdown()
        provider.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    parser.add_argument('--runtime', choices=['source', 'bundled'], default='source')
    parser.add_argument('--desktop', action='store_true')
    run(parser.parse_args())
