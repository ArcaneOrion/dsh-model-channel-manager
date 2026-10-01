from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import os

out = Path('docs/screenshots')
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/etc/profiles/per-user/arcaneorion/bin/chromium', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(Path(os.environ.get('MCM_PREVIEW_FILE', '/tmp/mcm-preview-url')).read_text())
    page.wait_for_load_state('networkidle')
    page.get_by_role('button', name='全局健康统计', exact=True).click()
    page.locator('.mcm-health-card').first.wait_for()
    assert page.locator('.mcm-metric-value').nth(0).inner_text() == '4'
    page.screenshot(path=str(out / 'health-light.png'), full_page=True)
    page.get_by_role('button', name='🟢 近 30 分钟', exact=True).click()
    assert page.locator('.mcm-metric-value').nth(0).inner_text() == '3'
    reads = page.evaluate('testState.configReads')
    page.wait_for_timeout(5400)
    assert page.evaluate('testState.configReads') == reads, 'health refresh must not read Settings'
    page.evaluate('document.body.classList.add("dark")')
    page.screenshot(path=str(out / 'health-dark.png'), full_page=True)
    page.evaluate('testState.failHealth=true')
    page.get_by_role('button', name='刷新统计', exact=True).click()
    page.get_by_role('alert').wait_for()
    assert page.locator('.mcm-metric-value').nth(0).inner_text() == '3', 'retain last snapshot after transport failure'
    page.evaluate('testState.failHealth=false')
    page.get_by_role('button', name='重试', exact=True).click()
    page.get_by_role('alert').wait_for(state='detached')
    page.evaluate('document.body.classList.remove("dark")')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_timeout(250)
    page.screenshot(path=str(out / 'health-mobile.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'page must fit mobile viewport'
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.get_by_role('button', name='提供商与模型', exact=True).click()
    page.locator('.mcm-card-h').first.click()
    page.get_by_role('button', name='⚡测试', exact=True).first.click()
    page.get_by_text('✓ 成功 (详情)', exact=True).wait_for(timeout=15000)
    assert page.evaluate('testState.writes.length') == 0, 'test task must not write Settings'
    page.evaluate('testState.providers=structuredClone(testState.providers);testState.providers.fixture.baseURL="https://changed.test"')
    page.get_by_role('button', name='保存全部变更', exact=True).click()
    page.get_by_text('版本冲突', exact=False).first.wait_for()
    assert page.evaluate('testState.writes.every(row=>row[0]!=="llm-pi-ai")'), 'concurrent provider edits must be refused before write'
    assert not errors, errors
    result = {'checks': ['original-card-layout', 'exact-windows', 'runtime-only-refresh', 'light-dark', 'mobile', 'stale-data-error', 'model-task-no-config-write', 'provider-conflict'], 'pageErrors': errors}
    Path('docs/screenshots/browser-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    browser.close()
    print(json.dumps(result, ensure_ascii=False))
