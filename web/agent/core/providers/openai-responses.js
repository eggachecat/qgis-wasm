/**
 * openai-responses.js — model provider for the OpenAI Responses API (POST {baseUrl}/responses), streaming with a
 * non-streaming fallback. Any OpenAI-compatible gateway that offers the Responses API works.
 *
 * Provider contract (docs/05 §4): `for await (const ev of provider.stream(request))` yields
 *   { type: 'text', delta }                                   streamed assistant text
 *   { type: 'tool_call', callId, name, arguments }            a complete function call (arguments = JSON string)
 *   { type: 'done', text, usage }                             end of the model turn
 * request = { system, items, tools, signal } where items are the runtime's transcript items (see runtime.js).
 */

export default class OpenAIResponsesProvider {
  static id = 'openai-responses';
  static label = 'OpenAI Responses API';

  constructor({ baseUrl, apiKey, model, maxOutputTokens = 4096, stream = true, temperature } = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || '';
    this.maxOutputTokens = maxOutputTokens;
    this.useStream = stream !== false;
    this.temperature = temperature;
  }

  get configured() { return !!(this.baseUrl && this.model); }

  toInput(items) {
    const input = [];
    for (const it of items) {
      if (it.role === 'user') input.push({ role: 'user', content: it.content });
      else if (it.role === 'assistant') input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: it.content }] });
      else if (it.type === 'tool_call') input.push({ type: 'function_call', call_id: it.callId, name: it.name, arguments: it.arguments || '{}' });
      else if (it.type === 'tool_result') input.push({ type: 'function_call_output', call_id: it.callId, output: it.output });
    }
    return input;
  }

  toTools(tools) { return tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })); }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async *stream({ system, items, tools, signal }) {
    const body = { model: this.model, instructions: system, input: this.toInput(items), tools: this.toTools(tools), max_output_tokens: this.maxOutputTokens, store: false, stream: this.useStream };
    if (this.temperature !== undefined) body.temperature = this.temperature;
    const res = await fetch(`${this.baseUrl}/responses`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`model request failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 400)}`);
    const type = res.headers.get('Content-Type') || '';
    if (!this.useStream || !type.includes('text/event-stream')) {
      yield* this.fromResponse(await res.json());
      return;
    }
    // SSE: use deltas for live text, the final response object as the authoritative result
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', final = null, streamedText = '';
    const calls = new Map(); // item_id → {callId, name, arguments}
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let ev; try { ev = JSON.parse(data); } catch (e) { continue; }
        switch (ev.type) {
          case 'response.output_text.delta': streamedText += ev.delta || ''; yield { type: 'text', delta: ev.delta || '' }; break;
          case 'response.output_item.added': if (ev.item?.type === 'function_call') calls.set(ev.item.id || ev.item.call_id, { callId: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments || '' }); break;
          case 'response.function_call_arguments.delta': { const c = calls.get(ev.item_id); if (c) c.arguments += ev.delta || ''; break; }
          case 'response.function_call_arguments.done': { const c = calls.get(ev.item_id); if (c) c.arguments = ev.arguments || c.arguments; break; }
          case 'response.completed': case 'response.incomplete': final = ev.response; break;
          case 'response.failed': throw new Error(`model: ${ev.response?.error?.message || 'response failed'}`);
          case 'error': throw new Error(`model: ${ev.error?.message || ev.message || 'stream error'}`);
          default: break;
        }
      }
    }
    if (final) {
      for (const ev of this.collect(final)) { if (ev.type !== 'text') yield ev; }
      return;
    }
    // stream ended without a final response object: fall back to what was streamed
    for (const c of calls.values()) yield { type: 'tool_call', callId: c.callId, name: c.name, arguments: c.arguments || '{}' };
    yield { type: 'done', text: streamedText, usage: null };
  }

  *fromResponse(response) {
    const events = this.collect(response);
    for (const ev of events) yield ev;
  }

  /** The final response object → text + tool calls + done */
  collect(response) {
    if (response.error) throw new Error(`model: ${response.error.message || JSON.stringify(response.error)}`);
    const out = [];
    let text = '';
    for (const item of response.output || []) {
      if (item.type === 'message') for (const c of item.content || []) if (c.type === 'output_text') text += c.text || '';
      if (item.type === 'function_call') out.push({ type: 'tool_call', callId: item.call_id, name: item.name, arguments: item.arguments || '{}' });
    }
    if (text) out.unshift({ type: 'text', delta: text });
    out.push({ type: 'done', text, usage: response.usage || null });
    return out;
  }
}
