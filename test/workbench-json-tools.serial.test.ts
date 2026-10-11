import {afterEach,expect,test} from 'bun:test';
import {configureGateway,resetGateway,chat,toolLoop} from '../src/core/ai/gateway';
import {knowledgeWorkbenchAnswer} from '../src/product/workbench/routes';

afterEach(()=>resetGateway());
test('a tools-and-schema-rejecting endpoint executes validated JSON read and remembers its protocol',async()=>{
  const requests:any[]=[];let reads=0;
  const server=Bun.serve({port:0,async fetch(req){
    const body=await req.json() as any;requests.push(body);
    if(body.tools)return Response.json({error:{message:'tools are not supported'}},{status:400});
    if(body.response_format)return Response.json({error:{message:'json_schema not supported'}},{status:400});
    const done=body.messages.some((message:any)=>typeof message.content==='string'&&message.content.includes('tool-result'));
    const content=done?JSON.stringify({answer:'已核对：预算十万元 [1]'}):JSON.stringify({tool_calls:[{name:'knowledge_read',arguments:{source_id:'a',slug:'budget'}}]});
    return Response.json({id:'fixture',object:'chat.completion',created:1,model:body.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:50,completion_tokens:20,total_tokens:70}});
  }});
  try{
    configureGateway({generative_enabled:true,chat_model:'service-http:chat',env:{},base_urls:{'service-http':`${server.url}v1`}});
    const answer=knowledgeWorkbenchAnswer({getPage:async()=>{reads++;return {source_id:'a',compiled_truth:'预算十万元',timeline:''};}} as any,{search:async()=>({results:[{source_id:'a',slug:'budget',title:'预算',snippet:'预算十万元'}]} as any),answer:chat,loop:toolLoop});
    const input={model:'service-http:chat',knowledge:true,signal:new AbortController().signal,progress:()=>{},messages:[{id:'q',role:'user' as const,status:'complete' as const,createdAt:'',text:'核对预算'}]};
    const first=await answer(input);expect(first.text).toBe('已核对：预算十万元 [1]');expect(first.citations[0]?.sourceId).toBe('a');expect(reads).toBe(2);
    const boundary=requests.length;const second=await answer(input);expect(second.text).toBe(first.text);
    expect(requests.slice(boundary).every(body=>!body.tools&&!body.response_format)).toBe(true);
    expect(requests.filter(body=>body.tools)).toHaveLength(1);expect(requests.filter(body=>body.response_format)).toHaveLength(1);
  }finally{server.stop(true);}
});
