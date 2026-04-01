import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { getCollections, type LlmGatewayTelemetryDoc, type MongoCollections } from '../db/mongo.js';
import type { LlmGatewayEvent, LlmGatewayEventSink, LlmGatewayUsage } from './llmGateway.js';

export type LlmCostEstimate = {
  estimatedInputCostUsd: number | null;
  estimatedOutputCostUsd: number | null;
  estimatedTotalCostUsd: number | null;
};

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateLlmCostUsd(input: {
  usage: LlmGatewayUsage;
  inputUsdPer1MTokens: number | null;
  outputUsdPer1MTokens: number | null;
}): LlmCostEstimate {
  const promptTokens = input.usage.promptTokens;
  const completionTokens = input.usage.completionTokens;

  const estimatedInputCostUsd =
    promptTokens === null || input.inputUsdPer1MTokens === null
      ? null
      : roundUsd((promptTokens / 1_000_000) * input.inputUsdPer1MTokens);
  const estimatedOutputCostUsd =
    completionTokens === null || input.outputUsdPer1MTokens === null
      ? null
      : roundUsd((completionTokens / 1_000_000) * input.outputUsdPer1MTokens);
  const estimatedTotalCostUsd =
    estimatedInputCostUsd === null || estimatedOutputCostUsd === null
      ? null
      : roundUsd(estimatedInputCostUsd + estimatedOutputCostUsd);

  return {
    estimatedInputCostUsd,
    estimatedOutputCostUsd,
    estimatedTotalCostUsd,
  };
}

export function buildLlmGatewayTelemetryDoc(
  event: LlmGatewayEvent,
  now: Date = new Date()
): LlmGatewayTelemetryDoc {
  const usage = event.event === 'llm_gateway_success'
    ? event.usage
    : {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      };
  const costEstimate = estimateLlmCostUsd({
    usage,
    inputUsdPer1MTokens: env.OPENAI_COST_INPUT_USD_PER_1M_TOKENS ?? null,
    outputUsdPer1MTokens: env.OPENAI_COST_OUTPUT_USD_PER_1M_TOKENS ?? null,
  });

  return {
    _id: new ObjectId(),
    event: event.event,
    feature: event.feature,
    schemaName: event.schemaName,
    requestModel: event.model,
    promptVersion: event.promptVersion,
    responseModel: event.event === 'llm_gateway_success' ? event.responseModel : null,
    temperature: event.temperature,
    maxTokens: event.maxTokens,
    timeoutMs: event.timeoutMs,
    messageCount: event.messageCount,
    attempts: event.attempts,
    durationMs: event.durationMs,
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimatedInputCostUsd: costEstimate.estimatedInputCostUsd,
      estimatedOutputCostUsd: costEstimate.estimatedOutputCostUsd,
      estimatedTotalCostUsd: costEstimate.estimatedTotalCostUsd,
    },
    failureStage: event.event === 'llm_gateway_failure' ? event.failureStage : null,
    upstreamStatus: event.event === 'llm_gateway_failure' ? event.upstreamStatus : null,
    errorMessage: event.event === 'llm_gateway_failure' ? event.errorMessage : null,
    createdAt: now,
  };
}

export function createPersistedLlmGatewayEventSink(deps?: {
  getCollectionsImpl?: () => Promise<MongoCollections>;
  now?: () => Date;
  warn?: (message: string) => void;
}): LlmGatewayEventSink {
  return async (event) => {
    if (!env.OPENAI_TELEMETRY_ENABLED) return;

    try {
      const collections = await (deps?.getCollectionsImpl ?? getCollections)();
      await collections.llmGatewayTelemetry.insertOne(buildLlmGatewayTelemetryDoc(event, deps?.now?.() ?? new Date()));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      (deps?.warn ?? console.warn)(
        JSON.stringify({
          scope: 'llm_gateway_telemetry',
          event: 'persist_failed',
          feature: event.feature,
          errorMessage,
        })
      );
    }
  };
}
