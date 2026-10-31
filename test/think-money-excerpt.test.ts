import { describe, expect, test } from 'bun:test';
import { moneyAnswerOffset } from '../src/core/think/money-excerpt.ts';
import { selectRelevantExcerptDetailed, renderPagesBlockDetailed, EXCERPT_CUT_END_MARKER } from '../src/core/think/gather.ts';
import type { SearchResult } from '../src/core/types.ts';

const question='How much did Example Health deposit for the reimbursement they emailed about on October 15?';
const prefix='# We reimbursed you for a recent claim\nFrom: Example Health\nLook for a deposit in your bank. View email in a browser.\n' + 'General plan details and email delivery information.\n'.repeat(30);
const statement='Amount we deposited: $1,234.56 (This is the amount your plan covered.)';
const content=prefix+'Amount you pay: $140.00\n'+statement+'\nTotal amount you pay: $220.00\n'+'Other terms.\n'.repeat(70);

describe('monetary answer excerpts',()=>{
 test('retains the explicit deposit rather than matching mail boilerplate',()=>{
  const r=selectRelevantExcerptDetailed(content,question,600,'We reimbursed you for a recent claim');
  expect(r.text).toContain(statement);expect(r.text.length).toBeLessThanOrEqual(600);
  expect(r.truncatedStart).toBe(true);expect(r.truncatedEnd).toBe(true);
 });
 test('uses the same bounded window for a real search-result chunk',()=>{
  const r=renderPagesBlockDetailed([{slug:'mail/receipt',title:'We reimbursed you for a recent claim',chunk_text:content}as SearchResult],600,question);
  expect(r.text).toContain(statement);expect(r.text).toContain(EXCERPT_CUT_END_MARKER);expect(r.truncated).toBe(true);
 });
 test('keeps a label and value separated by blank lines',()=>{
  const body=prefix+'Amount we deposited:\r\n\r\n$1,234.56\n'+'Tail.\n'.repeat(100);
  expect(selectRelevantExcerptDetailed(body,question,600).text).toContain('$1,234.56');
 });
 test('does not borrow an earlier deposit label for a member-share amount',()=>{
  expect(moneyAnswerOffset(content,question)).toBe(content.indexOf('$1,234.56'));
 });
 test('leaves multiple deposits to normal lexical selection',()=>{
  expect(moneyAnswerOffset(content+'\nAmount we deposited: $432.10',question)).toBeNull();
 });
 test('does not force a monetary window for a date question',()=>{
  expect(moneyAnswerOffset(content,'When did Example Health email me?')).toBeNull();
 });
 test('does not use an unrelated copayment as the deposit',()=>{
  expect(moneyAnswerOffset(prefix+'Amount you pay: $140.00',question)).toBeNull();
 });
 test('does not match rent for a balance question',()=>{
  expect(moneyAnswerOffset('Rent: $500.00','How much is the balance?')).toBeNull();
 });
 test('requires an explicit monetary value and respects zero budgets',()=>{
  expect(moneyAnswerOffset('Amount we deposited: unknown',question)).toBeNull();
  expect(selectRelevantExcerptDetailed(content,question,0).text).toBe('');
 });
 test('retains whole short pages and well-formed unicode',()=>{
  expect(selectRelevantExcerptDetailed(statement,question,600).text).toBe(statement);
  expect(selectRelevantExcerptDetailed(prefix+'🚀'+statement,question,600).text.isWellFormed()).toBe(true);
 });
});
