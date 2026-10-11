import json
import os
import re
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('PMBRAIN_UI_URL', 'http://127.0.0.1:5193/admin/')
SERVICE = dict(id='ollama', provider='ollama', name='Ollama', enabled=True, apiKey='', baseUrl='http://localhost:11434/v1', models=[dict(id=name, name=name, group='', kind='chat', capabilities=[], contextWindow=8192) for name in ['sample', 'sample2']])
ASSISTANT = dict(name='知识库助手', emoji='知', description='', systemPrompt='', model='', knowledge=True, temperature=None, context={'maxMessages': 24, 'threshold': .8, 'summaryModel': ''})

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    scripts = set()
    page.on('request', lambda request: scripts.add(urlparse(request.url).path.rsplit('/', 1)[-1]) if urlparse(request.url).path.endswith('.js') else None)
    def mock(route):
        path = urlparse(route.request.url).path
        body = {'models': [], 'conversations': [], 'nodes': [], 'links': [], 'edges': []}
        if path.endswith('/assistant'): body = ASSISTANT
        route.fulfill(content_type='application/json', body=json.dumps(body))
    page.route('**/admin/api/**', mock)
    page.goto(BASE + '#home')
    page.wait_for_load_state('networkidle')
    initial = sorted(scripts)
    assert not any(name.startswith(('Workbench-', 'ModelServices-', 'KnowledgeGraph-', 'Settings-', 'DesktopSettings-', 'App-', 'charts-')) for name in scripts), initial
    page.get_by_role('button', name='知识助手', exact=True).click()
    page.wait_for_load_state('networkidle')
    expect(page.locator('.wb-composer textarea')).to_be_visible()
    page.locator('.wb-composer textarea').fill('切换页面保留这份草稿')
    page.get_by_role('button', name='首页', exact=True).click()
    page.get_by_role('button', name='知识助手', exact=True).click()
    expect(page.locator('.wb-composer textarea')).to_have_value('切换页面保留这份草稿')
    assert any(name.startswith('Workbench-') for name in scripts)
    with page.expect_request(re.compile(r'/KnowledgeGraph-[^/]+\.js')):
        page.get_by_role('button', name='知识图谱', exact=True).click()
    page.wait_for_load_state('networkidle')
    assert any(name.startswith('KnowledgeGraph-') for name in scripts)
    with page.expect_request(re.compile(r'/Settings-[^/]+\.js')):
        page.evaluate("location.hash = 'settings-knowledge'")
    page.wait_for_load_state('networkidle')
    assert any(name.startswith('Settings-') for name in scripts)
    page.close()

    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('''
      const clone = value => JSON.parse(JSON.stringify(value));
      window.fixture = { services: [SERVICE], revision: 'r1', reads: 0, saves: [], roleSaves: [] };
      const setup = { setup: { needsSetup: false, modelRevision: 'r1', current: { engine: 'pglite', chatModel: 'ollama:sample', ocrEnabled: false } } };
      const idle = () => () => {};
      window.pmbrainDesktop = {
        getState: async () => ({ phase: 'ready', port: 3131 }), getSetup: async () => clone(setup), getTheme: async () => ({ source: 'dark' }),
        getStartupProgress: async () => ({ visible: false }), getUpdateState: async () => null,
        onState: idle, onThemeState: idle, onNavigate: idle, onShowPanel: idle, onShowUpdates: idle, onStartupProgress: idle, onUpdateState: idle,
        getModelServices: async () => { fixture.reads++; return clone({ services: fixture.services, revision: fixture.revision }); },
        saveModelServices: async input => { fixture.saves.push(clone(input)); if (input.revision !== fixture.revision) throw new Error("Error invoking remote method 'desktop:save-model-services': Error: 配置已变化：其他页面已更新模型配置"); fixture.services = clone(input.services); fixture.revision += 'n'; return clone({ services: fixture.services, revision: fixture.revision }); },
        saveSetup: async input => { fixture.roleSaves.push(clone(input)); if (input.expectedModelRevision !== fixture.revision) throw new Error("Error invoking remote method 'desktop:save-setup': Error: 配置已变化：其他页面已更新模型配置"); return clone(setup); },
        productRequest: async request => ({ status: 200, contentType: 'application/json', body: JSON.stringify(request.path.endsWith('/assistant') ? ASSISTANT : { models: [], conversations: [] }) }),
      };
    '''.replace('SERVICE', json.dumps(SERVICE)).replace('ASSISTANT', json.dumps(ASSISTANT)))
    page.goto(BASE + '#home')
    page.wait_for_load_state('networkidle')
    assert page.evaluate('fixture.reads') == 0
    page.get_by_role('button', name='设置', exact=True).click()
    expect(page.get_by_role('heading', name='Ollama', exact=True)).to_be_visible()
    page.get_by_role('button', name='编辑 API 地址', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('textbox').fill('http://localhost:12000/v1')
    page.evaluate("fixture.revision = 'other-page'; fixture.services[0].name = '其他页面已保存'")
    dialog.get_by_role('button', name='保存并关闭', exact=True).click()
    expect(dialog).to_contain_text('配置已变化')
    expect(dialog.get_by_role('textbox')).to_have_value('http://localhost:12000/v1')
    assert page.evaluate('fixture.services[0].baseUrl') == SERVICE['baseUrl']
    assert page.evaluate('fixture.saves[0].revision') == 'r1'
    dialog.get_by_role('button', name='关闭添加端点', exact=True).click()
    expect(page.get_by_role('button', name='重新载入配置', exact=True)).to_be_visible()
    page.on('dialog', lambda prompt: prompt.accept())
    page.get_by_role('button', name='重新载入配置', exact=True).click()
    expect(page.get_by_role('heading', name='其他页面已保存', exact=True)).to_be_visible()
    page.get_by_role('button', name='知识库模型配置', exact=True).click()
    expect(page.get_by_role('combobox', name='普通模型', exact=True)).to_have_value('ollama:sample')
    page.evaluate("fixture.revision = 'second-page'")
    page.get_by_role('combobox', name='普通模型', exact=True).select_option('ollama:sample2')
    expect(page.locator('.model-notice')).to_contain_text('配置已变化')
    expect(page.get_by_role('combobox', name='普通模型', exact=True)).to_have_value('ollama:sample2')
    assert page.evaluate('fixture.roleSaves[0].expectedModelRevision') == 'other-page'
    page.get_by_role('button', name='重新载入配置', exact=True).click()
    expect(page.get_by_role('combobox', name='普通模型', exact=True)).to_have_value('ollama:sample')
    assert not errors, errors
    print(json.dumps({'result': 'passed', 'home_scripts': initial, 'lazy_pages': ['assistant', 'graph', 'settings', 'models'], 'draft_preserved': True, 'conflict_preserved': True, 'browser_errors': errors}, ensure_ascii=False))
    browser.close()
