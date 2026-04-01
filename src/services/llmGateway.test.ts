import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAiStructuredGateway, type LlmGatewayEvent } from './llmGateway.js';

test('llm gateway sends structured completion request with schema and messages', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const events: LlmGatewayEvent[] = [];
  const gateway = createOpenAiStructuredGateway({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [
            {
              message: {
                content: JSON.stringify({ explanation: 'Structured output.' }),
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
          },
        }),
        { status: 200 }
      );
    },
    openAiBaseUrl: 'https://api.openai.com/v1/',
    openAiApiKey: 'test-key',
    onEvent: (event) => events.push(event),
    nowMs: (() => {
      const timestamps = [100, 124];
      return () => timestamps.shift() ?? 124;
    })(),
  });

  const result = await gateway.requestStructuredCompletion({
    feature: 'interview strategy',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 200,
    timeoutMs: 5000,
    jsonSchema: {
      name: 'demo_schema',
      strict: true,
      schema: {
        type: 'object',
      },
    },
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User prompt' },
    ],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.openai.com/v1/chat/completions');
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 200);
  assert.deepEqual(body.response_format.json_schema, {
    name: 'demo_schema',
    strict: true,
    schema: {
      type: 'object',
    },
  });
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: 'User prompt' },
  ]);
  assert.equal(result.responseModel, 'gpt-4o-mini');
  assert.deepEqual(result.parsedContent, { explanation: 'Structured output.' });
  assert.deepEqual(result.usage, {
    promptTokens: 12,
    completionTokens: 8,
    totalTokens: 20,
  });
  assert.deepEqual(events, [
    {
      event: 'llm_gateway_success',
      feature: 'interview strategy',
      schemaName: 'demo_schema',
      model: 'gpt-4o-mini',
      responseModel: 'gpt-4o-mini',
      temperature: 0.3,
      maxTokens: 200,
      timeoutMs: 5000,
      messageCount: 2,
      durationMs: 24,
      usage: {
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
      },
    },
  ]);
});

test('llm gateway surfaces upstream status failures with feature-specific context', async () => {
  const events: LlmGatewayEvent[] = [];
  const gateway = createOpenAiStructuredGateway({
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
      }),
    openAiBaseUrl: 'https://api.openai.com/v1',
    openAiApiKey: 'test-key',
    onEvent: (event) => events.push(event),
    nowMs: (() => {
      const timestamps = [500, 512];
      return () => timestamps.shift() ?? 512;
    })(),
  });

  await assert.rejects(
    () =>
      gateway.requestStructuredCompletion({
        feature: 'career insights',
        model: 'gpt-4o-mini',
        temperature: 0.4,
        maxTokens: 300,
        timeoutMs: 5000,
        jsonSchema: {
          name: 'demo_schema',
          strict: true,
          schema: { type: 'object' },
        },
        messages: [{ role: 'user', content: 'Prompt' }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /OpenAI career insights request failed \(429\)/);
      return true;
    }
  );
  assert.deepEqual(events, [
    {
      event: 'llm_gateway_failure',
      feature: 'career insights',
      schemaName: 'demo_schema',
      model: 'gpt-4o-mini',
      temperature: 0.4,
      maxTokens: 300,
      timeoutMs: 5000,
      messageCount: 1,
      durationMs: 12,
      failureStage: 'upstream',
      upstreamStatus: 429,
      errorMessage: 'OpenAI career insights request failed (429): {"error":{"message":"rate limited"}}',
    },
  ]);
});

test('llm gateway emits config-stage failure when API key is missing', async () => {
  const events: LlmGatewayEvent[] = [];
  const gateway = createOpenAiStructuredGateway({
    fetchImpl: async () => new Response('{}', { status: 200 }),
    openAiBaseUrl: 'https://api.openai.com/v1',
    openAiApiKey: '',
    onEvent: (event) => events.push(event),
    nowMs: (() => {
      const timestamps = [900, 901];
      return () => timestamps.shift() ?? 901;
    })(),
  });

  await assert.rejects(
    () =>
      gateway.requestStructuredCompletion({
        feature: 'screenshot parse',
        model: 'gpt-4o-mini',
        temperature: 0.2,
        maxTokens: 128,
        timeoutMs: 5000,
        jsonSchema: {
          name: 'screenshot_schema',
          strict: true,
          schema: { type: 'object' },
        },
        messages: [{ role: 'user', content: 'Prompt' }],
      }),
    /OpenAI API key is not configured/
  );

  assert.deepEqual(events, [
    {
      event: 'llm_gateway_failure',
      feature: 'screenshot parse',
      schemaName: 'screenshot_schema',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 128,
      timeoutMs: 5000,
      messageCount: 1,
      durationMs: 1,
      failureStage: 'config',
      upstreamStatus: null,
      errorMessage: 'OpenAI API key is not configured',
    },
  ]);
});
