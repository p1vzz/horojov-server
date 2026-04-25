import type { NormalizedJobPayload } from '../jobProviders.js';
import type { JobUrlValidationCode } from '../jobUrl.js';

export type SupportedJobSource = NormalizedJobPayload["source"];

const VALIDATION_ERROR_TEXTS: Partial<Record<JobUrlValidationCode, string>> = {
  unsupported_path: "This URL is not supported by the current parser.",
};

export function statusCodeForValidationCode(code: JobUrlValidationCode) {
  switch (code) {
    case "invalid_url":
    case "unsupported_protocol":
      return 400;
    case "unsupported_source":
    case "unsupported_path":
      return 422;
  }
}

export function getValidationErrorMessage(
  code: JobUrlValidationCode,
  fallback: string,
) {
  return VALIDATION_ERROR_TEXTS[code] ?? fallback;
}

export function parseNormalizedJobPayload(
  input: unknown,
): NormalizedJobPayload | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  if (
    typeof obj.source !== "string" ||
    typeof obj.canonicalUrl !== "string" ||
    typeof obj.title !== "string" ||
    typeof obj.description !== "string"
  ) {
    return null;
  }

  const source = obj.source;
  if (
    source !== "linkedin" &&
    source !== "indeed" &&
    source !== "glassdoor" &&
    source !== "ziprecruiter" &&
    source !== "wellfound"
  ) {
    return null;
  }

  return {
    source,
    sourceJobId: typeof obj.sourceJobId === "string" ? obj.sourceJobId : null,
    canonicalUrl: obj.canonicalUrl,
    title: obj.title,
    company: typeof obj.company === "string" ? obj.company : null,
    location: typeof obj.location === "string" ? obj.location : null,
    salaryText: typeof obj.salaryText === "string" ? obj.salaryText : null,
    description: obj.description,
    employmentType:
      typeof obj.employmentType === "string" ? obj.employmentType : null,
    datePosted: typeof obj.datePosted === "string" ? obj.datePosted : null,
    seniority: typeof obj.seniority === "string" ? obj.seniority : null,
  };
}

export function fallbackJobFromText(input: {
  source: SupportedJobSource;
  canonicalUrl: string;
  sourceJobId: string | null;
  normalizedText: string;
}): NormalizedJobPayload {
  const [titleRow, ...descriptionRows] = input.normalizedText.split("\n");
  return {
    source: input.source,
    sourceJobId: input.sourceJobId,
    canonicalUrl: input.canonicalUrl,
    title: titleRow?.trim() || "Untitled role",
    company: null,
    location: null,
    salaryText: null,
    description: descriptionRows.join("\n").trim() || input.normalizedText,
    employmentType: null,
    datePosted: null,
    seniority: null,
  };
}

export function compactProviderAttempts(
  providerAttempts: Array<{
    provider: string;
    ok: boolean;
    reason: string;
    statusCode: number | null;
  }>,
) {
  return providerAttempts.map((entry) => ({
    provider: entry.provider,
    ok: entry.ok,
    reason: entry.reason,
    statusCode: entry.statusCode,
  }));
}

export function extractRawHtmlArtifact(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const payload = input as Record<string, unknown>;
  const html = typeof payload.html === "string" ? payload.html : null;
  if (!html || html.length === 0) return null;

  return {
    html,
    statusCode: typeof payload.status === "number" ? payload.status : null,
    finalUrl: typeof payload.finalUrl === "string" ? payload.finalUrl : null,
    title: typeof payload.title === "string" ? payload.title : null,
  };
}

export function stripRawHtmlFromPayload(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const payload = input as Record<string, unknown>;
  const { html: _unusedHtml, ...rest } = payload;
  return rest;
}

export function isSupportedSource(value: unknown): value is SupportedJobSource {
  return (
    value === "linkedin" ||
    value === "indeed" ||
    value === "glassdoor" ||
    value === "ziprecruiter" ||
    value === "wellfound"
  );
}
