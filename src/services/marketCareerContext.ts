import type { FastifyBaseLogger } from 'fastify';
import type { ChartPromptPayload } from './careerInsights.js';
import { getOccupationInsight } from './marketData/occupationInsight.js';
import type {
  MarketSalaryRange,
  OccupationInsightRequest,
  OccupationInsightResponse,
} from './marketData/types.js';

type LoggerLike = Pick<FastifyBaseLogger, 'warn'>;

export type MarketCareerPathGradient =
  | 'high_upside'
  | 'steady_growth'
  | 'stable_floor'
  | 'niche_path'
  | 'limited_data';

export type MarketCareerPath = {
  slug: string;
  title: string;
  domain: string;
  fitScore: number;
  fitLabel: string;
  opportunityScore: number;
  rationale: string;
  developmentVector: string;
  exampleRoles: string[];
  tags: string[];
  salaryRangeLabel: string | null;
  marketGradient: MarketCareerPathGradient;
  marketScoreLabel: OccupationInsightResponse['labels']['marketScore'] | null;
  demandLabel: OccupationInsightResponse['outlook']['demandLabel'] | null;
  sourceRoleTitle: string | null;
  market: OccupationInsightResponse | null;
};

export type NegotiationPrepGuidance = {
  title: string;
  summary: string;
  sourceRoleTitle: string | null;
  salaryRangeLabel: string | null;
  salaryVisibilityLabel: string;
  rangePositioningLabel: string;
  anchorStrategy: {
    label: string;
    target: string | null;
    explanation: string;
    talkingPoint: string;
  };
  guidance: string[];
  recruiterQuestions: string[];
  salaryExpectationScripts: Array<{
    label: string;
    script: string;
  }>;
  offerChecklist: string[];
  redFlags: string[];
  tradeoffLevers: string[];
  nextSteps: string[];
  market: OccupationInsightResponse | null;
};

export type MarketCareerContext = {
  algorithmVersion: 'market_career_context.v1';
  generatedAt: string;
  location: string;
  sourceNote: string;
  marketCareerPaths: MarketCareerPath[];
  negotiationPrep: NegotiationPrepGuidance;
};

export type MarketCareerPromptPath = {
  title: string;
  domain: string;
  fitScore: number;
  salaryRangeLabel: string | null;
  marketGradient: MarketCareerPathGradient;
  marketScoreLabel: string | null;
  demandLabel: string | null;
  growthLabel: string | null;
  developmentVector: string;
};

type RoleSeed = {
  slug: string;
  title: string;
  keyword: string;
  domain: string;
  exampleRoles: string[];
  tags: string[];
  mcSigns: string[];
  ascSigns: string[];
  planets: string[];
  houses: number[];
  rationale: string;
  developmentVector: string;
};

type ScoredRoleSeed = RoleSeed & {
  chartScore: number;
};

type BuildMarketCareerContextDeps = {
  getOccupationInsight?: (request: OccupationInsightRequest) => Promise<OccupationInsightResponse>;
  now?: () => Date;
};

const DEFAULT_LOCATION = 'US';
const DEFAULT_LIMIT = 4;
const SOURCE_NOTE =
  'Labor market data is provided by CareerOneStop and O*NET where available. Horojob guidance is independently generated and does not imply provider endorsement.';

const ROLE_SEEDS: RoleSeed[] = [
  {
    slug: 'product-manager',
    title: 'Product Strategy',
    keyword: 'Product Managers',
    domain: 'Product & Strategy',
    exampleRoles: ['Product Manager', 'Product Strategist', 'Growth Product Manager'],
    tags: ['strategy', 'leadership', 'customer insight'],
    mcSigns: ['leo', 'libra', 'sagittarius', 'aries'],
    ascSigns: ['leo', 'libra', 'sagittarius'],
    planets: ['sun', 'jupiter', 'mercury'],
    houses: [5, 7, 10, 11],
    rationale: 'Visible leadership and cross-functional decision-making are emphasized by the chart signals.',
    developmentVector: 'Move toward roadmap ownership, stakeholder alignment, and measurable product outcomes.',
  },
  {
    slug: 'software-engineer',
    title: 'Technical Systems',
    keyword: 'Software Developers',
    domain: 'Technical Systems',
    exampleRoles: ['Software Developer', 'Platform Engineer', 'Automation Engineer'],
    tags: ['technical', 'systems', 'automation'],
    mcSigns: ['virgo', 'aquarius', 'capricorn', 'gemini'],
    ascSigns: ['virgo', 'aquarius', 'gemini'],
    planets: ['mercury', 'uranus', 'saturn'],
    houses: [3, 6, 10, 11],
    rationale: 'Analytical placements and systems-oriented houses support structured technical work.',
    developmentVector: 'Build a stronger portfolio around production systems, automation, and technical depth.',
  },
  {
    slug: 'data-analyst',
    title: 'Data & Research',
    keyword: 'Data Analysts',
    domain: 'Research & Analytics',
    exampleRoles: ['Data Analyst', 'Business Intelligence Analyst', 'Research Analyst'],
    tags: ['analysis', 'evidence', 'insight'],
    mcSigns: ['virgo', 'scorpio', 'capricorn', 'aquarius'],
    ascSigns: ['virgo', 'scorpio', 'capricorn'],
    planets: ['mercury', 'saturn', 'pluto'],
    houses: [6, 8, 10, 11],
    rationale: 'The chart favors pattern recognition, investigation, and turning evidence into decisions.',
    developmentVector: 'Strengthen SQL, dashboarding, and decision-support storytelling.',
  },
  {
    slug: 'ux-research-design',
    title: 'User Insight & Design',
    keyword: 'User Experience Designers',
    domain: 'Design & User Insight',
    exampleRoles: ['UX Designer', 'UX Researcher', 'Product Designer'],
    tags: ['empathy', 'design', 'research'],
    mcSigns: ['libra', 'taurus', 'gemini', 'pisces'],
    ascSigns: ['libra', 'taurus', 'pisces'],
    planets: ['venus', 'mercury', 'neptune'],
    houses: [3, 5, 7, 11],
    rationale: 'Relational and communication signals point toward user-centered problem solving.',
    developmentVector: 'Turn user empathy into portfolio cases, usability evidence, and design systems literacy.',
  },
  {
    slug: 'marketing-manager',
    title: 'Growth Communication',
    keyword: 'Marketing Managers',
    domain: 'Growth & Communication',
    exampleRoles: ['Marketing Manager', 'Growth Marketer', 'Content Strategist'],
    tags: ['communication', 'growth', 'positioning'],
    mcSigns: ['gemini', 'leo', 'libra', 'sagittarius'],
    ascSigns: ['gemini', 'leo', 'libra'],
    planets: ['mercury', 'venus', 'jupiter', 'sun'],
    houses: [3, 5, 7, 10],
    rationale: 'Communication, visibility, and audience-building signals are prominent.',
    developmentVector: 'Build proof around campaigns, messaging tests, and revenue or engagement outcomes.',
  },
  {
    slug: 'people-operations',
    title: 'People Operations',
    keyword: 'Human Resources Specialists',
    domain: 'People & Talent',
    exampleRoles: ['HR Specialist', 'Talent Partner', 'Learning Coordinator'],
    tags: ['people', 'coaching', 'systems'],
    mcSigns: ['cancer', 'libra', 'sagittarius', 'pisces'],
    ascSigns: ['cancer', 'libra', 'pisces'],
    planets: ['moon', 'venus', 'jupiter'],
    houses: [6, 7, 10, 11],
    rationale: 'The chart supports relationship-building, development, and team-facing systems.',
    developmentVector: 'Move toward talent analytics, structured coaching, and scalable people programs.',
  },
  {
    slug: 'financial-analyst',
    title: 'Finance & Value Analysis',
    keyword: 'Financial Analysts',
    domain: 'Business & Finance',
    exampleRoles: ['Financial Analyst', 'Revenue Analyst', 'Compensation Analyst'],
    tags: ['value', 'forecasting', 'risk'],
    mcSigns: ['taurus', 'capricorn', 'scorpio', 'virgo'],
    ascSigns: ['taurus', 'capricorn', 'virgo'],
    planets: ['saturn', 'venus', 'mercury'],
    houses: [2, 6, 8, 10],
    rationale: 'Resource, risk, and structure signals make value analysis a natural development path.',
    developmentVector: 'Develop modeling, scenario planning, and business-case communication.',
  },
  {
    slug: 'operations-manager',
    title: 'Operations Leadership',
    keyword: 'Operations Managers',
    domain: 'Operations & Execution',
    exampleRoles: ['Operations Manager', 'Program Manager', 'Process Improvement Lead'],
    tags: ['execution', 'process', 'leadership'],
    mcSigns: ['capricorn', 'aries', 'virgo', 'scorpio'],
    ascSigns: ['capricorn', 'aries', 'virgo'],
    planets: ['saturn', 'mars', 'sun'],
    houses: [6, 10, 11],
    rationale: 'Execution, responsibility, and coordination signals are strong in the chart pattern.',
    developmentVector: 'Translate reliability into process metrics, operating cadence, and team coordination.',
  },
  {
    slug: 'management-analyst',
    title: 'Strategy Consulting',
    keyword: 'Management Analysts',
    domain: 'Advisory & Consulting',
    exampleRoles: ['Management Analyst', 'Strategy Analyst', 'Business Consultant'],
    tags: ['advisory', 'systems', 'strategy'],
    mcSigns: ['sagittarius', 'capricorn', 'gemini', 'libra'],
    ascSigns: ['sagittarius', 'gemini', 'libra'],
    planets: ['jupiter', 'mercury', 'saturn'],
    houses: [3, 9, 10, 11],
    rationale: 'Big-picture synthesis and structured communication can combine into advisory work.',
    developmentVector: 'Build frameworks, case-study evidence, and client-facing problem diagnosis.',
  },
  {
    slug: 'training-development',
    title: 'Learning & Enablement',
    keyword: 'Training and Development Specialists',
    domain: 'Learning & Enablement',
    exampleRoles: ['Training Specialist', 'Enablement Manager', 'Instructional Designer'],
    tags: ['teaching', 'enablement', 'communication'],
    mcSigns: ['sagittarius', 'gemini', 'virgo', 'pisces'],
    ascSigns: ['sagittarius', 'gemini', 'pisces'],
    planets: ['jupiter', 'mercury', 'moon'],
    houses: [3, 6, 9, 11],
    rationale: 'Teaching, synthesis, and service-oriented signals support learning design.',
    developmentVector: 'Turn expertise into workshops, enablement programs, and measurable learner outcomes.',
  },
];

function normalizeText(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function placementMatches(chartPayload: ChartPromptPayload, seed: RoleSeed) {
  let score = 0;
  const reasons: string[] = [];
  for (const placement of chartPayload.placements) {
    const planet = normalizeText(placement.planet);
    const sign = normalizeText(placement.sign);
    if (seed.planets.includes(planet)) {
      score += 4;
      reasons.push(`${placement.planet} emphasis`);
    }
    if (seed.houses.includes(placement.house)) {
      score += 3;
      reasons.push(`House ${placement.house}`);
    }
    if (seed.mcSigns.includes(sign) || seed.ascSigns.includes(sign)) {
      score += 2;
      reasons.push(placement.sign);
    }
  }
  return { score: Math.min(score, 34), reasons: [...new Set(reasons)].slice(0, 3) };
}

function scoreRoleSeed(chartPayload: ChartPromptPayload, seed: RoleSeed): ScoredRoleSeed {
  let score = 46;
  const mcSign = normalizeText(chartPayload.mcSign);
  const ascSign = normalizeText(chartPayload.ascSign);
  if (seed.mcSigns.includes(mcSign)) score += 18;
  if (seed.ascSigns.includes(ascSign)) score += 7;
  score += placementMatches(chartPayload, seed).score;
  return {
    ...seed,
    chartScore: clampScore(score),
  };
}

function formatMoney(value: number, period: MarketSalaryRange['period']) {
  if (period === 'hourly') {
    return `$${Math.round(value)}`;
  }
  if (value >= 1000) {
    return `$${Math.round(value / 1000)}k`;
  }
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export function formatMarketSalaryRange(salary: MarketSalaryRange | null) {
  if (!salary) return null;
  const suffix = salary.period === 'hourly' ? '/hr' : '/yr';
  if (typeof salary.min === 'number' && typeof salary.max === 'number') {
    return `${formatMoney(salary.min, salary.period)}-${formatMoney(salary.max, salary.period)}${suffix}`;
  }
  if (typeof salary.median === 'number') {
    return `Median ${formatMoney(salary.median, salary.period)}${suffix}`;
  }
  if (typeof salary.min === 'number') {
    return `From ${formatMoney(salary.min, salary.period)}${suffix}`;
  }
  if (typeof salary.max === 'number') {
    return `Up to ${formatMoney(salary.max, salary.period)}${suffix}`;
  }
  return null;
}

function computeOpportunityScore(market: OccupationInsightResponse | null) {
  if (!market) return 0;
  const marketScore = {
    'strong market': 38,
    'steady market': 29,
    'niche market': 18,
    'limited data': 8,
  }[market.labels.marketScore];
  const demandScore = {
    high: 24,
    moderate: 15,
    low: 6,
    unknown: 4,
  }[market.outlook.demandLabel];
  const median = market.salary?.median ?? null;
  const salaryScore =
    typeof median === 'number'
      ? median >= 150_000
        ? 24
        : median >= 110_000
          ? 20
          : median >= 80_000
            ? 15
            : median >= 55_000
              ? 10
              : 6
      : 4;
  const openings = market.outlook.projectedOpenings ?? null;
  const openingsScore =
    typeof openings === 'number'
      ? openings >= 50_000
        ? 14
        : openings >= 15_000
          ? 10
          : openings >= 5_000
            ? 6
            : 3
      : 3;
  return clampScore(marketScore + demandScore + salaryScore + openingsScore);
}

function resolveMarketGradient(market: OccupationInsightResponse | null): MarketCareerPathGradient {
  if (!market || !market.salary) return 'limited_data';
  if (market.labels.marketScore === 'strong market' || market.outlook.demandLabel === 'high') {
    return 'high_upside';
  }
  if (market.labels.marketScore === 'steady market') {
    return 'steady_growth';
  }
  if (typeof market.salary.median === 'number' && market.salary.median >= 65_000) {
    return 'stable_floor';
  }
  return 'niche_path';
}

function buildFitLabel(score: number) {
  if (score >= 86) return 'Best fit';
  if (score >= 74) return 'Strong fit';
  if (score >= 64) return 'Good fit';
  return 'Exploratory fit';
}

function buildPath(seed: ScoredRoleSeed, market: OccupationInsightResponse | null): MarketCareerPath {
  const opportunityScore = computeOpportunityScore(market);
  const blendedScore = market
    ? clampScore(seed.chartScore * 0.45 + opportunityScore * 0.55)
    : seed.chartScore;
  return {
    slug: seed.slug,
    title: seed.title,
    domain: seed.domain,
    fitScore: blendedScore,
    fitLabel: buildFitLabel(blendedScore),
    opportunityScore,
    rationale: seed.rationale,
    developmentVector: seed.developmentVector,
    exampleRoles: seed.exampleRoles,
    tags: seed.tags,
    salaryRangeLabel: formatMarketSalaryRange(market?.salary ?? null),
    marketGradient: resolveMarketGradient(market),
    marketScoreLabel: market?.labels.marketScore ?? null,
    demandLabel: market?.outlook.demandLabel ?? null,
    sourceRoleTitle: market?.occupation.title ?? null,
    market,
  };
}

function marketFailureCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

async function loadMarketForSeed(input: {
  seed: ScoredRoleSeed;
  location: string;
  logger?: LoggerLike;
  getInsight: (request: OccupationInsightRequest) => Promise<OccupationInsightResponse>;
}) {
  try {
    return await input.getInsight({
      keyword: input.seed.keyword,
      location: input.location,
    });
  } catch (error) {
    input.logger?.warn(
      {
        role: input.seed.slug,
        keyword: input.seed.keyword,
        code: marketFailureCode(error),
      },
      'market career path enrichment failed',
    );
    return null;
  }
}

export function serializeMarketCareerPathsForPrompt(paths: MarketCareerPath[]): MarketCareerPromptPath[] {
  return paths.map((path) => ({
    title: path.title,
    domain: path.domain,
    fitScore: path.fitScore,
    salaryRangeLabel: path.salaryRangeLabel,
    marketGradient: path.marketGradient,
    marketScoreLabel: path.marketScoreLabel,
    demandLabel: path.demandLabel,
    growthLabel: path.market?.outlook.growthLabel ?? null,
    developmentVector: path.developmentVector,
  }));
}

function buildNegotiationPrep(paths: MarketCareerPath[]): NegotiationPrepGuidance {
  const anchorPath = paths.find((path) => path.salaryRangeLabel && path.market) ?? paths.find((path) => path.market) ?? paths[0] ?? null;
  const market = anchorPath?.market ?? null;
  const range = anchorPath?.salaryRangeLabel ?? null;
  const sourceRoleTitle = anchorPath?.sourceRoleTitle ?? anchorPath?.exampleRoles[0] ?? null;
  const roleLabel = sourceRoleTitle ?? 'the role';
  const salaryVisibilityLabel = market?.labels.salaryVisibility === 'market_estimate'
    ? 'Market estimate'
    : market?.labels.salaryVisibility === 'posted'
      ? 'Posted range'
      : 'Range unavailable';
  const summary = range && sourceRoleTitle
    ? `Use ${range} for ${sourceRoleTitle} as a market anchor. We do not see an employer-posted salary here, so this is a public market estimate rather than company-specific compensation.`
    : 'Use role scope, location, and public market context as the anchor until a role-specific pay range is available.';

  return {
    title: 'Negotiation Prep',
    summary,
    sourceRoleTitle,
    salaryRangeLabel: range,
    salaryVisibilityLabel,
    rangePositioningLabel: range ? 'Anchor from the upper half when your scope exceeds the posting.' : 'Ask for the budgeted range before naming a number.',
    anchorStrategy: {
      label: range ? 'Market anchor' : 'Range discovery',
      target: range,
      explanation: range
        ? `Use ${range} as the public market context for ${roleLabel}. Adjust your ask by seniority, location, scope, and evidence of impact.`
        : 'No reliable market range is available yet, so the first goal is to learn the employer budget before naming a number.',
      talkingPoint: range
        ? `For roles like ${roleLabel}, I am seeing the market around ${range}. Based on this scope, I would like to understand where this role sits in your budgeted range.`
        : 'Could you share the budgeted compensation range for this role before I give a number?',
    },
    guidance: [
      'Ask for the budgeted range early, especially when the posting omits compensation.',
      'Anchor your ask to role scope, seniority, location, and measurable business impact.',
      'If the range is broad, position yourself by responsibilities rather than by title alone.',
      'Separate base pay, bonus, equity, flexibility, and growth path before accepting a tradeoff.',
    ],
    recruiterQuestions: [
      'What compensation range has been budgeted for this role?',
      'Which level or seniority band is this opening mapped to internally?',
      'How is the range adjusted for location, remote work, or hybrid expectations?',
      'Which outcomes would justify the top end of the range in the first 6-12 months?',
      'Are bonus, equity, benefits, flexibility, or learning budget part of the total package?',
    ],
    salaryExpectationScripts: [
      {
        label: 'When pay is not posted',
        script: 'I am flexible depending on scope and total package. Could you share the budgeted range so I can make sure we are aligned?',
      },
      {
        label: 'When you have a market anchor',
        script: range
          ? `For comparable ${roleLabel} roles, I am using ${range} as market context. If the responsibilities match the senior end of the scope, I would expect to be in the upper part of that range.`
          : 'For comparable roles, I am benchmarking against market range and scope. I would like to understand your level expectations before naming a number.',
      },
      {
        label: 'When the offer is low',
        script: 'I am excited about the role. Based on the scope we discussed and the market context, is there room to move closer to the expected range?',
      },
    ],
    offerChecklist: [
      'Base salary matches scope, level, and location expectations.',
      'Bonus, equity, benefits, and flexibility are clear enough to compare total value.',
      'Title and responsibilities match the compensation band.',
      'First 90-day success criteria are realistic and measurable.',
      'Growth path, manager support, and review timeline are explicit.',
    ],
    redFlags: [
      'The employer refuses to share a range after multiple compensation questions.',
      'Responsibilities are senior but compensation is framed as junior or exploratory.',
      'The offer depends heavily on vague future raises without written checkpoints.',
      'Large tradeoffs are requested without matching flexibility, growth, or total compensation value.',
    ],
    tradeoffLevers: [
      'Base salary',
      'Signing bonus',
      'Equity or bonus plan',
      'Remote or hybrid flexibility',
      'Learning budget',
      'Title or level',
      'Review timeline',
      'PTO or schedule flexibility',
    ],
    nextSteps: [
      'Confirm the role level and budgeted range before naming a final number.',
      'Choose your target, acceptable floor, and walk-away point before the offer call.',
      'Prepare one short impact story that supports the upper half of the range.',
      'Compare total package, not only base salary.',
    ],
    market,
  };
}

export async function buildMarketCareerContext(
  input: {
    chartPayload: ChartPromptPayload;
    location?: string;
    limit?: number;
    logger?: LoggerLike;
  },
  deps: BuildMarketCareerContextDeps = {},
): Promise<MarketCareerContext> {
  const location = input.location?.trim() || DEFAULT_LOCATION;
  const limit = Math.max(2, Math.min(6, input.limit ?? DEFAULT_LIMIT));
  const getInsight = deps.getOccupationInsight ?? getOccupationInsight;
  const scoredSeeds = ROLE_SEEDS
    .map((seed) => scoreRoleSeed(input.chartPayload, seed))
    .sort((a, b) => b.chartScore - a.chartScore)
    .slice(0, Math.max(limit + 2, 6));

  const paths = await Promise.all(
    scoredSeeds.map(async (seed) => buildPath(
      seed,
      await loadMarketForSeed({
        seed,
        location,
        logger: input.logger,
        getInsight,
      }),
    )),
  );

  const marketCareerPaths = paths
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit);

  return {
    algorithmVersion: 'market_career_context.v1',
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    location,
    sourceNote: SOURCE_NOTE,
    marketCareerPaths,
    negotiationPrep: buildNegotiationPrep(marketCareerPaths),
  };
}
