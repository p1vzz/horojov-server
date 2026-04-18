import { ObjectId } from 'mongodb';
import type {
  DiscoverRoleCatalogDoc,
  DiscoverRoleRecommendationItemDoc,
  DiscoverRoleTraitVectorDoc,
  MongoCollections,
} from '../db/mongo.js';
import { getCollections } from '../db/mongo.js';

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

function buildRecommendationReason(overlapTraits: TraitKey[], signals: string[]) {
  const firstTrait = overlapTraits[0] ? TRAIT_LABELS[overlapTraits[0]] : 'balanced';
  const secondTrait = overlapTraits[1] ? TRAIT_LABELS[overlapTraits[1]] : null;
  const traitText = secondTrait ? `${firstTrait} + ${secondTrait}` : firstTrait;
  const signal = signals[0] ?? 'Your natal chart profile';
  return `${signal} aligns with ${traitText} demands for this role.`;
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

function buildRoleView(
  role: DiscoverRoleCatalogDoc,
  score: number,
  reason: string,
  tags: string[]
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
  };
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
  log?: LoggerLike;
};

export type DiscoverRolesResponse = {
  algorithmVersion: string;
  cached: boolean;
  generatedAt: string;
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
  }>;
  search: Array<{
    slug: string;
    title: string;
    domain: string;
    tags: string[];
    score?: number;
    scoreLabel?: string;
    scoreStatus: 'ready' | 'deferred';
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
  const recommended: DiscoverRolesResponse['recommended'] = [];

  for (const item of cacheItems) {
    const role = roleBySlug.get(item.roleSlug);
    if (!role) continue;
    const fallback =
      item.reason && item.tags.length > 0
        ? null
        : ensureFallbackBySlug().get(role.slug);
    const score = scoreForRole(role);
    const reason = item.reason || fallback?.reason || 'This role aligns well with your chart profile.';
    const tags = item.tags.length > 0 ? item.tags : fallback?.tags ?? role.tags;
    recommended.push(buildRoleView(role, score, reason, tags));
    if (recommended.length >= recommendedCount) break;
  }

  if (recommended.length < recommendedCount) {
    for (const entry of ensureRanked()) {
      if (recommended.some((item) => item.slug === entry.role.slug)) continue;
      recommended.push(buildRoleView(entry.role, entry.score, entry.reason, entry.tags));
      if (recommended.length >= recommendedCount) break;
    }
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
      });
    }
  }

  return {
    algorithmVersion: DISCOVER_ROLES_ALGORITHM_VERSION,
    cached: fromCache,
    generatedAt: generatedAt.toISOString(),
    recommended,
    search,
    query: normalizedQuery,
    meta: {
      catalogSize: catalog.length,
      signals: userProfile.signals,
    },
  };
}
