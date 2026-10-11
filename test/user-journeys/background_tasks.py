import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote
from urllib.request import Request, build_opener, HTTPCookieProcessor
from urllib.error import HTTPError
import zipfile
from playwright.sync_api import sync_playwright
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[2]
TOKEN = 'background_task_test_only_12345678901234567890'
waiting = threading.Event()
release = threading.Event()
delay = False


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def response(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.response({'object': 'list', 'data': [{'id': 'task-test', 'object': 'model'}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        if self.path.endswith('/embeddings'):
            if delay and 'Delayed synthetic embedding' in json.dumps(body.get('input')):
                waiting.set()
                release.wait(120)
            inputs = body.get('input', [])
            if not isinstance(inputs, list):
                inputs = [inputs]
            self.response({'object': 'list', 'data': [{'object': 'embedding', 'index': i, 'embedding': [1.0] + [0.0] * 1023} for i in range(len(inputs))], 'model': 'task-test', 'usage': {'prompt_tokens': 1, 'total_tokens': 1}})
        else:
            if body.get('stream'):
                chunks = [{'id': 'background-chat', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'task-test', 'choices': [{'index': 0, 'finish_reason': None, 'delta': {'role': 'assistant', 'content': '后台导入期间仍可对话'}}]}, {'id': 'background-chat', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'task-test', 'choices': [{'index': 0, 'finish_reason': 'stop', 'delta': {}}]}]
                data = (''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks) + 'data: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.response({'id': 'background-chat', 'object': 'chat.completion', 'created': int(time.time()), 'model': 'task-test', 'choices': [{'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': '后台导入期间仍可对话'}}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def run(args):
    global delay
    artifacts = Path(args.artifacts_dir).resolve()
    artifacts.mkdir(parents=True, exist_ok=False)
    home = artifacts / 'home'
    config_dir = home / '.pmbrain'
    config_dir.mkdir(parents=True)
    materials = artifacts / 'materials'
    materials.mkdir()
    (materials / 'seed.md').write_text('# Seed\n\nbackground task acceptance seed.', encoding='utf-8')
    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    config = {'engine': 'pglite', 'database_path': str(config_dir / 'db'), 'embedding_model': 'custom-openai:task-test', 'embedding_dimensions': 1024, 'chat_model': 'custom-openai:task-test', 'custom_openai_api_key': 'task-only', 'provider_base_urls': {'custom-openai': f'http://127.0.0.1:{provider.server_port}/v1'}, 'model_usage': {'embedding_enabled': True, 'generative_enabled': True}, 'desktop': {'knowledge_directory': str(materials)}}
    (config_dir / 'config.json').write_text(json.dumps(config), encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.startswith(('PMBRAIN_', 'GBRAIN_')) and not key.endswith('_API_KEY')}
    env.update({'PMBRAIN_HOME': str(home), 'GBRAIN_HOME': str(home), 'PMBRAIN_ADMIN_BOOTSTRAP_TOKEN': TOKEN, 'PMBRAIN_DIAGNOSTIC_MODE': '1'})
    for key in ['DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
        env.pop(key, None)
    init = 'import {PGLiteEngine} from "./src/core/pglite-engine.ts"; import {configureGateway} from "./src/core/ai/gateway.ts"; import {loadConfig} from "./src/core/config.ts"; configureGateway({embedding_model:"custom-openai:task-test",embedding_dimensions:1024,env:{}}); const e=new PGLiteEngine(); await e.connect(loadConfig()); await e.initSchema(); await e.disconnect();'
    if args.database_only:
        init = init.replace('await e.disconnect();', 'await e.putPage("compiled-probe", {type:"note", title:"Compiled probe", compiled_truth:"Synthetic isolated database probe", frontmatter:{}}); await e.disconnect();')
    with (artifacts / 'init.log').open('w', encoding='utf-8') as log:
        subprocess.run([shutil.which('bun'), '--eval', init], cwd=ROOT, env=env, stdout=log, stderr=log, check=True, timeout=60)
    if args.runtime == 'bundled':
        runtime = ROOT / 'desktop/build/extraResources/pmbrain-runtime'
        entry = [str(runtime / 'bun.exe'), str(runtime / 'pmbrain-sidecar.js')]
    elif args.runtime == 'compiled':
        entry = [str(ROOT / 'bin/pmbrain.exe')]
    elif args.runtime == 'worker-load':
        entry = [shutil.which('bun'), str(ROOT / 'test/helpers/serve-worker-load.ts')]
    else:
        entry = [shutil.which('bun'), str(ROOT / 'src/cli.ts')]
    service_port = port()
    origin = f'http://127.0.0.1:{service_port}'
    opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(path, payload=None, raw=None, headers=None):
        data = raw if raw is not None else json.dumps(payload).encode() if payload is not None else None
        req = Request(origin + path, data=data, headers=headers or {'Content-Type': 'application/json'})
        with opener.open(req, timeout=20) as response:
            if path == '/mcp':
                return response.read().decode('utf-8')
            return json.load(response)

    def start():
        log = (artifacts / f'service-{time.time_ns()}.log').open('w', encoding='utf-8')
        process = subprocess.Popen(entry + ['serve', '--http', '--port', str(service_port), '--suppress-bootstrap-token'], cwd=artifacts if args.database_only else ROOT, env=env, stdin=subprocess.PIPE, stdout=log, stderr=log)
        deadline = time.time() + 60
        while time.time() < deadline:
            if process.poll() is not None:
                raise AssertionError('Sidecar exited before startup')
            try:
                request('/health')
                request('/admin/login', {'token': TOKEN})
                return process, log
            except Exception:
                time.sleep(.2)
        raise AssertionError('Sidecar startup timed out')

    def stop(process, log):
        process.terminate()
        process.wait(timeout=20)
        log.close()

    def finished(id):
        deadline = time.time() + 45
        while time.time() < deadline:
            result = request('/admin/api/runs/' + id)
            if result['status'] not in ['queued', 'running']:
                return result
            time.sleep(.15)
        raise AssertionError('Background task timed out: ' + id)

    process, log = start()
    try:
        if args.database_only:
            assert request('/admin/api/brain/pages/default/compiled-probe')['title'] == 'Compiled probe'
            assert request('/admin/api/workbench/models')['models']
            stop(process, log)
            process, log = start()
            assert request('/admin/api/brain/pages/default/compiled-probe')['compiled_truth'] == 'Synthetic isolated database probe'
            (artifacts / 'result.json').write_text(json.dumps({'runtime': args.runtime, 'passed': True, 'checks': ['standalone_worker_database_read', 'model_configuration', 'database_reopen_preserves_page'], 'cwd': str(artifacts)}, ensure_ascii=False), encoding='utf-8')
            print('Compiled database worker probe passed')
            return
        accepted = request('/admin/api/import-runs', {'path': str(materials / 'seed.md')})
        seed = finished(accepted['runId'])
        assert seed['status'] == 'completed', seed
        assert seed['command'] == [], seed
        assert seed['result']['imported'] == 1
        assert seed['product']['percent'] == 100
        assert seed['product']['name'] == '导入资料'
        if args.runtime == 'worker-load':
            process.stdin.write(b'load\n')
            process.stdin.flush()
            deadline = time.monotonic() + 15
            while not (home / 'load-started').exists() and time.monotonic() < deadline:
                time.sleep(.02)
            assert (home / 'load-started').exists()
            assert not (home / 'load-finished').exists()
            started = time.monotonic()
            assert request('/admin/api/workbench/models')['models']
            thread = request('/admin/api/workbench/conversations', {'model': 'custom-openai:task-test', 'knowledge': False})
            request('/admin/api/workbench/conversations/' + thread['id'] + '/messages', {'text': '数据库忙时仍能普通对话', 'knowledge': False})
            with opener.open(origin + '/admin/', timeout=2) as response:
                assert response.status == 200
            assert time.monotonic() - started < 2
            assert not (home / 'load-finished').exists(), 'Service checks completed only after the heavy query'
            deadline = time.monotonic() + 30
            while not (home / 'load-finished').exists() and time.monotonic() < deadline:
                time.sleep(.02)
            assert (home / 'load-finished').exists()
        slow_path = materials / 'slow.md'
        slow_path.write_text('# Slow\n\nDelayed synthetic embedding verifies concurrent application access.', encoding='utf-8')
        delay = True
        slow = request('/admin/api/import-runs', {'path': str(slow_path)})
        assert waiting.wait(15), 'Embedding request was not started'
        snapshot = request('/admin/api/task-center')
        assert not snapshot['pglite_busy']
        assert request('/admin/api/brain/pages/default/seed')['slug'] == 'seed'
        key = request('/admin/api/api-keys', {'name': 'background-read-only', 'scopes': ['read'], 'sourceId': 'default'})
        mcp = request('/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'get_page', 'arguments': {'slug': 'seed'}}}, headers={'Authorization': 'Bearer ' + key['token'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
        assert 'acceptance seed' in json.dumps(mcp), mcp
        search = request('/mcp', {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'search', 'arguments': {'query': 'acceptance seed', 'limit': 5}}}, headers={'Authorization': 'Bearer ' + key['token'], 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
        assert 'acceptance seed' in search, search
        conversation = request('/admin/api/workbench/conversations', {'model': 'custom-openai:task-test', 'knowledge': False})
        request('/admin/api/workbench/conversations/' + conversation['id'] + '/messages', {'text': '请确认后台任务期间仍可对话', 'knowledge': False})
        deadline = time.time() + 15
        while time.time() < deadline:
            chat = request('/admin/api/workbench/conversations/' + conversation['id'])
            if any(message['role'] == 'assistant' and '仍可对话' in message['text'] for message in chat['messages']):
                break
            time.sleep(.15)
        else:
            raise AssertionError('Chat did not finish while import was waiting')
        request('/admin/api/runs/' + slow['runId'] + '/cancel', {})
        assert finished(slow['runId'])['status'] == 'cancelled'
        delay = False
        release.set()
        try:
            request('/admin/api/brain/pages/default/slow')
            raise AssertionError('Cancelled import wrote a late page')
        except HTTPError as error:
            assert error.code == 404
        pdf = artifacts / 'office.pdf'
        document = canvas.Canvas(str(pdf))
        document.drawString(72, 720, 'Background PDF task acceptance content.')
        document.save()
        docx = artifacts / 'office.docx'
        with zipfile.ZipFile(docx, 'w') as archive:
            archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
            archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Background DOCX task acceptance.</w:t></w:r></w:p></w:body></w:document>')
        for file in [pdf, docx]:
            upload = request('/admin/api/import-upload-runs', raw=file.read_bytes(), headers={'Content-Type': 'application/octet-stream', 'x-pmbrain-filename': quote(file.name)})
            result = finished(upload['runId'])
            assert result['status'] == 'completed', result
        pending_path = materials / 'pending.md'
        pending_path.write_text('# Pending\n\nDelayed synthetic embedding verifies quick maintenance concurrent access.', encoding='utf-8')
        request('/admin/api/sources/local-path', {'sourceId': 'default', 'localPath': str(materials)})
        waiting.clear()
        release.clear()
        delay = True
        live_quick = request('/admin/api/dream-runs', {'preset': 'quick', 'sourceId': 'default'})
        if not waiting.wait(20):
            (artifacts / 'quick-wait-failure.json').write_text(json.dumps(request('/admin/api/runs/' + live_quick['runId']), ensure_ascii=False), encoding='utf-8')
            raise AssertionError('Quick maintenance never reached the delayed model')
        read_started = time.monotonic()
        assert request('/admin/api/brain/pages/default/seed')['slug'] == 'seed'
        live_progress = request('/admin/api/runs/' + live_quick['runId'])
        assert live_progress['status'] == 'running'
        assert len(live_progress['product']['steps']) == 5
        request('/admin/api/dream/overview')
        assert time.monotonic() - read_started < 5, 'Quick maintenance blocked knowledge and overview reads'
        if not args.no_browser:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel='msedge', headless=True)
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                context.add_init_script("localStorage.setItem('pmbrain.admin.theme-mode', 'dark')")
                context.request.post(origin + '/admin/login', data={'token': TOKEN})
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(origin + '/admin/#dream')
                page.locator('.maintenance-run-row').filter(has=page.locator('.maintenance-state-running')).first.click()
                progress = page.locator('.maintenance-task-dialog .product-task-progress')
                progress.wait_for()
                assert '同步资料' in progress.inner_text() or '更新搜索索引' in progress.inner_text()
                assert '快速维护' in page.locator('.maintenance-task-dialog').inner_text()
                assert '正在了解你的知识库' not in page.locator('body').inner_text()
                assert '[pmbrain phase]' not in page.locator('body').inner_text()
                page.screenshot(path=str(artifacts / 'quick-running.png'), full_page=True)
                page.goto(origin + '/admin/#tasks?run=' + live_quick['runId'])
                page.locator('.task-detail-drawer .product-task-progress').wait_for()
                assert page.locator('.task-technical-details').get_attribute('open') is None
                assert '[pmbrain phase]' not in page.locator('body').inner_text()
                page.get_by_role('button', name='关闭任务详情').click()
                assert page.locator('.task-table tbody tr').count() > 0
                page.goto(origin + '/admin/#settings-diagnostics')
                page.get_by_role('heading', name='诊断与日志', exact=True).wait_for()
                page.get_by_role('tab', name='后台任务日志', exact=True).click()
                page.get_by_role('heading', name='后台任务技术日志', exact=True).wait_for()
                assert page.locator('.diagnostic-card details').get_attribute('open') is None
                page.screenshot(path=str(artifacts / 'diagnostics-dark.png'), full_page=True)
                page.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
                page.set_viewport_size({'width': 1100, 'height': 850})
                page.screenshot(path=str(artifacts / 'diagnostics-light.png'), full_page=True)
                assert not errors, errors
                browser.close()
        delay = False
        release.set()
        assert finished(live_quick['runId'])['status'] == 'completed'
        quick = request('/admin/api/dream-runs', {'preset': 'quick', 'dryRun': True})
        assert finished(quick['runId'])['status'] == 'completed'
        deep = request('/admin/api/dream-runs', {'preset': 'full', 'dryRun': True})
        assert finished(deep['runId'])['status'] == 'completed'
        missing = request('/admin/api/import-runs', {'path': str(materials / 'missing.md')})
        assert finished(missing['runId'])['status'] == 'failed'
        (materials / 'missing.md').write_text('# Recovered\n\nExplicit retry now imports this source.', encoding='utf-8')
        retry = request('/admin/api/runs/' + missing['runId'] + '/retry', {})
        assert finished(retry['runId'])['status'] == 'completed'
        if not args.no_browser:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel='msedge', headless=True)
                context = browser.new_context(viewport={'width': 1440, 'height': 1000})
                context.add_init_script("localStorage.setItem('pmbrain.admin.theme-mode', 'dark')")
                context.request.post(origin + '/admin/login', data={'token': TOKEN})
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(origin + '/admin/#tasks')
                page.wait_for_load_state('networkidle')
                page.get_by_role('heading', name='任务中心', exact=True).wait_for()
                page.get_by_text('新增资料 1', exact=False).first.wait_for()
                page.get_by_role('button', name='重试', exact=True).first.wait_for()
                page.get_by_role('button', name='查看详情', exact=True).first.click()
                page.locator('.task-detail-drawer .product-task-progress').wait_for()
                assert page.locator('.task-technical-details').get_attribute('open') is None
                page.get_by_text('技术日志', exact=True).click()
                page.locator('.task-technical-details .run-output').wait_for()
                page.screenshot(path=str(artifacts / 'tasks.png'), full_page=True)
                assert not errors, errors
                browser.close()
        stop(process, log)
        process, log = start()
        assert finished(seed['id'])['result']['imported'] == 1
        assert finished(seed['id'])['product'] == seed['product']
        assert request('/admin/api/brain/pages/default/seed')['slug'] == 'seed'
        assert request('/admin/api/workbench/conversations/' + conversation['id'])['messages'][-1]['text'] == '后台导入期间仍可对话'
        if args.desktop:
            from core_journeys import DesktopSession
            stop(process, log)
            with sync_playwright() as playwright:
                session = DesktopSession(playwright, artifacts, home)
                desktop_page = session.start()
                try:
                    desktop_page.evaluate("""async () => {
                      const deadline = Date.now() + 120000;
                      while (Date.now() < deadline) {
                        const state = await window.pmbrainDesktop.getState();
                        if (state?.phase === 'ready') {
                          const response = await window.pmbrainDesktop.productRequest({path: '/admin/api/runs?summary=1'});
                          if (response.status === 200) return;
                        }
                        if (state?.phase === 'failed') throw new Error(state.message);
                        await new Promise(resolve => setTimeout(resolve, 100));
                      }
                      throw new Error('Desktop service did not become ready');
                    }""")
                    desktop_page.locator('.product-nav').wait_for()
                    def desktop_request(path, body=None):
                        return desktop_page.evaluate("""async ({path, body}) => {
                          const response = await window.pmbrainDesktop.productRequest({path, method: body === null ? 'GET' : 'POST', headers: {'Content-Type': 'application/json'}, body: body === null ? undefined : JSON.stringify(body)});
                          if (response.status >= 400) throw new Error(response.body);
                          return JSON.parse(response.body);
                        }""", {'path': path, 'body': body})
                    (materials / 'desktop-pending.md').write_text('# Desktop pending\n\nDelayed synthetic embedding verifies Desktop settings during quick maintenance.', encoding='utf-8')
                    waiting.clear()
                    release.clear()
                    delay = True
                    desktop_quick = desktop_request('/admin/api/dream-runs', {'preset': 'quick', 'sourceId': 'default'})
                    assert waiting.wait(20), 'Desktop quick maintenance did not reach the delayed model'
                    desktop_page.get_by_role('button', name='设置', exact=True).click()
                    settings_started = time.monotonic()
                    desktop_page.locator('.model-services').wait_for(timeout=5000)
                    assert time.monotonic() - settings_started < 5
                    desktop_page.get_by_role('button', name='知识库模型配置', exact=True).click()
                    desktop_page.locator('.model-services.is-roles').wait_for(timeout=5000)
                    desktop_page.screenshot(path=str(artifacts / 'desktop-model-roles-running.png'), full_page=True)
                    desktop_page.get_by_role('button', name='MCP 接入', exact=True).click()
                    desktop_page.locator('.mcp-endpoint-card').first.wait_for(timeout=5000)
                    service = desktop_page.evaluate('window.pmbrainDesktop.getState()')
                    assert f"http://127.0.0.1:{service['port']}/mcp" in desktop_page.locator('.mcp-endpoint-card').first.inner_text()
                    desktop_page.locator('.agents-section').get_by_text('background-read-only', exact=True).wait_for(timeout=5000)
                    desktop_page.screenshot(path=str(artifacts / 'desktop-mcp-running.png'), full_page=True)
                    desktop_page.get_by_role('button', name='返回', exact=True).click()
                    desktop_page.get_by_role('button', name='知识助手', exact=True).click()
                    desktop_page.get_by_label('对话模型', exact=True).select_option('custom-openai:task-test')
                    desktop_page.get_by_role('checkbox', name='知识库', exact=True).uncheck()
                    desktop_page.get_by_label('消息', exact=True).fill('维护期间验证普通对话')
                    desktop_page.get_by_role('button', name='发送消息', exact=True).click()
                    desktop_page.get_by_role('article', name='助手回答', exact=True).last.get_by_text('后台导入期间仍可对话', exact=True).wait_for(timeout=5000)
                    desktop_page.screenshot(path=str(artifacts / 'desktop-chat-running.png'), full_page=True)
                    desktop_page.get_by_role('button', name='知识整理', exact=True).click()
                    desktop_page.locator('.maintenance-run-row').filter(has=desktop_page.locator('.maintenance-state-running')).first.click()
                    desktop_page.locator('.maintenance-task-dialog .product-task-progress').wait_for()
                    assert '快速维护' in desktop_page.locator('.maintenance-task-dialog').inner_text()
                    assert '[pmbrain phase]' not in desktop_page.locator('body').inner_text()
                    desktop_page.screenshot(path=str(artifacts / 'desktop-quick-running.png'), full_page=True)
                    desktop_page.get_by_role('button', name='关闭整理详情', exact=True).click()
                    desktop_page.get_by_role('button', name='任务中心', exact=True).click()
                    desktop_page.locator('.task-table').wait_for()
                    desktop_page.screenshot(path=str(artifacts / 'desktop-task-center.png'), full_page=True)
                    desktop_page.get_by_role('button', name='设置', exact=True).click()
                    desktop_page.get_by_role('button', name='诊断与日志', exact=True).click()
                    desktop_page.get_by_role('heading', name='诊断与日志', exact=True).wait_for()
                    desktop_page.get_by_role('button', name='复制诊断信息', exact=True).click()
                    desktop_page.get_by_text('诊断信息已复制', exact=True).wait_for()
                    desktop_page.screenshot(path=str(artifacts / 'desktop-diagnostics.png'), full_page=True)
                    delay = False
                    release.set()
                    deadline = time.time() + 45
                    while time.time() < deadline:
                        terminal = desktop_request('/admin/api/runs/' + desktop_quick['runId'])
                        if terminal['status'] not in ['running', 'queued']:
                            assert terminal['status'] == 'completed', terminal
                            assert terminal['product']['percent'] == 100
                            break
                        time.sleep(.2)
                    else:
                        raise AssertionError('Desktop quick maintenance did not finish')
                    desktop_page.get_by_role('button', name='返回', exact=True).click()
                    desktop_page.get_by_role('button', name='知识整理', exact=True).click()
                    desktop_page.locator('.maintenance-run-row').first.click()
                    desktop_page.locator('.maintenance-task-dialog .product-task-progress').wait_for()
                    desktop_page.locator('.maintenance-task-dialog').get_by_text('100%', exact=True).first.wait_for(timeout=5000)
                    assert '快速维护' in desktop_page.locator('.maintenance-task-dialog').inner_text()
                    desktop_page.screenshot(path=str(artifacts / 'desktop-quick-completed.png'), full_page=True)
                finally:
                    delay = False
                    release.set()
                    session.stop()
        checks = ['native_import', 'slow_model_database_read', 'concurrent_mcp_read_search', 'concurrent_chat', 'cancel_no_late_write', 'PDF', 'DOCX', 'quick', 'quick_model_wait_read_and_overview', 'product_progress_persistence', 'full_dry_run', 'explicit_retry', 'restart_history', 'restart_chat']
        if args.desktop:
            checks.extend(['real_desktop_model_settings_during_quick_maintenance', 'real_desktop_mcp_origin_and_credentials', 'real_desktop_model_selection_and_chat_during_quick_maintenance'])
        if args.runtime == 'worker-load':
            checks.append('real_http_models_chat_and_static_during_heavy_database_query')
        if not args.no_browser:
            checks.extend(['task_center_browser', 'quick_running_gui', 'diagnostics_dark_light'])
        (artifacts / 'result.json').write_text(json.dumps({'runtime': args.runtime, 'passed': True, 'checks': checks}, ensure_ascii=False), encoding='utf-8')
        print('Background task journey passed: ' + args.runtime)
    finally:
        delay = False
        release.set()
        if process.poll() is None:
            stop(process, log)
        provider.shutdown()
        provider.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    parser.add_argument('--runtime', choices=['source', 'bundled', 'compiled', 'worker-load'], default='source')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--desktop', action='store_true')
    parser.add_argument('--database-only', action='store_true')
    run(parser.parse_args())
