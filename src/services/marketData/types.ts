export type MarketSourceProvider = 'careeronestop' | 'onet';

export type MarketSource = {
  provider: MarketSourceProvider;
  label: string;
  url: string | null;
  retrievedAt: string;
  attributionText: string;
  logoRequired: boolean;
};

export type MarketSalaryRange = {
  currency: 'USD';
  period: 'annual' | 'hourly';
  min: number | null;
  max: number | null;
  median: number | null;
  year: string | null;
  confidence: 'high' | 'medium' | 'low';
  basis: 'posted_salary' | 'market_estimate';
};

export type MarketSkillCategory = 'skill' | 'knowledge' | 'tool' | 'technology' | 'ability' | 'unknown';

export type OccupationInsightResponse = {
  query: {
    keyword: string;
    location: string;
  };
  occupation: {
    onetCode: string | null;
    socCode: string | null;
    title: string;
    description: string | null;
    matchConfidence: 'high' | 'medium' | 'low';
  };
  salary: MarketSalaryRange | null;
  outlook: {
    growthLabel: string | null;
    projectedOpenings: number | null;
    projectionYears: string | null;
    demandLabel: 'high' | 'moderate' | 'low' | 'unknown';
  };
  skills: Array<{
    name: string;
    category: MarketSkillCategory;
    sourceProvider: MarketSourceProvider;
  }>;
  labels: {
    marketScore: 'strong market' | 'steady market' | 'niche market' | 'limited data';
    salaryVisibility: 'posted' | 'not_disclosed' | 'market_estimate' | 'unavailable';
  };
  sources: MarketSource[];
};

export type OccupationInsightRequest = {
  keyword: string;
  location: string;
  refresh?: boolean;
};
