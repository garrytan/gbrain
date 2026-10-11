import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('PMBRAIN_UI_OUTPUT', str(Path(tempfile.gettempdir()) / 'pmbrain-product-polish')))
OUT.mkdir(parents=True, exist_ok=True)
BASE = os.environ.get('PMBRAIN_UI_URL', 'http://127.0.0.1:5192/admin/')
DATE = '2026-10-03T08:00:00.000Z'
STATS = dict(page_count=128, chunk_count=640, embedded_count=600, link_count=320, timeline_entry_count=42, pages_by_type={'document': 128})
OVERVIEW = dict(version='1.4.13', engine='pglite', schema_pack='default', chat_model='ollama:sample', embedding_model=None,
    embedding_dimensions=None, expansion_model=None, stats=STATS, embedding_coverage=93.75, pending_embeddings=40,
    recent_write_at=DATE, sources=[], main_source_id='default', federated_source_count=0, provider_status={'providers': {}, 'chat': {'enabled': True, 'chat_model': 'ollama:sample', 'provider': 'ollama', 'missing': []}},
    llm_enabled=True, generative_enabled=True, config={})
DREAM = dict(phase_catalog=['lint', 'sync', 'embed', 'orphans'], phase_capabilities=[], generative_enabled=True, generative_usage={'generative_enabled': True, 'capabilities': {'semantic_search': True, 'hybrid_search': True, 'vectorization': True, 'quick_maintenance': True, 'ai_deep_organize': True, 'ai_meeting_organize': True}}, overview=OVERVIEW, health=None,
    locks=[], runs=[], proposals=[], takes=None, grades=None, calibration={'latest': None, 'history': []},
    embeddings={'coverage': 93.75, 'pending': 40, 'by_source': []}, weights={'top_pages': []}, knowledge={'types': [], 'ingest': None}, lifecycle=None,
    jobs={'recent': [], 'status': [], 'subagent_status': [], 'subagent_queue': None}, supervisor={'running': False, 'supervisor_pid': None, 'pid_file': ''},
    quality={'takes_quality_runs': [], 'contradiction_runs': []})
ASSISTANT = dict(name='知识库助手', emoji='知', description='', systemPrompt='', model='ollama:sample', knowledge=True, temperature=None, context={'maxMessages': 24, 'threshold': .8, 'summaryModel': ''})
THREAD = dict(id='sample-thread', title='项目复盘', model='ollama:sample', knowledge=True, createdAt=DATE, updatedAt=DATE, messages=[
    dict(id='question', role='user', text='整理这次项目复盘里的主要结论。', status='complete', createdAt=DATE),
    dict(id='answer', role='assistant', text='这次复盘有三个结论：\n\n1. **先确认目标。** 在执行前把验收标准写清楚。\n2. **及时处理变化。** 把新增需求和已有承诺分开记录。\n3. **用结果验证。** 每次调整都保留可追溯的依据。\n\n参考了项目复盘资料 [1]。', status='complete', createdAt=DATE, model='ollama:sample', modelName='示例模型 · 本地', knowledge='used', citations=[dict(sourceId='default', slug='reviews/project', title='项目复盘', snippet='先确认目标，再执行。')])])
PAGE_ROW = dict(id=1, source_id='default', slug='reviews/project', title='项目复盘', type='document', updated_at=DATE, deleted_at=None, chunk_count=5, embedded_chunks=5, tag_count=0, frontmatter={}, preview='目标、变化与验收结果。')
THREAD['messages'][-1]['toolCalls'] = [
    dict(id='search', name='knowledge_search', input=json.dumps({'query': '项目复盘'}, ensure_ascii=False), status='complete', startedAt=DATE, completedAt=DATE, output=json.dumps({'results': [{'source_id': 'default', 'slug': 'reviews/project', 'title': '项目复盘'}]}, ensure_ascii=False)),
    dict(id='read', name='knowledge_read', input=json.dumps({'source_id': 'default', 'slug': 'reviews/project'}, ensure_ascii=False), status='complete', startedAt=DATE, completedAt=DATE, output=json.dumps({'content': '先确认目标，再执行。', 'source_id': 'default', 'slug': 'reviews/project'}, ensure_ascii=False)),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='msedge')
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    models = [dict(id='ollama:sample', name='示例模型 · 本地', contextWindow=32000), dict(id='ollama:other', name='备用模型 · 本地', contextWindow=8192)]
    imports = []
    failed = False
    def mock(route):
        nonlocal_path = urlparse(route.request.url).path
        data = {}
        status = 200
        if nonlocal_path.endswith('/workbench/models'): data = {'models': models}
        elif nonlocal_path.endswith('/workbench/assistant'): data = ASSISTANT
        elif nonlocal_path.endswith('/workbench/conversations'): data = {'conversations': [{**THREAD, 'messageCount': 2, 'running': False}]}
        elif '/workbench/conversations/' in nonlocal_path: data = THREAD
        elif nonlocal_path.endswith('/brain/overview'): data = OVERVIEW
        elif nonlocal_path.endswith('/brain/pages'): data = {'rows': [PAGE_ROW], 'total': 1, 'page': 1, 'limit': 10, 'pages': 1}
        elif nonlocal_path.endswith('/dream/overview'): data = DREAM
        elif nonlocal_path.endswith('/dream/schedule'): data = dict(enabled=True, time='02:00', timeZone='Asia/Shanghai', lastStartedDate=None)
        elif nonlocal_path.endswith('/import-runs') or nonlocal_path.endswith('/import-upload-runs'):
            imports.append({'path': nonlocal_path, 'body': route.request.post_data})
            data = dict(runId='sample-run', status='queued', fileName='示例.md')
        elif '/runs/sample-run' in nonlocal_path:
            data = dict(id='sample-run', kind='import', status='failed' if failed else 'completed', command=[], stdout='' if failed else 'Found 1 files\nimported=1 skipped=0 errors=0', stderr='', exitCode=1 if failed else 0, error='示例读取失败' if failed else None, startedAt=DATE, completedAt=DATE, durationMs=10)
        elif nonlocal_path.endswith('/search-index-health'): data = dict(ok=True, engine='pglite')
        route.fulfill(status=status, content_type='application/json', body=json.dumps(data, ensure_ascii=False))
    page.route('**/admin/api/**', mock)
    page.goto(BASE + '#home')
    page.wait_for_load_state('networkidle')
    for theme in ['dark', 'light']:
        page.evaluate('(theme) => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }', theme)
        expect(page.get_by_role('heading', name='你好，开始探索你的知识')).to_be_visible()
        checkbox = page.locator('.home-ask input[type=checkbox]')
        expect(checkbox).to_be_visible()
        rect = checkbox.bounding_box()
        assert rect['width'] == 16 and rect['height'] == 16, rect
        page.screenshot(path=str(OUT / f'home-{theme}.png'))
        page.get_by_role('button', name='知识库', exact=True).click()
        page.wait_for_load_state('networkidle')
        expect(page.get_by_role('heading', name='知识库', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='添加资料', exact=True)).to_be_visible()
        page.screenshot(path=str(OUT / f'knowledge-{theme}.png'))
        page.get_by_role('button', name='添加资料', exact=True).click()
        expect(page.get_by_role('dialog', name='添加资料')).to_be_visible()
        expect(page.get_by_role('button', name='本地文件')).to_be_visible()
        assert not page.get_by_role('dialog').locator('textarea').count()
        page.screenshot(path=str(OUT / f'import-{theme}.png'))
        page.get_by_role('button', name='关闭添加资料').click()
        page.get_by_role('button', name='知识整理', exact=True).click()
        page.wait_for_load_state('networkidle')
        expect(page.get_by_role('heading', name='知识整理', exact=True)).to_be_visible()
        expect(page.get_by_text('自动整理已开启', exact=True)).to_be_visible()
        assert not page.locator('.maintenance-manual').get_attribute('open')
        assert not page.locator('.dream-launcher').is_visible()
        page.screenshot(path=str(OUT / f'maintenance-{theme}.png'))
        page.get_by_role('button', name='知识助手', exact=True).click()
        page.locator('.wb-history-list button').filter(has_text='项目复盘').click()
        expect(page.get_by_text('这次复盘有三个结论：', exact=False)).to_be_visible()
        page.locator('.wb-tools > summary').click()
        expect(page.locator('.wb-tools')).to_contain_text('搜索知识')
        expect(page.locator('.wb-tools')).to_contain_text('default / reviews/project')
        page.locator('.wb-tools li').last.locator('details > summary').click()
        expect(page.locator('.wb-tools li').last.locator('.wb-tool-output')).to_contain_text('先确认目标，再执行。')
        page.screenshot(path=str(OUT / f'assistant-tools-{theme}.png'))
        page.locator('.wb-tools > summary').click()
        page.screenshot(path=str(OUT / f'assistant-{theme}.png'))
        page.get_by_role('button', name='首页', exact=True).click()
    page.get_by_role('button', name='知识库', exact=True).click()
    page.get_by_role('button', name='添加资料', exact=True).click()
    page.get_by_role('textbox', name='文件或文件夹路径').fill('D:\\示例资料')
    page.get_by_role('button', name='添加路径', exact=True).click()
    page.get_by_role('button', name='导入 1 项', exact=True).click()
    expect(page.locator('.materials-result')).to_contain_text('已完成')
    assert len(imports) == 1 and json.loads(imports[0]['body'])['path'] == 'D:\\示例资料'
    page.locator('.materials-drawer input[type=file]').set_input_files({'name': '示例.md', 'mimeType': 'text/markdown', 'buffer': '文件导入示例'.encode('utf-8')})
    page.get_by_role('button', name='导入 1 项', exact=True).click()
    page.wait_for_load_state('networkidle')
    expect(page.locator('.materials-result')).to_contain_text('示例.md')
    assert imports[-1]['path'].endswith('/import-upload-runs')
    page.get_by_role('button', name='关闭添加资料').click()
    page.get_by_role('button', name='添加资料', exact=True).click()
    expect(page.locator('.materials-result')).to_contain_text('已完成')
    failed = True
    page.get_by_role('textbox', name='文件或文件夹路径').fill('D:\\失败资料')
    page.get_by_role('button', name='导入', exact=True).click()
    expect(page.get_by_role('alert')).to_contain_text('示例读取失败')
    expect(page.locator('.materials-list')).to_contain_text('失败资料')
    page.get_by_role('button', name='关闭添加资料').click()
    page.get_by_role('button', name='知识助手', exact=True).click()
    page.evaluate("window.dispatchEvent(new StorageEvent('storage', {key: 'pmbrain.workbench.chatModel', newValue: 'ollama:other'}))")
    expect(page.locator('.wb-toolbar select')).to_have_value('ollama:other')
    models[:] = [dict(id='ollama:other', name='更新后的名称 · 本地', contextWindow=8192)]
    page.evaluate("window.dispatchEvent(new Event('pmbrain:models-updated'))")
    expect(page.locator('.wb-toolbar select')).to_have_value('ollama:other')
    expect(page.locator('.wb-toolbar select')).to_contain_text('更新后的名称')
    page.reload()
    expect(page.locator('.wb-toolbar select')).to_have_value('ollama:other')
    for width in [1440, 1100]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(OUT / f'assistant-{width}.png'))
    template = (ROOT / 'desktop/src/renderer/settings-content.html').read_text(encoding='utf-8')
    credentials = template.split('<div class="credential-switch">', 1)[1].split('</div>', 1)[0]
    page.evaluate('(html) => { const holder = document.createElement("div"); holder.id = "credential-visual-check"; holder.className = "desktop-settings"; holder.innerHTML = `<div class="credential-switch">${html}</div>`; document.querySelector(".product-main").appendChild(holder); }', credentials)
    for label in page.locator('#credential-visual-check label').all():
        radio = label.locator('input[type=radio]')
        rect = radio.bounding_box()
        assert rect['width'] == 16 and rect['height'] == 16, rect
        assert label.evaluate('(e)=>getComputedStyle(e).alignItems') == 'center'
    page.locator('#credential-visual-check').screenshot(path=str(OUT / 'mcp-alignment.png'))
    THREAD['messages'][-1]['toolCalls'][-1].update(status='error', error='示例原生读取失败', output=None)
    page.reload()
    page.locator('.wb-history-list button').filter(has_text='项目复盘').click()
    expect(page.locator('.wb-tools')).to_contain_text('1 项失败')
    expect(page.locator('p.wb-tool-error')).to_contain_text('示例原生读取失败')
    page.screenshot(path=str(OUT / 'assistant-tools-error.png'))
    mobile = browser.new_page(viewport={'width': 390, 'height': 844})
    mobile.route('**/admin/api/**', mock)
    mobile.goto(BASE + '#import')
    expect(mobile.locator('textarea')).to_be_visible()
    assert mobile.evaluate('location.hash') == '#import'
    mobile.close()
    assert not errors, errors
    print(json.dumps({'result': 'passed', 'themes': 2, 'widths': [1440, 1100], 'screenshots': str(OUT), 'browser_errors': errors}, ensure_ascii=False))
    browser.close()
