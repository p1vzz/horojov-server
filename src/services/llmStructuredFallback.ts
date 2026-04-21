import { env } from '../config/env.js';
import {
  createCompositeLlmGatewayEventSink,
  createConsoleLlmGatewayEventLogger,
  createOpenAiStructuredGateway,
  openAiStructuredGateway,
} from './llmGateway.js';
import { createPersistedLlmGatewayEventSink } from './llmTelemetry.js';

type StructuredCompletionRequest = Parameters<typeof openAiStructuredGateway.requestStructuredCompletion>[0];
type StructuredCompletionResponse = Awaited<ReturnType<typeof openAiStructuredGateway.requestStructuredCompletion>>;
type StructuredCompletionRequester = (input: StructuredCompletionRequest) => Promise<StructuredCompletionResponse>;

export type LlmNarrativeSource = 'llm' | null;
export type LlmNarrativeStatus = 'ready' | 'pending' | 'unavailable' | 'failed';

export type LlmGenerationFailureCode =
  | 'llm_unavailable'
  | 'llm_unconfigured'
  | 'llm_timeout'
  | 'llm_rate_limited'
  | 'llm_invalid_response'
  | 'llm_upstream_error';

export type LlmFallbackFeature =
  | 'ai_synergy'
  | 'career_insights'
  | 'career_vibe_plan'
  | 'job_screenshot'
  | 'interview_strategy'
  | 'full_natal_analysis';

export class LlmStructuredCompletionError extends Error {
  code: LlmGenerationFailureCode;
  primaryError: unknown;
  backupError: unknown;

  constructor(input: {
    code: LlmGenerationFailureCode;
    message: string;
    primaryError?: unknown;
    backupError?: unknown;
  }) {
    super(input.message);
    this.name = 'LlmStructuredCompletionError';
    this.code = input.code;
    this.primaryError = input.primaryError;
    this.backupError = input.backupError;
  }
}

let backupStructuredGateway: ReturnType<typeof createOpenAiStructuredGateway> | null | undefined;

function getBackupStructuredGateway() {
  if (backupStructuredGateway !== undefined) return backupStructuredGateway;
  if (!env.LLM_BACKUP_API_KEY || !env.LLM_BACKUP_BASE_URL) {
    backupStructuredGateway = null;
    return backupStructuredGateway;
  }

  backupStructuredGateway = createOpenAiStructuredGateway({
    fetchImpl: fetch,
    openAiBaseUrl: env.LLM_BACKUP_BASE_URL,
    openAiApiKey: env.LLM_BACKUP_API_KEY,
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
  return backupStructuredGateway;
}

function isGatewayStage(error: unknown, stage: string) {
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    (error as { failureStage?: unknown }).failureStage === stage
  );
}

function upstreamStatus(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { upstreamStatus?: unknown }).upstreamStatus;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function isTimeoutLike(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();
  return name.includes('timeout') || message.includes('timeout') || message.includes('aborted');
}

export function classifyLlmGenerationError(error: unknown): LlmGenerationFailureCode {
  if (error instanceof LlmStructuredCompletionError) return error.code;
  if (isGatewayStage(error, 'config')) return 'llm_unconfigured';
  if (isGatewayStage(error, 'response_content') || isGatewayStage(error, 'response_json')) {
    return 'llm_invalid_response';
  }
  if (error instanceof Error && error.message.toLowerCase().includes('payload format is invalid')) {
    return 'llm_invalid_response';
  }
  if (isTimeoutLike(error)) return 'llm_timeout';

  const status = upstreamStatus(error);
  if (status === 429) return 'llm_rate_limited';
  if (status !== null) return 'llm_upstream_error';

  return 'llm_upstream_error';
}

export function resolveBackupModel(feature: LlmFallbackFeature) {
  switch (feature) {
    case 'ai_synergy':
      return env.LLM_BACKUP_AI_SYNERGY_MODEL ?? env.LLM_BACKUP_MODEL ?? null;
    case 'career_insights':
      return env.LLM_BACKUP_CAREER_INSIGHTS_MODEL ?? env.LLM_BACKUP_MODEL ?? null;
    case 'career_vibe_plan':
      return env.LLM_BACKUP_CAREER_VIBE_PLAN_MODEL ?? env.LLM_BACKUP_MODEL ?? null;
    case 'job_screenshot':
      return env.LLM_BACKUP_JOB_SCREENSHOT_MODEL ?? env.LLM_BACKUP_MODEL ?? null;
    case 'interview_strategy':
      return env.LLM_BACKUP_INTERVIEW_STRATEGY_MODEL ?? env.LLM_BACKUP_MODEL ?? null;
    case 'full_natal_analysis':
      return env.LLM_BACKUP_FULL_NATAL_ANALYSIS_MODEL ?? env.LLM_BACKUP_MODEL ?? null;
  }
}

export async function requestStructuredCompletionWithFallback(input: {
  request: StructuredCompletionRequest;
  primaryEnabled: boolean;
  primaryRequester?: StructuredCompletionRequester;
  backupModel?: string | null;
  backupRequester?: StructuredCompletionRequester;
  isBackupEnabled?: () => boolean;
  onBackupRoute?: () => void;
}): Promise<{
  completion: StructuredCompletionResponse;
  model: string;
  provider: 'primary' | 'backup';
  usedBackup: boolean;
}> {
  const hasInjectedPrimaryRequester = Boolean(input.primaryRequester);
  const primaryRequester = input.primaryRequester ?? openAiStructuredGateway.requestStructuredCompletion;
  const primaryAvailable = input.primaryEnabled && (hasInjectedPrimaryRequester || Boolean(env.OPENAI_API_KEY));
  const backupGateway = getBackupStructuredGateway();
  const backupRequester = input.backupRequester ?? backupGateway?.requestStructuredCompletion;
  const backupModel = input.backupModel ?? null;
  const backupAvailable =
    (input.isBackupEnabled?.() ?? true) &&
    Boolean(backupRequester) &&
    Boolean(backupModel);

  if (!primaryAvailable && !backupAvailable) {
    throw new LlmStructuredCompletionError({
      code: 'llm_unavailable',
      message: `${input.request.feature} generation is unavailable`,
    });
  }

  const requestBackup = async (primaryError?: unknown) => {
    if (!backupAvailable || !backupRequester || !backupModel) {
      throw new LlmStructuredCompletionError({
        code: primaryError ? classifyLlmGenerationError(primaryError) : 'llm_unavailable',
        message: `${input.request.feature} primary generation failed and no backup provider is available`,
        primaryError,
      });
    }

    input.onBackupRoute?.();
    try {
      const completion = await backupRequester({
        ...input.request,
        model: backupModel,
      });
      return {
        completion,
        model: backupModel,
        provider: 'backup' as const,
        usedBackup: true,
      };
    } catch (backupError) {
      throw new LlmStructuredCompletionError({
        code: classifyLlmGenerationError(backupError),
        message: `${input.request.feature} backup generation failed`,
        primaryError,
        backupError,
      });
    }
  };

  if (!primaryAvailable) {
    return requestBackup();
  }

  try {
    const completion = await primaryRequester(input.request);
    return {
      completion,
      model: input.request.model,
      provider: 'primary',
      usedBackup: false,
    };
  } catch (primaryError) {
    return requestBackup(primaryError);
  }
}
