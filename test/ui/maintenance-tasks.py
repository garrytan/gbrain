import argparse
import json
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect


def run(args):
    output = Path(args.artifacts_dir).resolve()
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    requests = []
    reject = False
    date = '2026-10-03T14:30:00.000Z'
    steps = [{'id': key, 'label': label, 'status': 'completed' if index < 2 else 'running' if index == 2 else 'pending', 'phases': [key]} for index, (key, label) in enumerate([('check', '检查知识'), ('sync', '同步资料'), ('relations', '建立知识关联'), ('embed', '更新搜索索引'), ('finish', '完成检查')])]

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='msedge', headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script("localStorage.setItem('pmbrain.admin.theme-mode', 'dark')")
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def mock(route):
            path = urlparse(route.request.url).path
            data = {}
            status = 200
            if path.endswith('/runs'):
                data = rows
            elif path.endswith('/task-center'):
                data = {'mode': 'pglite', 'pglite_busy': False, 'rows': rows, 'queue': None, 'server_time': date}
            elif path.endswith('/workbench/availability'):
                data = {'serviceReady': True, 'databaseReady': True}
            elif path.endswith('/dream/schedule'):
                data = {'enabled': True, 'time': '02:00', 'timeZone': 'Asia/Shanghai', 'lastStartedDate': None}
            elif path.endswith('/brain/overview'):
                data = dict(version='1.4.19', engine='pglite', schema_pack='default', chat_model='test', embedding_model=None, embedding_dimensions=None, expansion_model=None, stats=dict(page_count=0, chunk_count=0, embedded_count=0, link_count=0, timeline_entry_count=0, pages_by_type={}), embedding_coverage=0, pending_embeddings=0, recent_write_at=None, sources=[], main_source_id='main-test', federated_source_count=0, provider_status={'providers': {}, 'chat': {'enabled': True, 'chat_model': 'test', 'provider': 'test', 'missing': []}}, llm_enabled=True, config={})
            elif path.endswith('/dream-runs'):
                if reject:
                    data = {'error': '模型当前不可用，请检查配置。'}
                    status = 403
                else:
                    body = route.request.post_data_json
                    requests.append(body)
                    quick = body['preset'] == 'quick'
                    name = '快速维护' if quick else 'AI 深度整理'
                    task = dict(id=f'task-{len(rows) + 1}', kind='dream_quick' if quick else 'dream_full', status='queued' if quick else 'running', command=[], stdout='[pmbrain phase] hidden', stderr='', error=None, exitCode=None, startedAt=date, completedAt=None, durationMs=185000, product=dict(name=name, stage='等待执行' if quick else '建立知识关联', percent=0 if quick else 40, phasePercent=None if quick else 63, completedSteps=2, steps=json.loads(json.dumps(steps)), total=None, processed=None, file=None, metrics=[], errorReason=None))
                    rows.insert(0, task)
                    data = {'runId': task['id'], 'status': task['status']}
            elif '/runs/' in path:
                task = next(row for row in rows if row['id'] == path.split('/runs/')[1].split('/')[0])
                if path.endswith('/files'):
                    after = int(route.request.url.split('after=')[-1]) if 'after=' in route.request.url else 0
                    data = {'rows': [{'id': after + i + 1, 'sourceId': 'main-test', 'path': f'file-{after + i}.md', 'status': 'failed' if after + i == 0 else 'completed', 'error': '文件格式不支持' if after + i == 0 else None} for i in range(50 if not after else 10)], 'next': 50 if not after else None}
                elif path.endswith('/retry'):
                    task.update(status='running', completedAt=None)
                    task['product'].update(stage='建立知识关联', percent=40, steps=json.loads(json.dumps(steps)))
                    data = {'runId': task['id'], 'status': task['status']}
                elif path.endswith('/cancel'):
                    task.update(status='cancelled', completedAt=date)
                    task['product']['stage'] = '任务已停止'
                    data = task
                else:
                    data = task
            route.fulfill(status=status, content_type='application/json', body=json.dumps(data, ensure_ascii=False))

        page.route('**/admin/api/**', mock)
        page.goto(args.url + '#dream')
        page.wait_for_load_state('networkidle')
        (output / 'initial-dom.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
        (output / 'initial-errors.json').write_text(json.dumps(errors), encoding='utf-8')
        page.screenshot(path=str(output / 'initial.png'), full_page=True)
        expect(page.get_by_role('heading', name='知识整理', exact=True)).to_be_visible()
        expect(page.get_by_text('暂无整理记录', exact=True)).to_be_visible()
        page.get_by_role('button', name='快速维护', exact=True).click()
        task = page.locator('.maintenance-run-row').first
        expect(task).to_contain_text('快速维护')
        assert requests[0]['allSources'] is True and requests[0]['dryRun'] is False
        expect(task).to_contain_text('排队中')
        rows[0]['status'] = 'running'
        rows[0]['product'].update(stage='建立知识关联', percent=40, phasePercent=63, syncScan={'scanned': 64, 'unchanged': 4}, syncFiles={'total': 60, 'completed': 58, 'failed': 1, 'remaining': 1})
        expect(task).to_contain_text('执行中', timeout=10000)
        assert task.locator('.maintenance-state-running svg').count() == 1
        assert page.locator('.maintenance-task-dialog[open]').count() == 0
        page.screenshot(path=str(output / 'list-dark.png'), full_page=True)
        task.click()
        dialog = page.get_by_role('dialog', name='快速维护详情', exact=True)
        expect(dialog).to_be_visible()
        expect(dialog).to_contain_text('建立知识关联')
        expect(dialog).to_contain_text('当前阶段 63%')
        expect(dialog).to_contain_text('待同步 60')
        expect(dialog).to_contain_text('未变化 4')
        dialog.locator('summary').filter(has_text='查看同步文件明细').click()
        expect(dialog).to_contain_text('file-0.md')
        expect(dialog).to_contain_text('文件格式不支持')
        page.get_by_role('button', name='加载更多', exact=True).click()
        expect(dialog).to_contain_text('file-59.md')
        expect(page.get_by_role('button', name='加载更多', exact=True)).to_have_count(0)
        page.get_by_role('button', name='刷新文件状态', exact=True).click()
        expect(dialog.get_by_text('file-59.md', exact=True)).to_have_count(0)
        assert dialog.locator('.step-running').count() == 1
        assert '[pmbrain phase]' not in page.locator('body').inner_text()
        page.screenshot(path=str(output / 'detail-dark.png'), full_page=True)
        page.reload()
        expect(page.get_by_role('dialog', name='快速维护详情', exact=True)).to_be_visible()
        page.get_by_role('button', name='关闭整理详情', exact=True).click()
        assert page.locator('.maintenance-task-dialog[open]').count() == 0
        task = page.locator('.maintenance-run-row').first
        task.focus()
        page.keyboard.press('Enter')
        page.get_by_role('button', name='停止任务', exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('已停止')
        assert page.get_by_role('button', name='停止任务', exact=True).count() == 0
        assert page.get_by_role('dialog').locator('.product-task-progress').evaluate("element => [...element.querySelectorAll('.product-task-steps svg')].every(icon => getComputedStyle(icon).animationName === 'none')")
        page.on('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='继续未完成任务', exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('执行中')
        page.get_by_role('button', name='停止任务', exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('已停止')
        page.keyboard.press('Escape')
        expect(page.locator('.maintenance-task-dialog[open]')).to_have_count(0)
        page.get_by_role('button', name='AI 深度整理', exact=True).click()
        expect(page.locator('.maintenance-run-row').first).to_contain_text('AI 深度整理')
        assert requests[-1]['sourceId'] == 'main-test' and requests[-1]['dryRun'] is False
        current = rows[0]
        current.update(status='completed', completedAt=date)
        current['product'].update(stage='整理完成', percent=100, completedSteps=5, metrics=[{'label': '新建关联', 'value': 26}])
        for step in current['product']['steps']:
            step['status'] = 'completed'
        expect(page.locator('.maintenance-run-row').first).to_contain_text('已完成', timeout=10000)
        page.locator('.maintenance-run-row').first.click()
        expect(page.get_by_role('dialog')).to_contain_text('新建关联')
        page.evaluate("document.documentElement.setAttribute('data-theme','light')")
        page.set_viewport_size({'width': 1100, 'height': 850})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(output / 'detail-light.png'), full_page=True)
        page.get_by_role('button', name='关闭整理详情', exact=True).click()
        page.screenshot(path=str(output / 'list-light.png'), full_page=True)
        page.reload()
        expect(page.locator('.maintenance-run-row')).to_have_count(2)
        assert page.locator('.maintenance-task-dialog[open]').count() == 0
        page.get_by_label('整理任务状态').select_option('completed')
        expect(page.locator('.maintenance-run-row')).to_have_count(1)
        reject = True
        page.get_by_role('button', name='AI 深度整理', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('模型当前不可用')
        assert len(rows) == 2
        reject = False
        partial = json.loads(json.dumps(current))
        partial.update(id='task-3', startedAt='2026-10-09T14:00:00Z')
        partial['product'].update(stage='部分完成，请查看未完成步骤', percent=0, total=1482, processed=0, completedSteps=1, errorReason='实体落库验收失败：目标未保存', metrics=[{'label': label, 'value': value} for label, value in [('待检查项', 2939), ('长期判断', 5), ('合并事实', 11), ('创建实体', 4), ('剩余页面', 1482)]], steps=[{'id': 'relations', 'label': '建立知识关联', 'status': 'completed', 'phases': ['extract']}, {'id': 'capture', 'label': '识别实体', 'status': 'failed', 'phases': ['capture_entities']}])
        rows.insert(0, partial)
        page.reload()
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
        partial_row = page.locator('.maintenance-run-row').first
        expect(partial_row).to_contain_text('本轮已完成')
        expect(partial_row).to_contain_text('长期判断 5')
        expect(partial_row).to_contain_text('待处理：待检查项 2939')
        assert '部分完成' not in partial_row.inner_text() and '0%' not in partial_row.inner_text()
        assert partial_row.locator('.maintenance-state-completed').count() == 1
        page.screenshot(path=str(output / 'round-list.png'), full_page=True)
        partial_row.click()
        dialog = page.get_by_role('dialog', name='AI 深度整理详情', exact=True)
        expect(dialog).to_contain_text('本轮成果')
        expect(dialog).to_contain_text('剩余事项')
        expect(dialog).to_contain_text('创建实体 4')
        expect(dialog).to_contain_text('剩余页面 1482')
        expect(dialog).to_contain_text('目标未保存')
        badge = dialog.locator('.product-task-state.state-completed')
        assert badge.evaluate("element => { const values=getComputedStyle(element).color.match(/\\d+/g).map(Number); return values[1]>values[0] && values[1]>values[2]; }")
        expect(dialog.locator('[role=progressbar]')).to_have_count(0)
        expect(dialog).to_contain_text('已处理 0 / 1482 份资料')
        dialog.get_by_role('heading', name='本轮成果', exact=True).click()
        expect(dialog).to_be_visible()
        page.screenshot(path=str(output / 'round-detail.png'), full_page=True)
        page.mouse.click(70, 90)
        expect(page.locator('.maintenance-task-dialog[open]')).to_have_count(0)
        assert 'run=' not in page.url
        page.get_by_label('整理任务状态').select_option('unfinished')
        expect(page.locator('.maintenance-run-row')).to_have_count(2)
        page.get_by_label('整理任务状态').select_option('all')
        rows[-1].update(status='completed', completedAt=date)
        rows[-1]['product'].update(stage='部分完成，请查看未完成步骤', percent=0)
        page.reload()
        page.locator('.maintenance-run-row').filter(has_text='快速维护').click()
        expect(page.get_by_role('button', name='继续未完成任务', exact=True)).to_be_visible()
        page.keyboard.press('Escape')
        failed = json.loads(json.dumps(partial))
        failed.update(id='task-4', status='failed', startedAt='2026-10-09T15:00:00Z', error='数据库执行失败')
        failed['product'].update(stage='任务失败', errorReason='数据库执行失败')
        rows.insert(0, failed)
        page.reload()
        failed_row = page.locator('.maintenance-run-row').first
        expect(failed_row.locator('.maintenance-state-failed')).to_contain_text('失败')
        assert '本轮已完成' not in failed_row.inner_text()
        failed_row.click()
        expect(page.get_by_role('dialog').get_by_role('alert')).to_contain_text('数据库执行失败')
        page.mouse.click(70, 90)
        page.get_by_role('button', name='任务中心', exact=True).click()
        task_row = page.locator('.task-table tbody tr').filter(has_text='长期判断 5').filter(has_text='本轮已完成')
        expect(task_row).to_have_count(1)
        expect(task_row).to_contain_text('待检查项 2939')
        assert '0%' not in task_row.inner_text() and '部分完成' not in task_row.inner_text()
        page.screenshot(path=str(output / 'round-task-center.png'), full_page=True)
        task_row.get_by_role('button', name='查看详情', exact=True).click()
        expect(page.get_by_label('任务详情', exact=True)).to_contain_text('本轮成果')
        page.mouse.click(70, 90)
        expect(page.get_by_label('任务详情', exact=True)).to_have_count(0)
        assert partial['product']['percent'] == 0 and partial['status'] == 'completed'
        assert not errors, errors
        (output / 'result.json').write_text(json.dumps({'passed': True, 'checks': ['quick_create', 'queued_to_running', 'full_main_source', 'list_spinner', 'click_details', 'keyboard_details', 'reload_details', 'cancel_stops_spinners', 'explicit_retry', 'completed_result', 'reload_history', 'filters', 'native_submit_error', 'dark_light', '1100_layout', 'green_round_result', 'outcomes_and_remaining', 'zero_pages_preserved', 'outside_click_close', 'inside_click_stays', 'unfinished_filter_and_retry', 'real_failure_red', 'task_center_round_parity'], 'browser_errors': errors}), encoding='utf-8')
        browser.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='')
    parser.add_argument('--artifacts-dir', required=True)
    args = parser.parse_args()
    server = None
    if not args.url:
        class Assets(SimpleHTTPRequestHandler):
            def __init__(self, *values, **kwargs):
                super().__init__(*values, directory=str(Path(__file__).resolve().parents[2] / 'admin/dist'), **kwargs)

            def translate_path(self, path):
                return super().translate_path(path.replace('/admin/', '/', 1))

            def log_message(self, *values):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Assets)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        args.url = f'http://127.0.0.1:{server.server_port}/admin/'
    try:
        run(args)
    finally:
        if server:
            server.shutdown()
            server.server_close()
