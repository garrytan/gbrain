import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dream = readFileSync(join(process.cwd(), 'admin/src/pages/Dream.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'admin/src/App.tsx'), 'utf8');
const api = readFileSync(join(process.cwd(), 'src/commands/natural-lang/api.ts'), 'utf8');

describe('Dream GUI product contract', () => {
  test('ordinary navigation exposes one beginner-friendly Dream entry', () => {
    expect(app).toContain("{ page: 'dream', label: 'AI 知识整理' }");
    expect(app).not.toContain("{ page: 'dream-execute', label: '阶段执行' }");
    expect(app).not.toContain("{ page: 'dream-insights', label: '项目洞察' }");
  });

  test('meeting mode calls the canonical CLI preset instead of synthesize-only', () => {
    expect(dream).toContain("preset: runMode === 'meeting' ? 'meeting'");
    expect(api).toContain("cmd.push('--preset', input.preset)");
  });

  test('phase ordering comes from the backend catalog', () => {
    expect(dream).toContain('phaseCatalog.map(item => <option');
    expect(dream).toContain('phaseCatalog={data.phase_catalog}');
  });

  test('removed project-management phases are not presented by Dream', () => {
    expect(dream).not.toContain('project_health');
    expect(dream).not.toContain('risk_detect');
    expect(dream).not.toContain('report_gen');
  });

  test('advanced observability remains available behind details', () => {
    expect(dream).toContain('查看阶段、模型与 Token');
    expect(dream).toContain('原始日志与命令');
    expect(dream).toContain('查看运行诊断');
  });
});
