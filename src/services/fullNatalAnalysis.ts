import { env } from '../config/env.js';
import {
  createCompositeLlmGatewayEventSink,
  createConsoleLlmGatewayEventLogger,
  createOpenAiStructuredGateway,
  openAiStructuredGateway,
} from './llmGateway.js';
import { createPersistedLlmGatewayEventSink } from './llmTelemetry.js';
import { getFullNatalAnalysisPromptConfig } from './llmPromptRegistry.js';
import { REFLECTIVE_CAREER_GUIDANCE_PROMPT } from './llmPromptGuidance.js';
import type { FastifyBaseLogger } from 'fastify';
import type { ChartPromptPayload } from './careerInsights.js';
import type {
  FullNatalCareerAnalysisPayloadDoc,
  FullNatalCareerArchetypeDoc,
  FullNatalCareerBlindSpotDoc,
  FullNatalCareerPhasePlanDoc,
  FullNatalCareerRoleFitDoc,
  FullNatalCareerStrengthDoc,
} from '../db/mongo.js';

type FullNatalContextInput = {
  aiSynergyScore?: number | null;
  aiSynergyBand?: 'peak' | 'strong' | 'stable' | 'volatile' | null;
  careerInsightsSummary?: string | null;
};

type FullNatalStructuredCompletionRequest = Parameters<
  typeof openAiStructuredGateway.requestStructuredCompletion
>[0];

type FullNatalAnalysisGenerationDeps = {
  isLlmAvailable?: () => boolean;
  isBackupLlmAvailable?: () => boolean;
  requestStructuredCompletion?: (
    input: FullNatalStructuredCompletionRequest,
  ) => Promise<{ parsedContent: unknown }>;
  requestBackupStructuredCompletion?: (
    input: FullNatalStructuredCompletionRequest,
  ) => Promise<{ parsedContent: unknown }>;
  backupModel?: string;
};

type FullNatalAnalysisProgressTracker = {
  setStage: (stageKey: string) => void;
};

const FULL_NATAL_SCHEMA_VERSION = 'full_natal_analysis.v1';

const FULL_NATAL_SYSTEM_PROMPT = [
  'You are a senior vocational astrologer and career strategy advisor.',
  'Your task is to produce a practical long-range career blueprint.',
  'Use only the provided input data and evidence.',
  REFLECTIVE_CAREER_GUIDANCE_PROMPT,
  'No deterministic predictions and no guaranteed outcomes.',
  'Avoid medical, legal, and financial claims.',
  'Every key recommendation should reference chart evidence in plain language.',
  'Output strict JSON only, matching schema.',
].join(' ');

const FULL_NATAL_USER_PROMPT = [
  'Generate Full Natal Career Blueprint.',
  'Requirements:',
  '- executiveSummary: 2-4 focused sentences.',
  '- careerArchetypes: 3 to 4 entries with score 0..100 and clear evidence lines.',
  '- strengths: exactly 4 entries.',
  '- blindSpots: exactly 3 entries with mitigation.',
  '- roleFitMatrix: exactly 5 domains with fitScore and example roles.',
  '- phasePlan: exactly 3 phases (0_6_months, 6_18_months, 18_36_months).',
  '- decisionRules: exactly 6 concise rules.',
  '- next90DaysPlan: exactly 6 concrete actions.',
  '- Tone: strategic, practical, not mystical.',
].join('\n');

const OUTPUT_SCHEMA = {
  name: 'full_natal_career_blueprint',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'headline',
      'executiveSummary',
      'careerArchetypes',
      'strengths',
      'blindSpots',
      'roleFitMatrix',
      'phasePlan',
      'decisionRules',
      'next90DaysPlan',
    ],
    properties: {
      schemaVersion: { type: 'string', minLength: 3, maxLength: 80 },
      headline: { type: 'string', minLength: 6, maxLength: 120 },
      executiveSummary: { type: 'string', minLength: 80, maxLength: 800 },
      careerArchetypes: {
        type: 'array',
        minItems: 3,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'score', 'evidence'],
          properties: {
            name: { type: 'string', minLength: 3, maxLength: 80 },
            score: { type: 'number', minimum: 0, maximum: 100 },
            evidence: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string', minLength: 8, maxLength: 180 },
            },
          },
        },
      },
      strengths: {
        type: 'array',
        minItems: 4,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'details', 'evidence'],
          properties: {
            title: { type: 'string', minLength: 3, maxLength: 100 },
            details: { type: 'string', minLength: 24, maxLength: 400 },
            evidence: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', minLength: 8, maxLength: 180 },
            },
          },
        },
      },
      blindSpots: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'risk', 'mitigation', 'evidence'],
          properties: {
            title: { type: 'string', minLength: 3, maxLength: 100 },
            risk: { type: 'string', minLength: 20, maxLength: 260 },
            mitigation: { type: 'string', minLength: 18, maxLength: 260 },
            evidence: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', minLength: 8, maxLength: 180 },
            },
          },
        },
      },
      roleFitMatrix: {
        type: 'array',
        minItems: 5,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['domain', 'fitScore', 'why', 'exampleRoles'],
          properties: {
            domain: { type: 'string', minLength: 3, maxLength: 80 },
            fitScore: { type: 'number', minimum: 0, maximum: 100 },
            why: { type: 'string', minLength: 18, maxLength: 240 },
            exampleRoles: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string', minLength: 3, maxLength: 80 },
            },
          },
        },
      },
      phasePlan: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['phase', 'goal', 'actions', 'kpis', 'risks'],
          properties: {
            phase: { type: 'string', enum: ['0_6_months', '6_18_months', '18_36_months'] },
            goal: { type: 'string', minLength: 14, maxLength: 220 },
            actions: {
              type: 'array',
              minItems: 3,
              maxItems: 5,
              items: { type: 'string', minLength: 12, maxLength: 180 },
            },
            kpis: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string', minLength: 8, maxLength: 120 },
            },
            risks: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string', minLength: 8, maxLength: 140 },
            },
          },
        },
      },
      decisionRules: {
        type: 'array',
        minItems: 6,
        maxItems: 6,
        items: { type: 'string', minLength: 12, maxLength: 200 },
      },
      next90DaysPlan: {
        type: 'array',
        minItems: 6,
        maxItems: 6,
        items: { type: 'string', minLength: 12, maxLength: 200 },
      },
    },
  },
} as const;

export type FullNatalAnalysisGenerationFailureCode =
  | 'full_natal_llm_unavailable'
  | 'full_natal_llm_unconfigured'
  | 'full_natal_llm_timeout'
  | 'full_natal_llm_rate_limited'
  | 'full_natal_llm_invalid_response'
  | 'full_natal_llm_upstream_error';

export class FullNatalAnalysisGenerationError extends Error {
  code: FullNatalAnalysisGenerationFailureCode;

  constructor(input: {
    code: FullNatalAnalysisGenerationFailureCode;
    message: string;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = 'FullNatalAnalysisGenerationError';
    this.code = input.code;
    this.cause = input.cause;
  }
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function safeString(value: unknown, fallback: string, minLength = 1) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length >= minLength ? trimmed : fallback;
}

export function normalizeLlmPayload(raw: unknown): FullNatalCareerAnalysisPayloadDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;

  const toArchetypes = (input: unknown): FullNatalCareerArchetypeDoc[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        name: safeString(item.name, 'Career Archetype', 2),
        score: clampScore(typeof item.score === 'number' ? item.score : 70),
        evidence: Array.isArray(item.evidence)
          ? item.evidence.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 4)
          : [],
      }))
      .filter((item) => item.evidence.length > 0)
      .slice(0, 4);
  };

  const toStrengths = (input: unknown): FullNatalCareerStrengthDoc[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        title: safeString(item.title, 'Strength', 2),
        details: safeString(item.details, 'Strength details unavailable', 8),
        evidence: Array.isArray(item.evidence)
          ? item.evidence.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 3)
          : [],
      }))
      .filter((item) => item.evidence.length > 0)
      .slice(0, 4);
  };

  const toBlindSpots = (input: unknown): FullNatalCareerBlindSpotDoc[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        title: safeString(item.title, 'Blind spot', 2),
        risk: safeString(item.risk, 'Risk details unavailable', 8),
        mitigation: safeString(item.mitigation, 'Mitigation details unavailable', 8),
        evidence: Array.isArray(item.evidence)
          ? item.evidence.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 3)
          : [],
      }))
      .filter((item) => item.evidence.length > 0)
      .slice(0, 3);
  };

  const toRoleFit = (input: unknown): FullNatalCareerRoleFitDoc[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        domain: safeString(item.domain, 'General Domain', 2),
        fitScore: clampScore(typeof item.fitScore === 'number' ? item.fitScore : 70),
        why: safeString(item.why, 'Rationale unavailable', 8),
        exampleRoles: Array.isArray(item.exampleRoles)
          ? item.exampleRoles.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 4)
          : [],
      }))
      .filter((item) => item.exampleRoles.length >= 2)
      .slice(0, 5);
  };

  const toPhasePlan = (input: unknown): FullNatalCareerPhasePlanDoc[] => {
    if (!Array.isArray(input)) return [];
    const allowed: FullNatalCareerPhasePlanDoc['phase'][] = ['0_6_months', '6_18_months', '18_36_months'];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => {
        const phaseRaw = safeString(item.phase, '0_6_months');
        const phase = allowed.includes(phaseRaw as FullNatalCareerPhasePlanDoc['phase'])
          ? (phaseRaw as FullNatalCareerPhasePlanDoc['phase'])
          : '0_6_months';
        const list = (value: unknown, max: number) =>
          Array.isArray(value)
            ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, max)
            : [];
        return {
          phase,
          goal: safeString(item.goal, 'Phase goal unavailable', 8),
          actions: list(item.actions, 5),
          kpis: list(item.kpis, 4),
          risks: list(item.risks, 4),
        };
      })
      .filter((item) => item.actions.length >= 2 && item.kpis.length >= 1 && item.risks.length >= 1)
      .slice(0, 3);
  };

  const careerArchetypes = toArchetypes(root.careerArchetypes);
  const strengths = toStrengths(root.strengths);
  const blindSpots = toBlindSpots(root.blindSpots);
  const roleFitMatrix = toRoleFit(root.roleFitMatrix);
  const phasePlan = toPhasePlan(root.phasePlan);
  const decisionRules = Array.isArray(root.decisionRules)
    ? root.decisionRules.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 6)
    : [];
  const next90DaysPlan = Array.isArray(root.next90DaysPlan)
    ? root.next90DaysPlan.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 6)
    : [];

  if (
    careerArchetypes.length < 3 ||
    strengths.length < 4 ||
    blindSpots.length < 3 ||
    roleFitMatrix.length < 5 ||
    phasePlan.length < 3 ||
    decisionRules.length < 6 ||
    next90DaysPlan.length < 6
  ) {
    return null;
  }

  return {
    schemaVersion: safeString(root.schemaVersion, FULL_NATAL_SCHEMA_VERSION),
    headline: safeString(root.headline, 'Full Natal Career Blueprint', 5),
    executiveSummary: safeString(root.executiveSummary, 'Career blueprint summary unavailable.', 20),
    careerArchetypes,
    strengths,
    blindSpots,
    roleFitMatrix,
    phasePlan,
    decisionRules,
    next90DaysPlan,
  };
}

export function getFullNatalAnalysisConfig() {
  const config = getFullNatalAnalysisPromptConfig();
  return {
    model: config.model,
    promptVersion: config.promptVersion,
  };
}

let backupStructuredGateway: ReturnType<typeof createOpenAiStructuredGateway> | null = null;

function getBackupFullNatalGateway() {
  if (
    !env.LLM_BACKUP_API_KEY ||
    !env.LLM_BACKUP_BASE_URL ||
    !env.LLM_BACKUP_FULL_NATAL_ANALYSIS_MODEL
  ) {
    return null;
  }

  if (!backupStructuredGateway) {
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
  }

  return backupStructuredGateway;
}

function buildFullNatalStructuredRequest(input: {
  config: ReturnType<typeof getFullNatalAnalysisPromptConfig>;
  model: string;
  chartPayload: ChartPromptPayload;
  context?: FullNatalContextInput;
}): FullNatalStructuredCompletionRequest {
  return {
    feature: input.config.feature,
    model: input.model,
    promptVersion: input.config.promptVersion,
    temperature: input.config.temperature,
    maxTokens: input.config.maxTokens,
    jsonSchema: OUTPUT_SCHEMA,
    messages: [
      { role: 'system', content: FULL_NATAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${FULL_NATAL_USER_PROMPT}

Input JSON:
${JSON.stringify({
  chartPayload: input.chartPayload,
  context: input.context ?? {},
  requiredSchemaVersion: FULL_NATAL_SCHEMA_VERSION,
})}`,
      },
    ],
    timeoutMs: input.config.timeoutMs,
  };
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

function classifyGenerationError(error: unknown): FullNatalAnalysisGenerationFailureCode {
  if (isGatewayStage(error, 'config')) return 'full_natal_llm_unconfigured';
  if (isGatewayStage(error, 'response_content') || isGatewayStage(error, 'response_json')) {
    return 'full_natal_llm_invalid_response';
  }
  if (error instanceof Error && error.message.toLowerCase().includes('payload format is invalid')) {
    return 'full_natal_llm_invalid_response';
  }
  if (isTimeoutLike(error)) return 'full_natal_llm_timeout';

  const status = upstreamStatus(error);
  if (status === 429) return 'full_natal_llm_rate_limited';
  if (status !== null) return 'full_natal_llm_upstream_error';

  return 'full_natal_llm_upstream_error';
}

export async function generateFullNatalCareerAnalysis(input: {
  chartPayload: ChartPromptPayload;
  context?: FullNatalContextInput;
  logger?: Pick<FastifyBaseLogger, 'warn'>;
  progress?: FullNatalAnalysisProgressTracker;
}, deps: FullNatalAnalysisGenerationDeps = {}): Promise<{
  analysis: FullNatalCareerAnalysisPayloadDoc;
  model: string;
  promptVersion: string;
  narrativeSource: 'llm';
}> {
  const config = getFullNatalAnalysisPromptConfig();
  const { model, promptVersion } = config;
  const isLlmAvailable =
    deps.isLlmAvailable ?? (() => Boolean(env.OPENAI_FULL_NATAL_ANALYSIS_ENABLED && env.OPENAI_API_KEY));
  const backupGateway = getBackupFullNatalGateway();
  const backupModel = deps.backupModel ?? env.LLM_BACKUP_FULL_NATAL_ANALYSIS_MODEL ?? env.LLM_BACKUP_MODEL ?? null;
  const isBackupLlmAvailable =
    deps.isBackupLlmAvailable ??
    (() => Boolean(backupGateway && backupModel));
  const requestStructuredCompletion =
    deps.requestStructuredCompletion ?? openAiStructuredGateway.requestStructuredCompletion;
  const requestBackupStructuredCompletion =
    deps.requestBackupStructuredCompletion ?? backupGateway?.requestStructuredCompletion;

  if (!isLlmAvailable() && !isBackupLlmAvailable()) {
    throw new FullNatalAnalysisGenerationError({
      code: 'full_natal_llm_unavailable',
      message: 'Full natal analysis LLM pipeline is unavailable',
    });
  }

  const requestAndNormalize = async (
    requestFn: NonNullable<FullNatalAnalysisGenerationDeps['requestStructuredCompletion']>,
    requestModel: string,
  ) => {
    const completion = await requestFn(
      buildFullNatalStructuredRequest({
        config,
        model: requestModel,
        chartPayload: input.chartPayload,
        context: input.context,
      }),
    );
    input.progress?.setStage('validating_report');
    const normalized = normalizeLlmPayload(completion.parsedContent);
    if (!normalized) {
      throw new Error('OpenAI full natal analysis payload format is invalid');
    }

    return {
      analysis: {
        ...normalized,
        schemaVersion: FULL_NATAL_SCHEMA_VERSION,
      },
      model: requestModel,
      promptVersion,
      narrativeSource: 'llm' as const,
    };
  };

  const useBackup = async (primaryError?: unknown) => {
    if (!isBackupLlmAvailable() || !requestBackupStructuredCompletion || !backupModel) {
      throw primaryError;
    }
    input.progress?.setStage('backup_route');
    try {
      return await requestAndNormalize(requestBackupStructuredCompletion, backupModel);
    } catch (backupError) {
      input.logger?.warn(
        { primaryError, backupError },
        'full natal analysis backup provider generation failed',
      );
      throw backupError;
    }
  };

  try {
    if (!isLlmAvailable()) {
      return await useBackup();
    }

    try {
      return await requestAndNormalize(requestStructuredCompletion, model);
    } catch (primaryError) {
      return await useBackup(primaryError);
    }
  } catch (error) {
    const code = classifyGenerationError(error);
    input.logger?.warn({ error, code }, 'full natal analysis llm generation failed');
    throw new FullNatalAnalysisGenerationError({
      code,
      message: 'Full natal analysis LLM generation failed',
      cause: error,
    });
  }
}
