import {stripReasoningBlocks} from '../llm-json';

export function modelAnswerText(raw:string):string{
  if(!/<\/?(?:think|thinking)>/i.test(raw))return raw;
  return stripReasoningBlocks(raw).replace(/^[\s\S]*?<\/(?:think|thinking)>/i,'').trim();
}
export function toolTextPreview(raw:string):string{
  return modelAnswerText(raw.replace(/<[^>]*$/,'').replace(/<[｜|]{1,2}DSML[｜|]{1,2}[\s\S]*$/,''));
}
export function normalizeToolText(raw:string):{text:string;toolCalls:Array<{toolName:string;input:Record<string,unknown>}>}{
  const text=modelAnswerText(raw);
  if(!/<\/?[｜|]{1,2}DSML[｜|]{1,2}/.test(text))return {text,toolCalls:[]};
  const normalized=text.replace(/[｜|]{1,2}DSML[｜|]{1,2}\s*/g,'DSML ');
  const fail=()=>new Error('模型工具协议解析失败，已有资料和对话已保留。');
  const toolCalls:Array<{toolName:string;input:Record<string,unknown>}>=[];
  let remainder=normalized.replace(/<DSML (calls|tool_calls|function_calls)\s*>([\s\S]*?)<\/DSML \1\s*>/g,(_block,_wrapper,body:string)=>{
    const rest=body.replace(/<DSML invoke\s+name="([\w.-]+)"\s*>([\s\S]*?)<\/DSML invoke\s*>/g,(_invoke,toolName:string,parameters:string)=>{
      const input:Record<string,unknown>=Object.create(null);
      const extra=parameters.replace(/<DSML parameter\s+name="([\w.-]+)"\s+string="(true|false)"\s*>([\s\S]*?)<\/DSML parameter\s*>/g,(_parameter,name:string,string:string,value:string)=>{
        if(Object.hasOwn(input,name))throw fail();
        try{input[name]=string==='true'?value:JSON.parse(value);}catch{throw fail();}return '';
      });
      if(extra.trim()||toolCalls.length>=32)throw fail();toolCalls.push({toolName,input});return '';
    });
    if(rest.trim())throw fail();return '';
  });
  if(/<\/?DSML\s/.test(remainder)||!toolCalls.length)throw fail();
  return {text:remainder.trim(),toolCalls};
}
