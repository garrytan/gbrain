import argparse
import json
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect


class Assets(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(Path(__file__).resolve().parents[2] / 'admin/dist'), **kwargs)

    def translate_path(self, path):
        return super().translate_path(path.replace('/admin/', '/', 1))

    def log_message(self, *args):
        pass


def run(output):
    output.mkdir(parents=True, exist_ok=False)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Assets)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel='msedge', headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            page = context.new_page()
            errors = []
            requests = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('response', lambda response: requests.append([response.status, response.url]))
            page.on('requestfailed', lambda request: requests.append([request.failure, request.url]))

            def mock(route):
                path = urlparse(route.request.url).path
                data, status = {'error': '此隔离测试未提供该服务'}, 503
                if path.endswith('/workbench/availability'):
                    status, data = 200, {'serviceReady': True, 'databaseReady': True}
                elif path.endswith('/workbench/models'):
                    status, data = 200, {'models': [{'id': 'ollama:test', 'name': '测试模型'}]}
                elif path.endswith('/workbench/assistant'):
                    status, data = 200, {'name': '知识库助手', 'emoji': '知', 'model': '', 'knowledge': False, 'systemPrompt': '', 'temperature': None, 'context': {'maxMessages': 24, 'threshold': .8, 'summaryModel': ''}}
                elif path.endswith('/workbench/conversations'):
                    status, data = 503, {'error': '会话记录读取失败'}
                elif path.endswith('/agents'):
                    status, data = 503, {'error': 'Agent 服务读取失败'}
                elif path.endswith('/brain/overview'):
                    status, data = 503, {'error': '数据库正在执行查询'}
                elif path.endswith('/runs'):
                    status, data = 200, []
                route.fulfill(status=status, content_type='application/json', body=json.dumps(data, ensure_ascii=False))

            page.route('**/admin/api/**', mock)
            page.goto(f'http://127.0.0.1:{server.server_port}/admin/#assistant')
            page.wait_for_load_state('networkidle')
            expect(page.get_by_label('对话模型', exact=True)).to_have_value('ollama:test')
            page.get_by_label('对话模型', exact=True).select_option('ollama:test')
            expect(page.get_by_role('alert')).to_contain_text('会话记录读取失败')
            page.screenshot(path=str(output / 'independent-models.png'), full_page=True)
            page.goto(f'http://127.0.0.1:{server.server_port}/admin/#settings-integrations')
            page.wait_for_load_state('networkidle')
            (output / 'mcp-state.txt').write_text(page.locator('body').inner_text() + '\n' + json.dumps(errors), encoding='utf-8')
            try:
                expect(page.get_by_role('heading', name='MCP 接入')).to_be_visible()
            finally:
                (output / 'mcp-network.json').write_text(json.dumps(requests, ensure_ascii=False), encoding='utf-8')
                (output / 'mcp-state.txt').write_text(page.locator('body').inner_text() + '\n' + json.dumps(errors), encoding='utf-8')
            expect(page.locator('.mcp-endpoint-card').first).to_contain_text(f'http://127.0.0.1:{server.server_port}/mcp')
            expect(page.locator('.agents-section').get_by_role('alert')).to_contain_text('Agent 服务读取失败')
            expect(page.get_by_text('暂无已注册 Agent。请先注册第一个 Agent。', exact=True)).to_have_count(0)
            page.screenshot(path=str(output / 'mcp-native-error.png'), full_page=True)
            assert not errors, errors
            (output / 'result.json').write_text(json.dumps({'passed': True, 'checks': ['models_independent_of_history', 'models_selectable_on_history_error', 'agent_error_not_empty', 'actual_browser_mcp_origin'], 'browser_errors': errors}), encoding='utf-8')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts-dir', required=True)
    args = parser.parse_args()
    run(Path(args.artifacts_dir).resolve())
