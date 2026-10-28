/**
 * openai-chat.js — model provider for the Chat Completions API (POST {baseUrl}/chat/completions), the format most
 * OpenAI-compatible gateways and local servers (Ollama, vLLM, …) support. Same provider contract as openai-responses.js.
 */

export default class OpenAIChatProvider {
  static id = 'openai-chat';
  static label = 'OpenAI Chat Completions (OpenAI-compatible servers, Ollama, vLLM)';

  constructor({ baseUrl, apiKey, model, maxOutputTokens = 4096, stream = true, temperature } = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || '';
    this.maxOutputTokens = maxOutputTokens;
    this.useStream = stream !== false;
    this.temperature = temperature;
  }

  get configured() { return !!(this.baseUrl && this.model); }

  toMessages(system, items) {
    const messages = [{ role: 'system', content: system }];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.role === 'user') messages.push({ role: 'user', content: it.content });
      else if (it.role === 'assistant') messages.push({ role: 'assistant', content: it.content });
      else if (it.type === 'tool_call') {
        // consecutive tool calls of one model turn become one assistant message with tool_calls
        const last = messages[messages.length - 1];
        const call = { id: it.callId, type: 'function', function: { name: it.name, arguments: it.arguments || '{}' } };
        if (last && last.role === 'assistant' && last.tool_calls && !last._closed) last.tool_calls.push(call);
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      } else if (it.type === 'tool_result') {
        for (let j = messages.length - 1; j >= 0; j--) if (messages[j].role === 'assistant' && messages[j].tool_calls) { messages[j]._closed = true; break; }
        messages.push({ role: 'tool', tool_call_id: it.callId, content: it.output });
      }
    }
    for (const m of messages) delete m._closed;
    return messages;
  }

  toTools(tools) { return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })); }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async *stream({ system, items, tools, signal }) {
    const body = { model: this.model, messages: this.toMessages(system, items), max_tokens: this.maxOutputTokens, stream: this.useStream };
    if (tools.length) body.tools = this.toTools(tools);
    if (this.temperature !== undefined) body.temperature = this.temperature;
    const res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`model request failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 400)}`);
    const type = res.headers.get('Content-Type') || '';
    if (!this.useStream || !type.includes('text/event-stream')) {
      const json = await res.json();
      if (json.error) throw new Error(`model: ${json.error.message || JSON.stringify(json.error)}`);
      const msg = json.choices?.[0]?.message || {};
      if (msg.content) yield { type: 'text', delta: msg.content };
      for (const c of msg.tool_calls || []) yield { type: 'tool_call', callId: c.id, name: c.function?.name, arguments: c.function?.arguments || '{}' };
      yield { type: 'done', text: msg.content || '', usage: json.usage || null };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', text = '', usage = null;
    const calls = []; // by index
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let ev; try { ev = JSON.parse(data); } catch (e) { continue; }
        if (ev.error) throw new Error(`model: ${ev.error.message || JSON.stringify(ev.error)}`);
        if (ev.usage) usage = ev.usage;
        const delta = ev.choices?.[0]?.delta || {};
        if (delta.content) { text += delta.content; yield { type: 'text', delta: delta.content }; }
        for (const tc of delta.tool_calls || []) {
          const i = tc.index ?? calls.length;
          calls[i] = calls[i] || { callId: '', name: '', arguments: '' };
          if (tc.id) calls[i].callId = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
        }
      }
    }
    for (const c of calls) if (c) yield { type: 'tool_call', callId: c.callId || `call_${Math.random().toString(36).slice(2)}`, name: c.name, arguments: c.arguments || '{}' };
    yield { type: 'done', text, usage };
  }
}
