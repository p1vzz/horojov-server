import { env } from '../config/env.js';
import { openAiStructuredGateway } from './llmGateway.js';
import { getJobScreenshotPromptConfig } from './llmPromptRegistry.js';
import type { SupportedJobSource } from './jobUrl.js';

const MAX_REASON_LENGTH = 220;
const MIN_DESCRIPTION_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 7000;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const PARSE_SYSTEM_PROMPT = [
  'You extract job vacancy data from mobile screenshots.',
  'Determine whether screenshots contain a real job posting.',
  'Do not hallucinate. If a field is not visible, return null and include it in missingFields.',
  'If screenshots are not a vacancy page, return status=not_vacancy.',
  'If vacancy is visible but key fields are not readable/visible, return status=incomplete.',
  'Output only strict JSON.',
].join(' ');

const PARSE_USER_PROMPT = [
  'Analyze all screenshots as one vacancy candidate.',
  'Rules:',
  '- status = "ok" only when title, company, and substantial description are visible.',
  '- status = "incomplete" when vacancy seems valid but required data is missing.',
  '- status = "not_vacancy" when screenshots are not a job posting.',
  '- sourceHint may be linkedin, indeed, glassdoor, ziprecruiter, wellfound, or unknown.',
  '- confidence is 0..1.',
  '- highlights: 1 to 8 concise bullets extracted from visible text.',
].join('\n');

const OUTPUT_SCHEMA = {
  name: 'job_screenshot_parse',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'reason', 'confidence', 'sourceHint', 'job', 'missingFields'],
    properties: {
      status: {
        type: 'string',
        enum: ['ok', 'not_vacancy', 'incomplete'],
      },
      reason: { type: 'string', minLength: 4, maxLength: 260 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      sourceHint: {
        type: 'string',
        enum: ['linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'wellfound', 'unknown'],
      },
      job: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'company', 'location', 'employmentType', 'seniority', 'description', 'highlights'],
        properties: {
          title: { anyOf: [{ type: 'string', minLength: 2, maxLength: 180 }, { type: 'null' }] },
          company: { anyOf: [{ type: 'string', minLength: 2, maxLength: 180 }, { type: 'null' }] },
          location: { anyOf: [{ type: 'string', minLength: 2, maxLength: 180 }, { type: 'null' }] },
          employmentType: { anyOf: [{ type: 'string', minLength: 2, maxLength: 80 }, { type: 'null' }] },
          seniority: { anyOf: [{ type: 'string', minLength: 2, maxLength: 80 }, { type: 'null' }] },
          description: { anyOf: [{ type: 'string', minLength: 20, maxLength: 8000 }, { type: 'null' }] },
          highlights: {
            type: 'array',
            maxItems: 8,
            items: { type: 'string', minLength: 3, maxLength: 220 },
          },
        },
      },
      missingFields: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'string',
          enum: ['title', 'company', 'location', 'employmentType', 'seniority', 'description'],
        },
      },
    },
  },
} as const;

type ScreenshotSourceHint = SupportedJobSource | 'unknown';

type ScreenshotParseStatus = 'ok' | 'not_vacancy' | 'incomplete';

type ScreenshotParsePayload = {
  status: ScreenshotParseStatus;
  reason: string;
  confidence: number;
  sourceHint: ScreenshotSourceHint;
  job: {
    title: string | null;
    company: string | null;
    location: string | null;
    employmentType: string | null;
    seniority: string | null;
    description: string | null;
    highlights: string[];
  };
  missingFields: Array<'title' | 'company' | 'location' | 'employmentType' | 'seniority' | 'description'>;
};

type PreparedImage = {
  dataUrl: string;
  bytes: number;
};

type ParseErrorCode = 'invalid_screenshot_payload' | 'screenshot_not_vacancy' | 'screenshot_incomplete_info';

export class JobScreenshotParseError extends Error {
  code: ParseErrorCode;
  details: Record<string, unknown>;

  constructor(code: ParseErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type JobScreenshotParseResult = {
  status: 'ok';
  confidence: number;
  reason: string;
  sourceHint: SupportedJobSource | null;
  job: {
    title: string;
    company: string;
    location: string | null;
    employmentType: string | null;
    seniority: string | null;
    description: string;
  };
  missingFields: string[];
  imageCount: number;
};

function asTrimmedString(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseJsonSafely(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toBase64ByteLength(base64: string) {
  return Buffer.byteLength(base64, 'base64');
}

function validateAndPrepareScreenshots(dataUrls: string[]) {
  if (dataUrls.length === 0) {
    throw new JobScreenshotParseError('invalid_screenshot_payload', 'At least one screenshot is required');
  }
  if (dataUrls.length > env.JOB_SCREENSHOT_MAX_IMAGES) {
    throw new JobScreenshotParseError('invalid_screenshot_payload', 'Too many screenshots uploaded', {
      maxImages: env.JOB_SCREENSHOT_MAX_IMAGES,
    });
  }

  const prepared: PreparedImage[] = [];
  let totalBytes = 0;

  for (const raw of dataUrls) {
    const value = asTrimmedString(raw);
    if (!value) {
      throw new JobScreenshotParseError('invalid_screenshot_payload', 'Screenshot payload contains empty image data');
    }

    const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!match || !match[1] || !match[2]) {
      throw new JobScreenshotParseError('invalid_screenshot_payload', 'Unsupported screenshot format');
    }

    const mime = match[1].toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      throw new JobScreenshotParseError('invalid_screenshot_payload', 'Unsupported screenshot mime type', {
        mimeType: mime,
      });
    }

    const base64 = match[2];
    const bytes = toBase64ByteLength(base64);
    if (bytes > env.JOB_SCREENSHOT_MAX_IMAGE_BYTES) {
      throw new JobScreenshotParseError('invalid_screenshot_payload', 'Single screenshot exceeds max size', {
        maxBytes: env.JOB_SCREENSHOT_MAX_IMAGE_BYTES,
      });
    }

    totalBytes += bytes;
    if (totalBytes > env.JOB_SCREENSHOT_MAX_TOTAL_BYTES) {
      throw new JobScreenshotParseError('invalid_screenshot_payload', 'Total screenshot payload exceeds max size', {
        maxTotalBytes: env.JOB_SCREENSHOT_MAX_TOTAL_BYTES,
      });
    }

    prepared.push({ dataUrl: value, bytes });
  }

  return prepared;
}

export function normalizeParsePayload(raw: unknown): ScreenshotParsePayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;

  const statusRaw = payload.status;
  const reasonRaw = payload.reason;
  const confidenceRaw = payload.confidence;
  const sourceHintRaw = payload.sourceHint;
  const jobRaw = payload.job;
  const missingFieldsRaw = payload.missingFields;

  if (
    (statusRaw !== 'ok' && statusRaw !== 'not_vacancy' && statusRaw !== 'incomplete') ||
    typeof reasonRaw !== 'string' ||
    typeof confidenceRaw !== 'number' ||
    (sourceHintRaw !== 'linkedin' &&
      sourceHintRaw !== 'indeed' &&
      sourceHintRaw !== 'glassdoor' &&
      sourceHintRaw !== 'ziprecruiter' &&
      sourceHintRaw !== 'wellfound' &&
      sourceHintRaw !== 'unknown') ||
    !jobRaw ||
    typeof jobRaw !== 'object' ||
    !Array.isArray(missingFieldsRaw)
  ) {
    return null;
  }

  const jobObj = jobRaw as Record<string, unknown>;
  const highlights = Array.isArray(jobObj.highlights)
    ? jobObj.highlights.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : [];

  const missingFields = missingFieldsRaw
    .filter((field): field is ScreenshotParsePayload['missingFields'][number] =>
      field === 'title' ||
      field === 'company' ||
      field === 'location' ||
      field === 'employmentType' ||
      field === 'seniority' ||
      field === 'description'
    )
    .slice(0, 8);

  return {
    status: statusRaw,
    reason: reasonRaw.trim().slice(0, MAX_REASON_LENGTH),
    confidence: clamp01(confidenceRaw),
    sourceHint: sourceHintRaw,
    job: {
      title: asTrimmedString(jobObj.title),
      company: asTrimmedString(jobObj.company),
      location: asTrimmedString(jobObj.location),
      employmentType: asTrimmedString(jobObj.employmentType),
      seniority: asTrimmedString(jobObj.seniority),
      description: asTrimmedString(jobObj.description),
      highlights: highlights.slice(0, 8),
    },
    missingFields,
  };
}

function mergeDescription(input: { description: string | null; highlights: string[] }) {
  const parts: string[] = [];
  if (input.description) parts.push(input.description);
  if (input.highlights.length > 0) {
    parts.push(input.highlights.map((entry) => `- ${entry}`).join('\n'));
  }
  const merged = parts.join('\n\n').trim();
  if (merged.length === 0) return null;
  return merged.slice(0, MAX_DESCRIPTION_LENGTH);
}

function finalizeParseResult(payload: ScreenshotParsePayload, imageCount: number): JobScreenshotParseResult {
  if (payload.status === 'not_vacancy') {
    throw new JobScreenshotParseError('screenshot_not_vacancy', 'Uploaded screenshots do not look like a vacancy page', {
      reason: payload.reason,
      confidence: payload.confidence,
    });
  }

  const descriptionMerged = mergeDescription({
    description: payload.job.description,
    highlights: payload.job.highlights,
  });

  const missing = new Set(payload.missingFields);
  if (!payload.job.title) missing.add('title');
  if (!payload.job.company) missing.add('company');
  if (!descriptionMerged || descriptionMerged.length < MIN_DESCRIPTION_LENGTH) {
    missing.add('description');
  }

  if (payload.status === 'incomplete' || missing.size > 0) {
    throw new JobScreenshotParseError('screenshot_incomplete_info', 'Not enough visible vacancy data in screenshots', {
      reason: payload.reason,
      confidence: payload.confidence,
      missingFields: [...missing],
    });
  }

  return {
    status: 'ok',
    confidence: payload.confidence,
    reason: payload.reason,
    sourceHint: payload.sourceHint === 'unknown' ? null : payload.sourceHint,
    job: {
      title: payload.job.title as string,
      company: payload.job.company as string,
      location: payload.job.location,
      employmentType: payload.job.employmentType,
      seniority: payload.job.seniority,
      description: descriptionMerged as string,
    },
    missingFields: [],
    imageCount,
  };
}

function buildOpenAiMessages(images: PreparedImage[]): Array<{ role: 'system' | 'user'; content: unknown }> {
  const userContent: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'low' } }> = [
    { type: 'text', text: PARSE_USER_PROMPT },
  ];

  for (const image of images) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: image.dataUrl,
        detail: 'low',
      },
    });
  }

  return [
    { role: 'system', content: PARSE_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

export function getScreenshotParserConfig() {
  const config = getJobScreenshotPromptConfig();
  return {
    model: config.model,
    promptVersion: config.promptVersion,
  };
}

export async function parseJobFromScreenshots(input: { screenshots: string[] }) {
  const preparedScreenshots = validateAndPrepareScreenshots(input.screenshots);
  const config = getJobScreenshotPromptConfig();
  const completion = await openAiStructuredGateway.requestStructuredCompletion({
    feature: config.feature,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    jsonSchema: OUTPUT_SCHEMA,
    messages: buildOpenAiMessages(preparedScreenshots),
    timeoutMs: config.timeoutMs,
  });

  const normalized = normalizeParsePayload(completion.parsedContent);
  if (!normalized) {
    throw new Error('Screenshot parser payload format is invalid');
  }

  return finalizeParseResult(normalized, preparedScreenshots.length);
}
