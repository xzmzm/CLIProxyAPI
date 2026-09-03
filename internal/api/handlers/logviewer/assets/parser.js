// Pure parsing helpers shared by the viewer and Node's built-in test runner.
(function (root) {
  'use strict';
  const json = text => { try { return JSON.parse(text); } catch { return undefined; } };
  const array = value => Array.isArray(value) ? value : value == null ? [] : [value];
  const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  function frames(text) {
    const single = json(text.trim());
    if (single !== undefined) return array(single);
    const result = [];
    let pending = [];
    const flush = () => {
      const value = json(pending.join('\n'));
      if (value && typeof value === 'object') result.push(value);
      pending = [];
    };
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
      if (line.startsWith('data:')) {
        // Some logs omit blank lines between SSE events.
        if (pending.length && json(pending.join('\n')) !== undefined) flush();
        pending.push(line.slice(5).trimStart());
      } else if (!line.trim()) flush();
      else if (!line.startsWith('event:') && !line.startsWith(':')) {
        flush();
        const start = line.indexOf('{');
        const value = json(start >= 0 ? line.slice(start) : line);
        if (value && typeof value === 'object') result.push(value);
      }
    }
    flush();
    return result;
  }

  function responseBody(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const split = normalized.indexOf('\n\n');
    return split >= 0 ? normalized.slice(split + 2).trim() : normalized.trim();
  }

  function consolidate(events) {
    if (events.length === 1 && !events[0]?.type?.startsWith('response.') && !events[0]?.choices?.[0]?.delta) return events[0];
    if (events.some(e => Array.isArray(e?.candidates) || Array.isArray(e?.response?.candidates))) return consolidateGemini(events);
    // Prefer a complete Responses payload, but reconstruct output from item events
    // when an upstream completion envelope incorrectly carries an empty array.
    const completed = events.filter(e => ['response.completed', 'response.done', 'response.incomplete', 'response.failed'].includes(e.type) && e.response?.output?.length);
    if (completed.length) return completed.length === 1 ? completed[0].response : completed.map(e => e.response);
    const items = new Map(), choices = new Map(), blocks = new Map();
    let envelope = {}, usage, error;
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      if (e.error) error = e.error;
      if (e.usage) usage = e.usage;
      if (e.response) envelope = {...envelope, ...e.response};
      const key = e.output_index ?? e.item_id ?? 0;
      if (e.type === 'response.output_item.added' || e.type === 'response.output_item.done') items.set(key, e.item);
      if (e.type === 'response.output_text.delta') {
        const item = items.get(key) || {type:'message', role:'assistant', content:[]};
        const index = e.content_index ?? 0;
        item.content ||= [];
        item.content[index] ||= {type:'output_text', text:''};
        item.content[index].text += e.delta || '';
        items.set(key, item);
      }
      if (e.type === 'response.function_call_arguments.delta') {
        const item = items.get(key) || {type:'function_call', call_id:e.item_id, arguments:''};
        item.arguments = (item.arguments || '') + (e.delta || '');
        items.set(key, item);
      }
      if (e.type === 'response.reasoning_summary_text.delta') {
        const item = items.get(key) || {type:'reasoning', summary:[]};
        item.summary ||= [];
        const index = e.summary_index ?? 0;
        item.summary[index] ||= {type:'summary_text', text:''};
        item.summary[index].text += e.delta || '';
        items.set(key, item);
      }
      for (const choice of e.choices || []) {
        const index = choice.index ?? 0;
        const target = choices.get(index) || {index, message:{role:'assistant', content:''}};
        if (choice.message) target.message = choice.message;
        const delta = choice.delta || {};
        target.message.content += delta.content || '';
        if (delta.reasoning_content) target.message.reasoning_content = (target.message.reasoning_content || '') + delta.reasoning_content;
        for (const tool of delta.tool_calls || []) {
          target.message.tool_calls ||= [];
          const t = target.message.tool_calls[tool.index ?? 0] ||= {id:tool.id, type:'function', function:{name:'', arguments:''}};
          if (tool.id) t.id = tool.id;
          t.function.name += tool.function?.name || '';
          t.function.arguments += tool.function?.arguments || '';
        }
        if (choice.finish_reason) target.finish_reason = choice.finish_reason;
        choices.set(index, target);
      }
      if (e.type === 'message_start') envelope = {...e.message};
      if (e.type === 'content_block_start') blocks.set(e.index, {...e.content_block});
      if (e.type === 'content_block_delta') {
        const block = blocks.get(e.index) || {type:'text', text:''};
        if (e.delta?.text) block.text = (block.text || '') + e.delta.text;
        if (e.delta?.thinking) block.thinking = (block.thinking || '') + e.delta.thinking;
        if (e.delta?.partial_json) block.partial = (block.partial || '') + e.delta.partial_json;
        blocks.set(e.index, block);
      }
      if (e.type === 'message_delta') envelope = {...envelope, ...e.delta};
    }
    if (choices.size) return {choices:[...choices.values()], usage, error};
    if (blocks.size) return {...envelope, content:[...blocks.values()].map(b => b.partial ? {...b, input:json(b.partial) ?? b.partial} : b), usage, error};
    if (items.size) return {...envelope, output:[...items.values()], usage, error};
    return events.length === 1 ? events[0] : events;
  }

  function consolidateGemini(events) {
    const wrapped = events.some(event => Array.isArray(event?.response?.candidates));
    const candidates = new Map();
    let response = {}, wrapper = {};
    const mergePart = (parts, part) => {
      const previous = parts.at(-1);
      const isText = part && typeof part.text === 'string' && !part.functionCall && !part.functionResponse && !part.inlineData && !part.fileData;
      const sameKind = isText && previous && typeof previous.text === 'string' && Boolean(previous.thought) === Boolean(part.thought);
      if (!sameKind) { parts.push({...part}); return; }
      previous.text += part.text;
      if (part.thoughtSignature != null) previous.thoughtSignature = part.thoughtSignature;
    };
    for (const event of events) {
      const chunk = wrapped ? event.response : event;
      if (!chunk || typeof chunk !== 'object') continue;
      const usageMetadata = {...response.usageMetadata, ...chunk.usageMetadata};
      response = {...response, ...chunk};
      if (Object.keys(usageMetadata).length) response.usageMetadata = usageMetadata;
      delete response.candidates;
      if (wrapped) {
        const metadata = {...wrapper.metadata, ...event.metadata};
        wrapper = {...wrapper, ...event};
        if (Object.keys(metadata).length) wrapper.metadata = metadata;
        delete wrapper.response;
      }
      (chunk.candidates || []).forEach((candidate, position) => {
        const key = candidate.index ?? position;
        const target = candidates.get(key) || {index:candidate.index, content:{role:candidate.content?.role || 'model', parts:[]}};
        const parts = target.content?.parts || [];
        Object.assign(target, candidate);
        target.content = {...target.content, ...candidate.content, parts};
        for (const part of candidate.content?.parts || []) mergePart(parts, part);
        candidates.set(key, target);
      });
    }
    response.candidates = [...candidates.values()].map(candidate => {
      if (candidate.index != null) return candidate;
      const {index, ...rest} = candidate;
      return rest;
    });
    return wrapped ? {...wrapper, response} : response;
  }

  function messages(payload, fallback = 'assistant') {
    const result = [];
    const add = (role, text, label, id) => { if (text != null && text !== '') result.push({role, text:pretty(text), label:label || role, id}); };
    function item(value, role = fallback) {
      if (value == null) return;
      if (typeof value === 'string') { add(role, value); return; }
      if (Array.isArray(value)) { value.forEach(v => item(v, role)); return; }
      role = value.role || role;
      if (role === 'model') role = 'assistant';
      if (value.type === 'function_call' || value.type === 'tool_use' || value.functionCall) {
        const tool = value.functionCall || value;
        add('tool-call', json(tool.arguments) ?? tool.arguments ?? tool.input ?? tool.args ?? '', 'Tool call · ' + (tool.name || 'function'), tool.call_id || tool.id);
      } else if (value.type === 'function_call_output' || value.type === 'tool_result' || value.functionResponse) {
        const tool = value.functionResponse || value;
        add('tool', tool.output ?? tool.content ?? tool.response, 'Tool result' + (tool.name ? ' · ' + tool.name : ''), tool.call_id || tool.tool_use_id);
      } else if (value.type === 'reasoning' || value.type === 'thinking' || value.type === 'redacted_thinking') {
        add('reasoning', value.thinking || value.summary?.map(s => s.text).join('\n') || value.text || '[Encrypted or redacted reasoning]', 'Reasoning');
      } else if (value.type === 'image_url' || value.type === 'input_image' || value.type === 'image' || value.inlineData || value.fileData) {
        add(role, '[Image / attachment — inspect Tree or Raw view]', 'Attachment');
      } else if (value.text != null || value.type === 'refusal') {
        add(role, value.text ?? value.refusal);
      } else if (role === 'tool') {
        add('tool', value.content, 'Tool result' + (value.name ? ' · ' + value.name : ''), value.tool_call_id);
      } else if (value.content != null || value.parts != null) {
        item(value.content ?? value.parts, role);
      } else if (!value.tool_calls && !value.reasoning_content) {
        add(role, value, value.type || role);
      }
      if (value.reasoning_content) add('reasoning', value.reasoning_content, 'Reasoning');
      for (const call of value.tool_calls || []) {
        if (call) add('tool-call', json(call.function?.arguments) ?? call.function?.arguments ?? call, 'Tool call · ' + (call.function?.name || 'function'), call.id);
      }
    }
    if (!payload) return result;
    if (Array.isArray(payload)) { payload.forEach(p => result.push(...messages(p, fallback))); return result; }
    if (typeof payload !== 'object') { item(payload); return result; }
    if (payload.instructions) item(payload.instructions, 'system');
    if (payload.system) item(payload.system, 'system');
    if (payload.systemInstruction) item(payload.systemInstruction.parts, 'system');
    if (payload.messages) item(payload.messages, 'user');
    if (payload.input != null) item(payload.input, 'user');
    if (payload.contents) item(payload.contents, 'user');
    if (payload.output) item(payload.output, 'assistant');
    if (payload.content) item(payload.content, payload.role || fallback);
    if (payload.choices) payload.choices.forEach(c => item(c.message ?? c.text, 'assistant'));
    if (payload.candidates) payload.candidates.forEach(c => item(c.content, 'assistant'));
    if (payload.error) add('error', payload.error, 'Error');
    if (!result.length && (payload.role || payload.type === 'function_call')) item(payload);
    return result;
  }

  function parse(sections) {
    const section = name => sections.find(s => s.name === name)?.text || '';
    const requestText = section('REQUEST BODY').trim();
    const responseText = responseBody(section('RESPONSE'));
    const timeline = frames(section('WEBSOCKET TIMELINE'));
    const requestFrames = timeline.filter(e => e.type === 'response.create');
    const requests = requestText ? frames(requestText) : requestFrames;
    const request = requests.length === 1 ? requests[0] : requests;
    const events = responseText ? frames(responseText) : timeline.filter(e => e.type !== 'response.create');
    const response = consolidate(events);
    let chat = [...messages(request, 'user'), ...messages(response)];
    // Preserve session ordering when the log contains multiple WebSocket turns.
    if (requestFrames.length) {
      chat = [];
      let responses = [];
      const flush = () => { chat.push(...messages(consolidate(responses))); responses = []; };
      for (const event of timeline) {
        if (event.type === 'response.create') { flush(); chat.push(...messages(event, 'user')); }
        else responses.push(event);
      }
      flush();
    }
    return {request, response, chat, events, requestText, responseText, requestHeaders:section('HEADERS'), sections};
  }

  // Use one partition for both views so proxy and upstream traffic never mix.
  function exchangeSections(sections, source) {
    const clientRequest = /^(REQUEST INFO|HEADERS|REQUEST BODY)$/;
    const clientResponse = /^RESPONSE$/;
    const apiRequest = /^API REQUEST(?: \d+)?$/;
    const apiResponse = /^API (?:RESPONSE(?: ERROR)?|ERROR RESPONSE)(?: \d+)?$/;
    const timelineName = source === 'api' ? 'API WEBSOCKET TIMELINE' : 'WEBSOCKET TIMELINE';
    const requestPattern = source === 'api' ? apiRequest : clientRequest;
    const responsePattern = source === 'api' ? apiResponse : clientResponse;
    return {
      request:sections.filter(s => requestPattern.test(s.name)),
      response:sections.filter(s => responsePattern.test(s.name)),
      timeline:sections.filter(s => s.name === timelineName),
      other:sections.filter(s => !clientRequest.test(s.name) && !clientResponse.test(s.name) && !apiRequest.test(s.name) && !apiResponse.test(s.name) && !['WEBSOCKET TIMELINE','API WEBSOCKET TIMELINE'].includes(s.name))
    };
  }

  // Partition recorded sections without interpreting or rewriting their payloads.
  function rawExchange(sections, source = 'api') {
    const data = exchangeSections(sections, source);
    const format = values => values.map(s => '=== ' + s.name + ' ===\n' + s.text).join('');
    return {request:format(data.request), response:format(data.response), timeline:format(data.timeline), other:data.other};
  }

  function structuredSection(section, response = false) {
    let text = section.text.replace(/\r\n/g, '\n').trim();
    let metadata = '';
    // Request bodies are already JSON; upstream sections also contain HTTP metadata.
    if (section.name !== 'REQUEST BODY' && json(text) === undefined) {
      const marker = /^Body:[ \t]*\n/m.exec(text);
      const boundary = marker ? marker.index : text.search(/^(?:\{|\[|data:|event:)/m);
      if (boundary >= 0) {
        metadata = text.slice(0, boundary).trim();
        text = text.slice(boundary + (marker ? marker[0].length : 0)).trim();
      } else if (response && text.includes('\n\n')) {
        const split = text.indexOf('\n\n');
        metadata = text.slice(0, split).trim();
        text = text.slice(split + 2).trim();
      }
    }
    const single = json(text);
    const events = single === undefined ? frames(text) : [];
    // Consolidate each attempt independently, retaining untouched original events.
    const body = single !== undefined ? single : events.length
      ? response ? consolidate(JSON.parse(JSON.stringify(events))) : events.length === 1 ? events[0] : events
      : text;
    return {name:section.name, metadata, body, events};
  }

  function treeExchange(sections, source = 'api') {
    const data = exchangeSections(sections, source);
    return {
      request:data.request.map(s => structuredSection(s)),
      response:data.response.map(s => structuredSection(s, true)),
      // Keep WebSocket events in order; never merge separate turns or their errors.
      timeline:data.timeline.map(s => ({name:s.name, body:s.text.replace(/\r\n/g, '\n').trim()
        .split(/(?=^Timestamp:)/m).filter(text => text.trim())
        .map(text => structuredSection({name:s.name, text}))})),
      sections:[...data.request, ...data.response, ...data.timeline],
      other:data.other
    };
  }

  const api = {frames, consolidate, messages, parse, rawExchange, treeExchange};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LogParser = api;
})(typeof window === 'undefined' ? {} : window);
