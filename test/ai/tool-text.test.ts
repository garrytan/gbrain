import {expect,test} from 'bun:test';
import {normalizeToolText,toolTextPreview} from '../../src/core/ai/tool-text';
for(const token of ['｜DSML｜','｜｜DSML｜｜','|DSML|'])for(const wrapper of ['calls','tool_calls','function_calls'])test(`${token} ${wrapper}: typed DSML becomes validated tool data`,()=>{
  const raw=`先核对。<${token} ${wrapper}><${token} invoke name="knowledge_read"><${token} parameter name="source_id" string="true">journey</${token} parameter><${token} parameter name="offset" string="false">120</${token} parameter></${token} invoke></${token} ${wrapper}>`;
  const result=normalizeToolText(raw);expect(result.text).toBe('先核对。');expect(result.toolCalls).toEqual([{toolName:'knowledge_read',input:{source_id:'journey',offset:120}}]);
  for(let offset=0;offset<raw.length;offset++)expect(toolTextPreview(raw.slice(0,offset))).not.toContain('DSML');
});
test('malformed or duplicate DSML parameters never become an answer or executable call',()=>{
  expect(()=>normalizeToolText('<｜DSML｜calls><｜DSML｜invoke name="read">')).toThrow('协议');
  expect(()=>normalizeToolText('<｜DSML｜calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="x" string="false">not-json</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>')).toThrow('协议');
});
test('plain text remains text, while complete and unfinished reasoning are hidden',()=>{
  expect(normalizeToolText('正常正文').text).toBe('正常正文');expect(toolTextPreview('<think>内部思考')).toBe('');expect(normalizeToolText('<think>内部</think>最终回答').text).toBe('最终回答');
  expect(normalizeToolText('\n正文\n').text).toBe('\n正文\n');
});
test('a reasoning closing marker without an opening marker still separates the final answer',()=>{
  expect(normalizeToolText('内部分析\n</think>最终回答').text).toBe('最终回答');
  expect(toolTextPreview('内部分析\n</thinking>最终回答')).toBe('最终回答');
});
