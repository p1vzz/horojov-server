import { env } from '../config/env.js';

type StructuredOutputSchema = {
  name: string;
  strict: boolean;
  schema: unknown;
};

type OpenAiChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
};

export type LlmGatewayUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

type OpenAiStructuredRequest = {
  feature: string;
  model: string;
  temperature: number;
  maxTokens: number;
  jsonSchema: StructuredOutputSchema;
  messages: OpenAiChatMessage[];
  timeoutMs: number;
};

type OpenAiStructuredResponse = {
  content: string;
  parsedContent: unknown;
  responseModel: string | null;
  usage: LlmGatewayUsage;
};

export type LlmGatewayEvent =
  | {
      event: 'llm_gateway_success';
      feature: string;
      schemaName: string;
      model: string;
      responseModel: string | null;
      temperature: number;
      maxTokens: number;
      timeoutMs: number;
      messageCount: number;
      durationMs: number;
      usage: LlmGatewayUsage;
    }
  | {
      event: 'llm_gateway_failure';
      feature: string;
      schemaName: string;
      model: string;
      temperature: number;
      maxTokens: number;
      timeoutMs: number;
      messageCount: number;
      durationMs: number;
      failureStage: 'config' | 'transport' | 'upstream' | 'response_content' | 'response_json';
      upstreamStatus: number | null;
      errorMessage: string;
    };

type LlmGatewayEventSink = (event: LlmGatewayEvent) => void;

type LlmGatewayEventBase = {
  feature: string;
  schemaName: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  messageCount: number;
};

type LlmGatewayDeps = {
  fetchImpl: typeof fetch;
  openAiBaseUrl: string;
  openAiApiKey: string;
  onEvent?: LlmGatewayEventSink;
  nowMs?: () => number;
};

function parseJsonSafely(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function truncateUpstreamErrorBody(input: unknown, fallbackText: string) {
  if (typeof input === 'object' && input) {
    return JSON.stringify(input).slice(0, 220);
  }

  return fallbackText.slice(0, 220);
}

function extractMessageContent(upstream: unknown) {
  if (!upstream || typeof upstream !== 'object') return null;
  const choices = (upstream as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== 'object') return null;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : null;
}

function extractUsage(upstream: unknown) {
  if (!upstream || typeof upstream !== 'object') {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
  }

  const usage = (upstream as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') {
    return {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
  }

  const usageRecord = usage as Record<string, unknown>;
  const asNullableNumber = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  return {
    promptTokens: asNullableNumber(usageRecord.prompt_tokens),
    completionTokens: asNullableNumber(usageRecord.completion_tokens),
    totalTokens: asNullableNumber(usageRecord.total_tokens),
  };
}

function errorMessageFromUnknown(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

export function createConsoleLlmGatewayEventLogger(): LlmGatewayEventSink {
  return (event) => {
    const message = JSON.stringify({
      scope: 'llm_gateway',
      ...event,
    });
    if (event.event === 'llm_gateway_failure') {
      console.warn(message);
      return;
    }
    console.info(message);
  };
}

export function createOpenAiStructuredGateway(deps: LlmGatewayDeps) {
  return {
    async requestStructuredCompletion(input: OpenAiStructuredRequest): Promise<OpenAiStructuredResponse> {
      const startedAtMs = deps.nowMs?.() ?? Date.now();
      const eventBase: LlmGatewayEventBase = {
        feature: input.feature,
        schemaName: input.jsonSchema.name,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        timeoutMs: input.timeoutMs,
        messageCount: input.messages.length,
      };
      const emitEvent = deps.onEvent;
      let failureLogged = false;
      const elapsedMs = () => Math.max(0, (deps.nowMs?.() ?? Date.now()) - startedAtMs);
      const emitFailure = (
        failureStage: Extract<LlmGatewayEvent, { event: 'llm_gateway_failure' }>['failureStage'],
        upstreamStatus: number | null,
        error: unknown
      ) => {
        failureLogged = true;
        emitEvent?.({
          event: 'llm_gateway_failure',
          ...eventBase,
          durationMs: elapsedMs(),
          failureStage,
          upstreamStatus,
          errorMessage: errorMessageFromUnknown(error),
        });
      };

      if (!deps.openAiApiKey) {
        const error = new Error('OpenAI API key is not configured');
        emitFailure('config', null, error);
        throw error;
      }

      try {
        const response = await deps.fetchImpl(`${deps.openAiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${deps.openAiApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: input.model,
            temperature: input.temperature,
            max_tokens: input.maxTokens,
            response_format: {
              type: 'json_schema',
              json_schema: input.jsonSchema,
            },
            messages: input.messages,
          }),
          signal: AbortSignal.timeout(input.timeoutMs),
        });

        const rawText = await response.text();
        const upstream = parseJsonSafely(rawText);

        if (!response.ok) {
          const error = new Error(
            `OpenAI ${input.feature} request failed (${response.status}): ${truncateUpstreamErrorBody(upstream, rawText)}`
          );
          emitFailure('upstream', response.status, error);
          throw error;
        }

        const content = extractMessageContent(upstream);
        if (!content) {
          const error = new Error(`OpenAI returned no ${input.feature} content`);
          emitFailure('response_content', response.status, error);
          throw error;
        }

        const parsedContent = parseJsonSafely(content);
        if (parsedContent === null) {
          const error = new Error(`OpenAI ${input.feature} payload is not valid JSON`);
          emitFailure('response_json', response.status, error);
          throw error;
        }

        const usage = extractUsage(upstream);
        const responseModel =
          upstream && typeof upstream === 'object' && typeof (upstream as Record<string, unknown>).model === 'string'
            ? ((upstream as Record<string, unknown>).model as string)
            : null;

        emitEvent?.({
          event: 'llm_gateway_success',
          ...eventBase,
          durationMs: elapsedMs(),
          responseModel,
          usage,
        });

        return {
          content,
          parsedContent,
          responseModel,
          usage,
        };
      } catch (error) {
        if (!failureLogged) {
          emitFailure('transport', null, error);
        }
        throw error;
      }
    },
  };
}

export const openAiStructuredGateway = createOpenAiStructuredGateway({
  fetchImpl: fetch,
  openAiBaseUrl: env.OPENAI_BASE_URL,
  openAiApiKey: env.OPENAI_API_KEY ?? '',
  onEvent: createConsoleLlmGatewayEventLogger(),
});
