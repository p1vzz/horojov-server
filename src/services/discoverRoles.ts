import { ObjectId } from 'mongodb';
import type {
  DiscoverRoleCatalogDoc,
  DiscoverRoleRecommendationItemDoc,
  DiscoverRoleTraitVectorDoc,
  MongoCollections,
} from '../db/mongo.js';
import { getCollections } from '../db/mongo.js';
import { getOccupationInsight } from './marketData/occupationInsight.js';
import { MarketProviderError } from './marketData/providerErrors.js';
import type { OccupationInsightResponse } from './marketData/types.js';
import type { DiscoverRoleCurrentJobPayload } from './astrology/discoverRoleCurrentJobStore.js';

type TraitKey = keyof DiscoverRoleTraitVectorDoc;

type RoleSeedInput = {
  title: string;
  onetCode: string | null;
  majorGroup: string | null;
  domain?: string;
  aliases?: string[];
  source: 'onetonline' | 'manual';
};

type LoggerLike = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

type UserTraitProfile = {
  traits: DiscoverRoleTraitVectorDoc;
  signals: string[];
};

type RankedRole = {
  role: DiscoverRoleCatalogDoc;
  score: number;
  overlapTraits: TraitKey[];
  reason: string;
  tags: string[];
};

export type DiscoverRoleDetail = {
  whyFit: {
    summary: string;
    bullets: string[];
    topTraits: string[];
  };
  realityCheck: {
    summary: string;
    tasks: string[];
    workContext: string[];
    toolThemes: string[];
  };
  entryBarrier: {
    level: 'accessible' | 'moderate' | 'specialized' | 'high';
    label: string;
    summary: string;
    signals: string[];
  };
  transitionMap: DiscoverRoleTransitionPath[];
  bestAlternative: DiscoverRoleBestAlternative | null;
};

export type DiscoverRoleDecisionRole = {
  slug: string;
  title: string;
  domain: string;
  fitScore: number;
  fitLabel: string;
  barrier: {
    level: DiscoverRoleDetail['entryBarrier']['level'];
    label: string;
  };
};

export type DiscoverRoleTransitionPath = {
  lane: 'best_match' | 'easier_entry' | 'higher_ceiling';
  label: string;
  summary: string;
  role: DiscoverRoleDecisionRole;
};

export type DiscoverRoleBestAlternative = {
  headline: string;
  summary: string;
  reasons: string[];
  role: DiscoverRoleDecisionRole;
};

export type DiscoverRoleRankingMode = 'fit' | 'opportunity';

const TRAIT_KEYS: TraitKey[] = [
  'analytical',
  'creative',
  'leadership',
  'technical',
  'people',
  'business',
  'operations',
  'detail',
  'research',
  'communication',
];

const TRAIT_LABELS: Record<TraitKey, string> = {
  analytical: 'Analytical',
  creative: 'Creative',
  leadership: 'Leadership',
  technical: 'Technical',
  people: 'People-Focused',
  business: 'Strategic',
  operations: 'Operational',
  detail: 'Detail-Oriented',
  research: 'Research',
  communication: 'Communicative',
};

const TRAIT_EXPLANATIONS: Record<TraitKey, string> = {
  analytical: 'structured problem solving and pattern recognition',
  creative: 'original thinking and concept shaping',
  leadership: 'direction-setting and ownership under pressure',
  technical: 'systems thinking and hands-on execution',
  people: 'relationship building and user sensitivity',
  business: 'tradeoff judgment and commercial intuition',
  operations: 'turning plans into reliable execution',
  detail: 'precision, follow-through, and quality control',
  research: 'digging deeper before making decisions',
  communication: 'explaining, aligning, and influencing clearly',
};

type DiscoverRoleRealityTemplate = {
  summary: string;
  tasks: string[];
  workContext: string[];
  toolThemes: string[];
  barrierLevel: DiscoverRoleDetail['entryBarrier']['level'];
  barrierSignals: string[];
};

const GENERAL_DISCOVER_ROLE_REALITY_TEMPLATE: DiscoverRoleRealityTemplate = {
  summary: 'Expect a blend of practical execution, communication, and adaptation as the work becomes more specific.',
  tasks: [
    'Turn expectations into repeatable execution.',
    'Communicate clearly enough for others to act with you.',
    'Learn the role by doing, not only by reading.',
  ],
  workContext: ['Execution under feedback', 'Collaboration', 'Gradual skill-building'],
  toolThemes: ['Documentation', 'Communication tools', 'Tracking systems'],
  barrierLevel: 'moderate',
  barrierSignals: [
    'Transferable evidence usually matters more than perfect title history.',
    'Entry gets easier when you can point to concrete examples of similar work.',
    'Teams still look for signs that you can ramp without heavy supervision.',
  ],
};

const DOMAIN_REALITY_TEMPLATES: Record<string, DiscoverRoleRealityTemplate> = {
  'Product & Strategy': {
    summary: 'Most days mix prioritization, ambiguity management, and cross-functional decision making.',
    tasks: [
      'Turn vague goals into concrete priorities and tradeoffs.',
      'Align product, design, engineering, or business partners around the next move.',
      'Keep execution pointed at outcomes rather than only activity.',
    ],
    workContext: ['Cross-functional tradeoffs', 'High ambiguity', 'Stakeholder alignment'],
    toolThemes: ['Roadmaps', 'Research notes', 'Delivery tracking'],
    barrierLevel: 'specialized',
    barrierSignals: [
      'Usually rewards prior context in a product, business, or operational lane.',
      'Credibility often comes from decision quality, not only title history.',
      'Switching in is easier with portfolio evidence or adjacent ownership experience.',
    ],
  },
  'Data & Technology': {
    summary: 'The work usually alternates between deep focus, technical problem solving, and iterative delivery.',
    tasks: [
      'Break complex systems or product needs into concrete technical work.',
      'Debug, refine, and ship reliable solutions under changing constraints.',
      'Translate abstract requirements into working systems people can use.',
    ],
    workContext: ['Deep focus blocks', 'Rapid iteration', 'Technical collaboration'],
    toolThemes: ['Code tools', 'Version control', 'Issue tracking'],
    barrierLevel: 'specialized',
    barrierSignals: [
      'Usually expects proof of hands-on execution, not only interest.',
      'Portfolio, shipped work, or strong technical reps lower switching risk.',
      'Tool fluency matters early because teams look for practical ramp speed.',
    ],
  },
  Engineering: {
    summary: 'Expect a mix of analytical rigor, technical execution, and longer-horizon problem solving.',
    tasks: [
      'Design solutions that hold up under real-world constraints.',
      'Balance technical precision with delivery timelines.',
      'Review systems, failures, or requirements before committing to an approach.',
    ],
    workContext: ['Precision under constraints', 'System-level thinking', 'Review-heavy collaboration'],
    toolThemes: ['Design tools', 'Simulation or build tools', 'Technical documentation'],
    barrierLevel: 'specialized',
    barrierSignals: [
      'The ramp is easier with disciplined technical foundations already in place.',
      'Teams often expect evidence of problem-solving depth before trusting larger scope.',
      'Adjacent technical work helps more than generic generalist experience.',
    ],
  },
  'Business & Finance': {
    summary: 'Daily work tends to center on structured analysis, risk framing, and decision support.',
    tasks: [
      'Analyze metrics, financial patterns, or operational signals.',
      'Turn messy inputs into recommendations leaders can act on.',
      'Document assumptions, controls, and tradeoffs clearly.',
    ],
    workContext: ['Metric-driven review', 'Stakeholder presentations', 'Risk and process control'],
    toolThemes: ['Spreadsheets', 'Reporting tools', 'Documentation'],
    barrierLevel: 'moderate',
    barrierSignals: [
      'Switching is easier when you can show disciplined analysis or business judgment.',
      'Precision and trust matter as much as raw pace.',
      'Domain language and stakeholder confidence usually improve access to stronger roles.',
    ],
  },
  'Creative & Media': {
    summary: 'The work blends taste, iteration, and clear translation of ideas into outputs other people can react to.',
    tasks: [
      'Shape concepts into concrete visual, written, or research outputs.',
      'Iterate fast from feedback without losing the core idea.',
      'Balance originality with audience, brand, or user constraints.',
    ],
    workContext: ['Feedback cycles', 'Portfolio-driven proof', 'Ambiguous briefs'],
    toolThemes: ['Creative suites', 'Prototyping', 'Content workflows'],
    barrierLevel: 'moderate',
    barrierSignals: [
      'A visible body of work usually matters more than abstract interest.',
      'Taste, communication, and iteration speed all affect credibility.',
      'Adjacent roles can be easier bridges than cold entry into senior creative scope.',
    ],
  },
  'Sales & Growth': {
    summary: 'Expect externally-facing work, fast feedback loops, and constant pressure to turn effort into movement.',
    tasks: [
      'Create momentum with customers, audiences, or revenue-driving systems.',
      'Adjust messaging and tactics based on live feedback.',
      'Balance relationship-building with measurable performance targets.',
    ],
    workContext: ['Fast feedback loops', 'External communication', 'Performance pressure'],
    toolThemes: ['CRM', 'Campaign tools', 'Pipeline tracking'],
    barrierLevel: 'moderate',
    barrierSignals: [
      'Communication proof and visible execution usually matter early.',
      'Switching in is easier when you already operate close to customer or revenue workflows.',
      'Consistency under pressure matters more than perfect credentials.',
    ],
  },
  'Science & Research': {
    summary: 'The work rewards patience, deeper investigation, and comfort with uncertainty before results become clear.',
    tasks: [
      'Study patterns, evidence, or hypotheses before acting.',
      'Document findings clearly enough for others to trust the conclusion.',
      'Spend longer cycles refining methods, not only outputs.',
    ],
    workContext: ['Evidence-first decisions', 'Longer feedback cycles', 'Methodical review'],
    toolThemes: ['Research workflows', 'Data tools', 'Documentation'],
    barrierLevel: 'specialized',
    barrierSignals: [
      'Most switches require real subject-matter depth, not only curiosity.',
      'The ramp often depends on method quality and domain fluency.',
      'Demonstrated rigor matters more than surface familiarity.',
    ],
  },
  Healthcare: {
    summary: 'The work combines human care, process discipline, and high-stakes judgment around real people.',
    tasks: [
      'Operate carefully in situations where quality and safety matter.',
      'Communicate clearly with patients, teams, or care systems.',
      'Balance empathy with protocol and time pressure.',
    ],
    workContext: ['High trust environment', 'Protocol-driven execution', 'People-centered decisions'],
    toolThemes: ['Clinical systems', 'Care documentation', 'Operational workflows'],
    barrierLevel: 'high',
    barrierSignals: [
      'Many paths require regulated credentials, supervised hours, or formal training.',
      'Cold switches are usually slower without a staged bridge role.',
      'The barrier is often structural, not only skill-based.',
    ],
  },
  Legal: {
    summary: 'Expect high-detail reasoning, formal language, and consequences for imprecision.',
    tasks: [
      'Interpret rules, contracts, or cases with precision.',
      'Build defensible recommendations from incomplete facts.',
      'Communicate clearly where nuance changes the decision.',
    ],
    workContext: ['High precision', 'Formal review', 'Consequence-heavy decisions'],
    toolThemes: ['Document systems', 'Research databases', 'Case tracking'],
    barrierLevel: 'high',
    barrierSignals: [
      'Formal credentials or regulated pathways usually define access.',
      'The ramp is long when you are switching from outside the lane.',
      'Trust comes from precision and training, not only raw intelligence.',
    ],
  },
  Education: {
    summary: 'The work blends communication, structure, and repeated adaptation to how other people learn or develop.',
    tasks: [
      'Translate ideas into teachable or coachable steps.',
      'Adjust delivery based on how people respond in real time.',
      'Balance care, clarity, and structure over repeated cycles.',
    ],
    workContext: ['People development', 'High communication load', 'Structured repetition'],
    toolThemes: ['Planning tools', 'Instruction materials', 'Progress tracking'],
    barrierLevel: 'specialized',
    barrierSignals: [
      'Some paths require licenses or specific credentials before access improves.',
      'Switches are smoother when you already coach, train, or guide others.',
      'Patience and consistency matter as much as content knowledge.',
    ],
  },
  General: GENERAL_DISCOVER_ROLE_REALITY_TEMPLATE,
};

const MAJOR_GROUP_TO_DOMAIN: Record<string, string> = {
  '11': 'Management & Operations',
  '13': 'Business & Finance',
  '15': 'Data & Technology',
  '17': 'Engineering',
  '19': 'Science & Research',
  '21': 'Counseling & Social Impact',
  '23': 'Legal',
  '25': 'Education',
  '27': 'Creative & Media',
  '29': 'Healthcare',
  '41': 'Sales & Growth',
};

const DOMAIN_BASE_TRAITS: Record<string, Partial<DiscoverRoleTraitVectorDoc>> = {
  'Management & Operations': { leadership: 0.82, operations: 0.75, business: 0.72, communication: 0.62 },
  'Business & Finance': { analytical: 0.78, business: 0.8, detail: 0.7, communication: 0.52 },
  'Data & Technology': { technical: 0.86, analytical: 0.78, detail: 0.62, research: 0.52 },
  Engineering: { technical: 0.85, analytical: 0.74, operations: 0.56, detail: 0.58 },
  'Science & Research': { research: 0.84, analytical: 0.73, technical: 0.62, detail: 0.6 },
  'Counseling & Social Impact': { people: 0.84, communication: 0.75, research: 0.42, operations: 0.45 },
  Legal: { analytical: 0.76, communication: 0.76, detail: 0.74, business: 0.48 },
  Education: { communication: 0.82, people: 0.76, analytical: 0.52, creative: 0.42 },
  'Creative & Media': { creative: 0.87, communication: 0.7, people: 0.44, business: 0.45 },
  Healthcare: { people: 0.82, detail: 0.72, operations: 0.62, research: 0.48 },
  'Sales & Growth': { communication: 0.84, business: 0.82, people: 0.64, leadership: 0.46 },
  'Product & Strategy': { business: 0.78, leadership: 0.7, communication: 0.74, analytical: 0.62 },
  'Administration & Office': { detail: 0.78, operations: 0.72, communication: 0.56, business: 0.46 },
  'Skilled Trades': { operations: 0.78, technical: 0.72, detail: 0.6, analytical: 0.38 },
  'Hospitality & Service': { people: 0.76, communication: 0.64, operations: 0.56, detail: 0.4 },
  'Transportation & Logistics': { operations: 0.8, detail: 0.58, technical: 0.46, analytical: 0.38 },
  'Public Safety': { operations: 0.74, leadership: 0.58, people: 0.56, detail: 0.54 },
  'Agriculture & Environment': { operations: 0.64, research: 0.52, technical: 0.46, detail: 0.46 },
  'Personal Care & Wellness': { people: 0.82, creative: 0.48, communication: 0.58, operations: 0.38 },
};

const TITLE_TRAIT_RULES: Array<{ regex: RegExp; delta: Partial<DiscoverRoleTraitVectorDoc> }> = [
  { regex: /\b(engineer|developer|architect|software|network|devops|sre|backend|frontend|full stack)\b/i, delta: { technical: 0.2, analytical: 0.14 } },
  { regex: /\b(data|analyst|scientist|actuar|research|biostat|quantitative)\b/i, delta: { analytical: 0.2, research: 0.14, detail: 0.08 } },
  { regex: /\b(design|designer|ux|user experience|brand|creative|media|journalist)\b/i, delta: { creative: 0.2, communication: 0.09 } },
  { regex: /\b(manager|director|chief|lead|executive|head)\b/i, delta: { leadership: 0.18, operations: 0.11, business: 0.09 } },
  { regex: /\b(project|program|operations)\b/i, delta: { operations: 0.16, leadership: 0.08, detail: 0.06 } },
  { regex: /\b(marketing|sales|public relations|fundraising|growth)\b/i, delta: { business: 0.17, communication: 0.13, people: 0.08 } },
  { regex: /\b(counselor|therap|nurse|health|psychologist|special education|teacher|training)\b/i, delta: { people: 0.18, communication: 0.12 } },
  { regex: /\b(financial|account|audit|risk|compliance|regulatory|quality|security|law)\b/i, delta: { detail: 0.15, analytical: 0.11 } },
  { regex: /\b(product)\b/i, delta: { business: 0.1, analytical: 0.08, leadership: 0.08 } },
];

const SIGN_TRAIT_BONUS: Record<string, Partial<DiscoverRoleTraitVectorDoc>> = {
  aries: { leadership: 0.15, operations: 0.08 },
  taurus: { detail: 0.13, operations: 0.07 },
  gemini: { communication: 0.16, analytical: 0.09 },
  cancer: { people: 0.13, communication: 0.08 },
  leo: { leadership: 0.16, creative: 0.1 },
  virgo: { analytical: 0.14, detail: 0.15 },
  libra: { communication: 0.13, people: 0.11, creative: 0.07 },
  scorpio: { research: 0.13, analytical: 0.1 },
  sagittarius: { research: 0.1, leadership: 0.09, communication: 0.08 },
  capricorn: { operations: 0.14, leadership: 0.1, detail: 0.08 },
  aquarius: { technical: 0.14, research: 0.1 },
  pisces: { creative: 0.14, people: 0.1 },
};

const PLANET_TRAIT_BONUS: Record<string, Partial<DiscoverRoleTraitVectorDoc>> = {
  sun: { leadership: 0.1, creative: 0.06, business: 0.05 },
  moon: { people: 0.08, communication: 0.06 },
  mercury: { analytical: 0.12, communication: 0.11, technical: 0.06 },
  venus: { creative: 0.12, people: 0.09 },
  mars: { leadership: 0.11, operations: 0.11 },
  jupiter: { business: 0.1, leadership: 0.08, research: 0.05 },
  saturn: { detail: 0.12, operations: 0.1 },
  uranus: { technical: 0.12, research: 0.09 },
  neptune: { creative: 0.11, people: 0.06 },
  pluto: { research: 0.12, leadership: 0.06 },
};

const HOUSE_TRAIT_BONUS: Record<number, Partial<DiscoverRoleTraitVectorDoc>> = {
  1: { leadership: 0.04, communication: 0.03 },
  2: { business: 0.04, detail: 0.03 },
  3: { communication: 0.07, analytical: 0.05 },
  4: { people: 0.04, operations: 0.03 },
  5: { creative: 0.08, leadership: 0.04 },
  6: { operations: 0.08, detail: 0.08 },
  7: { people: 0.08, communication: 0.06 },
  8: { research: 0.09, detail: 0.05 },
  9: { research: 0.07, communication: 0.05 },
  10: { leadership: 0.12, business: 0.09, operations: 0.07 },
  11: { technical: 0.09, communication: 0.04 },
  12: { research: 0.04, creative: 0.05, people: 0.04 },
};

const DISCOVER_ROLES_ALGORITHM_VERSION = 'discover-roles-v2';
const RECOMMENDED_CACHE_SIZE = 12;
const MIN_QUERY_LENGTH = 2;
const SOURCE_URL_BASE = 'https://www.onetonline.org/link/summary/';
const DISCOVER_ROLE_CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
const DISCOVER_MARKET_LOCATION = 'US';
const DISCOVER_OPPORTUNITY_CANDIDATE_LIMIT = 16;
const DISCOVER_MARKET_CONCURRENCY = 4;

let catalogSeedPromise: Promise<number> | null = null;
let discoverRoleCatalogCache: { loadedAt: number; items: DiscoverRoleCatalogDoc[] } | null = null;

function clearDiscoverRoleCatalogCache() {
  discoverRoleCatalogCache = null;
}

async function loadActiveDiscoverRoleCatalog(
  collections: MongoCollections,
  options?: { forceRefresh?: boolean }
) {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    discoverRoleCatalogCache &&
    now - discoverRoleCatalogCache.loadedAt < DISCOVER_ROLE_CATALOG_CACHE_TTL_MS
  ) {
    return discoverRoleCatalogCache.items.slice();
  }

  const items = await collections.discoverRoleCatalog.find({ active: true }).sort({ title: 1 }).toArray();
  discoverRoleCatalogCache = {
    loadedAt: now,
    items,
  };
  return items.slice();
}

const ONET_ROLE_LINES = [
  '11-9041.00|Architectural and Engineering Managers',
  '11-9199.02|Compliance Managers',
  '11-3021.00|Computer and Information Systems Managers',
  '11-3031.00|Financial Managers',
  '11-2033.00|Fundraising Managers',
  '11-1021.00|General and Operations Managers',
  '11-3121.00|Human Resources Managers',
  '11-3051.00|Industrial Production Managers',
  '11-2021.00|Marketing Managers',
  '11-2032.00|Public Relations Managers',
  '11-3051.01|Quality Control Systems Managers',
  '11-9199.01|Regulatory Affairs Managers',
  '13-2031.00|Budget Analysts',
  '13-2041.00|Credit Analysts',
  '13-2051.00|Financial and Investment Analysts',
  '13-2099.01|Financial Quantitative Analysts',
  '13-2054.00|Financial Risk Specialists',
  '13-2099.04|Fraud Examiners, Investigators and Analysts',
  '13-1071.00|Human Resources Specialists',
  '13-1081.02|Logistics Analysts',
  '13-1161.00|Market Research Analysts and Marketing Specialists',
  '13-1023.00|Purchasing Agents, Except Wholesale, Retail, and Farm Products',
  '13-1022.00|Wholesale and Retail Buyers, Except Farm Products',
  '15-1299.07|Blockchain Engineers',
  '15-2051.02|Clinical Data Managers',
  '15-1221.00|Computer and Information Research Scientists',
  '15-1241.00|Computer Network Architects',
  '15-1231.00|Computer Network Support Specialists',
  '15-1211.00|Computer Systems Analysts',
  '15-1299.08|Computer Systems Engineers/Architects',
  '15-2051.00|Data Scientists',
  '15-1243.00|Database Architects',
  '15-1212.00|Information Security Analysts',
  '15-1299.05|Information Security Engineers',
  '15-1299.09|Information Technology Project Managers',
  '15-1244.00|Network and Computer Systems Administrators',
  '15-2031.00|Operations Research Analysts',
  '15-1252.00|Software Developers',
  '15-1253.00|Software Quality Assurance Analysts and Testers',
  '17-2011.00|Aerospace Engineers',
  '17-1011.00|Architects, Except Landscape and Naval',
  '17-2141.02|Automotive Engineers',
  '17-2031.00|Bioengineers and Biomedical Engineers',
  '17-2041.00|Chemical Engineers',
  '17-2051.00|Civil Engineers',
  '17-2061.00|Computer Hardware Engineers',
  '17-2071.00|Electrical Engineers',
  '17-2072.00|Electronics Engineers, Except Computer',
  '17-2199.03|Energy Engineers, Except Wind and Solar',
  '17-2081.00|Environmental Engineers',
  '17-2111.02|Fire-Prevention and Protection Engineers',
  '17-2112.01|Human Factors Engineers and Ergonomists',
  '17-2121.00|Marine Engineers and Naval Architects',
  '19-1011.00|Animal Scientists',
  '19-1029.01|Bioinformatics Scientists',
  '19-2041.01|Climate Change Policy Analysts',
  '19-3033.00|Clinical and Counseling Psychologists',
  '19-3039.03|Clinical Neuropsychologists',
  '19-2042.00|Geoscientists, Except Hydrologists and Geographers',
  '19-3032.00|Industrial-Organizational Psychologists',
  '19-1042.00|Medical Scientists, Except Epidemiologists',
  '19-4099.01|Quality Control Analysts',
  '21-1012.00|Educational, Guidance, and Career Counselors and Advisors',
  '21-1091.00|Health Education Specialists',
  '21-1013.00|Marriage and Family Therapists',
  '21-1014.00|Mental Health Counselors',
  '21-1015.00|Rehabilitation Counselors',
  '21-1011.00|Substance Abuse and Behavioral Disorder Counselors',
  '23-1011.00|Lawyers',
  '25-1031.00|Architecture Teachers, Postsecondary',
  '25-2023.00|Career/Technical Education Teachers, Middle School',
  '25-2032.00|Career/Technical Education Teachers, Secondary School',
  '25-1021.00|Computer Science Teachers, Postsecondary',
  '25-2021.00|Elementary School Teachers, Except Special Education',
  '25-1032.00|Engineering Teachers, Postsecondary',
  '25-2012.00|Kindergarten Teachers, Except Special Education',
  '25-2022.00|Middle School Teachers, Except Special and Career/Technical Education',
  '25-2031.00|Secondary School Teachers, Except Special and Career/Technical Education',
  '25-2051.00|Special Education Teachers, Preschool',
  '27-1021.00|Commercial and Industrial Designers',
  '27-1024.00|Graphic Designers',
  '27-1025.00|Interior Designers',
  '27-2012.03|Media Programming Directors',
  '27-2012.05|Media Technical Directors/Managers',
  '27-3023.00|News Analysts, Reporters, and Journalists',
  '27-3031.00|Public Relations Specialists',
  '27-1027.00|Set and Exhibit Designers',
  '29-1141.01|Acute Care Nurses',
  '29-1141.02|Advanced Practice Psychiatric Nurses',
  '29-1129.01|Art Therapists',
  '29-1141.04|Clinical Nurse Specialists',
  '29-1141.03|Critical Care Nurses',
  '29-9092.00|Genetic Counselors',
  '29-2092.00|Hearing Aid Specialists',
  '29-1151.00|Nurse Anesthetists',
  '29-1161.00|Nurse Midwives',
  '29-1171.00|Nurse Practitioners',
  '29-1122.00|Occupational Therapists',
  '29-1123.00|Physical Therapists',
  '41-3011.00|Advertising Sales Agents',
  '41-1012.00|First-Line Supervisors of Non-Retail Sales Workers',
  '41-9031.00|Sales Engineers',
  '41-4012.00|Sales Representatives, Wholesale and Manufacturing, Except Technical and Scientific Products',
  '41-4011.00|Sales Representatives, Wholesale and Manufacturing, Technical and Scientific Products',
  '41-3031.00|Securities, Commodities, and Financial Services Sales Agents',
];

const MANUAL_ROLE_SEEDS: RoleSeedInput[] = [
  { title: 'Product Manager', onetCode: null, majorGroup: '11', domain: 'Product & Strategy', source: 'manual', aliases: ['Product Owner', 'Technical Product Manager'] },
  { title: 'Program Manager', onetCode: null, majorGroup: '11', domain: 'Product & Strategy', source: 'manual' },
  { title: 'Software Engineer', onetCode: null, majorGroup: '15', domain: 'Data & Technology', source: 'manual', aliases: ['Software Developer', 'Application Engineer'] },
  { title: 'Backend Engineer', onetCode: null, majorGroup: '15', domain: 'Data & Technology', source: 'manual', aliases: ['Backend Developer'] },
  { title: 'Frontend Engineer', onetCode: null, majorGroup: '15', domain: 'Data & Technology', source: 'manual', aliases: ['Frontend Developer'] },
  { title: 'Full Stack Engineer', onetCode: null, majorGroup: '15', domain: 'Data & Technology', source: 'manual', aliases: ['Full Stack Developer'] },
  { title: 'DevOps Engineer', onetCode: null, majorGroup: '15', domain: 'Data & Technology', source: 'manual', aliases: ['Site Reliability Engineer', 'SRE Engineer'] },
  { title: 'Machine Learning Engineer', onetCode: null, majorGroup: '15', domain: 'Data & Technology', source: 'manual', aliases: ['ML Engineer'] },
  { title: 'AI Engineer', onetCode: null, majorGroup: '15', domain: 'Data & Technology', source: 'manual', aliases: ['Applied AI Engineer'] },
  { title: 'UX Researcher', onetCode: null, majorGroup: '27', domain: 'Creative & Media', source: 'manual', aliases: ['User Experience Researcher'] },
  { title: 'UX Designer', onetCode: null, majorGroup: '27', domain: 'Creative & Media', source: 'manual', aliases: ['User Experience Designer'] },
  { title: 'Brand Manager', onetCode: null, majorGroup: '11', domain: 'Sales & Growth', source: 'manual', aliases: ['Brand Strategist'] },
  { title: 'Business Analyst', onetCode: null, majorGroup: '13', domain: 'Business & Finance', source: 'manual', aliases: ['Business Systems Analyst'] },
  { title: 'Customer Success Manager', onetCode: null, majorGroup: '41', domain: 'Sales & Growth', source: 'manual', aliases: ['Client Success Manager'] },
  { title: 'Talent Acquisition Specialist', onetCode: null, majorGroup: '13', domain: 'Business & Finance', source: 'manual', aliases: ['Recruiter', 'Technical Recruiter'] },
  { title: 'Solutions Architect', onetCode: null, majorGroup: '15', domain: 'Data & Technology', source: 'manual', aliases: ['Enterprise Architect'] },
];

const GENERAL_ROLE_GROUPS: Array<{ domain: string; majorGroup: string | null; titles: string[] }> = [
  {
    domain: 'Healthcare',
    majorGroup: '29',
    titles: [
      'Registered Nurse',
      'Physician Assistant',
      'Medical Assistant',
      'Dental Hygienist',
      'Radiologic Technologist',
      'Respiratory Therapist',
      'Speech-Language Pathologist',
      'Dietitian',
      'Pharmacist',
      'Pharmacy Technician',
      'Medical Laboratory Technician',
      'Surgical Technologist',
      'Paramedic',
      'Emergency Medical Technician',
      'Veterinarian',
      'Veterinary Technician',
      'Optometrist',
      'Medical Records Specialist',
      'Healthcare Administrator',
      'Clinical Research Coordinator',
      'Public Health Analyst',
      'Epidemiologist',
      'Community Health Worker',
      'Mental Health Technician',
      'Dental Assistant',
      'Home Health Aide',
      'Massage Therapist',
      'Chiropractor',
    ],
  },
  {
    domain: 'Education',
    majorGroup: '25',
    titles: [
      'Preschool Teacher',
      'High School Teacher',
      'College Professor',
      'Instructional Designer',
      'School Counselor',
      'Librarian',
      'Tutor',
      'Training and Development Specialist',
      'Corporate Trainer',
      'Education Administrator',
      'Curriculum Developer',
      'Teaching Assistant',
      'Adult Basic Education Teacher',
      'ESL Teacher',
      'Music Teacher',
      'Art Teacher',
      'Athletic Coach',
      'Museum Educator',
      'Academic Advisor',
      'Learning Specialist',
    ],
  },
  {
    domain: 'Business & Finance',
    majorGroup: '13',
    titles: [
      'Accountant',
      'Auditor',
      'Bookkeeper',
      'Payroll Specialist',
      'Tax Preparer',
      'Personal Financial Advisor',
      'Loan Officer',
      'Insurance Underwriter',
      'Claims Adjuster',
      'Actuary',
      'Economist',
      'Management Analyst',
      'Operations Analyst',
      'Procurement Specialist',
      'Supply Chain Analyst',
      'Pricing Analyst',
      'Investment Banker',
      'Portfolio Manager',
      'Real Estate Appraiser',
      'Real Estate Agent',
      'Property Manager',
      'Office Manager',
      'Executive Assistant',
      'Administrative Assistant',
      'Data Entry Clerk',
      'Records Manager',
      'Compliance Analyst',
      'Risk Manager',
      'Benefits Specialist',
      'Compensation Analyst',
    ],
  },
  {
    domain: 'Management & Operations',
    majorGroup: '11',
    titles: [
      'Project Manager',
      'Operations Manager',
      'Restaurant Manager',
      'Hotel Manager',
      'Retail Store Manager',
      'Facilities Manager',
      'Construction Manager',
      'Warehouse Manager',
      'Manufacturing Manager',
      'Procurement Manager',
      'Training Manager',
      'Administrative Services Manager',
      'Event Manager',
      'Fleet Manager',
      'Distribution Manager',
      'Call Center Manager',
      'Nonprofit Program Manager',
      'City Manager',
      'Risk Management Director',
      'Sustainability Manager',
    ],
  },
  {
    domain: 'Sales & Growth',
    majorGroup: '41',
    titles: [
      'Sales Representative',
      'Account Executive',
      'Account Manager',
      'Business Development Representative',
      'Sales Manager',
      'Retail Sales Associate',
      'Insurance Sales Agent',
      'Travel Agent',
      'Marketing Specialist',
      'Digital Marketing Specialist',
      'SEO Specialist',
      'Content Marketing Manager',
      'Social Media Manager',
      'Communications Specialist',
      'Publicist',
      'Community Manager',
      'Partnerships Manager',
      'Merchandiser',
      'E-commerce Specialist',
      'Market Analyst',
      'Fundraiser',
      'Admissions Representative',
    ],
  },
  {
    domain: 'Creative & Media',
    majorGroup: '27',
    titles: [
      'Copywriter',
      'Editor',
      'Technical Writer',
      'Translator',
      'Interpreter',
      'Photographer',
      'Videographer',
      'Film Editor',
      'Animator',
      'Illustrator',
      'Art Director',
      'Creative Director',
      'Fashion Designer',
      'Industrial Designer',
      'Landscape Architect',
      'Architect',
      'Urban Planner',
      'Producer',
      'Podcast Producer',
      'Sound Engineer',
      'Musician',
      'Actor',
      'Writer',
      'Content Creator',
    ],
  },
  {
    domain: 'Legal',
    majorGroup: '23',
    titles: [
      'Paralegal',
      'Legal Assistant',
      'Court Reporter',
      'Mediator',
      'Judge',
      'Legal Secretary',
      'Contract Administrator',
      'Policy Analyst',
      'Legislative Assistant',
      'Claims Examiner',
      'Title Examiner',
      'Immigration Specialist',
    ],
  },
  {
    domain: 'Public Safety',
    majorGroup: null,
    titles: [
      'Police Officer',
      'Firefighter',
      'Correctional Officer',
      'Security Guard',
      'Emergency Dispatcher',
      'Forensic Science Technician',
      'Probation Officer',
      'Customs Officer',
      'Occupational Health and Safety Specialist',
      'Disaster Recovery Specialist',
      'Private Investigator',
      'Loss Prevention Specialist',
    ],
  },
  {
    domain: 'Skilled Trades',
    majorGroup: null,
    titles: [
      'Electrician',
      'Plumber',
      'Carpenter',
      'Welder',
      'Machinist',
      'HVAC Technician',
      'Automotive Technician',
      'Aircraft Mechanic',
      'Diesel Mechanic',
      'Industrial Machinery Mechanic',
      'Maintenance Technician',
      'Elevator Installer',
      'Solar Installer',
      'Wind Turbine Technician',
      'Line Installer',
      'Telecommunications Technician',
      'Painter',
      'Roofer',
      'Mason',
      'Glazier',
      'Pipefitter',
      'Tool and Die Maker',
      'CNC Operator',
      'Appliance Repair Technician',
      'Locksmith',
      'Jeweler',
      'Baker',
      'Butcher',
      'Chef',
      'Head Cook',
    ],
  },
  {
    domain: 'Transportation & Logistics',
    majorGroup: null,
    titles: [
      'Truck Driver',
      'Delivery Driver',
      'Bus Driver',
      'Taxi Driver',
      'Pilot',
      'Flight Attendant',
      'Air Traffic Controller',
      'Logistics Coordinator',
      'Dispatcher',
      'Shipping and Receiving Clerk',
      'Inventory Specialist',
      'Forklift Operator',
      'Train Conductor',
      'Railroad Worker',
      'Ship Captain',
      'Deckhand',
      'Crane Operator',
      'Heavy Equipment Operator',
      'Courier',
      'Route Planner',
    ],
  },
  {
    domain: 'Hospitality & Service',
    majorGroup: null,
    titles: [
      'Customer Service Representative',
      'Receptionist',
      'Concierge',
      'Hotel Front Desk Agent',
      'Server',
      'Bartender',
      'Barista',
      'Caterer',
      'Event Planner',
      'Tour Guide',
      'Housekeeper',
      'Janitor',
      'Laundry Worker',
      'Childcare Worker',
      'Nanny',
      'Personal Trainer',
      'Fitness Instructor',
      'Hair Stylist',
      'Cosmetologist',
      'Esthetician',
      'Manicurist',
      'Funeral Director',
    ],
  },
  {
    domain: 'Agriculture & Environment',
    majorGroup: null,
    titles: [
      'Farmer',
      'Farm Manager',
      'Agricultural Technician',
      'Agronomist',
      'Soil Scientist',
      'Conservation Scientist',
      'Forester',
      'Park Ranger',
      'Wildlife Biologist',
      'Zoologist',
      'Environmental Scientist',
      'Environmental Technician',
      'Hydrologist',
      'Meteorologist',
      'Cartographer',
      'Surveyor',
      'Geographer',
      'Archaeologist',
      'Food Scientist',
      'Water Treatment Operator',
      'Recycling Coordinator',
      'Landscape Designer',
      'Groundskeeper',
      'Animal Trainer',
    ],
  },
];

function buildGeneralRoleSeeds(): RoleSeedInput[] {
  return GENERAL_ROLE_GROUPS.flatMap((group) =>
    group.titles.map((title) => ({
      title,
      onetCode: null,
      majorGroup: group.majorGroup,
      domain: group.domain,
      source: 'manual' as const,
    }))
  );
}

function zeroTraitVector(initial = 0): DiscoverRoleTraitVectorDoc {
  return {
    analytical: initial,
    creative: initial,
    leadership: initial,
    technical: initial,
    people: initial,
    business: initial,
    operations: initial,
    detail: initial,
    research: initial,
    communication: initial,
  };
}

function cloneTraitVector(input: DiscoverRoleTraitVectorDoc): DiscoverRoleTraitVectorDoc {
  return { ...input };
}

function addTraits(target: DiscoverRoleTraitVectorDoc, delta: Partial<DiscoverRoleTraitVectorDoc>, multiplier = 1) {
  for (const key of TRAIT_KEYS) {
    const value = delta[key];
    if (typeof value === 'number') {
      target[key] += value * multiplier;
    }
  }
}

function normalizeTraitVector(input: DiscoverRoleTraitVectorDoc): DiscoverRoleTraitVectorDoc {
  const maxValue = Math.max(...TRAIT_KEYS.map((key) => input[key]), 0.001);
  const normalized = zeroTraitVector();
  for (const key of TRAIT_KEYS) {
    const value = input[key] / maxValue;
    normalized[key] = Math.max(0.05, Math.min(1, Number(value.toFixed(4))));
  }
  return normalized;
}

function normalizeSign(input: string | null | undefined) {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (normalized.startsWith('ari')) return 'aries';
  if (normalized.startsWith('tau')) return 'taurus';
  if (normalized.startsWith('gem')) return 'gemini';
  if (normalized.startsWith('can')) return 'cancer';
  if (normalized.startsWith('leo')) return 'leo';
  if (normalized.startsWith('vir')) return 'virgo';
  if (normalized.startsWith('lib')) return 'libra';
  if (normalized.startsWith('sco')) return 'scorpio';
  if (normalized.startsWith('sag')) return 'sagittarius';
  if (normalized.startsWith('cap')) return 'capricorn';
  if (normalized.startsWith('aqu')) return 'aquarius';
  if (normalized.startsWith('pis')) return 'pisces';
  return null;
}

function normalizePlanetName(input: string | null | undefined) {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (normalized.includes('mercur')) return 'mercury';
  if (normalized.includes('venus')) return 'venus';
  if (normalized.includes('mars')) return 'mars';
  if (normalized.includes('jupiter')) return 'jupiter';
  if (normalized.includes('saturn')) return 'saturn';
  if (normalized.includes('uran')) return 'uranus';
  if (normalized.includes('nept')) return 'neptune';
  if (normalized.includes('pluto')) return 'pluto';
  if (normalized.includes('moon')) return 'moon';
  if (normalized.includes('sun')) return 'sun';
  return null;
}

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueLower(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function tokenizeText(values: string[]) {
  const parts: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized.length === 0) continue;
    parts.push(normalized);
    const tokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
    parts.push(...tokens);
  }
  return uniqueLower(parts);
}

function topTraits(vector: DiscoverRoleTraitVectorDoc, count: number) {
  return [...TRAIT_KEYS]
    .sort((a, b) => vector[b] - vector[a])
    .slice(0, count);
}

function buildTraitWeights(seed: RoleSeedInput, domain: string): DiscoverRoleTraitVectorDoc {
  const traits = zeroTraitVector(0.25);
  const domainBase = DOMAIN_BASE_TRAITS[domain];
  if (domainBase) addTraits(traits, domainBase);

  const majorDomain = seed.majorGroup ? MAJOR_GROUP_TO_DOMAIN[seed.majorGroup] : null;
  if (majorDomain && majorDomain !== domain) {
    const majorBase = DOMAIN_BASE_TRAITS[majorDomain];
    if (majorBase) addTraits(traits, majorBase, 0.35);
  }

  const texts = [seed.title, ...(seed.aliases ?? [])];
  for (const text of texts) {
    for (const rule of TITLE_TRAIT_RULES) {
      if (rule.regex.test(text)) addTraits(traits, rule.delta);
    }
  }

  return normalizeTraitVector(traits);
}

function deriveDomain(seed: RoleSeedInput): string {
  if (seed.domain) return seed.domain;
  if (seed.majorGroup) {
    const mapped = MAJOR_GROUP_TO_DOMAIN[seed.majorGroup];
    if (mapped) return mapped;
  }
  return 'General';
}

function parseRoleSeeds(): RoleSeedInput[] {
  const fromOnet: RoleSeedInput[] = ONET_ROLE_LINES.flatMap((line) => {
    const [codeRaw, titleRaw] = line.split('|');
    const code = codeRaw?.trim() ?? '';
    const title = titleRaw?.trim() ?? '';
    if (code.length === 0 || title.length === 0) return [];
    return [
      {
        title,
        onetCode: code,
        majorGroup: code.slice(0, 2),
        source: 'onetonline' as const,
        aliases: [],
      },
    ];
  });
  return [...fromOnet, ...MANUAL_ROLE_SEEDS, ...buildGeneralRoleSeeds()];
}

function buildCatalogDocs(now: Date) {
  const seeds = parseRoleSeeds();
  const slugCounters = new Map<string, number>();
  const docs: Array<Omit<DiscoverRoleCatalogDoc, '_id'>> = [];

  for (const seed of seeds) {
    const baseSlug = slugify(seed.title);
    const currentCount = slugCounters.get(baseSlug) ?? 0;
    slugCounters.set(baseSlug, currentCount + 1);
    const slug = currentCount === 0 ? baseSlug : `${baseSlug}-${currentCount + 1}`;
    const domain = deriveDomain(seed);
    const aliases = uniqueLower(seed.aliases ?? []);
    const traitWeights = buildTraitWeights(seed, domain);
    const tagLabels = topTraits(traitWeights, 3).map((key) => TRAIT_LABELS[key]);
    const keywords = tokenizeText([seed.title, ...aliases, domain, ...tagLabels]);

    docs.push({
      slug,
      title: seed.title,
      domain,
      majorGroup: seed.majorGroup,
      onetCode: seed.onetCode,
      source: seed.source,
      sourceUrl: seed.onetCode ? `${SOURCE_URL_BASE}${seed.onetCode}` : null,
      aliases,
      keywords,
      tags: tagLabels,
      traitWeights,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  return docs;
}

export async function ensureDiscoverRoleCatalogSeeded(log?: LoggerLike) {
  if (!catalogSeedPromise) {
    catalogSeedPromise = (async () => {
      const collections = await getCollections();
      const now = new Date();
      const docs = buildCatalogDocs(now);
      const slugs = docs.map((doc) => doc.slug);

      if (docs.length > 0) {
        await collections.discoverRoleCatalog.bulkWrite(
          docs.map((doc) => ({
            updateOne: {
              filter: { slug: doc.slug },
              update: {
                $set: {
                  title: doc.title,
                  domain: doc.domain,
                  majorGroup: doc.majorGroup,
                  onetCode: doc.onetCode,
                  source: doc.source,
                  sourceUrl: doc.sourceUrl,
                  aliases: doc.aliases,
                  keywords: doc.keywords,
                  tags: doc.tags,
                  traitWeights: doc.traitWeights,
                  active: true,
                  updatedAt: now,
                },
                $setOnInsert: {
                  _id: new ObjectId(),
                  createdAt: now,
                },
              },
              upsert: true,
            },
          })),
          { ordered: false }
        );
      }

      await collections.discoverRoleCatalog.updateMany(
        { slug: { $nin: slugs }, active: true },
        { $set: { active: false, updatedAt: now } }
      );

      clearDiscoverRoleCatalogCache();
      log?.info?.({ count: docs.length }, 'discover role catalog seeded');
      return docs.length;
    })();
  }

  return catalogSeedPromise;
}

type ExtractedPlacement = {
  house: number;
  planet: string;
};

function extractPlacementsFromChart(chart: unknown) {
  if (!chart || typeof chart !== 'object') return { placements: [] as ExtractedPlacement[], houseSigns: new Map<number, string>() };
  const root = chart as Record<string, unknown>;
  if (!Array.isArray(root.houses)) return { placements: [] as ExtractedPlacement[], houseSigns: new Map<number, string>() };

  const placements: ExtractedPlacement[] = [];
  const houseSigns = new Map<number, string>();

  for (const houseEntry of root.houses) {
    if (!houseEntry || typeof houseEntry !== 'object') continue;
    const houseObject = houseEntry as Record<string, unknown>;
    const houseIdRaw = houseObject.house_id;
    if (typeof houseIdRaw !== 'number' || !Number.isFinite(houseIdRaw)) continue;
    const houseId = Math.round(houseIdRaw);
    if (houseId < 1 || houseId > 12) continue;

    const sign = normalizeSign(typeof houseObject.sign === 'string' ? houseObject.sign : null);
    if (sign) {
      houseSigns.set(houseId, sign);
    }

    const planetsRaw = houseObject.planets;
    if (!Array.isArray(planetsRaw)) continue;
    for (const planetEntry of planetsRaw) {
      if (!planetEntry || typeof planetEntry !== 'object') continue;
      const planetObject = planetEntry as Record<string, unknown>;
      const planet = normalizePlanetName(typeof planetObject.name === 'string' ? planetObject.name : null);
      if (!planet) continue;
      placements.push({ house: houseId, planet });
    }
  }

  return { placements, houseSigns };
}

function buildUserTraitsFromChart(chart: unknown): UserTraitProfile {
  const traits = zeroTraitVector(0.34);
  const signals: string[] = [];
  const { placements, houseSigns } = extractPlacementsFromChart(chart);

  const ascSign = houseSigns.get(1);
  const mcSign = houseSigns.get(10);

  if (ascSign && SIGN_TRAIT_BONUS[ascSign]) {
    addTraits(traits, SIGN_TRAIT_BONUS[ascSign], 0.5);
    signals.push(`Ascendant in ${ascSign} supports a distinctive work style.`);
  }
  if (mcSign && SIGN_TRAIT_BONUS[mcSign]) {
    addTraits(traits, SIGN_TRAIT_BONUS[mcSign], 0.9);
    signals.push(`MC in ${mcSign} emphasizes visible career direction.`);
  }

  const houseCounts = new Map<number, number>();
  for (const placement of placements) {
    houseCounts.set(placement.house, (houseCounts.get(placement.house) ?? 0) + 1);
    const planetBonus = PLANET_TRAIT_BONUS[placement.planet];
    if (planetBonus) addTraits(traits, planetBonus, 0.8);
  }

  for (const [house, count] of houseCounts.entries()) {
    const houseBonus = HOUSE_TRAIT_BONUS[house];
    if (!houseBonus) continue;
    const multiplier = Math.min(2, count) * 0.75;
    addTraits(traits, houseBonus, multiplier);
  }

  const house10Count = houseCounts.get(10) ?? 0;
  if (house10Count > 0) {
    signals.push('10th house activity points to strong career visibility.');
  }
  const mercuryCount = placements.filter((entry) => entry.planet === 'mercury').length;
  if (mercuryCount > 0) {
    signals.push('Mercury placements favor communication and analytical work.');
  }
  const venusCount = placements.filter((entry) => entry.planet === 'venus').length;
  if (venusCount > 0) {
    signals.push('Venus placements support creative and people-facing strengths.');
  }

  const normalizedTraits = normalizeTraitVector(traits);
  const uniqueSignals = uniqueLower(signals).map((line) => line.charAt(0).toUpperCase() + line.slice(1));

  return {
    traits: normalizedTraits,
    signals: uniqueSignals.slice(0, 3),
  };
}

function computeRoleScore(userTraits: DiscoverRoleTraitVectorDoc, roleTraits: DiscoverRoleTraitVectorDoc) {
  let numerator = 0;
  let denominator = 0;
  for (const key of TRAIT_KEYS) {
    const weight = roleTraits[key];
    numerator += userTraits[key] * weight;
    denominator += weight;
  }
  const ratio = denominator > 0 ? numerator / denominator : 0;
  const score = Math.round(ratio * 100);
  return Math.max(45, Math.min(98, score));
}

function computeOverlapTraits(
  userTraits: DiscoverRoleTraitVectorDoc,
  roleTraits: DiscoverRoleTraitVectorDoc,
  count: number
) {
  return [...TRAIT_KEYS]
    .map((key) => ({ key, value: userTraits[key] * roleTraits[key] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, count)
    .map((entry) => entry.key);
}

function buildRecommendationReason(
  overlapTraits: TraitKey[],
  signals: string[],
  currentJob: DiscoverRoleCurrentJobPayload | null = null,
  role?: Pick<DiscoverRoleCatalogDoc, 'slug' | 'domain'>
) {
  const firstTrait = overlapTraits[0] ? TRAIT_LABELS[overlapTraits[0]] : 'balanced';
  const secondTrait = overlapTraits[1] ? TRAIT_LABELS[overlapTraits[1]] : null;
  const traitText = secondTrait ? `${firstTrait} + ${secondTrait}` : firstTrait;
  if (currentJob?.title) {
    if (currentJob.matchedRole?.slug && role && currentJob.matchedRole.slug === role.slug) {
      return `Your current work as ${currentJob.title} already leans on ${traitText} strengths highlighted in your chart.`;
    }
    if (currentJob.matchedRole?.domain && role && currentJob.matchedRole.domain === role.domain) {
      return `Coming from ${currentJob.title}, this path keeps building ${traitText} strengths in a familiar lane.`;
    }
    return `From your current work as ${currentJob.title}, this role could build on ${traitText} strengths highlighted in your chart.`;
  }
  const signal = signals[0] ?? 'Your natal chart profile';
  return `${signal} aligns with ${traitText} demands for this role.`;
}

function buildRoleReasonAndTags(
  role: DiscoverRoleCatalogDoc,
  userProfile: UserTraitProfile,
  currentJob: DiscoverRoleCurrentJobPayload | null = null,
) {
  const overlapTraits = computeOverlapTraits(userProfile.traits, role.traitWeights, 2);
  return {
    reason: buildRecommendationReason(overlapTraits, userProfile.signals, currentJob, role),
    tags: overlapTraits.map((key) => TRAIT_LABELS[key]),
  };
}

function dedupeStringsPreserveCase(values: string[], limit: number) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const normalized = normalizeText(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(trimmed);
    if (output.length >= limit) break;
  }
  return output;
}

function pickRealityTemplate(role: DiscoverRoleCatalogDoc): DiscoverRoleRealityTemplate {
  return DOMAIN_REALITY_TEMPLATES[role.domain] ?? GENERAL_DISCOVER_ROLE_REALITY_TEMPLATE;
}

function buildTitleSpecificTasks(role: DiscoverRoleCatalogDoc) {
  const tasks: string[] = [];
  const title = role.title;

  if (/\b(manager|director|head|lead)\b/i.test(title)) {
    tasks.push('Set direction, sequence work, and keep multiple stakeholders aligned.');
  }
  if (/\b(product)\b/i.test(title)) {
    tasks.push('Decide what matters now versus later when resources are limited.');
  }
  if (/\b(engineer|developer|architect|devops|sre|software)\b/i.test(title)) {
    tasks.push('Ship working systems that hold up under real technical constraints.');
  }
  if (/\b(analyst|research|scientist)\b/i.test(title)) {
    tasks.push('Interrogate signals before turning them into a recommendation.');
  }
  if (/\b(designer|ux|brand|creative)\b/i.test(title)) {
    tasks.push('Translate abstract feedback into concrete iterations people can feel.');
  }
  if (/\b(recruit|talent|customer success|sales|marketing|growth)\b/i.test(title)) {
    tasks.push('Keep external conversations moving while protecting trust and momentum.');
  }

  return tasks;
}

function buildRealityToolThemes(role: DiscoverRoleCatalogDoc, market: OccupationInsightResponse | null) {
  const marketTools = (market?.skills ?? [])
    .filter((item) => item.category === 'tool' || item.category === 'technology')
    .map((item) => item.name);
  const template = pickRealityTemplate(role);
  const titleTools: string[] = [];

  if (/\b(product)\b/i.test(role.title)) {
    titleTools.push('Prioritization frameworks');
  }
  if (/\b(engineer|developer|architect|devops|software)\b/i.test(role.title)) {
    titleTools.push('Code review workflows');
  }
  if (/\b(analyst|scientist|research)\b/i.test(role.title)) {
    titleTools.push('Analysis workflows');
  }
  if (/\b(designer|ux|creative|brand)\b/i.test(role.title)) {
    titleTools.push('Design critique loops');
  }

  return dedupeStringsPreserveCase(
    [...marketTools, ...titleTools, ...template.toolThemes],
    4,
  );
}

const DISCOVER_ENTRY_BARRIER_RANK: Record<DiscoverRoleDetail['entryBarrier']['level'], number> = {
  accessible: 0,
  moderate: 1,
  specialized: 2,
  high: 3,
};

function resolveEntryBarrierLevel(role: DiscoverRoleCatalogDoc): DiscoverRoleDetail['entryBarrier']['level'] {
  const title = role.title;
  if (/\b(physician|surgeon|dentist|pharmacist|lawyer|attorney|judge|psychologist)\b/i.test(title)) {
    return 'high';
  }
  if (/\b(nurse|teacher|therapist|scientist|engineer|developer|architect|research|analyst)\b/i.test(title)) {
    return 'specialized';
  }
  if (/\b(assistant|associate|representative|coordinator|support|administrator|technician)\b/i.test(title)) {
    return 'accessible';
  }
  return pickRealityTemplate(role).barrierLevel;
}

function resolveEntryBarrierLabel(level: DiscoverRoleDetail['entryBarrier']['level']) {
  const labels: Record<DiscoverRoleDetail['entryBarrier']['level'], string> = {
    accessible: 'Lower Entry Barrier',
    moderate: 'Moderate Entry Barrier',
    specialized: 'Specialized Ramp',
    high: 'High Entry Barrier',
  };
  return labels[level];
}

type DiscoverRoleDecisionSupportCandidate = {
  role: DiscoverRoleCatalogDoc;
  score: number;
  barrierLevel: DiscoverRoleDetail['entryBarrier']['level'];
  barrierLabel: string;
  barrierRank: number;
  sameSelectedDomain: boolean;
  sameCurrentRole: boolean;
  sameCurrentDomain: boolean;
  sharedTagCount: number;
  practicalScore: number;
  stretchScore: number;
};

function countSharedStrings(left: string[], right: string[]) {
  const rightSet = new Set(right.map((item) => normalizeText(item)));
  return left.reduce((count, item) => {
    const key = normalizeText(item);
    if (!key || !rightSet.has(key)) return count;
    return count + 1;
  }, 0);
}

function toDecisionRole(
  role: DiscoverRoleCatalogDoc,
  score: number,
  barrierLevel: DiscoverRoleDetail['entryBarrier']['level'],
): DiscoverRoleDecisionRole {
  return {
    slug: role.slug,
    title: role.title,
    domain: role.domain,
    fitScore: score,
    fitLabel: `${score}% fit`,
    barrier: {
      level: barrierLevel,
      label: resolveEntryBarrierLabel(barrierLevel),
    },
  };
}

function buildDecisionSupportCandidate(input: {
  selectedRole: DiscoverRoleCatalogDoc;
  candidateRole: DiscoverRoleCatalogDoc;
  candidateScore: number;
  currentJob: DiscoverRoleCurrentJobPayload | null;
}): DiscoverRoleDecisionSupportCandidate {
  const { selectedRole, candidateRole, candidateScore, currentJob } = input;
  const barrierLevel = resolveEntryBarrierLevel(candidateRole);
  const barrierLabel = resolveEntryBarrierLabel(barrierLevel);
  const barrierRank = DISCOVER_ENTRY_BARRIER_RANK[barrierLevel];
  const sameSelectedDomain = selectedRole.domain === candidateRole.domain;
  const sameCurrentRole = currentJob?.matchedRole?.slug === candidateRole.slug;
  const sameCurrentDomain = currentJob?.matchedRole?.domain === candidateRole.domain;
  const sharedTagCount = countSharedStrings(selectedRole.tags, candidateRole.tags);

  return {
    role: candidateRole,
    score: candidateScore,
    barrierLevel,
    barrierLabel,
    barrierRank,
    sameSelectedDomain,
    sameCurrentRole,
    sameCurrentDomain,
    sharedTagCount,
    practicalScore:
      candidateScore -
      barrierRank * 11 +
      (sameCurrentRole ? 18 : 0) +
      (sameCurrentDomain ? 10 : 0) +
      (sameSelectedDomain ? 7 : 0) +
      sharedTagCount * 3,
    stretchScore:
      candidateScore +
      (sameSelectedDomain ? 6 : 0) +
      sharedTagCount * 2 +
      (barrierRank >= DISCOVER_ENTRY_BARRIER_RANK[resolveEntryBarrierLevel(selectedRole)] ? 4 : 0),
  };
}

function buildDecisionSupportSummary(input: {
  lane: DiscoverRoleTransitionPath['lane'];
  selectedRole: DiscoverRoleCatalogDoc;
  candidate: DiscoverRoleDecisionSupportCandidate;
  currentJob: DiscoverRoleCurrentJobPayload | null;
}) {
  const { lane, selectedRole, candidate, currentJob } = input;

  if (lane === 'best_match') {
    if (currentJob?.title && (candidate.sameCurrentRole || candidate.sameCurrentDomain)) {
      return `Closest to ${currentJob.title} while still keeping strong alignment with your chart profile.`;
    }
    if (candidate.sameSelectedDomain) {
      return `Stays close to the ${selectedRole.domain.toLowerCase()} lane, but reads as easier to picture in practice.`;
    }
    return `The cleanest adjacent move from your current fit profile.`;
  }

  if (lane === 'easier_entry') {
    return `Lower switching friction than ${selectedRole.title} while keeping enough fit to stay credible.`;
  }

  if (candidate.barrierRank > DISCOVER_ENTRY_BARRIER_RANK[resolveEntryBarrierLevel(selectedRole)]) {
    return `A longer stretch than ${selectedRole.title}, but the upside may justify a slower ramp.`;
  }
  return `Similar fit with a stronger long-range ceiling if you can tolerate a more deliberate ramp.`;
}

function buildBestAlternativeReasons(input: {
  selectedRole: DiscoverRoleCatalogDoc;
  selectedScore: number;
  candidate: DiscoverRoleDecisionSupportCandidate;
  currentJob: DiscoverRoleCurrentJobPayload | null;
}) {
  const { selectedRole, selectedScore, candidate, currentJob } = input;
  const selectedBarrierRank = DISCOVER_ENTRY_BARRIER_RANK[resolveEntryBarrierLevel(selectedRole)];

  return dedupeStringsPreserveCase(
    [
      candidate.sameCurrentRole
        ? 'This is already your current lane, so you are compounding existing credibility instead of explaining a cold switch.'
        : '',
      candidate.sameCurrentDomain && currentJob?.title
        ? `It stays closer to ${currentJob.title}, which should make the move easier to explain to recruiters and hiring managers.`
        : '',
      candidate.barrierRank < selectedBarrierRank
        ? `Entry friction is lower than ${selectedRole.title}, which makes early traction more realistic.`
        : '',
      candidate.score >= selectedScore - 8
        ? `Fit stays close to ${selectedRole.title}, so you are not giving up much alignment for practicality.`
        : '',
      candidate.sameSelectedDomain
        ? `It still keeps you near the same ${selectedRole.domain.toLowerCase()} lane.`
        : '',
    ],
    3,
  );
}

function buildBestAlternativeHeadline(input: {
  candidate: DiscoverRoleDecisionSupportCandidate;
  currentJob: DiscoverRoleCurrentJobPayload | null;
}) {
  const { candidate, currentJob } = input;
  if (candidate.sameCurrentRole) {
    return 'Most realistic continuation from your current role';
  }
  if (candidate.sameCurrentDomain && currentJob?.title) {
    return 'Cleaner move from your current lane';
  }
  if (candidate.barrierRank <= 1) {
    return 'Lower-friction alternative';
  }
  return 'More practical next bet';
}

function buildBestAlternativeSummary(input: {
  selectedRole: DiscoverRoleCatalogDoc;
  candidate: DiscoverRoleDecisionSupportCandidate;
  currentJob: DiscoverRoleCurrentJobPayload | null;
}) {
  const { selectedRole, candidate, currentJob } = input;
  if (candidate.sameCurrentRole) {
    return `${candidate.role.title} looks easier to convert from ${currentJob?.title ?? 'your current work'} without losing the strengths already showing up in your chart.`;
  }
  if (candidate.sameCurrentDomain && currentJob?.title) {
    return `${candidate.role.title} is the cleaner bet if you want to stay closer to ${currentJob.title} while still moving forward.`;
  }
  if (candidate.barrierRank < DISCOVER_ENTRY_BARRIER_RANK[resolveEntryBarrierLevel(selectedRole)]) {
    return `${candidate.role.title} may be the stronger immediate bet if you want similar upside with a lighter ramp.`;
  }
  return `${candidate.role.title} is the best alternate path when you want something that still fits, but reads as more actionable right now.`;
}

export function buildDiscoverRoleDecisionSupport(input: {
  selectedRole: DiscoverRoleCatalogDoc;
  selectedScore: number;
  rankedRoles: Array<{ role: DiscoverRoleCatalogDoc; score: number }>;
  currentJob: DiscoverRoleCurrentJobPayload | null;
}): Pick<DiscoverRoleDetail, 'transitionMap' | 'bestAlternative'> {
  const { selectedRole, selectedScore, rankedRoles, currentJob } = input;
  const selectedBarrierLevel = resolveEntryBarrierLevel(selectedRole);
  const selectedBarrierRank = DISCOVER_ENTRY_BARRIER_RANK[selectedBarrierLevel];
  const selectedPracticalScore =
    selectedScore -
    selectedBarrierRank * 11 +
    (currentJob?.matchedRole?.slug === selectedRole.slug ? 18 : 0) +
    (currentJob?.matchedRole?.domain === selectedRole.domain ? 10 : 0);

  const candidates = rankedRoles
    .filter((entry) => entry.role.slug !== selectedRole.slug)
    .map((entry) =>
      buildDecisionSupportCandidate({
        selectedRole,
        candidateRole: entry.role,
        candidateScore: entry.score,
        currentJob,
      }),
    );

  const practicalSorted = [...candidates].sort(
    (a, b) =>
      b.practicalScore - a.practicalScore ||
      b.score - a.score ||
      a.role.title.localeCompare(b.role.title),
  );

  const bestAlternativeCandidate = practicalSorted.find((candidate) => {
    const practicalDelta = candidate.practicalScore - selectedPracticalScore;
    return (
      practicalDelta >= 4 ||
      (selectedBarrierRank >= 2 && candidate.barrierRank < selectedBarrierRank) ||
      (Boolean(currentJob?.matchedRole) && (candidate.sameCurrentRole || candidate.sameCurrentDomain))
    );
  }) ?? null;

  const usedSlugs = new Set<string>();
  if (bestAlternativeCandidate) {
    usedSlugs.add(bestAlternativeCandidate.role.slug);
  }

  const pickCandidate = (
    items: DiscoverRoleDecisionSupportCandidate[],
    predicate: (candidate: DiscoverRoleDecisionSupportCandidate) => boolean,
  ) => items.find((candidate) => !usedSlugs.has(candidate.role.slug) && predicate(candidate)) ?? null;

  const transitionMap: DiscoverRoleTransitionPath[] = [];

  const bestMatchCandidate = pickCandidate(
    practicalSorted,
    () => true,
  );
  if (bestMatchCandidate) {
    usedSlugs.add(bestMatchCandidate.role.slug);
    transitionMap.push({
      lane: 'best_match',
      label: currentJob?.title ? 'Closest Next Move' : 'Best Match',
      summary: buildDecisionSupportSummary({
        lane: 'best_match',
        selectedRole,
        candidate: bestMatchCandidate,
        currentJob,
      }),
      role: toDecisionRole(
        bestMatchCandidate.role,
        bestMatchCandidate.score,
        bestMatchCandidate.barrierLevel,
      ),
    });
  }

  const easierEntryCandidate = pickCandidate(
    practicalSorted,
    (candidate) =>
      (candidate.barrierRank < selectedBarrierRank || candidate.barrierRank <= 1) &&
      (candidate.score >= Math.max(55, selectedScore - 20) || candidate.sameCurrentDomain || candidate.sameCurrentRole),
  );
  if (easierEntryCandidate) {
    usedSlugs.add(easierEntryCandidate.role.slug);
    transitionMap.push({
      lane: 'easier_entry',
      label: 'Easier Entry',
      summary: buildDecisionSupportSummary({
        lane: 'easier_entry',
        selectedRole,
        candidate: easierEntryCandidate,
        currentJob,
      }),
      role: toDecisionRole(
        easierEntryCandidate.role,
        easierEntryCandidate.score,
        easierEntryCandidate.barrierLevel,
      ),
    });
  }

  const higherCeilingCandidate = pickCandidate(
    [...candidates].sort(
      (a, b) =>
        b.stretchScore - a.stretchScore ||
        b.score - a.score ||
        a.role.title.localeCompare(b.role.title),
    ),
    (candidate) =>
      (candidate.barrierRank >= selectedBarrierRank || candidate.score >= selectedScore - 6) &&
      candidate.score >= Math.max(60, selectedScore - 12),
  );
  if (higherCeilingCandidate) {
    transitionMap.push({
      lane: 'higher_ceiling',
      label: 'Higher Ceiling',
      summary: buildDecisionSupportSummary({
        lane: 'higher_ceiling',
        selectedRole,
        candidate: higherCeilingCandidate,
        currentJob,
      }),
      role: toDecisionRole(
        higherCeilingCandidate.role,
        higherCeilingCandidate.score,
        higherCeilingCandidate.barrierLevel,
      ),
    });
  }

  return {
    transitionMap: transitionMap.slice(0, 3),
    bestAlternative: bestAlternativeCandidate
      ? {
          headline: buildBestAlternativeHeadline({
            candidate: bestAlternativeCandidate,
            currentJob,
          }),
          summary: buildBestAlternativeSummary({
            selectedRole,
            candidate: bestAlternativeCandidate,
            currentJob,
          }),
          reasons: buildBestAlternativeReasons({
            selectedRole,
            selectedScore,
            candidate: bestAlternativeCandidate,
            currentJob,
          }),
          role: toDecisionRole(
            bestAlternativeCandidate.role,
            bestAlternativeCandidate.score,
            bestAlternativeCandidate.barrierLevel,
          ),
        }
      : null,
  };
}

function buildDiscoverRoleDetail(input: {
  role: DiscoverRoleCatalogDoc;
  userProfile: UserTraitProfile;
  currentJob: DiscoverRoleCurrentJobPayload | null;
  market: OccupationInsightResponse | null;
  rankedRoles: Array<{ role: DiscoverRoleCatalogDoc; score: number }>;
}): DiscoverRoleDetail {
  const { role, userProfile, currentJob, market, rankedRoles } = input;
  const overlapTraits = computeOverlapTraits(userProfile.traits, role.traitWeights, 3);
  const topTraits = overlapTraits.map((trait) => TRAIT_LABELS[trait]);
  const selectedScore = computeRoleScore(userProfile.traits, role.traitWeights);
  const whySummary = buildRecommendationReason(overlapTraits, userProfile.signals, currentJob, role);
  const whyBullets = dedupeStringsPreserveCase(
    [
      ...overlapTraits.map(
        (trait) =>
          `${TRAIT_LABELS[trait]} helps here because the work leans on ${TRAIT_EXPLANATIONS[trait]}.`,
      ),
      currentJob?.matchedRole?.domain === role.domain
        ? `Your current role already sits near the ${role.domain.toLowerCase()} lane, so the transition is easier to picture.`
        : currentJob?.title
          ? `This can be read as a next-step option from ${currentJob.title}, not only a cold-switch fantasy role.`
          : userProfile.signals[0] ?? '',
    ],
    3,
  );

  const realityTemplate = pickRealityTemplate(role);
  const tasks = dedupeStringsPreserveCase(
    [...buildTitleSpecificTasks(role), ...realityTemplate.tasks],
    3,
  );
  const workContext = dedupeStringsPreserveCase(realityTemplate.workContext, 3);
  const toolThemes = buildRealityToolThemes(role, market);

  const barrierLevel = resolveEntryBarrierLevel(role);
  const barrierSignals = dedupeStringsPreserveCase(
    [
      currentJob?.matchedRole?.slug === role.slug
        ? 'This already overlaps strongly with your current lane, so the switching friction is lower than a cold move.'
        : currentJob?.matchedRole?.domain === role.domain
          ? 'Your current role is already adjacent to this domain, which lowers the ramp compared with a full lane change.'
          : '',
      ...realityTemplate.barrierSignals,
    ],
    3,
  );
  const barrierSummary =
    currentJob?.matchedRole?.slug === role.slug
      ? `This is already close to your current work, so the main challenge is depth, not entry.`
      : currentJob?.matchedRole?.domain === role.domain
        ? `Compared with a cold switch, this path should feel more reachable because you already operate near the same domain.`
        : {
            accessible: 'This path is usually easier to test with transferable proof and adjacent experience.',
            moderate: 'This path often rewards adjacent experience, but it does not usually require a long formal ramp.',
            specialized: 'This path usually needs focused proof, domain reps, or a stronger skills ramp before it feels natural.',
            high: 'This path often carries formal training, regulated access, or a long trust-building ramp.',
          }[barrierLevel];
  const decisionSupport = buildDiscoverRoleDecisionSupport({
    selectedRole: role,
    selectedScore,
    rankedRoles,
    currentJob,
  });

  return {
    whyFit: {
      summary: whySummary,
      bullets: whyBullets,
      topTraits,
    },
    realityCheck: {
      summary: realityTemplate.summary,
      tasks,
      workContext,
      toolThemes,
    },
    entryBarrier: {
      level: barrierLevel,
      label: resolveEntryBarrierLabel(barrierLevel),
      summary: barrierSummary,
      signals: barrierSignals,
    },
    transitionMap: decisionSupport.transitionMap,
    bestAlternative: decisionSupport.bestAlternative,
  };
}

function buildRankedRoles(roles: DiscoverRoleCatalogDoc[], userProfile: UserTraitProfile): RankedRole[] {
  return roles
    .map((role) => {
      const score = computeRoleScore(userProfile.traits, role.traitWeights);
      const overlapTraits = computeOverlapTraits(userProfile.traits, role.traitWeights, 2);
      const reason = buildRecommendationReason(overlapTraits, userProfile.signals);
      const tags = overlapTraits.map((key) => TRAIT_LABELS[key]);

      return {
        role,
        score,
        overlapTraits,
        reason,
        tags,
      } satisfies RankedRole;
    })
    .sort((a, b) => b.score - a.score || a.role.title.localeCompare(b.role.title));
}

function pickDiverseRankedRoles(ranked: RankedRole[], count: number, maxPerDomain: number) {
  const selected: RankedRole[] = [];
  const domainCounts = new Map<string, number>();

  for (const entry of ranked) {
    const current = domainCounts.get(entry.role.domain) ?? 0;
    if (current >= maxPerDomain) continue;
    selected.push(entry);
    domainCounts.set(entry.role.domain, current + 1);
    if (selected.length >= count) return selected;
  }

  for (const entry of ranked) {
    if (selected.some((item) => item.role.slug === entry.role.slug)) continue;
    selected.push(entry);
    if (selected.length >= count) break;
  }

  return selected;
}

function buildCacheItems(ranked: RankedRole[]): DiscoverRoleRecommendationItemDoc[] {
  return pickDiverseRankedRoles(ranked, RECOMMENDED_CACHE_SIZE, 3).map((entry) => ({
    roleSlug: entry.role.slug,
    score: entry.score,
    reason: entry.reason,
    tags: entry.tags,
  }));
}

export function computeDiscoverRoleMarketOpportunityScore(market: OccupationInsightResponse | null) {
  if (!market) return 0;

  const marketScore = {
    'strong market': 40,
    'steady market': 28,
    'niche market': 18,
    'limited data': 8,
  }[market.labels.marketScore];
  const demandScore = {
    high: 25,
    moderate: 16,
    low: 6,
    unknown: 8,
  }[market.outlook.demandLabel];
  const median = market.salary?.median ?? null;
  const salaryScore =
    typeof median === 'number'
      ? median >= 150_000
        ? 20
        : median >= 110_000
          ? 16
          : median >= 80_000
            ? 12
            : median >= 55_000
              ? 8
              : 5
      : 4;
  const openings = market.outlook.projectedOpenings ?? null;
  const openingsScore =
    typeof openings === 'number'
      ? openings >= 100_000
        ? 15
        : openings >= 25_000
          ? 10
          : openings >= 5_000
            ? 6
            : 3
      : 4;

  return Math.max(0, Math.min(100, marketScore + demandScore + salaryScore + openingsScore));
}

export function computeDiscoverRoleOpportunityRankScore(input: {
  fitScore: number;
  market: OccupationInsightResponse | null;
}) {
  const marketScore = computeDiscoverRoleMarketOpportunityScore(input.market);
  if (marketScore <= 0) return input.fitScore;
  return Math.round(marketScore * 0.65 + input.fitScore * 0.35);
}

function buildRoleView(
  role: DiscoverRoleCatalogDoc,
  score: number,
  reason: string,
  tags: string[],
  market: OccupationInsightResponse | null = null,
  detail?: DiscoverRoleDetail,
) {
  return {
    slug: role.slug,
    title: role.title,
    domain: role.domain,
    score,
    scoreLabel: `${score}%`,
    reason,
    tags,
    source: {
      provider: role.source,
      code: role.onetCode,
      url: role.sourceUrl,
    },
    market,
    detail: detail ?? null,
    opportunityScore: computeDiscoverRoleOpportunityRankScore({
      fitScore: score,
      market,
    }),
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const item = items[currentIndex];
        if (item === undefined) continue;
        results[currentIndex] = await mapper(item);
      }
    }),
  );

  return results;
}

async function loadMarketForRoles(input: {
  roles: DiscoverRoleCatalogDoc[];
  log?: LoggerLike;
}) {
  const uniqueRoles = [...new Map(input.roles.map((role) => [role.slug, role])).values()];
  const entries = await mapWithConcurrency(
    uniqueRoles,
    DISCOVER_MARKET_CONCURRENCY,
    async (role): Promise<[string, OccupationInsightResponse | null]> => {
      try {
        const market = await getOccupationInsight({
          keyword: role.onetCode ?? role.title,
          location: DISCOVER_MARKET_LOCATION,
        });
        return [role.slug, market];
      } catch (error) {
        if (error instanceof MarketProviderError) {
          input.log?.warn?.(
            { code: error.code, roleSlug: role.slug, roleTitle: role.title },
            'Discover role market enrichment unavailable',
          );
        } else {
          input.log?.warn?.(
            { error, roleSlug: role.slug, roleTitle: role.title },
            'Discover role market enrichment failed',
          );
        }
        return [role.slug, null];
      }
    },
  );

  return new Map(entries);
}

function queryMatchRank(role: DiscoverRoleCatalogDoc, normalizedQuery: string, tokens: string[]) {
  const title = normalizeText(role.title);
  let rank = 0;

  if (title === normalizedQuery) rank += 220;
  else if (title.startsWith(normalizedQuery)) rank += 160;
  else if (title.includes(normalizedQuery)) rank += 110;

  for (const alias of role.aliases) {
    if (alias === normalizedQuery) rank += 170;
    else if (alias.startsWith(normalizedQuery)) rank += 130;
    else if (alias.includes(normalizedQuery)) rank += 90;
  }

  const domain = normalizeText(role.domain);
  if (domain.includes(normalizedQuery)) rank += 35;

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (title.includes(token)) rank += 18;
    if (domain.includes(token)) rank += 8;
    if (role.keywords.includes(token)) rank += 10;
  }

  return rank;
}

export function findBestDiscoverRoleCatalogMatch(
  roles: DiscoverRoleCatalogDoc[],
  query: string,
): DiscoverRoleCatalogDoc | null {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length < MIN_QUERY_LENGTH) return null;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const match = roles
    .map((role) => ({
      role,
      rank: queryMatchRank(role, normalizedQuery, tokens),
    }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.role.title.localeCompare(b.role.title))[0];

  return match?.role ?? null;
}

export async function resolveDiscoverRoleCatalogMatch(
  query: string,
  options?: { forceRefresh?: boolean; log?: LoggerLike },
) {
  await ensureDiscoverRoleCatalogSeeded(options?.log);
  const collections = await getCollections();
  const catalog = await loadActiveDiscoverRoleCatalog(collections, {
    forceRefresh: options?.forceRefresh,
  });
  return findBestDiscoverRoleCatalogMatch(catalog, query);
}

type DiscoverRolesInput = {
  userId: ObjectId;
  profileHash: string;
  natalChart: unknown;
  query: string;
  limit: number;
  searchLimit: number;
  refresh: boolean;
  deferSearchScores: boolean;
  scoreSlug: string;
  rankingMode: DiscoverRoleRankingMode;
  currentJob?: DiscoverRoleCurrentJobPayload | null;
  log?: LoggerLike;
};

export type DiscoverRolesResponse = {
  algorithmVersion: string;
  cached: boolean;
  generatedAt: string;
  rankingMode: DiscoverRoleRankingMode;
  context: {
    currentJob: DiscoverRoleCurrentJobPayload | null;
  };
  recommended: Array<{
    slug: string;
    title: string;
    domain: string;
    score: number;
    scoreLabel: string;
    reason: string;
    tags: string[];
    source: {
      provider: 'onetonline' | 'manual';
      code: string | null;
      url: string | null;
    };
    market: OccupationInsightResponse | null;
    detail: DiscoverRoleDetail | null;
    opportunityScore: number;
  }>;
  search: Array<{
    slug: string;
    title: string;
    domain: string;
    tags: string[];
    score?: number;
    scoreLabel?: string;
    scoreStatus: 'ready' | 'deferred';
    market: OccupationInsightResponse | null;
    detail: DiscoverRoleDetail | null;
    opportunityScore: number | null;
  }>;
  query: string;
  meta: {
    catalogSize: number;
    signals: string[];
  };
};

export async function getDiscoverRoles(input: DiscoverRolesInput): Promise<DiscoverRolesResponse> {
  await ensureDiscoverRoleCatalogSeeded(input.log);
  const collections = await getCollections();
  const catalog = await loadActiveDiscoverRoleCatalog(collections, { forceRefresh: input.refresh });

  if (catalog.length === 0) {
    throw new Error('Discover role catalog is empty');
  }

  const cachedDoc = input.refresh
    ? null
    : await collections.discoverRoleRecommendations.findOne({
        userId: input.userId,
        profileHash: input.profileHash,
        algorithmVersion: DISCOVER_ROLES_ALGORITHM_VERSION,
      });

  let userProfile: UserTraitProfile;
  let generatedAt: Date;
  let cacheItems: DiscoverRoleRecommendationItemDoc[];
  let rankedFresh: RankedRole[] | null = null;
  let fromCache = false;

  if (cachedDoc) {
    userProfile = {
      traits: cloneTraitVector(cachedDoc.traitProfile),
      signals: cachedDoc.signals.slice(0, 3),
    };
    generatedAt = cachedDoc.generatedAt;
    cacheItems = cachedDoc.recommended.slice(0, RECOMMENDED_CACHE_SIZE);
    fromCache = true;
  } else {
    userProfile = buildUserTraitsFromChart(input.natalChart);
    rankedFresh = buildRankedRoles(catalog, userProfile);
    cacheItems = buildCacheItems(rankedFresh);
    generatedAt = new Date();
    const now = generatedAt;

    await collections.discoverRoleRecommendations.updateOne(
      {
        userId: input.userId,
        profileHash: input.profileHash,
        algorithmVersion: DISCOVER_ROLES_ALGORITHM_VERSION,
      },
      {
        $set: {
          traitProfile: userProfile.traits,
          signals: userProfile.signals,
          recommended: cacheItems,
          generatedAt: now,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          createdAt: now,
        },
      },
      { upsert: true }
    );
  }

  const roleBySlug = new Map(catalog.map((role) => [role.slug, role]));
  const currentJob = input.currentJob ?? null;
  const scoreBySlug = new Map<string, number>();
  const scoreForRole = (role: DiscoverRoleCatalogDoc) => {
    const cachedScore = scoreBySlug.get(role.slug);
    if (typeof cachedScore === 'number') return cachedScore;
    const nextScore = computeRoleScore(userProfile.traits, role.traitWeights);
    scoreBySlug.set(role.slug, nextScore);
    return nextScore;
  };

  let ranked: RankedRole[] | null = rankedFresh;
  const ensureRanked = () => {
    if (!ranked) {
      ranked = buildRankedRoles(catalog, userProfile);
    }
    return ranked;
  };

  let fallbackBySlug: Map<string, { reason: string; tags: string[] }> | null =
    rankedFresh
      ? new Map(
          rankedFresh.map((entry) => [
            entry.role.slug,
            {
              reason: entry.reason,
              tags: entry.tags,
            },
          ]),
        )
      : null;

  const ensureFallbackBySlug = () => {
    if (!fallbackBySlug) {
      fallbackBySlug = new Map(
        ensureRanked().map((entry) => [
          entry.role.slug,
          {
            reason: entry.reason,
            tags: entry.tags,
          },
        ]),
      );
    }
    return fallbackBySlug;
  };

  const recommendedCount = Math.max(3, Math.min(8, input.limit));
  const buildFitRecommended = () => {
    const items: DiscoverRolesResponse['recommended'] = [];

    for (const item of cacheItems) {
      const role = roleBySlug.get(item.roleSlug);
      if (!role) continue;
      const fallback =
        item.reason && item.tags.length > 0
          ? null
          : ensureFallbackBySlug().get(role.slug);
      const score = scoreForRole(role);
      const personalized = buildRoleReasonAndTags(role, userProfile, currentJob);
      const reason = currentJob?.title
        ? personalized.reason
        : item.reason || fallback?.reason || personalized.reason || 'This role aligns well with your chart profile.';
      const tags = currentJob?.title
        ? personalized.tags
        : item.tags.length > 0
          ? item.tags
          : fallback?.tags ?? personalized.tags ?? role.tags;
      items.push(buildRoleView(role, score, reason, tags));
      if (items.length >= recommendedCount) break;
    }

    if (items.length < recommendedCount) {
      for (const entry of ensureRanked()) {
        if (items.some((item) => item.slug === entry.role.slug)) continue;
        const personalized = buildRoleReasonAndTags(entry.role, userProfile, currentJob);
        items.push(
          buildRoleView(
            entry.role,
            entry.score,
            currentJob?.title ? personalized.reason : entry.reason,
            currentJob?.title ? personalized.tags : entry.tags,
          ),
        );
        if (items.length >= recommendedCount) break;
      }
    }

    return items;
  };

  let recommended: DiscoverRolesResponse['recommended'];
  const decisionSupportRankedRoles = ensureRanked().slice(
    0,
    Math.max(DISCOVER_OPPORTUNITY_CANDIDATE_LIMIT, recommendedCount + 8),
  );

  if (input.rankingMode === 'opportunity') {
    const candidateEntries = ensureRanked().slice(
      0,
      Math.max(DISCOVER_OPPORTUNITY_CANDIDATE_LIMIT, recommendedCount),
    );
    const marketBySlug = await loadMarketForRoles({
      roles: candidateEntries.map((entry) => entry.role),
      log: input.log,
    });
    recommended = candidateEntries
      .map((entry) => {
        const personalized = buildRoleReasonAndTags(entry.role, userProfile, currentJob);
        const market = marketBySlug.get(entry.role.slug) ?? null;
        return buildRoleView(
          entry.role,
          entry.score,
          currentJob?.title ? personalized.reason : entry.reason,
          currentJob?.title ? personalized.tags : entry.tags,
          market,
          buildDiscoverRoleDetail({
            role: entry.role,
            userProfile,
            currentJob,
            market,
            rankedRoles: decisionSupportRankedRoles,
          }),
        );
      })
      .sort(
        (a, b) =>
          b.opportunityScore - a.opportunityScore ||
          b.score - a.score ||
          a.title.localeCompare(b.title),
      )
      .slice(0, recommendedCount);
  } else {
    const fitRecommended = buildFitRecommended();
    const rolesToEnrich = fitRecommended
      .map((item) => roleBySlug.get(item.slug))
      .filter((role): role is DiscoverRoleCatalogDoc => Boolean(role));
    const marketBySlug = await loadMarketForRoles({
      roles: rolesToEnrich,
      log: input.log,
    });
    recommended = fitRecommended.map((item) => {
      const market = marketBySlug.get(item.slug) ?? null;
      const role = roleBySlug.get(item.slug);
      return {
        ...item,
        market,
        detail: role
          ? buildDiscoverRoleDetail({
              role,
              userProfile,
              currentJob,
              market,
              rankedRoles: decisionSupportRankedRoles,
            })
          : item.detail,
        opportunityScore: computeDiscoverRoleOpportunityRankScore({
          fitScore: item.score,
          market,
        }),
      };
    });
  }

  const normalizedQuery = normalizeText(input.query);
  const searchLimit = Math.max(5, Math.min(30, input.searchLimit));
  const search: DiscoverRolesResponse['search'] = [];

  if (normalizedQuery.length >= MIN_QUERY_LENGTH) {
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    const rankedMatches = catalog
      .map((role) => {
        const rank = queryMatchRank(role, normalizedQuery, tokens);
        if (rank <= 0) return null;
        const sortScore = input.deferSearchScores ? 0 : scoreForRole(role);
        return { role, rank, sortScore };
      })
      .filter((entry): entry is { role: DiscoverRoleCatalogDoc; rank: number; sortScore: number } => Boolean(entry))
      .sort((a, b) => b.rank - a.rank || b.sortScore - a.sortScore || a.role.title.localeCompare(b.role.title))
      .slice(0, searchLimit);

    for (const entry of rankedMatches) {
      const shouldScore = !input.deferSearchScores || entry.role.slug === input.scoreSlug;
      const score = shouldScore ? scoreForRole(entry.role) : null;
      search.push({
        slug: entry.role.slug,
        title: entry.role.title,
        domain: entry.role.domain,
        tags: entry.role.tags.slice(0, 2),
        ...(score !== null ? { score, scoreLabel: `${score}%` } : {}),
        scoreStatus: score !== null ? 'ready' : 'deferred',
        market: null,
        detail: buildDiscoverRoleDetail({
          role: entry.role,
          userProfile,
          currentJob,
          market: null,
          rankedRoles: decisionSupportRankedRoles,
        }),
        opportunityScore: score,
      });
    }
  }

  const searchRolesToEnrich = search
    .filter((item) => !input.deferSearchScores || item.slug === input.scoreSlug)
    .map((item) => roleBySlug.get(item.slug))
    .filter((role): role is DiscoverRoleCatalogDoc => Boolean(role));
  const searchMarketBySlug =
    searchRolesToEnrich.length > 0
      ? await loadMarketForRoles({
          roles: searchRolesToEnrich,
          log: input.log,
        })
      : new Map<string, OccupationInsightResponse | null>();
  const enrichedSearch = search.map((item) => {
    const market = searchMarketBySlug.get(item.slug) ?? null;
    const role = roleBySlug.get(item.slug);
    return {
      ...item,
      market,
      detail: role
        ? buildDiscoverRoleDetail({
            role,
            userProfile,
            currentJob,
            market,
            rankedRoles: decisionSupportRankedRoles,
          })
        : item.detail,
      opportunityScore:
        item.score == null
          ? null
          : computeDiscoverRoleOpportunityRankScore({
              fitScore: item.score,
              market,
            }),
    };
  });

  return {
    algorithmVersion: DISCOVER_ROLES_ALGORITHM_VERSION,
    cached: fromCache,
    generatedAt: generatedAt.toISOString(),
    rankingMode: input.rankingMode,
    context: {
      currentJob,
    },
    recommended,
    search: enrichedSearch,
    query: normalizedQuery,
    meta: {
      catalogSize: catalog.length,
      signals: userProfile.signals,
    },
  };
}
