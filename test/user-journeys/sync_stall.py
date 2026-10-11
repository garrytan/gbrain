import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time
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
    material = materials / 'large-three.md'
    material.write_text('# 大文件处理验收\n\n' + ''.join(f'## 第 {i} 节\n\n' + '正文保持有意义的中文段落以测试可信结构切分和逐批写入。' * 120 + '\n\n' for i in range(420)), encoding='utf-8')
    original_hash = hashlib.sha256(material.read_bytes()).hexdigest()
    config = {'engine': 'pglite', 'database_path': str(home / 'database'), 'model_usage': {'embedding_enabled': False, 'generative_enabled': False}}
    (config_dir / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PMBRAIN_', 'GBRAIN_')) and not key.endswith('_API_KEY')}
    env.update({'PMBRAIN_HOME': str(home), 'GBRAIN_HOME': str(home), 'PMBRAIN_ADMIN_BOOTSTRAP_TOKEN': tasks.TOKEN, 'PMBRAIN_DIAGNOSTIC_MODE': '1'})
    for key in ['DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
        env.pop(key, None)
    init = '''import {PGLiteEngine} from "./src/core/pglite-engine.ts";
import {loadConfig} from "./src/core/config.ts";
const e=new PGLiteEngine();await e.connect(loadConfig());await e.initSchema();
await e.putPage('retained',{type:'note',title:'原有知识',compiled_truth:'已经提交的知识必须保留'});
await e.executeRaw(`CREATE FUNCTION pmbrain_ui_blocked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.chunk_index>=100 AND EXISTS(SELECT 1 FROM pages WHERE id=NEW.page_id AND slug='large-three') THEN LOOP PERFORM 1; END LOOP; END IF; RETURN NEW; END $$`);
await e.executeRaw('CREATE TRIGGER pmbrain_ui_blocked BEFORE INSERT OR UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION pmbrain_ui_blocked()');
await e.disconnect();'''
    def sql_script(code, filename):
        with (artifacts / filename).open('w', encoding='utf-8') as log:
            subprocess.run([shutil.which('bun'), '--eval', code], cwd=tasks.ROOT, env=env, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    sql_script(init, 'init.log')
    service_port = tasks.port()
    origin = f'http://127.0.0.1:{service_port}'
    (artifacts / 'preview.json').write_text(json.dumps({'url': origin + '/admin/#dream', 'home': str(home)}), encoding='utf-8')
    runtime = tasks.ROOT / 'desktop/build/extraResources/pmbrain-runtime'
    entry = [str(runtime / 'bun.exe'), str(runtime / 'pmbrain-sidecar.js')]
    process = None
    log = None
    def start(context):
        nonlocal process, log
        log = (artifacts / 'service.log').open('a', encoding='utf-8')
        process = subprocess.Popen(entry + ['serve', '--http', '--port', str(service_port), '--suppress-bootstrap-token'], cwd=tasks.ROOT, env=env, stdout=log, stderr=log)
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                if context.request.post(origin + '/admin/login', data={'token': tasks.TOKEN}, timeout=1500).ok:
                    return
            except Exception:
                pass
            if process.poll() is not None:
                break
            time.sleep(.2)
        raise AssertionError('Latest isolated Sidecar failed to start')
    def stop():
        if process and process.poll() is None:
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, check=True)
            process.wait(timeout=15)
        if log:
            log.close()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel='msedge', headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            start(context)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/admin/#dream')
            page.get_by_role('heading', name='知识整理', exact=True).wait_for()
            response = context.request.post(origin + '/admin/api/sources/local-path', data={'sourceId': 'default', 'localPath': str(materials)})
            assert response.ok, response.text()
            page.get_by_role('button', name='快速维护', exact=True).click()
            page.locator('.maintenance-run-row').first.wait_for()
            page.locator('.maintenance-run-row').first.click()
            detail = page.get_by_role('dialog', name='快速维护详情', exact=True)
            expect(detail.locator('.product-active-files')).to_contain_text('正文已提交 100 / 3360 块', timeout=90000)
            expect(detail.locator('.product-active-files')).to_contain_text('已完成 1 / 34 批')
            expect(detail.locator('.product-active-files')).to_contain_text('正在写入第 2 批')
            expect(detail.locator('.product-active-files')).to_contain_text('最近活动：')
            expect(detail.locator('.product-active-files')).to_contain_text('large-three.md')
            expect(detail.locator('.product-active-files')).to_contain_text('3.90 MB')
            expect(detail.locator('.product-active-files')).to_contain_text('本轮同步未启用向量化')
            expect(detail.locator('.product-active-files')).to_contain_text('正在等待数据库：写入分块')
            detail.get_by_text('查看同步文件明细', exact=True).click()
            expect(detail.locator('details')).to_contain_text('状态更新于', timeout=5000)
            assert 'fetch failed' not in detail.inner_text()
            page.screenshot(path=str(artifacts / 'blocked-progress.png'), full_page=True)
            (artifacts / 'blocked-dom.txt').write_text(detail.inner_text(), encoding='utf-8')
            started = time.monotonic()
            detail.get_by_role('button', name='停止任务', exact=True).click()
            expect(detail).to_contain_text('任务已停止', timeout=20000)
            stop_seconds = time.monotonic() - started
            page.screenshot(path=str(artifacts / 'stopped.png'), full_page=True)
            stop()
            time.sleep(.5)
            remove = init.split('await e.putPage')[0] + '''
if(!(await e.getPage('retained'))?.compiled_truth.includes('必须保留'))throw new Error('previous content lost');
if((await e.getChunks('large-three')).length!==100)throw new Error('committed first batch lost');
if((await e.executeRaw("SELECT chunker_version FROM pages WHERE slug='large-three'"))[0].chunker_version>=0)throw new Error('incomplete page incorrectly finalized');
await e.executeRaw('DROP TRIGGER pmbrain_ui_blocked ON content_chunks');await e.executeRaw('DROP FUNCTION pmbrain_ui_blocked()');await e.disconnect();'''
            sql_script(remove, 'rollback.log')
            start(context)
            page.reload()
            expect(page.get_by_role('dialog')).to_contain_text('任务已停止')
            page.on('dialog', lambda dialog: dialog.accept())
            page.get_by_role('button', name='继续未完成任务', exact=True).click()
            expect(page.get_by_role('dialog').locator('.product-task-state')).to_have_text(re.compile('已完成|部分完成'), timeout=120000)
            expect(page.get_by_role('dialog')).to_contain_text('已处理 1 / 1 份资料')
            quick_outcome=page.get_by_role('dialog').inner_text()
            page.screenshot(path=str(artifacts / 'continued.png'), full_page=True)
            stop()
            verify = init.split('await e.putPage')[0] + '''
if(!(await e.getPage('retained'))?.compiled_truth.includes('必须保留'))throw new Error('previous content lost');
const chunks=await e.getChunks('large-three');if(chunks.length!==3360)throw new Error('final chunks incomplete');
if((await e.executeRaw("SELECT chunker_version FROM pages WHERE slug='large-three'"))[0].chunker_version<0)throw new Error('page still partial');
const versions=await e.executeRaw("SELECT count(*)::int AS n FROM page_versions WHERE page_id=(SELECT id FROM pages WHERE slug='large-three')");
console.log(JSON.stringify({chunks:chunks.length,versions:versions[0].n}));await e.disconnect();'''
            sql_script(verify, 'verified.log')
            assert hashlib.sha256(material.read_bytes()).hexdigest() == original_hash
            assert not errors, errors
            result = {'passed': True, 'runtime': 'bundled', 'stop_seconds': stop_seconds, 'bytes': material.stat().st_size, 'quick_outcome':quick_outcome,'checks': ['real_committed_batch_100', 'batch_count_1_of_34', 'activity_seconds', 'database_wait', 'files_during_sql_block', 'stop_owner_recovery', 'native_reopen_preserves_first_batch', 'stopped_after_restart', 'manual_continue', 'original_bytes_preserved'], 'browser_errors': errors}
            (artifacts / 'result.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
            print(json.dumps(result, ensure_ascii=False))
            browser.close()
    finally:
        stop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    run(parser.parse_args())
