import type { NormalizedJobPayload } from './jobProviders.js';

type JobFeatureRule = {
  tag: string;
  regex: RegExp;
  weight: number;
};

type PlanetPlacement = {
  name: string;
  house: number;
};

export type ParsedJobFeatures = {
  parserVersion: string;
  tags: string[];
  descriptors: string[];
  summary: string;
  confidence: number;
};

export type JobAnalysisResult = {
  scores: {
    compatibility: number;
    aiReplacementRisk: number;
    overall: number;
  };
  breakdown: Array<{
    key: string;
    label: string;
    score: number;
    note: string;
  }>;
  jobSummary: string;
  tags: string[];
  descriptors: string[];
};

const PARSER_VERSION = 'v1';
const MODEL_VERSION = 'deterministic-v1';
const RUBRIC_VERSION = 'v1';

const FEATURE_RULES: JobFeatureRule[] = [
  { tag: 'leadership', regex: /\b(lead|manager|head of|director|ownership|drive strategy)\b/i, weight: 1.2 },
  { tag: 'communication', regex: /\b(communication|stakeholder|presentation|storytelling|cross-functional)\b/i, weight: 1.1 },
  { tag: 'analytics', regex: /\b(sql|analytics|analysis|dashboard|kpi|insight|forecast)\b/i, weight: 1.1 },
  { tag: 'engineering', regex: /\b(engineer|software|backend|frontend|api|infrastructure|devops)\b/i, weight: 1.2 },
  { tag: 'product', regex: /\b(product manager|roadmap|product strategy|user research)\b/i, weight: 1.1 },
  { tag: 'sales', regex: /\b(sales|quota|pipeline|account executive|business development)\b/i, weight: 1 },
  { tag: 'customer-facing', regex: /\b(customer|client|support|success|service)\b/i, weight: 1 },
  { tag: 'operations', regex: /\b(operations|process|workflow|sop|coordination)\b/i, weight: 1 },
  { tag: 'research', regex: /\b(research|experiments|hypothesis|evidence|benchmark)\b/i, weight: 1 },
  { tag: 'creativity', regex: /\b(creative|design|brand|content|ideation)\b/i, weight: 1 },
  { tag: 'strategy', regex: /\b(strategy|long-term|planning|portfolio|roadmap)\b/i, weight: 1.15 },
  { tag: 'documentation', regex: /\b(documentation|reporting|compliance|audit)\b/i, weight: 0.9 },
  { tag: 'collaboration', regex: /\b(team|collaboration|partner|alignment|facilitat)\b/i, weight: 0.95 },
  { tag: 'autonomy', regex: /\b(self-starter|autonomous|independent|own your)\b/i, weight: 0.9 },
  { tag: 'high-pressure', regex: /\b(fast-paced|tight deadline|high pressure|urgent|firefighting|24\/7)\b/i, weight: 0.85 },
  { tag: 'repetitive', regex: /\b(repetitive|routine|manual entry|data entry|clerical)\b/i, weight: 0.9 },
  { tag: 'remote', regex: /\b(remote|distributed|work from home|hybrid)\b/i, weight: 0.7 },
  { tag: 'ai-exposure', regex: /\b(ai|automation|machine learning|llm|genai)\b/i, weight: 0.8 },
];

const TAG_HOUSE_MAP: Record<string, number[]> = {
  leadership: [1, 10],
  communication: [3, 7],
  analytics: [6, 8, 10],
  engineering: [6, 10, 11],
  product: [5, 6, 10],
  sales: [2, 7, 10],
  'customer-facing': [7, 10],
  operations: [6, 10],
  research: [8, 9, 12],
  creativity: [5, 9],
  strategy: [9, 10],
  documentation: [3, 6],
  collaboration: [7, 11],
  autonomy: [1, 10],
  'high-pressure': [6, 10],
  repetitive: [6],
  remote: [11, 12],
  'ai-exposure': [11, 3],
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number) {
  return Math.round(value);
}

function safeString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function extractPlacements(chart: unknown): PlanetPlacement[] {
  if (!chart || typeof chart !== 'object') return [];
  const root = chart as Record<string, unknown>;
  const housesRaw = root.houses;
  if (!Array.isArray(housesRaw)) return [];

  const placements: PlanetPlacement[] = [];
  for (const houseEntry of housesRaw) {
    if (!houseEntry || typeof houseEntry !== 'object') continue;
    const houseObject = houseEntry as Record<string, unknown>;
    const houseIdRaw = houseObject.house_id;
    if (typeof houseIdRaw !== 'number' || !Number.isFinite(houseIdRaw)) continue;

    const planetsRaw = houseObject.planets;
    if (!Array.isArray(planetsRaw)) continue;

    for (const planetEntry of planetsRaw) {
      if (!planetEntry || typeof planetEntry !== 'object') continue;
      const planetObject = planetEntry as Record<string, unknown>;
      const name = safeString(planetObject.name).trim().toLowerCase();
      if (name.length === 0) continue;
      placements.push({ name, house: houseIdRaw });
    }
  }

  return placements;
}

function buildDescriptorSummary(tags: string[]) {
  const descriptors: string[] = [];
  if (tags.includes('high-pressure')) descriptors.push('high-pressure');
  if (tags.includes('leadership')) descriptors.push('leadership-heavy');
  if (tags.includes('analytics')) descriptors.push('data-oriented');
  if (tags.includes('creativity')) descriptors.push('creative');
  if (tags.includes('customer-facing')) descriptors.push('client-facing');
  if (tags.includes('remote')) descriptors.push('remote-friendly');
  if (descriptors.length === 0) descriptors.push('generalist');
  return descriptors.slice(0, 4);
}

function fallbackSummary(job: NormalizedJobPayload, descriptors: string[]) {
  const company = job.company ? ` at ${job.company}` : '';
  const location = job.location ? ` (${job.location})` : '';
  const descriptorText = descriptors.length > 0 ? descriptors.join(', ') : 'general';
  return `${job.title}${company}${location}: ${descriptorText} role with practical execution focus.`;
}

function toNormalizedText(job: NormalizedJobPayload) {
  return [job.title, job.company ?? '', job.location ?? '', job.description]
    .join('\n')
    .toLowerCase();
}

export function getJobAnalysisVersions() {
  return {
    parserVersion: PARSER_VERSION,
    rubricVersion: RUBRIC_VERSION,
    modelVersion: MODEL_VERSION,
  };
}

export function extractJobFeatures(job: NormalizedJobPayload): ParsedJobFeatures {
  const text = toNormalizedText(job);
  const matchedTags: string[] = [];
  let scoreSum = 0;

  for (const rule of FEATURE_RULES) {
    if (rule.regex.test(text)) {
      matchedTags.push(rule.tag);
      scoreSum += rule.weight;
    }
  }

  const tags = Array.from(new Set(matchedTags));
  const descriptors = buildDescriptorSummary(tags);
  const summary = fallbackSummary(job, descriptors);
  const confidence = clamp(round(42 + scoreSum * 8), 40, 96);

  return {
    parserVersion: PARSER_VERSION,
    tags,
    descriptors,
    summary,
    confidence,
  };
}

function getHouseCounts(placements: PlanetPlacement[]) {
  const counts = new Map<number, number>();
  for (const placement of placements) {
    const current = counts.get(placement.house) ?? 0;
    counts.set(placement.house, current + 1);
  }
  return counts;
}

function computeTagMatchScore(tags: string[], houseCounts: Map<number, number>) {
  if (tags.length === 0) return { matched: 0, total: 1 };

  let matched = 0;
  let total = 0;
  for (const tag of tags) {
    const preferred = TAG_HOUSE_MAP[tag];
    if (!preferred) continue;
    total += 1;
    const hasSupport = preferred.some((house) => (houseCounts.get(house) ?? 0) > 0);
    if (hasSupport) matched += 1;
  }
  return { matched, total: total > 0 ? total : 1 };
}

function computeAiRisk(tags: string[]) {
  let score = 34;
  if (tags.includes('repetitive')) score += 18;
  if (tags.includes('documentation')) score += 8;
  if (tags.includes('operations')) score += 6;
  if (tags.includes('customer-facing')) score += 5;

  if (tags.includes('strategy')) score -= 10;
  if (tags.includes('leadership')) score -= 9;
  if (tags.includes('creativity')) score -= 9;
  if (tags.includes('research')) score -= 6;
  if (tags.includes('ai-exposure')) score -= 5;

  return clamp(round(score), 8, 95);
}

function breakdownNote(key: string, score: number) {
  if (score >= 75) {
    if (key === 'stress_load') return 'High intensity profile; plan workload boundaries early.';
    return 'Strong alignment with the chart indicators.';
  }
  if (score >= 55) {
    return 'Moderate alignment; should work with focused adaptation.';
  }
  return 'Lower alignment; expect steeper adaptation cost.';
}

export function buildDeterministicJobAnalysis(input: {
  normalizedJob: NormalizedJobPayload;
  features: ParsedJobFeatures;
  natalChart: unknown;
}): JobAnalysisResult {
  const placements = extractPlacements(input.natalChart);
  const houseCounts = getHouseCounts(placements);
  const tagMatch = computeTagMatchScore(input.features.tags, houseCounts);

  const house10 = houseCounts.get(10) ?? 0;
  const house6 = houseCounts.get(6) ?? 0;
  const house1 = houseCounts.get(1) ?? 0;

  const compatibility = clamp(round(40 + (tagMatch.matched / tagMatch.total) * 44 + house10 * 2 + house1 * 1), 20, 96);
  const aiRisk = computeAiRisk(input.features.tags);
  const growthPotential = clamp(
    round(
      45 +
        (input.features.tags.includes('strategy') ? 8 : 0) +
        (input.features.tags.includes('leadership') ? 7 : 0) +
        (input.features.tags.includes('research') ? 6 : 0) +
        house10 * 2 -
        (input.features.tags.includes('repetitive') ? 8 : 0)
    ),
    18,
    97
  );

  const stressLoad = clamp(
    round(
      32 +
        (input.features.tags.includes('high-pressure') ? 22 : 0) +
        (input.features.tags.includes('customer-facing') ? 8 : 0) +
        (input.features.tags.includes('operations') ? 6 : 0) +
        house6 * 2 -
        (input.features.tags.includes('remote') ? 6 : 0)
    ),
    12,
    95
  );

  const aiResilience = clamp(round(100 - aiRisk + (input.features.tags.includes('creativity') ? 4 : 0)), 10, 95);

  const overall = clamp(round(compatibility * 0.52 + (100 - aiRisk) * 0.28 + growthPotential * 0.2), 0, 100);

  const breakdown = [
    { key: 'role_fit', label: 'Role Fit', score: compatibility },
    { key: 'growth_potential', label: 'Growth Potential', score: growthPotential },
    { key: 'stress_load', label: 'Stress Load', score: stressLoad },
    { key: 'ai_resilience', label: 'AI Resilience', score: aiResilience },
  ].map((item) => ({
    ...item,
    note: breakdownNote(item.key, item.score),
  }));

  return {
    scores: {
      compatibility,
      aiReplacementRisk: aiRisk,
      overall,
    },
    breakdown,
    jobSummary: input.features.summary,
    tags: input.features.tags,
    descriptors: input.features.descriptors,
  };
}
