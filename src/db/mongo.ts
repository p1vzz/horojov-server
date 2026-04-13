import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb';
import { env } from '../config/env.js';
import type { JobProviderName, SupportedJobSource } from '../services/jobUrl.js';

export type UserDoc = {
  _id: ObjectId;
  kind: 'anonymous' | 'registered';
  subscriptionTier?: 'free' | 'premium';
  appleSub?: string | null;
  email?: string | null;
  displayName?: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
};

export type SessionDoc = {
  _id: ObjectId;
  userId: ObjectId;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  revokedAt?: Date | null;
};

export type BirthProfileDoc = {
  _id: ObjectId;
  userId: ObjectId;
  name?: string;
  birthDate: string;
  birthTime: string | null;
  unknownTime: boolean;
  city: string;
  latitude?: number | null;
  longitude?: number | null;
  country?: string | null;
  admin1?: string | null;
  normalizedCity: string;
  profileHash: string;
  createdAt: Date;
  updatedAt: Date;
};

export type NatalChartDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash: string;
  houseType: string;
  provider: 'astrologyapi';
  chart: unknown;
  meta: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type CareerInsightItemDoc = {
  title: string;
  tag: string;
  description: string;
  actions: string[];
};

export type CareerInsightsDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash: string;
  tier: 'free' | 'premium';
  promptVersion: string;
  model: string;
  summary: string;
  insights: CareerInsightItemDoc[];
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type DailyTransitMetricsDoc = {
  energy: number;
  focus: number;
  luck: number;
};

export type AlgorithmTagDoc = {
  group: string;
  label: string;
  score: number;
  reason: string;
};

export type DailyTransitVibeDoc = {
  algorithmVersion: string;
  title: string;
  modeLabel: string;
  summary: string;
  dominant: {
    planet: string;
    sign: string;
    house: number;
    retrograde: boolean;
  };
  metrics: DailyTransitMetricsDoc;
  signals?: {
    positiveAspects: number;
    hardAspects: number;
    positiveAspectStrength: number;
    hardAspectStrength: number;
    dominantScore: number;
    secondaryHouse: number | null;
    secondaryHouseDensity: number;
    dignityBalance: number;
    momentum: {
      energy: number;
      focus: number;
      luck: number;
    };
  };
  tags?: AlgorithmTagDoc[];
  drivers?: string[];
  cautions?: string[];
};

export type DailyTransitDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash: string;
  dateKey: string;
  chart: unknown;
  vibe: DailyTransitVibeDoc;
  meta: {
    latitude: number;
    longitude: number;
    timezone: number;
    timezoneId: string | null;
    source: 'profile_coordinates' | 'astrology_geo';
    placeName: string;
  };
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type AiSynergyComponentScoresDoc = {
  cognitiveFlow: number;
  automationReadiness: number;
  decisionQuality: number;
  collaborationWithAI: number;
};

export type AiSynergySignalsDoc = {
  dominantPlanet: string;
  dominantHouse: number;
  mcSign: string | null;
  ascSign: string | null;
  positiveAspects: number;
  hardAspects: number;
  positiveAspectStrength?: number;
  hardAspectStrength?: number;
  secondaryHouse?: number | null;
  secondaryHouseDensity?: number;
  dignityBalance?: number;
  momentumScore?: number;
  natalTechnicalBias: number;
  natalCommunicationBias: number;
};

export type AiSynergyConfidenceBreakdownDoc = {
  dataQuality: number;
  coherence: number;
  stability: number;
};

export type AiSynergyDailyDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash: string;
  dateKey: string;
  algorithmVersion: string;
  narrativeSource: 'template' | 'llm';
  llmModel: string | null;
  llmPromptVersion: string | null;
  score: number;
  band: 'peak' | 'strong' | 'stable' | 'volatile';
  confidence: number;
  components: AiSynergyComponentScoresDoc;
  signals: AiSynergySignalsDoc;
  confidenceBreakdown?: AiSynergyConfidenceBreakdownDoc;
  tags?: AlgorithmTagDoc[];
  drivers?: string[];
  cautions?: string[];
  actionsPriority?: string[];
  narrativeVariantId?: string;
  styleProfile?: string;
  headline: string;
  summary: string;
  description: string;
  recommendations: string[];
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type MorningBriefingMetricsDoc = {
  energy: number;
  focus: number;
  luck: number;
  aiSynergy: number;
};

export type MorningBriefingDailyDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash: string;
  dateKey: string;
  schemaVersion: string;
  headline: string;
  summary: string;
  modeLabel: string;
  metrics: MorningBriefingMetricsDoc;
  insights?: {
    vibe: {
      algorithmVersion: string;
      drivers: string[];
      cautions: string[];
      tags: AlgorithmTagDoc[];
    };
    aiSynergy: {
      algorithmVersion: string;
      band: 'peak' | 'strong' | 'stable' | 'volatile';
      confidence: number;
      confidenceBreakdown: AiSynergyConfidenceBreakdownDoc;
      drivers: string[];
      cautions: string[];
      actionsPriority: string[];
      tags: AlgorithmTagDoc[];
      narrativeVariantId: string;
      styleProfile: string;
    };
  };
  sources: {
    dailyTransitDateKey: string;
    aiSynergyDateKey: string | null;
  };
  generatedAt: Date;
  staleAfter: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type FullNatalCareerArchetypeDoc = {
  name: string;
  score: number;
  evidence: string[];
};

export type FullNatalCareerStrengthDoc = {
  title: string;
  details: string;
  evidence: string[];
};

export type FullNatalCareerBlindSpotDoc = {
  title: string;
  risk: string;
  mitigation: string;
  evidence: string[];
};

export type FullNatalCareerRoleFitDoc = {
  domain: string;
  fitScore: number;
  why: string;
  exampleRoles: string[];
};

export type FullNatalCareerPhasePlanDoc = {
  phase: '0_6_months' | '6_18_months' | '18_36_months';
  goal: string;
  actions: string[];
  kpis: string[];
  risks: string[];
};

export type FullNatalCareerAnalysisPayloadDoc = {
  schemaVersion: string;
  headline: string;
  executiveSummary: string;
  careerArchetypes: FullNatalCareerArchetypeDoc[];
  strengths: FullNatalCareerStrengthDoc[];
  blindSpots: FullNatalCareerBlindSpotDoc[];
  roleFitMatrix: FullNatalCareerRoleFitDoc[];
  phasePlan: FullNatalCareerPhasePlanDoc[];
  decisionRules: string[];
  next90DaysPlan: string[];
};

export type FullNatalCareerAnalysisDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash: string;
  promptVersion: string;
  model: string;
  narrativeSource: 'template' | 'llm';
  analysis: FullNatalCareerAnalysisPayloadDoc;
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type DiscoverRoleTraitVectorDoc = {
  analytical: number;
  creative: number;
  leadership: number;
  technical: number;
  people: number;
  business: number;
  operations: number;
  detail: number;
  research: number;
  communication: number;
};

export type DiscoverRoleCatalogDoc = {
  _id: ObjectId;
  slug: string;
  title: string;
  domain: string;
  majorGroup: string | null;
  onetCode: string | null;
  source: 'onetonline' | 'manual';
  sourceUrl: string | null;
  aliases: string[];
  keywords: string[];
  tags: string[];
  traitWeights: DiscoverRoleTraitVectorDoc;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type DiscoverRoleRecommendationItemDoc = {
  roleSlug: string;
  score: number;
  reason: string;
  tags: string[];
};

export type DiscoverRoleRecommendationsDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash: string;
  algorithmVersion: string;
  traitProfile: DiscoverRoleTraitVectorDoc;
  signals: string[];
  recommended: DiscoverRoleRecommendationItemDoc[];
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type JobRawDoc = {
  _id: ObjectId;
  source: SupportedJobSource;
  host: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  sourceJobId: string | null;
  provider: JobProviderName | 'manual';
  providerRequestId?: string | null;
  providerMeta?: Record<string, unknown> | null;
  rawPayload: unknown;
  normalizedText: string;
  normalizedJob: unknown;
  jobContentHash: string;
  fetchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date | null;
};

export type JobRawArtifactDoc = {
  _id: ObjectId;
  source: SupportedJobSource;
  canonicalUrlHash: string;
  provider: JobProviderName | 'manual';
  providerRequestId?: string | null;
  providerMeta?: Record<string, unknown> | null;
  statusCode: number | null;
  finalUrl: string | null;
  title: string | null;
  html: string;
  fetchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type JobParsedDoc = {
  _id: ObjectId;
  source: SupportedJobSource;
  host: string;
  canonicalUrlHash: string;
  jobContentHash: string;
  parserVersion: string;
  parsed: unknown;
  tags: string[];
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date | null;
};

export type JobAnalysisDoc = {
  _id: ObjectId;
  userId: ObjectId;
  source: SupportedJobSource;
  profileHash: string;
  canonicalUrlHash: string;
  jobContentHash: string;
  rubricVersion: string;
  modelVersion: string;
  provider: 'openai' | 'deterministic';
  result: unknown;
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type JobUsageLimitsDoc = {
  _id: ObjectId;
  userId: ObjectId;
  plan: 'free' | 'premium';
  freeWindowStartedAt: Date | null;
  freeWindowSuccessCount: number;
  premiumDateKey: string | null;
  premiumDailyCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LlmGatewayTelemetryUsageDoc = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedInputCostUsd: number | null;
  estimatedOutputCostUsd: number | null;
  estimatedTotalCostUsd: number | null;
};

export type LlmGatewayTelemetryDoc = {
  _id: ObjectId;
  event: 'llm_gateway_success' | 'llm_gateway_failure';
  feature: string;
  schemaName: string;
  requestModel: string;
  promptVersion: string | null;
  responseModel: string | null;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  messageCount: number;
  attempts: number;
  durationMs: number;
  usage: LlmGatewayTelemetryUsageDoc;
  failureStage: 'config' | 'transport' | 'upstream' | 'response_content' | 'response_json' | null;
  upstreamStatus: number | null;
  errorMessage: string | null;
  createdAt: Date;
};

export type BillingSubscriptionStatus = 'active' | 'grace' | 'billing_issue' | 'expired' | 'none';

export type BillingSubscriptionDoc = {
  _id: ObjectId;
  userId: ObjectId;
  provider: 'revenuecat';
  appUserId: string;
  tier: 'free' | 'premium';
  entitlementId: string | null;
  status: BillingSubscriptionStatus;
  productId: string | null;
  store: 'app_store' | 'play_store' | 'stripe' | 'promotional' | 'unknown';
  willRenew: boolean | null;
  periodType: 'normal' | 'trial' | 'intro' | 'prepaid' | 'unknown' | null;
  purchasedAt: Date | null;
  expiresAt: Date | null;
  latestEventId: string | null;
  latestEventAt: Date | null;
  source: 'sync' | 'webhook';
  rawSnapshot: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type RevenueCatEventDoc = {
  _id: ObjectId;
  eventId: string;
  eventType: string;
  appUserId: string | null;
  userId: ObjectId | null;
  eventTimestampMs: number | null;
  receivedAt: Date;
  processedAt: Date | null;
  processingStatus: 'processed' | 'ignored' | 'failed';
  errorMessage: string | null;
  rawPayload: unknown;
};

export type PushTokenPlatform = 'ios' | 'android' | 'web';

export type PushNotificationTokenDoc = {
  _id: ObjectId;
  userId: ObjectId;
  token: string;
  platform: PushTokenPlatform;
  appVersion: string | null;
  active: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type BurnoutAlertSettingsDoc = {
  _id: ObjectId;
  userId: ObjectId;
  enabled: boolean;
  timezoneIana: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  createdAt: Date;
  updatedAt: Date;
};

export type BurnoutAlertSeverity = 'warn' | 'high' | 'critical';

export type BurnoutAlertJobStatus = 'planned' | 'sent' | 'failed' | 'skipped' | 'cancelled';

export type BurnoutAlertEventType = 'planned' | 'skipped' | 'cancelled' | 'sent' | 'failed' | 'seen';

export type BurnoutAlertJobDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash?: string;
  dateKey: string;
  severity: BurnoutAlertSeverity;
  riskScore: number;
  predictedPeakAt: Date | null;
  scheduledAt: Date | null;
  status: BurnoutAlertJobStatus;
  providerMessageId: string | null;
  lastError: string | null;
  sentAt: Date | null;
  seenAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BurnoutAlertEventDoc = {
  _id: ObjectId;
  userId: ObjectId;
  jobId: ObjectId | null;
  profileHash: string | null;
  dateKey: string | null;
  type: BurnoutAlertEventType;
  severity: BurnoutAlertSeverity | null;
  riskScore: number | null;
  reason: string | null;
  providerMessageId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export type LunarProductivityRiskSeverity = 'none' | BurnoutAlertSeverity;
export type LunarProductivityImpactDirection = 'supportive' | 'disruptive';

export type LunarProductivitySettingsDoc = {
  _id: ObjectId;
  userId: ObjectId;
  enabled: boolean;
  timezoneIana: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LunarProductivityJobDoc = {
  _id: ObjectId;
  userId: ObjectId;
  profileHash?: string;
  dateKey: string;
  severity: BurnoutAlertSeverity;
  riskScore: number;
  impactDirection?: LunarProductivityImpactDirection;
  predictedDipAt: Date | null;
  scheduledAt: Date | null;
  status: BurnoutAlertJobStatus;
  providerMessageId: string | null;
  lastError: string | null;
  sentAt: Date | null;
  seenAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InterviewStrategyAlgorithmVersion = 'interview-strategy-v1';

export type InterviewStrategySettingsDoc = {
  _id: ObjectId;
  userId: ObjectId;
  enabled: boolean;
  timezoneIana: string;
  slotDurationMinutes: 30 | 45 | 60;
  allowedWeekdays: number[];
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  slotsPerWeek: number;
  autoFillConfirmedAt: Date | null;
  autoFillStartAt: Date | null;
  filledUntilDateKey: string | null;
  lastGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InterviewStrategyScoreBreakdownDoc = {
  dailyCareerScore: number;
  aiSynergyScore: number;
  weekdayWeight: number;
  hourWeight: number;
  conflictPenalty: number;
};

export type InterviewStrategySlotSource = 'manual_refresh' | 'scheduler_refill' | 'bootstrap';

export type InterviewStrategySlotDoc = {
  _id: ObjectId;
  userId: ObjectId;
  slotId: string;
  dateKey: string;
  weekKey: string;
  startAt: Date;
  endAt: Date;
  timezoneIana: string;
  score: number;
  explanation: string;
  breakdown: InterviewStrategyScoreBreakdownDoc;
  algorithmVersion: InterviewStrategyAlgorithmVersion;
  source: InterviewStrategySlotSource;
  createdAt: Date;
  updatedAt: Date;
};

export type JobFetchNegativeCacheDoc = {
  _id: ObjectId;
  source: SupportedJobSource;
  canonicalUrlHash: string;
  status: 'blocked' | 'login_wall' | 'not_found';
  message: string;
  details?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
};

export type MongoCollections = {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  birthProfiles: Collection<BirthProfileDoc>;
  natalCharts: Collection<NatalChartDoc>;
  careerInsights: Collection<CareerInsightsDoc>;
  dailyTransits: Collection<DailyTransitDoc>;
  aiSynergyDaily: Collection<AiSynergyDailyDoc>;
  morningBriefingDaily: Collection<MorningBriefingDailyDoc>;
  fullNatalCareerAnalysis: Collection<FullNatalCareerAnalysisDoc>;
  discoverRoleCatalog: Collection<DiscoverRoleCatalogDoc>;
  discoverRoleRecommendations: Collection<DiscoverRoleRecommendationsDoc>;
  jobsRaw: Collection<JobRawDoc>;
  jobRawArtifacts: Collection<JobRawArtifactDoc>;
  jobsParsed: Collection<JobParsedDoc>;
  jobAnalyses: Collection<JobAnalysisDoc>;
  jobUsageLimits: Collection<JobUsageLimitsDoc>;
  llmGatewayTelemetry: Collection<LlmGatewayTelemetryDoc>;
  billingSubscriptions: Collection<BillingSubscriptionDoc>;
  revenueCatEvents: Collection<RevenueCatEventDoc>;
  pushNotificationTokens: Collection<PushNotificationTokenDoc>;
  burnoutAlertSettings: Collection<BurnoutAlertSettingsDoc>;
  burnoutAlertJobs: Collection<BurnoutAlertJobDoc>;
  burnoutAlertEvents: Collection<BurnoutAlertEventDoc>;
  lunarProductivitySettings: Collection<LunarProductivitySettingsDoc>;
  lunarProductivityJobs: Collection<LunarProductivityJobDoc>;
  interviewStrategySettings: Collection<InterviewStrategySettingsDoc>;
  interviewStrategySlots: Collection<InterviewStrategySlotDoc>;
  jobFetchNegativeCache: Collection<JobFetchNegativeCacheDoc>;
};

let clientPromise: Promise<MongoClient> | null = null;
let indexPromise: Promise<void> | null = null;

function getMongoUri() {
  if (!env.EFFECTIVE_MONGO_URI) {
    throw new Error('MongoDB URI is not configured (set MONGO_URI or MONGODB_URI)');
  }
  return env.EFFECTIVE_MONGO_URI;
}

export async function getMongoClient() {
  if (!clientPromise) {
    clientPromise = MongoClient.connect(getMongoUri(), {
      maxPoolSize: 25,
    });
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(env.MONGO_DB_NAME);
}

export async function getCollections(): Promise<MongoCollections> {
  const db = await getDb();
  return {
    users: db.collection<UserDoc>('users'),
    sessions: db.collection<SessionDoc>('sessions'),
    birthProfiles: db.collection<BirthProfileDoc>('birth_profiles'),
    natalCharts: db.collection<NatalChartDoc>('natal_charts'),
    careerInsights: db.collection<CareerInsightsDoc>('career_insights'),
    dailyTransits: db.collection<DailyTransitDoc>('daily_transits'),
    aiSynergyDaily: db.collection<AiSynergyDailyDoc>('ai_synergy_daily'),
    morningBriefingDaily: db.collection<MorningBriefingDailyDoc>('morning_briefing_daily'),
    fullNatalCareerAnalysis: db.collection<FullNatalCareerAnalysisDoc>('full_natal_career_analysis'),
    discoverRoleCatalog: db.collection<DiscoverRoleCatalogDoc>('discover_role_catalog'),
    discoverRoleRecommendations: db.collection<DiscoverRoleRecommendationsDoc>('discover_role_recommendations'),
    jobsRaw: db.collection<JobRawDoc>('jobs_raw'),
    jobRawArtifacts: db.collection<JobRawArtifactDoc>('job_raw_artifacts'),
    jobsParsed: db.collection<JobParsedDoc>('jobs_parsed'),
    jobAnalyses: db.collection<JobAnalysisDoc>('job_analyses'),
    jobUsageLimits: db.collection<JobUsageLimitsDoc>('job_usage_limits'),
    llmGatewayTelemetry: db.collection<LlmGatewayTelemetryDoc>('llm_gateway_telemetry'),
    billingSubscriptions: db.collection<BillingSubscriptionDoc>('billing_subscriptions'),
    revenueCatEvents: db.collection<RevenueCatEventDoc>('revenuecat_events'),
    pushNotificationTokens: db.collection<PushNotificationTokenDoc>('push_notification_tokens'),
    burnoutAlertSettings: db.collection<BurnoutAlertSettingsDoc>('burnout_alert_settings'),
    burnoutAlertJobs: db.collection<BurnoutAlertJobDoc>('burnout_alert_jobs'),
    burnoutAlertEvents: db.collection<BurnoutAlertEventDoc>('burnout_alert_events'),
    lunarProductivitySettings: db.collection<LunarProductivitySettingsDoc>('lunar_productivity_settings'),
    lunarProductivityJobs: db.collection<LunarProductivityJobDoc>('lunar_productivity_jobs'),
    interviewStrategySettings: db.collection<InterviewStrategySettingsDoc>('interview_strategy_settings'),
    interviewStrategySlots: db.collection<InterviewStrategySlotDoc>('interview_strategy_slots'),
    jobFetchNegativeCache: db.collection<JobFetchNegativeCacheDoc>('job_fetch_negative_cache'),
  };
}

export async function ensureMongoIndexes() {
  if (!indexPromise) {
    indexPromise = (async () => {
      const collections = await getCollections();
      await collections.users.createIndex({ appleSub: 1 }, { unique: true, sparse: true });
      await collections.sessions.createIndex({ accessTokenHash: 1 }, { unique: true });
      await collections.sessions.createIndex({ refreshTokenHash: 1 }, { unique: true });
      await collections.sessions.createIndex({ userId: 1, updatedAt: -1 });
      await collections.sessions.createIndex({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0 });
      await collections.birthProfiles.createIndex({ userId: 1 }, { unique: true });
      await collections.natalCharts.createIndex({ userId: 1, profileHash: 1 }, { unique: true });
      await collections.careerInsights.createIndex(
        { userId: 1, profileHash: 1, tier: 1, promptVersion: 1, model: 1 },
        { unique: true }
      );
      await collections.careerInsights.createIndex({ userId: 1, profileHash: 1, tier: 1, generatedAt: -1 });
      await collections.dailyTransits.createIndex({ userId: 1, profileHash: 1, dateKey: 1 }, { unique: true });
      await collections.dailyTransits.createIndex({ dateKey: 1, updatedAt: -1 });
      await collections.aiSynergyDaily.createIndex(
        { userId: 1, profileHash: 1, dateKey: 1, algorithmVersion: 1 },
        { unique: true }
      );
      await collections.aiSynergyDaily.createIndex({ userId: 1, profileHash: 1, dateKey: -1, updatedAt: -1 });
      await collections.aiSynergyDaily.createIndex({ userId: 1, dateKey: -1 });
      await collections.morningBriefingDaily.createIndex(
        { userId: 1, profileHash: 1, dateKey: 1, schemaVersion: 1 },
        { unique: true }
      );
      await collections.morningBriefingDaily.createIndex({ userId: 1, dateKey: -1 });
      await collections.fullNatalCareerAnalysis.createIndex(
        { userId: 1, profileHash: 1, promptVersion: 1, model: 1 },
        { unique: true }
      );
      await collections.fullNatalCareerAnalysis.createIndex({ userId: 1, updatedAt: -1 });
      await collections.discoverRoleCatalog.createIndex({ slug: 1 }, { unique: true });
      try {
        await collections.discoverRoleCatalog.dropIndex('onetCode_1');
      } catch {
        // Index may not exist yet on fresh databases.
      }
      await collections.discoverRoleCatalog.createIndex(
        { onetCode: 1 },
        { unique: true, partialFilterExpression: { onetCode: { $type: 'string' } } }
      );
      await collections.discoverRoleCatalog.createIndex({ active: 1, title: 1 });
      await collections.discoverRoleCatalog.createIndex({ domain: 1, title: 1 });
      await collections.discoverRoleRecommendations.createIndex(
        { userId: 1, profileHash: 1, algorithmVersion: 1 },
        { unique: true }
      );
      await collections.discoverRoleRecommendations.createIndex({ userId: 1, updatedAt: -1 });
      await collections.jobsRaw.createIndex({ canonicalUrlHash: 1 }, { unique: true });
      await collections.jobsRaw.createIndex({ source: 1, sourceJobId: 1 });
      await collections.jobsRaw.createIndex({ jobContentHash: 1, updatedAt: -1 });
      await collections.jobsRaw.createIndex({ source: 1, updatedAt: -1 });
      await collections.jobsRaw.createIndex({ updatedAt: -1 });
      await collections.jobsRaw.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });
      await collections.jobRawArtifacts.createIndex({ canonicalUrlHash: 1 }, { unique: true });
      await collections.jobRawArtifacts.createIndex({ source: 1, updatedAt: -1 });
      await collections.jobRawArtifacts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await collections.jobsParsed.createIndex({ jobContentHash: 1, parserVersion: 1 }, { unique: true });
      await collections.jobsParsed.createIndex({ canonicalUrlHash: 1, parserVersion: 1 });
      await collections.jobsParsed.createIndex({ source: 1, updatedAt: -1 });
      await collections.jobsParsed.createIndex({ updatedAt: -1 });
      await collections.jobsParsed.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });
      await collections.jobAnalyses.createIndex(
        { userId: 1, profileHash: 1, jobContentHash: 1, rubricVersion: 1, modelVersion: 1 },
        { unique: true }
      );
      await collections.jobAnalyses.createIndex({ userId: 1, updatedAt: -1 });
      await collections.jobUsageLimits.createIndex({ userId: 1 }, { unique: true });
      await collections.llmGatewayTelemetry.createIndex({ createdAt: -1 });
      await collections.llmGatewayTelemetry.createIndex({ event: 1, createdAt: -1 });
      await collections.llmGatewayTelemetry.createIndex({ feature: 1, createdAt: -1 });
      await collections.llmGatewayTelemetry.createIndex({ promptVersion: 1, createdAt: -1 });
      await collections.llmGatewayTelemetry.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: env.OPENAI_TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 }
      );
      await collections.billingSubscriptions.createIndex({ userId: 1 }, { unique: true });
      await collections.billingSubscriptions.createIndex({ appUserId: 1 });
      await collections.billingSubscriptions.createIndex({ tier: 1, updatedAt: -1 });
      await collections.billingSubscriptions.createIndex({ expiresAt: 1 });
      await collections.revenueCatEvents.createIndex({ eventId: 1 }, { unique: true });
      await collections.revenueCatEvents.createIndex({ userId: 1, receivedAt: -1 });
      await collections.revenueCatEvents.createIndex({ processingStatus: 1, receivedAt: -1 });
      await collections.pushNotificationTokens.createIndex({ token: 1 }, { unique: true });
      await collections.pushNotificationTokens.createIndex({ userId: 1, active: 1, updatedAt: -1 });
      await collections.burnoutAlertSettings.createIndex({ userId: 1 }, { unique: true });
      await collections.burnoutAlertSettings.createIndex({ enabled: 1, updatedAt: -1 });
      await collections.burnoutAlertJobs.createIndex({ userId: 1, dateKey: 1 }, { unique: true });
      await collections.burnoutAlertJobs.createIndex({ status: 1, scheduledAt: 1 });
      await collections.burnoutAlertJobs.createIndex({ userId: 1, status: 1, sentAt: -1 });
      await collections.burnoutAlertJobs.createIndex({ userId: 1, updatedAt: -1 });
      await collections.burnoutAlertEvents.createIndex({ userId: 1, createdAt: -1 });
      await collections.burnoutAlertEvents.createIndex({ type: 1, createdAt: -1 });
      await collections.burnoutAlertEvents.createIndex({ dateKey: 1, type: 1, createdAt: -1 });
      await collections.burnoutAlertEvents.createIndex({ jobId: 1, createdAt: -1 }, { sparse: true });
      await collections.lunarProductivitySettings.createIndex({ userId: 1 }, { unique: true });
      await collections.lunarProductivitySettings.createIndex({ enabled: 1, updatedAt: -1 });
      await collections.lunarProductivityJobs.createIndex({ userId: 1, dateKey: 1 }, { unique: true });
      await collections.lunarProductivityJobs.createIndex({ status: 1, scheduledAt: 1 });
      await collections.lunarProductivityJobs.createIndex({ userId: 1, status: 1, sentAt: -1 });
      await collections.lunarProductivityJobs.createIndex({ userId: 1, updatedAt: -1 });
      await collections.interviewStrategySettings.createIndex({ userId: 1 }, { unique: true });
      await collections.interviewStrategySettings.createIndex({ enabled: 1, autoFillConfirmedAt: 1, updatedAt: -1 });
      await collections.interviewStrategySlots.createIndex({ userId: 1, slotId: 1 }, { unique: true });
      await collections.interviewStrategySlots.createIndex({ userId: 1, startAt: 1 });
      await collections.interviewStrategySlots.createIndex({ userId: 1, updatedAt: -1 });
      await collections.jobFetchNegativeCache.createIndex({ canonicalUrlHash: 1 }, { unique: true });
      await collections.jobFetchNegativeCache.createIndex({ source: 1, status: 1, updatedAt: -1 });
      await collections.jobFetchNegativeCache.createIndex({ updatedAt: -1 });
      await collections.jobFetchNegativeCache.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    })();
  }
  await indexPromise;
}

export async function closeMongoConnection() {
  if (!clientPromise) return;
  const client = await clientPromise;
  await client.close();
  clientPromise = null;
  indexPromise = null;
}
