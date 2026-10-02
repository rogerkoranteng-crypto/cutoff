// Bedrock Converse with tool use. The account is rate limited (about 10 requests a minute, shared with other
// projects), so every call goes through the SDK's adaptive retry plus a bounded backoff of our own. When the
// budget for one call is spent, BedrockUnavailable tells the caller to switch to the labelled rule-based path.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

export const MODEL = () => process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
let client;

export class BedrockUnavailable extends Error {
  constructor(message, cause) { super(message); this.name = 'BedrockUnavailable'; this.cause = cause; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throttled = (e) => e?.name === 'ThrottlingException' || e?.name === 'ServiceUnavailableException' || /too many requests|throttl/i.test(e?.message ?? '');

export async function converseTurn({ system, messages, tools, maxTokens = 1400, budgetMs = 50_000, send }) {
  if (process.env.BEDROCK_DISABLED === '1') throw new BedrockUnavailable('the model is switched off for this environment');
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 5, retryMode: 'adaptive' });
  const cmd = new ConverseCommand({
    modelId: MODEL(),
    system: [{ text: system }],
    messages,
    toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input } } })) },
    inferenceConfig: { maxTokens, temperature: 0.1 },
  });
  const started = Date.now();
  let wait = 2000;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await (send ?? ((c) => client.send(c)))(cmd);
      return { message: out.output.message, stopReason: out.stopReason, usage: out.usage, ms: Date.now() - started, model: MODEL() };
    } catch (e) {
      if (!throttled(e)) throw new BedrockUnavailable(`Bedrock error: ${e.name ?? 'Error'}: ${String(e.message).slice(0, 160)}`, e);
      if (Date.now() - started + wait > budgetMs) throw new BedrockUnavailable('Bedrock was rate limited and the retry budget ran out', e);
      await sleep(wait);
      wait = Math.min(wait * 2, 12_000);
    }
  }
}
