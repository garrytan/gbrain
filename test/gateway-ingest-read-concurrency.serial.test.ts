import { afterEach, expect, test } from 'bun:test';
import { __setChatTransportForTests, configureGateway, resetGateway, toolLoop, type ChatBlock, type ToolHandler } from '../src/core/ai/gateway.ts';

afterEach(()=>{__setChatTransportForTests(null);resetGateway();});

for(const mixed of [false,true])test(mixed?'a write keeps an ingest tool batch serial':'independent ingest reads overlap with durable replay enabled',async()=>{
  configureGateway({chat_model:'anthropic:claude-sonnet-4-6',env:{ANTHROPIC_API_KEY:'stub'}});
  let turn=0,active=0,peak=0;
  const persisted=new Set<string>(),executed:string[]=[],settled:string[]=[];
  const names=['read',mixed?'write':'read'];
  __setChatTransportForTests(async()=>{
    const blocks:ChatBlock[]=turn++===0?names.map((toolName,index)=>({type:'tool-call',toolCallId:`call-${index}`,toolName,input:{index}})):[{type:'text',text:'done'}];
    return {text:turn===1?'':'done',blocks,stopReason:turn===1?'tool_calls':'end',usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0,cache_creation_tokens:0},model:'anthropic:claude-sonnet-4-6',providerId:'anthropic'};
  });
  const handler=(readOnly:boolean):ToolHandler=>({idempotent:true,readOnly,async execute(input){
    const {index}=input as {index:number};
    expect(persisted.has(`call-${index}`)).toBe(true);
    active++;peak=Math.max(peak,active);executed.push(`call-${index}`);
    await new Promise(resolve=>setTimeout(resolve,index===0?35:5));
    active--;return index;
  }});
  const result=await toolLoop({initialMessages:[{role:'user',content:'process'}],tools:['read','write'].map(name=>({name,description:name,inputSchema:{type:'object'}})),
    toolHandlers:new Map([['read',handler(true)],['write',handler(false)]]),toolConcurrency:2,parallelReadOnlyTools:true,
    replayState:{priorMessages:[],priorTools:new Map(),nextTurnIdx:0,nextMessageIdx:0},
    onToolCallStart:async(_turn,_message,_ordinal,_name,_input,id)=>{persisted.add(id);return {gbrainToolUseId:id};},
    onToolCallComplete:async id=>{settled.push(id);}});
  expect(peak).toBe(mixed?1:2);
  expect(executed).toEqual(['call-0','call-1']);
  expect(settled).toHaveLength(2);
  const messages=result.messages.flatMap(message=>Array.isArray(message.content)?message.content:[]);
  expect(messages.filter(block=>block.type==='tool-result').map(block=>block.output)).toEqual([0,1]);
});

test('completed replay reads are reused without execution',async()=>{
  configureGateway({chat_model:'anthropic:claude-sonnet-4-6',env:{ANTHROPIC_API_KEY:'stub'}});
  let turn=0,calls=0;
  __setChatTransportForTests(async()=>({text:'',blocks:turn++===0?[{type:'tool-call',toolCallId:'read-0',toolName:'read',input:{}}]:[],stopReason:turn===1?'tool_calls':'end',usage:{input_tokens:1,output_tokens:1,cache_read_tokens:0,cache_creation_tokens:0},model:'anthropic:claude-sonnet-4-6',providerId:'anthropic'}));
  const result=await toolLoop({initialMessages:[{role:'user',content:'resume'}],tools:[{name:'read',description:'read',inputSchema:{type:'object'}}],
    toolHandlers:new Map([['read',{readOnly:true,idempotent:true,async execute(){calls++;return 'unexpected';}}]]),toolConcurrency:2,parallelReadOnlyTools:true,
    replayState:{priorMessages:[],priorTools:new Map([['saved',{status:'complete',output:'saved result'}]]),nextTurnIdx:0,nextMessageIdx:0},
    onToolCallStart:async()=>({gbrainToolUseId:'saved'})});
  expect(calls).toBe(0);
  expect(JSON.stringify(result.messages)).toContain('saved result');
});
