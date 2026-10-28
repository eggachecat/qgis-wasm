/** Provider registry: add a file next to these and one line here (or register at runtime with registerProvider). */
import OpenAIResponsesProvider from './openai-responses.js';
import OpenAIChatProvider from './openai-chat.js';

const providers = new Map([
  [OpenAIResponsesProvider.id, OpenAIResponsesProvider],
  [OpenAIChatProvider.id, OpenAIChatProvider],
]);

export function registerProvider(cls) { providers.set(cls.id, cls); }
export function listProviders() { return [...providers.values()].map((p) => ({ id: p.id, label: p.label })); }
export function createProvider(config) {
  const Cls = providers.get(config.provider) || OpenAIResponsesProvider;
  return new Cls(config);
}
