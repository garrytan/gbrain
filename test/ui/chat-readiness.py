import argparse
import importlib.util
import json
from pathlib import Path
from http.server import ThreadingHTTPServer
import threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect


spec = importlib.util.spec_from_file_location('availability_ui', Path(__file__).with_name('service-availability.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def run(output):
    output.mkdir(parents=True, exist_ok=False)
    server = ThreadingHTTPServer(('127.0.0.1', 0), assets.Assets)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks, errors = [], []
    state = {'database': False, 'http': True, 'default': 'deepseek:test'}
    conversations, sent = {}, []
    assistant = {'name': '知识库助手', 'emoji': '知', 'description': '', 'model': '', 'knowledge': True, 'systemPrompt': '', 'temperature': None, 'context': {'maxMessages': 24, 'threshold': .8, 'summaryModel': ''}}
    overview = {'version': '1.4.21', 'engine': 'pglite', 'schema_pack': 'full', 'chat_model': 'deepseek:test', 'embedding_model': None, 'embedding_dimensions': 1024, 'expansion_model': None, 'stats': {'page_count': 12, 'chunk_count': 24, 'embedded_count': 0, 'link_count': 5, 'tag_count': 3, 'timeline_entry_count': 2, 'pages_by_type': {'note': 12}}, 'embedding_coverage': 0, 'pending_embeddings': 24, 'recent_write_at': None, 'sources': [], 'main_source_id': 'default', 'federated_source_count': 0, 'provider_status': {'providers': {}, 'chat': {'enabled': True, 'chat_model': 'deepseek:test', 'provider': 'deepseek', 'missing': []}}, 'llm_enabled': True, 'config': {}}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel='msedge', headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            context.add_init_script('''
              localStorage.setItem('pmbrain.navCollapsed', '0');
              window.pmbrainDesktop = {
                getState: async () => ({phase: 'starting', port: location.port}),
                getSetup: async () => ({setup: {needsSetup: false}}),
                getTheme: async () => ({source: 'dark'}),
                getStartupProgress: async () => null,
                getUpdateState: async () => ({phase: 'idle'}),
                productRequest: async req => {
                  const response = await fetch(req.path, {method: req.method, headers: req.headers, body: req.body});
                  return {status: response.status, body: await response.text(), contentType: response.headers.get('Content-Type')};
                },
                onState: () => () => {}, onThemeState: () => () => {}, onNavigate: () => () => {},
                onShowPanel: () => () => {}, onShowUpdates: () => () => {},
                onStartupProgress: () => () => {}, onUpdateState: () => () => {}
              };
            ''')
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))

            def mock(route):
                path = urlparse(route.request.url).path
                method = route.request.method
                data, status = {'error': '隔离测试未提供该服务'}, 503
                if not state['http']:
                    data = {'error': 'HTTP 服务不可用'}
                elif path.endswith('/workbench/availability'):
                    status, data = 200, {'serviceReady': True, 'databaseReady': state['database']}
                elif path.endswith('/workbench/models'):
                    status, data = 200, {'defaultModel': state['default'], 'models': [{'id': 'ollama:test', 'name': 'Ollama'}, {'id': 'deepseek:test', 'name': 'DeepSeek'}]}
                elif path.endswith('/workbench/assistant'):
                    status, data = 200, assistant
                elif path.endswith('/workbench/conversations'):
                    status = 200
                    if method == 'POST':
                        body = route.request.post_data_json
                        identifier = str(len(conversations) + 1)
                        data = {'id': identifier, 'title': '新对话', 'model': body['model'], 'knowledge': body['knowledge'], 'createdAt': '2026-10-04T08:00:00Z', 'updatedAt': '2026-10-04T08:00:00Z', 'messages': []}
                        conversations[identifier] = data
                    else:
                        data = {'conversations': [{**value, 'messageCount': len(value['messages']), 'running': False} for value in conversations.values()]}
                elif '/workbench/conversations/' in path:
                    identifier = path.split('/conversations/')[1].split('/')[0]
                    status, data = 200, conversations[identifier]
                    if path.endswith('/messages'):
                        body = route.request.post_data_json
                        sent.append(body)
                        data['messages'] += [{'id': 'u' + str(len(sent)), 'role': 'user', 'text': body['text'], 'createdAt': data['createdAt'], 'status': 'complete'}, {'id': 'a' + str(len(sent)), 'role': 'assistant', 'text': '普通对话成功', 'createdAt': data['createdAt'], 'status': 'complete', 'knowledge': 'off', 'model': body['model']}]
                elif path.endswith('/brain/overview'):
                    status, data = 200, overview
                elif path.endswith('/runs') or path.endswith('/requests'):
                    status, data = 200, []
                route.fulfill(status=status, content_type='application/json', body=json.dumps(data, ensure_ascii=False))

            page.route('**/admin/api/**', mock)
            page.goto(f'http://127.0.0.1:{server.server_port}/admin/#home')
            home = page.locator('.home-page')
            expect(home.get_by_label('消息', exact=True)).to_be_visible()
            expect(home.get_by_label('对话模型', exact=True)).to_have_value('deepseek:test')
            expect(home.get_by_role('checkbox', name='知识库', exact=True)).to_be_disabled()
            expect(home.get_by_text('知识库正在准备，当前可进行普通对话。', exact=True)).to_be_visible()
            expect(home.locator('.home-card')).to_have_count(6)
            home.screenshot(path=str(output / 'home-database-preparing.png'))
            checks.append('starting_sidecar_http_ready_composer_visible_default_model')
            home.get_by_label('消息', exact=True).fill('数据库准备时普通对话')
            home.get_by_role('button', name='发送消息', exact=True).click()
            expect(page.get_by_role('article', name='助手回答', exact=True).last).to_contain_text('普通对话成功')
            assert sent[-1]['knowledge'] is False and sent[-1]['model'] == 'deepseek:test', sent
            checks.append('database_unavailable_plain_chat')
            model = page.get_by_label('对话模型', exact=True).filter(visible=True)
            expect(model).to_have_value('deepseek:test')
            model.select_option('ollama:test')
            page.get_by_role('navigation', name='PMBrain 主导航').get_by_role('button', name='首页', exact=True).click()
            expect(home.get_by_label('对话模型', exact=True)).to_have_value('ollama:test')
            page.get_by_role('navigation', name='PMBrain 主导航').get_by_role('button', name='知识助手', exact=True).click()
            expect(model).to_have_value('ollama:test')
            model.select_option('deepseek:test')
            page.evaluate("window.dispatchEvent(new Event('focus'))")
            expect(model).to_have_value('deepseek:test')
            checks.append('manual_selection_survives_page_and_focus')
            page.get_by_label('消息', exact=True).filter(visible=True).fill('保留这份草稿')
            state['http'] = False
            expect(page.get_by_role('button', name='发送消息', exact=True).filter(visible=True)).to_be_disabled(timeout=10000)
            expect(page.get_by_label('消息', exact=True).filter(visible=True)).to_have_value('保留这份草稿')
            state['http'], state['database'] = True, True
            expect(page.get_by_role('button', name='发送消息', exact=True).filter(visible=True)).to_be_enabled(timeout=10000)
            expect(page.get_by_role('checkbox', name='知识库', exact=True).filter(visible=True)).to_be_enabled()
            expect(page.get_by_label('消息', exact=True).filter(visible=True)).to_have_value('保留这份草稿')
            checks.append('http_outage_disables_send_preserves_composer_and_draft')
            page.get_by_role('navigation', name='PMBrain 主导航').get_by_role('button', name='首页', exact=True).click()
            home.get_by_role('button', name='总体概览').click()
            expect(page.get_by_role('heading', name='总体概览', exact=True)).to_be_visible()
            page.screenshot(path=str(output / 'existing-overview.png'), full_page=True)
            page.get_by_role('navigation', name='PMBrain 主导航').get_by_role('button', name='首页', exact=True).click()
            expect(home.get_by_role('heading', name='你好，开始探索你的知识')).to_be_visible()
            expect(home.locator('.home-card')).to_have_count(6)
            checks.append('home_card_opens_existing_overview_home_layout_unchanged')
            page.evaluate("localStorage.setItem('pmbrain.workbench.chatModel', 'deepseek:test'); localStorage.removeItem('pmbrain.workbench.chatModelDefault')")
            page.reload()
            expect(page.locator('.home-page').get_by_label('对话模型', exact=True)).to_have_value('deepseek:test')
            checks.append('legacy_manual_selection_survives_reload')
            assert not errors, errors
            browser.close()
        (output / 'result.json').write_text(json.dumps({'passed': True, 'checks': checks, 'browser_errors': errors}, ensure_ascii=False), encoding='utf-8')
        print('Chat readiness UI passed: ' + str(len(checks)) + ' checks')
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    run(Path(parser.parse_args().artifacts_dir).resolve())
