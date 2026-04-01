import { env } from '../config/env.js';
import { createPersistedLlmGatewayEventSink } from './llmTelemetry.js';

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
  promptVersion?: string | null;
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
      promptVersion: string | null;
      responseModel: string | null;
      temperature: number;
      maxTokens: number;
      timeoutMs: number;
      messageCount: number;
      durationMs: number;
      attempts: number;
      usage: LlmGatewayUsage;
    }
  | {
      event: 'llm_gateway_failure';
      feature: string;
      schemaName: string;
      model: string;
      promptVersion: string | null;
      temperature: number;
      maxTokens: number;
      timeoutMs: number;
      messageCount: number;
      durationMs: number;
      attempts: number;
      failureStage: 'config' | 'transport' | 'upstream' | 'response_content' | 'response_json';
      upstreamStatus: number | null;
      errorMessage: string;
    };

export type LlmGatewayEventSink = (event: LlmGatewayEvent) => void | Promise<void>;

type LlmGatewayEventBase = {
  feature: string;
  schemaName: string;
  model: string;
  promptVersion: string | null;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  messageCount: number;
};

type LlmGatewayRetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type LlmGatewayDeps = {
  fetchImpl: typeof fetch;
  openAiBaseUrl: string;
  openAiApiKey: string;
  onEvent?: LlmGatewayEventSink;
  nowMs?: () => number;
  sleepMs?: (delayMs: number) => Promise<void>;
  retryPolicy?: LlmGatewayRetryPolicy;
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

class LlmGatewayRequestError extends Error {
  failureStage: Extract<LlmGatewayEvent, { event: 'llm_gateway_failure' }>['failureStage'];
  upstreamStatus: number | null;
  retryable: boolean;

  constructor(input: {
    message: string;
    failureStage: Extract<LlmGatewayEvent, { event: 'llm_gateway_failure' }>['failureStage'];
    upstreamStatus?: number | null;
    retryable?: boolean;
  }) {
    super(input.message);
    this.failureStage = input.failureStage;
    this.upstreamStatus = input.upstreamStatus ?? null;
    this.retryable = input.retryable ?? false;
  }
}

function normalizeGatewayError(error: unknown) {
  if (error instanceof LlmGatewayRequestError) {
    return error;
  }
  return new LlmGatewayRequestError({
    message: errorMessageFromUnknown(error),
    failureStage: 'transport',
    retryable: true,
  });
}

function isRetryableUpstreamStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function resolveRetryDelayMs(attempt: number, retryPolicy: LlmGatewayRetryPolicy) {
  const exponentialDelay = retryPolicy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(retryPolicy.maxDelayMs, exponentialDelay);
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

export function createCompositeLlmGatewayEventSink(sinks: LlmGatewayEventSink[]): LlmGatewayEventSink {
  return async (event) => {
    for (const sink of sinks) {
      try {
        await sink(event);
      } catch (error) {
        console.warn(
          JSON.stringify({
            scope: 'llm_gateway',
            event: 'llm_gateway_sink_failure',
            feature: event.feature,
            errorMessage: errorMessageFromUnknown(error),
          })
        );
      }
    }
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
        promptVersion: input.promptVersion ?? null,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        timeoutMs: input.timeoutMs,
        messageCount: input.messages.length,
      };
      const emitEvent = deps.onEvent;
      const elapsedMs = () => Math.max(0, (deps.nowMs?.() ?? Date.now()) - startedAtMs);
      const emitFailure = async (attempts: number, error: LlmGatewayRequestError) => {
        await emitEvent?.({
          event: 'llm_gateway_failure',
          ...eventBase,
          durationMs: elapsedMs(),
          attempts,
          failureStage: error.failureStage,
          upstreamStatus: error.upstreamStatus,
          errorMessage: error.message,
        });
      };
      const emitSuccess = async (attempts: number, responseModel: string | null, usage: LlmGatewayUsage) => {
        await emitEvent?.({
          event: 'llm_gateway_success',
          ...eventBase,
          durationMs: elapsedMs(),
          attempts,
          responseModel,
          usage,
        });
      };
      const sleepMs = deps.sleepMs ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
      const retryPolicy = deps.retryPolicy ?? {
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
      };

      if (!deps.openAiApiKey) {
        const error = new LlmGatewayRequestError({
          message: 'OpenAI API key is not configured',
          failureStage: 'config',
        });
        await emitFailure(1, error);
        throw error;
      }

      const maxAttempts = retryPolicy.maxRetries + 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
            throw new LlmGatewayRequestError({
              message: `OpenAI ${input.feature} request failed (${response.status}): ${truncateUpstreamErrorBody(upstream, rawText)}`,
              failureStage: 'upstream',
              upstreamStatus: response.status,
              retryable: isRetryableUpstreamStatus(response.status),
            });
          }

          const content = extractMessageContent(upstream);
          if (!content) {
            throw new LlmGatewayRequestError({
              message: `OpenAI returned no ${input.feature} content`,
              failureStage: 'response_content',
            });
          }

          const parsedContent = parseJsonSafely(content);
          if (parsedContent === null) {
            throw new LlmGatewayRequestError({
              message: `OpenAI ${input.feature} payload is not valid JSON`,
              failureStage: 'response_json',
            });
          }

          const usage = extractUsage(upstream);
          const responseModel =
            upstream && typeof upstream === 'object' && typeof (upstream as Record<string, unknown>).model === 'string'
              ? ((upstream as Record<string, unknown>).model as string)
              : null;

          await emitSuccess(attempt, responseModel, usage);

          return {
            content,
            parsedContent,
            responseModel,
            usage,
          };
        } catch (error) {
          const normalizedError = normalizeGatewayError(error);
          const shouldRetry = normalizedError.retryable && attempt < maxAttempts;
          if (shouldRetry) {
            await sleepMs(resolveRetryDelayMs(attempt, retryPolicy));
            continue;
          }

          await emitFailure(attempt, normalizedError);
          throw normalizedError;
        }
      }

      throw new Error(`OpenAI ${input.feature} request exhausted without result`);
    },
  };
}

export const openAiStructuredGateway = createOpenAiStructuredGateway({
  fetchImpl: fetch,
  openAiBaseUrl: env.OPENAI_BASE_URL,
  openAiApiKey: env.OPENAI_API_KEY ?? '',
  retryPolicy: {
    maxRetries: env.OPENAI_MAX_RETRIES,
    baseDelayMs: env.OPENAI_RETRY_BASE_DELAY_MS,
    maxDelayMs: env.OPENAI_RETRY_MAX_DELAY_MS,
  },
  onEvent: createCompositeLlmGatewayEventSink([
    createConsoleLlmGatewayEventLogger(),
    createPersistedLlmGatewayEventSink(),
  ]),
});
