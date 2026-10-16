import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { followLatestOnUpdate, nearLatest } from '../admin/src/workbench/scroll-pin';

const workbench = readFileSync(join(process.cwd(), 'admin/src/workbench/Workbench.tsx'), 'utf8');
const css = readFileSync(join(process.cwd(), 'admin/src/workbench/workbench.css'), 'utf8');

describe('打开助手对话直接停在最后', () => {
  test('点开一条已经很长的对话时，直接停在最后，不从开头滚下来', () => {
    expect(followLatestOnUpdate({ opened: true, generationStarted: false, following: false })).toBe(true);
  });

  test('人正在往上翻以前的内容时，后面继续出字也不要把画面拉回去', () => {
    expect(nearLatest(8000, 400, 500)).toBe(false);
    expect(followLatestOnUpdate({ opened: false, generationStarted: false, following: false })).toBe(false);
  });

  test('人已经在最底下，或者刚发出去开始生成时，继续贴着最后', () => {
    expect(nearLatest(8000, 7420, 500)).toBe(true);
    expect(followLatestOnUpdate({ opened: false, generationStarted: false, following: true })).toBe(true);
    expect(followLatestOnUpdate({ opened: false, generationStarted: true, following: false })).toBe(true);
  });

  test('对话区域在画出第一帧之前就跳到末尾，并且不再使用整段平滑滚动', () => {
    expect(workbench).toContain('useLayoutEffect');
    expect(workbench).toContain('node.scrollTop = node.scrollHeight');
    expect(workbench).not.toContain('scrollIntoView');
    expect(css).toContain('.wb-messages { overflow: auto; flex: 1; min-height: 0; scroll-behavior: auto; }');
    expect(css).not.toContain('scroll-behavior: smooth');
  });
});
