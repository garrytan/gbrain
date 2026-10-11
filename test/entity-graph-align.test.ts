/**
 * 产品经理能看懂的测试说明：
 * 不调用模型。检查两件整理后的整理动作：
 * 1. 同一页上如果有两节「当前状态」，只留下最后一节，中间的时间线标题还在。
 * 2. 一句带日期、并且点到至少两个实体名字的话，会变成这些实体共用的一条时间线。
 * 没有日期，或者只点到一个名字，就不写时间线。
 */
import { expect, test } from 'bun:test';
import { collapseStateSections, timelineCopies, timelineFactsFromSources } from '../src/core/cycle/entity-graph-align.ts';

test('两节当前状态只留最后一节，夹在中间的时间线还在', () => {
  const input = [
    '介绍',
    '## 当前状态',
    '旧职星河科技',
    '## Timeline',
    '保留这条',
    '## 当前状态',
    '现任北海数据',
  ].join('\n');
  const collapsed = collapseStateSections(input);
  expect(collapsed).not.toContain('旧职星河科技');
  expect(collapsed).toContain('## Timeline');
  expect(collapsed).toContain('现任北海数据');
  expect(collapsed.match(/当前状态/g)).toHaveLength(1);
  expect(collapseStateSections('## 当前状态\n只有一节')).toBe('## 当前状态\n只有一节');
});

test('带日期并且点到多个实体的句子，写成同一条时间线', () => {
  const entities = [
    { slug: 'people/张三', title: '张三' },
    { slug: 'companies/xinghe', title: '星河科技' },
    { slug: 'projects/shuiwu', title: '智慧水务' },
  ];
  const facts = timelineFactsFromSources([
    { slug: 'notes/job', body: '2026-03-01，张三在星河科技任职，负责智慧水务项目。明天再议。' },
  ], entities);
  expect(new Set(facts.map(fact => fact.slug))).toEqual(new Set(entities.map(entity => entity.slug)));
  expect(new Set(facts.map(fact => fact.date))).toEqual(new Set(['2026-03-01']));
  expect(new Set(facts.map(fact => fact.summary)).size).toBe(1);
  expect(facts.every(fact => fact.source === 'notes/job')).toBe(true);
  expect(timelineFactsFromSources([
    { slug: 'notes/plain', body: '张三在星河科技任职，负责智慧水务项目。' },
  ], entities)).toEqual([]);
  expect(timelineFactsFromSources([
    { slug: 'notes/one', body: '2026年6月1日，张三离职。' },
  ], entities)).toEqual([]);
});

test('已经写在一个实体上的时间线，会抄到摘要里点名的其他实体', () => {
  const copies = timelineCopies([
    { slug: 'people/张三', date: '2026-03-01', summary: '张三加入星河科技', source: 'notes/job' },
  ], [
    { slug: 'people/张三', title: '张三' },
    { slug: 'companies/xinghe', title: '星河科技' },
    { slug: 'projects/other', title: '其他项目' },
  ]);
  expect(copies).toEqual([
    { slug: 'companies/xinghe', date: '2026-03-01', summary: '张三加入星河科技', source: 'notes/job' },
  ]);
});
