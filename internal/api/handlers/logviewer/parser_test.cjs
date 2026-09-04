const test = require('node:test');
const assert = require('node:assert/strict');
const {frames, consolidate, messages, parse, rawExchange, treeExchange} = require('./assets/parser.js');

test('SSE multiline, DONE and malformed events', () => {
  assert.deepEqual(frames('event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"output":[]}}\n\ndata: [DONE]\n\ndata: bad\n\n'), [{type:'response.completed', response:{output:[]}}]);
});
test('Responses completion replaces output deltas', () => {
  const response = consolidate([{type:'response.output_text.delta', delta:'Hello'}, {type:'response.completed', response:{output:[{role:'assistant', content:[{type:'output_text',text:'Hello'}]}]}}]);
  assert.deepEqual(messages(response).map(m => m.text), ['Hello']);
});
test('Responses reconstructs output items when the completed upstream envelope is empty', () => {
  const events = [
    {type:'response.created',response:{id:'r1',status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{id:'reasoning',type:'reasoning',summary:[]}},
    {type:'response.output_item.done',output_index:0,item:{id:'reasoning',type:'reasoning',summary:[{type:'summary_text',text:'Summary'}]}},
    {type:'response.output_item.added',output_index:1,item:{id:'message',type:'message',role:'assistant',content:[]}},
    {type:'response.output_text.delta',output_index:1,content_index:0,delta:'Hello'},
    {type:'response.output_item.done',output_index:1,item:{id:'message',type:'message',role:'assistant',content:[{type:'output_text',text:'Hello'}]}},
    {type:'response.completed',response:{id:'r1',status:'completed',output:[],usage:{output_tokens:1}}}
  ];
  const response = consolidate(events);
  assert.equal(response.status, 'completed');
  assert.equal(response.output.length, 2);
  assert.deepEqual(response.output.map(item => item.type), ['reasoning','message']);
  assert.equal(response.output[1].content[0].text, 'Hello');
});
test('Incomplete Responses stream preserves text and tools', () => {
  const response = consolidate([{type:'response.output_text.delta', output_index:0, delta:'Hel'}, {type:'response.output_text.delta',output_index:0,delta:'lo'}, {type:'response.output_item.added',output_index:1,item:{type:'function_call',name:'test',call_id:'call-1',arguments:''}}, {type:'response.function_call_arguments.delta',output_index:1,delta:'{"a":1}'}]);
  const chat = messages(response);
  assert.equal(chat[0].text, 'Hello');
  assert.equal(chat[1].role, 'tool-call');
  assert.equal(chat[1].id, 'call-1');
});
test('Chat Completions deltas and tool argument fragments', () => {
  const response = consolidate([{choices:[{index:0,delta:{content:'Hi',tool_calls:[{index:0,id:'c1',function:{name:'run',arguments:'{"x":'}}]}}]}, {choices:[{index:0,delta:{content:' there',tool_calls:[{index:0,function:{arguments:'1}'}}]},finish_reason:'tool_calls'}]}]);
  assert.equal(response.choices[0].message.content,'Hi there');
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments,'{"x":1}');
});
test('Anthropic text, thinking, and tool input deltas', () => {
  const response = consolidate([{type:'message_start',message:{role:'assistant'}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{text:'Hello'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',name:'run',id:'t1',input:{}}},{type:'content_block_delta',index:1,delta:{partial_json:'{"x":1}'}}]);
  const chat = messages(response);
  assert.equal(chat[0].text,'Hello');
  assert.equal(chat[1].id,'t1');
  assert.match(chat[1].text, /"x": 1/);
});
test('Request instructions, user content, tools and outputs', () => {
  const chat = messages({instructions:'Rules',input:[{role:'user',content:[{type:'input_text',text:'Question'}]},{type:'function_call',name:'run',arguments:'{}',call_id:'c1'},{type:'function_call_output',call_id:'c1',output:'Result'}]},'user');
  assert.deepEqual(chat.map(m => m.role),['system','user','tool-call','tool']);
});
test('HTTP sections keep downstream response and upstream attempts separate', () => {
  const parsed = parse([{name:'REQUEST BODY',text:'{"messages":[{"role":"user","content":"Hi"}]}'},{name:'API RESPONSE 1',text:'Status: 500\n\n{"error":"upstream"}'},{name:'RESPONSE',text:'Status: 200\nContent-Type: application/json\n\n{"choices":[{"message":{"role":"assistant","content":"Hello"}}]}\n'}]);
  assert.deepEqual(parsed.chat.map(m => m.text), ['Hi','Hello']);
  assert.equal(parsed.sections.length,3);
});
test('WebSocket turns preserve order', () => {
  const events = [{type:'response.create',model:'test',input:'One'},{type:'response.completed',response:{output:[{role:'assistant',content:'First'}]}},{type:'response.create',input:'Two'},{type:'response.completed',response:{output:[{role:'assistant',content:'Second'}]}}];
  const parsed = parse([{name:'WEBSOCKET TIMELINE',text:events.map(e => JSON.stringify(e)).join('\n')}]);
  assert.deepEqual(parsed.chat.map(m => m.text), ['One','First','Two','Second']);
});
test('Gemini request and response parts', () => {
  const parsed = messages({systemInstruction:{parts:[{text:'Rules'}]},contents:[{role:'user',parts:[{text:'Hi'}]}],candidates:[{content:{role:'model',parts:[{text:'Hello'}]}}]});
  assert.deepEqual(parsed.map(m => m.role), ['system','user','assistant']);
});
test('Wrapped Antigravity Gemini chunks consolidate candidates, parts, finish state and usage', () => {
  const events = [
    {response:{candidates:[{content:{role:'model',parts:[{text:'think ',thought:true}]}}],usageMetadata:{promptTokenCount:10},modelVersion:'gemini-test'},traceId:'trace-1',metadata:{source:'antigravity'}},
    {response:{candidates:[{content:{role:'model',parts:[{text:'carefully',thought:true},{text:'Hello '}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12},modelVersion:'gemini-test'},traceId:'trace-1',metadata:{source:'antigravity'}},
    {response:{candidates:[{content:{role:'model',parts:[{text:'world',thoughtSignature:'signature'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:3,totalTokenCount:13},modelVersion:'gemini-test',responseId:'response-1'},traceId:'trace-1',metadata:{source:'antigravity'}}
  ];
  const result = consolidate(events);
  assert.equal(result.traceId, 'trace-1');
  assert.deepEqual(result.metadata, {source:'antigravity'});
  assert.equal(result.response.candidates.length, 1);
  assert.equal(result.response.candidates[0].finishReason, 'STOP');
  assert.deepEqual(result.response.candidates[0].content.parts, [
    {text:'think carefully',thought:true},
    {text:'Hello world',thoughtSignature:'signature'}
  ]);
  assert.equal(result.response.usageMetadata.totalTokenCount, 13);
  assert.equal(result.response.responseId, 'response-1');
});
test('Unwrapped Gemini chunks retain multiple candidates and merge cumulative metadata', () => {
  const result = consolidate([
    {candidates:[{index:0,content:{role:'model',parts:[{text:'A'}]}},{index:1,content:{role:'model',parts:[{text:'X'}]}}],usageMetadata:{promptTokenCount:2},modelVersion:'gemini-test'},
    {candidates:[{index:0,content:{role:'model',parts:[{text:'B'}]},finishReason:'STOP'},{index:1,content:{role:'model',parts:[{text:'Y'}]},finishReason:'MAX_TOKENS'}],usageMetadata:{candidatesTokenCount:4,totalTokenCount:6},responseId:'r1'}
  ]);
  assert.deepEqual(result.candidates.map(candidate => candidate.content.parts[0].text), ['AB','XY']);
  assert.deepEqual(result.candidates.map(candidate => candidate.finishReason), ['STOP','MAX_TOKENS']);
  assert.deepEqual(result.usageMetadata, {promptTokenCount:2,candidatesTokenCount:4,totalTokenCount:6});
  assert.equal(result.modelVersion, 'gemini-test');
  assert.equal(result.responseId, 'r1');
});
test('Untrusted HTML remains plain text and external images are marked for manual loading', () => {
  const chat = messages({messages:[{role:'user',content:[{type:'text',text:'<img src=x onerror=alert(1)>'},{type:'image_url',image_url:{url:'https://private.example/image'}}]}]});
  assert.equal(chat[0].text,'<img src=x onerror=alert(1)>');
  assert.deepEqual(chat[1].image, {src:'https://private.example/image', remote:true});
});

const png = 'data:image/png;base64,aGVsbG8=';
test('Responses, Anthropic and Chat Completions preserve mixed text and images in order', () => {
  const inputs = [
    {input:[{role:'user',content:[{type:'input_text',text:'Before'},{type:'input_image',image_url:png},{type:'input_text',text:'After'}]}]},
    {messages:[{role:'user',content:[{type:'text',text:'Before'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}},{type:'text',text:'After'}]}]},
    {messages:[{role:'user',content:[{type:'text',text:'Before'},{type:'image_url',image_url:{url:png,detail:'high'}},{type:'text',text:'After'}]}]}
  ];
  for (const payload of inputs) {
    const chat = messages(payload);
    assert.deepEqual(chat.map(m => m.text), ['Before','','After']);
    assert.deepEqual(chat.map(m => m.role), ['user','user','user']);
    assert.deepEqual(chat[1].image, {src:png,remote:false});
  }
});

test('Tool result images retain tool IDs and surrounding literal text', () => {
  const content = [{type:'text',text:'# Screenshot'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}];
  const payloads = [
    {messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content}]}]},
    {input:[{type:'function_call_output',call_id:'t1',output:content}]},
    {messages:[{role:'tool',tool_call_id:'t1',content}]}
  ];
  for (const payload of payloads) {
    const chat = messages(payload);
    assert.equal(chat.length, 2);
    assert.ok(chat.every(m => m.role === 'tool' && m.id === 't1'));
    assert.equal(chat[0].text, '# Screenshot');
    assert.equal(chat[1].image.src, png);
  }
});

test('Image sources reject active, malformed, missing, and non-image attachments', () => {
  for (const url of ['javascript:alert(1)','data:text/html;base64,aGVsbG8=','data:image/svg+xml;base64,aGVsbG8=','data:image/png;base64,','file:///tmp/image.png','/logs/api/entries','//example.com/a.png','https://user:pass@example.com/a.png','http://[invalid',null,{}]) {
    const chat = messages({input:[{role:'user',content:[{type:'input_image',image_url:url}]}]});
    assert.equal(chat[0].image, undefined);
    assert.match(chat[0].text, /unavailable/);
  }
  assert.equal(messages({contents:[{parts:[{inlineData:{mimeType:'application/pdf',data:'aGVsbG8='}}]}]})[0].image, undefined);
  assert.equal(messages({input:[{role:'user',content:[{type:'input_image',file_id:'file-123'}]}]})[0].image, undefined);
});

test('URL-backed Anthropic and Gemini image sources are recognized', () => {
  const chat = messages({messages:[{role:'user',content:[
    {type:'image',source:{type:'url',url:'https://example.com/image.png'}},
    {inlineData:{mimeType:'image/png',data:'aGVsbG8='}},
    {fileData:{mimeType:'image/png',fileUri:'https://example.com/image.png'}}
  ]}]});
  assert.deepEqual(chat.map(m => m.image.remote), [true,false,true]);
});

test('Images survive Responses, Anthropic and multipart Chat Completions streams', () => {
  const image = {type:'image_url',image_url:{url:png}};
  const streams = [
    [{type:'response.output_item.done',output_index:0,item:{role:'assistant',content:[image]}},{type:'response.completed',response:{output:[]}}],
    [{type:'message_start',message:{role:'assistant'}},{type:'content_block_start',index:0,content_block:{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}}],
    [{choices:[{index:0,delta:{content:'Before'}}]},{choices:[{index:0,delta:{content:[image]}}]},{choices:[{index:0,delta:{content:'After'}}]}]
  ];
  for (const stream of streams) {
    const chat = messages(consolidate(stream));
    assert.equal(chat.filter(m => m.image).length, 1);
    assert.equal(chat.find(m => m.image).image.src, png);
    assert.ok(chat.every(m => m.role === 'assistant'));
  }
});

test('Responses image generation results render as generated images', () => {
  for (const outputFormat of [undefined,'png','jpeg','jpg','webp']) {
    const item = {id:'ig_1',type:'image_generation_call',status:'completed',result:'aGVsbG8='};
    if (outputFormat) item.output_format = outputFormat;
    const chat = messages({output:[item]});
    assert.equal(chat.length, 1);
    assert.equal(chat[0].role, 'assistant');
    assert.equal(chat[0].label, 'Generated image');
    assert.equal(chat[0].id, 'ig_1');
    assert.equal(chat[0].image.remote, false);
    assert.equal(chat[0].image.src, 'data:image/' + (outputFormat === 'jpg' ? 'jpeg' : outputFormat || 'png') + ';base64,aGVsbG8=');
  }
});

test('Incomplete or unsupported image generation output stays inspectable', () => {
  const incomplete = messages({output:[{type:'image_generation_call',status:'in_progress'}]});
  assert.match(incomplete[0].text, /unavailable/);
  const unsupported = messages({output:[{type:'image_generation_call',output_format:'svg+xml',result:'aGVsbG8='}]});
  assert.match(unsupported[0].text, /unavailable/);
});

test('Raw exchange separates API retries and errors from the client exchange', () => {
  const sections = [
    {name:'REQUEST INFO',text:'client metadata\n'},
    {name:'HEADERS',text:'client headers\n'},
    {name:'REQUEST BODY',text:'client body\n'},
    {name:'API REQUEST 1',text:'first request\n'},
    {name:'API ERROR RESPONSE',text:'first error\n'},
    {name:'API REQUEST 2',text:'second request\n'},
    {name:'API RESPONSE 2',text:'second response\n'},
    {name:'API RESPONSE ERROR 3',text:'legacy error\n'},
    {name:'RESPONSE',text:'client result\n'}
  ];
  const api = rawExchange(sections);
  assert.equal(api.request,'=== API REQUEST 1 ===\nfirst request\n=== API REQUEST 2 ===\nsecond request\n');
  assert.match(api.response,/API ERROR RESPONSE/);
  assert.match(api.response,/API RESPONSE ERROR 3/);
  assert.doesNotMatch(api.response,/client result/);
  const client = rawExchange(sections,'client');
  assert.match(client.request,/client metadata/);
  assert.match(client.request,/client headers/);
  assert.match(client.response,/client result/);
  assert.doesNotMatch(client.request,/API REQUEST/);
});

test('Raw exchange preserves missing sides, WebSocket timelines, and unknown sections', () => {
  const sections = [{name:'API WEBSOCKET TIMELINE',text:'upstream frames\r\n'},{name:'WEBSOCKET TIMELINE',text:'client frames\n'},{name:'UNRECOGNIZED LOG',text:'partial'}];
  assert.equal(rawExchange(sections).request,'');
  assert.equal(rawExchange(sections).response,'');
  assert.equal(rawExchange(sections).timeline,'=== API WEBSOCKET TIMELINE ===\nupstream frames\r\n');
  assert.match(rawExchange(sections,'client').timeline,/client frames/);
  assert.deepEqual(rawExchange(sections).other,[sections[2]]);
});

test('Tree exchange parses pretty upstream JSON and preserves retry and error boundaries', () => {
  const sections = [
    {name:'REQUEST BODY',text:'{"model":"proxy-model"}'},
    {name:'API REQUEST 1',text:'Timestamp: now\r\nUpstream URL: https://provider.example\r\n\r\nHeaders:\r\nContent-Type: application/json\r\n\r\nBody:\r\n{\r\n  "model": "provider-model",\r\n  "input": [{"role":"user","content":"Hello"}]\r\n}\r\n'},
    {name:'API RESPONSE 1',text:'Status: 429\nHeaders:\nRetry-After: 1\n\nBody:\n{\n "error": "quota"\n}\n'},
    {name:'API REQUEST 2',text:'Body:\n{"model":"retry-model"}'},
    {name:'API RESPONSE 2',text:'Status: 200\n\n{\n "output": [{"role":"assistant","content":"Done"}]\n}'},
    {name:'API ERROR RESPONSE',text:'HTTP Status: 502\nconnection failed\n'},
    {name:'API RESPONSE ERROR 3',text:'legacy failure'},
    {name:'RESPONSE',text:'Status: 200\n\n{"result":"proxy-result"}'}
  ];
  const data = treeExchange(sections);
  assert.deepEqual(data.request.map(r => r.body.model), ['provider-model','retry-model']);
  assert.equal(data.request[0].body.input[0].content, 'Hello');
  assert.match(data.request[0].metadata, /Upstream URL: https:\/\/provider.example/);
  assert.match(data.request[0].metadata, /Content-Type: application\/json/);
  assert.deepEqual(data.response.map(r => r.name), ['API RESPONSE 1','API RESPONSE 2','API ERROR RESPONSE','API RESPONSE ERROR 3']);
  assert.equal(data.response[0].body.error, 'quota');
  assert.equal(data.response[1].body.output[0].content, 'Done');
  assert.match(data.response[2].body, /connection failed/);
  assert.equal(data.response[3].body, 'legacy failure');
  assert.doesNotMatch(JSON.stringify(data), /proxy-model|proxy-result/);
  const proxy = treeExchange(sections, 'client');
  assert.equal(proxy.request[0].body.model, 'proxy-model');
  assert.equal(proxy.response[0].body.result, 'proxy-result');
  assert.doesNotMatch(JSON.stringify(proxy), /provider-model|retry-model|quota/);
});

test('Tree consolidates each SSE attempt without mutating original events or repeated renders', () => {
  const events = [
    {type:'response.output_item.added',output_index:0,item:{type:'message',role:'assistant',content:[]}},
    {type:'response.output_text.delta',output_index:0,delta:'Hello'},
    {type:'response.output_text.delta',output_index:0,delta:' world'}
  ];
  const sections = [
    {name:'API RESPONSE 1',text:'Body:\ndata: {"choices":[{"index":0,"delta":{"content":"Attempt one"}}]}\n\n'},
    {name:'API RESPONSE 2',text:'Status: 200\n\nBody:\n' + events.map(e => 'data: '+JSON.stringify(e)+'\n\n').join('') + 'data: [DONE]\n'}
  ];
  const before = JSON.stringify(sections);
  const data = treeExchange(sections);
  assert.equal(data.response[0].body.choices[0].message.content, 'Attempt one');
  assert.equal(data.response[1].body.output[0].content[0].text, 'Hello world');
  assert.deepEqual(data.response[1].events, events);
  assert.equal(JSON.stringify(sections), before);
  assert.deepEqual(treeExchange(sections), data);
});

test('Tree preserves scalar/array JSON, malformed and empty bodies, missing sides and unknown sections', () => {
  const sections = [
    {name:'API REQUEST 1',text:'Body:\n[1,2]'},
    {name:'API REQUEST 2',text:'Body:\nnull'},
    {name:'API REQUEST 3',text:'Body:\nfalse'},
    {name:'API REQUEST 4',text:'Body:\n{\n "unfinished":'},
    {name:'API REQUEST 5',text:'Body:\n<empty>'},
    {name:'UNRECOGNIZED LOG',text:'preserve this'}
  ];
  const data = treeExchange(sections);
  assert.deepEqual(data.request.map(r => r.body), [[1,2],null,false,'{\n "unfinished":','<empty>']);
  assert.deepEqual(data.response, []);
  assert.deepEqual(data.other, [sections[5]]);
  assert.deepEqual(treeExchange(sections,'client').request, []);
  assert.deepEqual(treeExchange(sections,'client').response, []);
});

test('Tree keeps upstream WebSocket requests, responses, handshake and errors in order and separate from proxy', () => {
  const sections = [
    {name:'API WEBSOCKET TIMELINE',text:'Timestamp: t1\nEvent: api.websocket.request\nHeaders:\nX-Test: yes\n\nBody:\n{\n "type":"response.create",\n "input":"Upstream"\n}\n\nTimestamp: t2\nEvent: api.websocket.handshake\nStatus: 101\n\nTimestamp: t3\nEvent: api.websocket.response\n{\n "type":"response.completed",\n "response":{"output":[]}\n}\n\nTimestamp: t4\nEvent: api.websocket.error\nError: disconnected\n'},
    {name:'WEBSOCKET TIMELINE',text:'{"type":"response.create","input":"Client"}\n{"type":"response.completed","response":{"output":[]}}'}
  ];
  const api = treeExchange(sections);
  assert.deepEqual(api.request, []);
  assert.deepEqual(api.response, []);
  const records = api.timeline[0].body;
  assert.equal(records.length, 4);
  assert.equal(records[0].body.input, 'Upstream');
  assert.match(records[0].metadata, /api.websocket.request/);
  assert.match(records[1].body, /Status: 101/);
  assert.equal(records[2].body.type, 'response.completed');
  assert.match(records[3].body, /disconnected/);
  assert.doesNotMatch(JSON.stringify(api), /Client/);
  const proxy = treeExchange(sections,'client');
  assert.equal(proxy.timeline[0].body[0].body[0].input, 'Client');
  assert.doesNotMatch(JSON.stringify(proxy), /Upstream/);
});
