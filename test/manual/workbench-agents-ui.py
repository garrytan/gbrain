import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile
from playwright.sync_api import sync_playwright, expect

log = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
context = json.loads(re.findall(r"PREVIEW (\{.*\})", log)[-1])
output = Path(context["root"]) / "ui"
output.mkdir(exist_ok=True)
errors = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(context["url"])
    page.wait_for_load_state("networkidle")
    page.get_by_role("navigation", name="PMBrain 主导航").get_by_role("button", name="知识助手", exact=True).click()
    expect(page.get_by_role("textbox", name="消息")).to_be_visible()
    expect(page.get_by_role("heading", name="把工作交给你的助手")).to_be_visible()
    prompt = "创建一个周报助手，读取 " + context["materials"] + "，只写有依据的工作，周五17点生成Word周报。"
    page.get_by_role("textbox", name="消息").fill(prompt)
    page.get_by_role("button", name="发送消息").click()
    expect(page.get_by_label("我的助手").get_by_role("button", name=re.compile("周报助手"))).to_be_visible(timeout=30000)
    expect(page.get_by_label("已配置的助手")).to_contain_text("每周五 17:00")
    page.get_by_role("button", name="开始对话", exact=True).click()
    expect(page.get_by_role("heading", name="周报助手", exact=True)).to_be_visible()
    page.get_by_role("button", name="助手配置", exact=True).click()
    expect(page.get_by_role("dialog", name="助手配置")).to_contain_text("让主助手调整")
    page.get_by_role("button", name="职责与规则", exact=True).click()
    expect(page.get_by_label("助手规则")).to_have_value("只写有依据的工作，区分完成、推进中和计划")
    page.get_by_role("button", name="技能", exact=True).click()
    expect(page.get_by_label("助手工作步骤")).to_have_value(re.compile("读取工作记录"))
    expect(page.get_by_role("checkbox", name=re.compile("周报写作"))).to_be_checked()
    page.get_by_role("button", name="定时任务", exact=True).click()
    expect(page.get_by_label("执行时间")).to_have_value("17:00")
    expect(page.get_by_role("dialog", name="助手配置")).to_contain_text("北京时间")
    page.screenshot(path=str(output / "assistant-settings.png"))
    page.get_by_role("button", name="职责与规则", exact=True).click()
    page.get_by_label("助手规则").fill("先写结论，只写有依据的工作，区分完成、推进中和计划")
    page.get_by_role("button", name="保存", exact=True).click()
    page.reload()
    page.wait_for_load_state("networkidle")
    page.get_by_label("我的助手").get_by_role("button", name=re.compile("周报助手")).click()
    page.get_by_role("button", name="助手配置", exact=True).click()
    page.get_by_role("button", name="职责与规则", exact=True).click()
    expect(page.get_by_label("助手规则")).to_have_value("先写结论，只写有依据的工作，区分完成、推进中和计划")
    page.get_by_role("button", name="概览", exact=True).click()
    page.get_by_role("dialog", name="助手配置").get_by_role("button", name="让主助手调整", exact=True).click()
    expect(page.get_by_role("textbox", name="消息")).to_have_value("请调整助手「周报助手」的配置。我的新要求是：")
    page.get_by_role("textbox", name="消息").fill("")
    page.get_by_label("我的助手").get_by_role("button", name=re.compile("周报助手")).click()
    page.get_by_role("textbox", name="消息").fill("周报助手的未发送草稿")
    page.get_by_label("我的助手").get_by_role("button", name=re.compile("知识库助手")).click()
    expect(page.get_by_role("textbox", name="消息")).to_have_value("")
    page.get_by_label("我的助手").get_by_role("button", name=re.compile("周报助手")).click()
    expect(page.get_by_role("textbox", name="消息")).to_have_value("周报助手的未发送草稿")
    page.get_by_role("textbox", name="消息").fill("读取工作记录，写本周周报并保存Word。")
    page.get_by_role("button", name="发送消息").click()
    deliverable = page.get_by_role("button", name=re.compile("下载 本周周报"))
    expect(deliverable).to_be_visible(timeout=30000)
    page.get_by_role("button", name="预览 本周周报", exact=True).click()
    expect(page.get_by_role("dialog", name="成果预览")).to_contain_text("项目方案正在编写")
    page.get_by_role("button", name="关闭成果预览", exact=True).click()
    expect(page.get_by_label("助手回答").last).to_contain_text("上线属于下周计划")
    page.screenshot(path=str(output / "weekly-report.png"))
    with page.expect_download() as downloading:
        deliverable.click()
    download = downloading.value
    destination = output / "weekly-report.docx"
    download.save_as(str(destination))
    with ZipFile(destination) as archive:
        content = archive.read("word/document.xml").decode("utf-8")
        assert "完成需求评审" in content and "下周计划" in content
    page.reload()
    page.wait_for_load_state("networkidle")
    expect(page.get_by_label("我的助手").get_by_role("button", name=re.compile("周报助手"))).to_be_visible()
    page.get_by_role("button", name="工作成果", exact=True).click()
    page.get_by_role("button", name=re.compile("本周周报.*Word")).click()
    expect(page.get_by_role("dialog", name="工作成果")).to_contain_text("项目方案正在编写")
    page.screenshot(path=str(output / "artifacts.png"))
    assert not errors, errors
    browser.close()
result = {"checks": ["conversation-created-agent", "creation-card-to-chat", "rules-and-skill", "readable-weekly-schedule", "save-and-reload-settings", "conversation-adjust-entry", "isolated-unsent-drafts", "scoped-file-read", "inline-artifact-preview", "docx-download", "reload-and-artifact-preview"], "pageErrors": errors, "viewport": {"width": 1440, "height": 900}, "root": str(output)}
(output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False))
