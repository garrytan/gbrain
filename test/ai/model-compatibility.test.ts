import {expect,test} from 'bun:test';
import {defaultMaxOutputTokens,isThinkingModel} from '../../src/core/ai/model-compatibility.ts';
import {classifyChatError,isStructuredOutputRejection,isReasoningControlRejection} from '../../src/core/ai/errors.ts';

test('思考空间识别兼容端点、大小写和模型路径，普通及专用模型保持小上限',()=>{
  for(const model of ['custom-openai:Qwen3.6-35B-A3B','ollama:qwen3.6:35b','custom-openai:Qwen/Qwen3-8B','custom-openai:deepseek-r1','deepseek:deepseek-flash','custom-openai:glm-4.6','custom-openai:gpt-oss-20b','google:gemini-2.5-pro','google:gemini-3.5-flash','openai:o3-mini','openai:gpt-6-astra']){
    expect(isThinkingModel(model)).toBe(true);expect(defaultMaxOutputTokens(model)).toBe(32000);
  }
  for(const model of ['custom-openai:qwen2.5-7b','custom-openai:qwen3-coder','custom-openai:qwen3-embedding:8b','openai:gpt-4o','custom-openai:unknown'])expect(defaultMaxOutputTokens(model)).toBe(4096);
});

test('参数拒绝只识别明确的请求兼容错误，鉴权、限流及服务故障不降级',()=>{
  const wrapped={cause:{statusCode:400,responseBody:'unknown parameter chat_template_kwargs.enable_thinking'}};
  expect(isReasoningControlRejection(wrapped)).toBe(true);
  expect(isStructuredOutputRejection({status:422,message:'response_format json_schema unsupported'})).toBe(true);
  for(const status of [401,403,429,500]){
    expect(isReasoningControlRejection({status,message:'enable_thinking unsupported'})).toBe(false);
    expect(isStructuredOutputRejection({status,message:'response_format unsupported'})).toBe(false);
  }
  expect(isReasoningControlRejection({status:400,message:'maximum context length exceeded'})).toBe(false);
  expect(classifyChatError({cause:{statusCode:429}})).toBe('rate_limit');
  expect(classifyChatError({cause:{name:'TimeoutError'}})).toBe('timeout');
  expect(classifyChatError({cause:{code:'ECONNRESET'}})).toBe('network');
});
