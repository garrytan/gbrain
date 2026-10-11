import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import threading
import time
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect
import background_tasks as tasks


def run(args):
    if args.knowledge_only and not args.desktop:
        raise ValueError('--knowledge-only requires --desktop')
    artifacts = Path(args.artifacts_dir).resolve()
    artifacts.mkdir(parents=True, exist_ok=False)
    home = artifacts / 'home'
    materials = home / 'materials'
    materials.mkdir(parents=True)
    config_dir = home / '.pmbrain'
    config_dir.mkdir()
    provider = ThreadingHTTPServer(('127.0.0.1', 0), tasks.Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    config = {'engine': 'pglite', 'database_path': str(home / 'database'), 'embedding_model': 'custom-openai:task-test', 'embedding_dimensions': 1024, 'chat_model': 'custom-openai:task-test', 'custom_openai_api_key': 'task-only', 'provider_base_urls': {'custom-openai': f'http://127.0.0.1:{provider.server_port}/v1'}, 'model_usage': {'embedding_enabled': True, 'generative_enabled': True}, 'desktop': {'setup_completed': True, 'main_source_path_repair_completed': True, 'knowledge_directory': str(materials), 'last_migrated_version': json.loads((tasks.ROOT / 'desktop/package.json').read_text(encoding='utf-8'))['version']}}
    (config_dir / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PMBRAIN_', 'GBRAIN_')) and not key.endswith('_API_KEY')}
    env.update({'PMBRAIN_HOME': str(home), 'GBRAIN_HOME': str(home), 'PMBRAIN_ADMIN_BOOTSTRAP_TOKEN': tasks.TOKEN, 'PMBRAIN_DIAGNOSTIC_MODE': '1'})
    for key in ['DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
        env.pop(key, None)
    init = 'import {PGLiteEngine} from "./src/core/pglite-engine.ts"; import {loadConfig} from "./src/core/config.ts"; import {configureGateway} from "./src/core/ai/gateway.ts"; configureGateway({embedding_model:"custom-openai:task-test",embedding_dimensions:1024,env:{}}); const e=new PGLiteEngine(); await e.connect(loadConfig()); await e.initSchema(); await e.disconnect();'
    if args.knowledge_only:
        init = init.replace('await e.disconnect();', 'await e.executeRaw("INSERT INTO sources (id, name) VALUES ($1, $2)", ["isolated-other", "隔离来源"]); for (const sourceId of ["default", "isolated-other"]) { const compiled_truth=sourceId==="default"?"川商出海正文读取验收，明确来源为默认知识库。":"其他来源独立正文，不能混入默认知识库。"; await e.putPage("projects/川商出海", {type:"project", title:sourceId==="default"?"川商出海":"另一个来源项目", compiled_truth, frontmatter:{}}, {sourceId}); await e.upsertChunks("projects/川商出海", [{chunk_index:0, chunk_text:compiled_truth, chunk_source:"compiled_truth"}], {sourceId}); } await e.disconnect();')
    with (artifacts / 'init.log').open('w', encoding='utf-8') as log:
        subprocess.run([shutil.which('bun'), '--eval', init], cwd=tasks.ROOT, env=env, check=True, stdout=log, stderr=subprocess.STDOUT, timeout=60)
    process = session = browser = None
    try:
        with sync_playwright() as playwright:
            errors = []
            if args.desktop:
                from core_journeys import DesktopSession
                session = DesktopSession(playwright, artifacts, home)
                page = session.start()
                page.on('pageerror', lambda error: errors.append(str(error)))
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
                page.locator('.product-nav').wait_for()
                page.get_by_role('button', name='知识整理', exact=True).click()
                page.set_viewport_size({'width': 1440, 'height': 1000})
                if args.knowledge_only:
                    bodies = page.evaluate("""async () => {
                      const result=[];
                      for (const source of ['default','isolated-other']) {
                        const path='/admin/api/brain/pages/'+source+'/'+encodeURIComponent('projects/川商出海');
                        for (const suffix of ['','/chunks']) {
                          const response=await window.pmbrainDesktop.productRequest({path:path+suffix});
                          if(response.status!==200)throw new Error(response.body);
                          result.push({source,suffix,body:JSON.parse(response.body)});
                        }
                      }
                      for(const path of ['/admin/api/brain/pages/default/projects%2F..%2Fsecret','/admin/api/brain/pages/default%2Fother/projects%2Ftest']) {
                        let rejected=false;
                        try {await window.pmbrainDesktop.productRequest({path});} catch {rejected=true;}
                        if(!rejected)throw new Error('Unsafe identity was accepted');
                      }
                      return result;
                    }""")
                    (artifacts / 'desktop-page-bodies.json').write_text(json.dumps(bodies, ensure_ascii=False), encoding='utf-8')
                    for offset, source, expected in [(0, 'default', '川商出海正文读取验收，明确来源为默认知识库。'), (2, 'isolated-other', '其他来源独立正文，不能混入默认知识库。')]:
                        assert bodies[offset]['body']['source_id']==source
                        assert bodies[offset]['body']['compiled_truth']==expected
                        assert bodies[offset+1]['body']['rows'][0]['chunk_text']==expected
                    page.get_by_role('button', name='知识库', exact=True).click()
                    page.get_by_role('row', name='查看 川商出海', exact=True).click()
                    drawer=page.locator('.knowledge-drawer')
                    expect(drawer.locator('.knowledge-markdown')).to_contain_text('川商出海正文读取验收')
                    assert drawer.locator('.pm-error-text').count()==0
                    page.screenshot(path=str(artifacts / 'desktop-chinese-body.png'), full_page=True)
                    drawer.get_by_role('button', name='切片状态', exact=True).click()
                    expect(drawer).to_contain_text('川商出海正文读取验收')
                    page.mouse.click(70, 90)
                    expect(page.locator('.knowledge-drawer')).to_have_count(0)
                    page.get_by_role('button', name='知识整理', exact=True).click()
                    page.get_by_role('button', name='知识库', exact=True).click()
                    page.reload()
                    page.get_by_role('row', name='查看 川商出海', exact=True).click()
                    expect(page.locator('.knowledge-markdown')).to_contain_text('川商出海正文读取验收')
                    (artifacts / 'result.json').write_text(json.dumps({'passed': True, 'desktop': True, 'checks': ['desktop_chinese_nested_body', 'desktop_page_chunks', 'source_identity_isolation', 'unsafe_path_rejected', 'knowledge_outside_click_close', 'reload_body_visible'], 'browser_errors': errors}, ensure_ascii=False), encoding='utf-8')
                    assert not errors, errors
                    print('Desktop knowledge details journey passed')
                    return
            else:
                service_port = tasks.port()
                origin = f'http://127.0.0.1:{service_port}'
                runtime = tasks.ROOT / 'desktop/build/extraResources/pmbrain-runtime'
                entry = [str(runtime / 'bun.exe'), str(runtime / 'pmbrain-sidecar.js')] if args.runtime == 'bundled' else [shutil.which('bun'), str(tasks.ROOT / 'src/cli.ts')]
                log = (artifacts / 'service.log').open('w', encoding='utf-8')
                process = subprocess.Popen(entry + ['serve', '--http', '--port', str(service_port), '--suppress-bootstrap-token'], cwd=tasks.ROOT, env=env, stdout=log, stderr=log)
                browser = playwright.chromium.launch(channel='msedge', headless=True)
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
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
                page.goto(origin + '/admin/#dream')
            if not args.desktop:
                page.on('pageerror', lambda error: errors.append(str(error)))
            page.get_by_role('heading', name='知识整理', exact=True).wait_for()
            page.evaluate("""async path => {
              const body = JSON.stringify({sourceId:'default', localPath:path});
              let response;
              if (window.pmbrainDesktop) response = await window.pmbrainDesktop.productRequest({path:'/admin/api/sources/local-path', method:'POST', headers:{'Content-Type':'application/json'}, body});
              else { const native = await fetch('/admin/api/sources/local-path', {method:'POST', headers:{'Content-Type':'application/json'}, body}); response = {status:native.status, body:await native.text()}; }
              if (response.status >= 400) throw new Error(response.body);
            }""", str(materials))
            (materials / 'first.md').write_text('# First\n\nDelayed synthetic embedding verifies the maintenance list.', encoding='utf-8')
            tasks.waiting.clear()
            tasks.release.clear()
            tasks.delay = True
            page.get_by_role('button', name='快速维护', exact=True).click()
            page.locator('.maintenance-run-row').first.wait_for()
            (artifacts / 'accepted-dom.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
            assert tasks.waiting.wait(20), 'Quick maintenance never reached model wait'
            page.screenshot(path=str(artifacts / 'before-running-selector.png'), full_page=True)
            (artifacts / 'running-dom.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
            (artifacts / 'page-errors.json').write_text(json.dumps(errors), encoding='utf-8')
            running = page.locator('.maintenance-run-row').filter(has=page.locator('.maintenance-state-running'))
            running.first.wait_for()
            expect(page.locator('.maintenance-task-dialog[open]')).to_have_count(0)
            page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
            page.screenshot(path=str(artifacts / 'running-list.png'), full_page=True)
            running.first.click()
            detail = page.get_by_role('dialog', name='快速维护详情', exact=True)
            expect(detail).to_be_visible()
            expect(detail.locator('.product-task-steps')).to_be_visible()
            assert '[pmbrain phase]' not in page.locator('body').inner_text()
            page.screenshot(path=str(artifacts / 'running-detail.png'), full_page=True)
            page.mouse.click(70, 90)
            expect(page.locator('.maintenance-task-dialog[open]')).to_have_count(0)
            page.get_by_role('button', name='知识库', exact=True).click()
            page.screenshot(path=str(artifacts / 'navigated-knowledge.png'), full_page=True)
            (artifacts / 'navigated-dom.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
            page.get_by_role('heading', name='知识库', exact=True).wait_for()
            page.get_by_role('button', name='知识整理', exact=True).click()
            page.reload()
            page.locator('.maintenance-run-row').first.wait_for()
            assert page.locator('.maintenance-task-dialog[open]').count() == 0
            tasks.delay = False
            tasks.release.set()
            expect(page.locator('.maintenance-run-row').first).to_contain_text(re.compile('已完成|部分完成'), timeout=45000)
            quick_outcome = page.locator('.maintenance-run-row').first.inner_text()
            page.locator('.maintenance-run-row').first.click()
            expect(page.get_by_role('dialog')).to_contain_text('本轮已完成')
            expect(page.get_by_role('dialog').locator('[role=progressbar]')).to_have_count(0)
            expect(page.get_by_role('dialog')).to_contain_text('本轮成果')
            page.evaluate("document.documentElement.setAttribute('data-theme','light')")
            page.set_viewport_size({'width': 1100, 'height': 850})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(artifacts / 'completed-detail.png'), full_page=True)
            page.get_by_role('button', name='关闭整理详情', exact=True).click()
            page.screenshot(path=str(artifacts / 'completed-list.png'), full_page=True)
            (materials / 'second.md').write_text('# Second\n\nDelayed synthetic embedding verifies stopping a task.', encoding='utf-8')
            tasks.waiting.clear()
            tasks.release.clear()
            tasks.delay = True
            page.get_by_role('button', name='快速维护', exact=True).click()
            assert tasks.waiting.wait(20), 'Second quick task never reached model wait'
            page.locator('.maintenance-run-row').filter(has=page.locator('.maintenance-state-running')).first.click()
            page.get_by_role('button', name='停止任务', exact=True).click()
            expect(page.get_by_role('dialog')).to_contain_text('已停止', timeout=15000)
            page.get_by_role('button', name='关闭整理详情', exact=True).click()
            page.get_by_role('button', name='AI 深度整理', exact=True).click()
            expect(page.locator('.maintenance-run-row').first).to_contain_text('AI 深度整理', timeout=15000)
            page.locator('.maintenance-run-row').first.click()
            expect(page.get_by_role('dialog', name='AI 深度整理详情', exact=True)).to_be_visible()
            page.get_by_role('button', name='停止任务', exact=True).click()
            expect(page.get_by_role('dialog')).to_contain_text('已停止', timeout=15000)
            tasks.delay = False
            tasks.release.set()
            page.reload()
            expect(page.get_by_role('dialog', name='AI 深度整理详情', exact=True)).to_contain_text('已停止', timeout=15000)
            page.get_by_role('button', name='关闭整理详情', exact=True).click()
            expect(page.locator('.maintenance-run-row')).to_have_count(3)
            assert not errors, errors
            (artifacts / 'result.json').write_text(json.dumps({'passed': True, 'runtime': args.runtime, 'desktop': args.desktop, 'quick_outcome': quick_outcome, 'checks': ['quick_gui_start', 'real_running_list', 'timeline_details', 'outside_click_close', 'navigate_during_task', 'reload_running', 'completed_round_results', 'quick_cancel', 'full_gui_start_and_cancel', 'reload_history_and_detail', 'dark_light_1440_1100'], 'browser_errors': errors}, ensure_ascii=False), encoding='utf-8')
            print('Maintenance task list journey passed')
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
    parser.add_argument('--knowledge-only', action='store_true')
    run(parser.parse_args())
