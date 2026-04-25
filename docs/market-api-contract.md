# Market API Contract
**Status:** Active
**Last synced:** 2026-04-25

## Goal

Expose normalized U.S. labor market facts to Horojob clients without sending provider credentials or raw provider payloads to the browser or mobile app.

## Endpoints

### Occupation Insight

```text
GET /api/market/occupation-insight?keyword=<title-or-code>&location=<US|state|metro>&refresh=false
```

Auth:

- Requires the current app auth session.
- Anonymous app sessions are allowed.
- Raw market facts are not premium-gated.

Query:

- `keyword`: required, 2-120 chars.
- `location`: optional, default `US`, 2-80 chars.
- `refresh`: optional boolean flag, default `false`; bypasses fresh cache when true.

### Public Occupation Insight

```text
GET /api/public/market/occupation-insight?keyword=<title-or-code>&location=<US|state|metro>
```

Auth:

- No auth required.
- Intended for the public compliance web surface in `../horojob-landing`.
- Uses the same normalized provider response shape as `/api/market/occupation-insight`.
- Forces `refresh=false`; public callers cannot bypass server cache.

Query:

- `keyword`: required, 2-120 chars.
- `location`: optional, default `US`, 2-80 chars.

## Response

```ts
type OccupationInsightResponse = {
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
  salary: {
    currency: 'USD';
    period: 'annual' | 'hourly';
    min: number | null;
    max: number | null;
    median: number | null;
    year: string | null;
    confidence: 'high' | 'medium' | 'low';
    basis: 'posted_salary' | 'market_estimate';
  } | null;
  outlook: {
    growthLabel: string | null;
    projectedOpenings: number | null;
    projectionYears: string | null;
    demandLabel: 'high' | 'moderate' | 'low' | 'unknown';
  };
  skills: Array<{
    name: string;
    category: 'skill' | 'knowledge' | 'tool' | 'technology' | 'ability' | 'unknown';
    sourceProvider: 'careeronestop' | 'onet';
  }>;
  labels: {
    marketScore: 'strong market' | 'steady market' | 'niche market' | 'limited data';
    salaryVisibility: 'posted' | 'not_disclosed' | 'market_estimate' | 'unavailable';
  };
  sources: Array<{
    provider: 'careeronestop' | 'onet';
    label: string;
    url: string | null;
    retrievedAt: string;
    attributionText: string;
    logoRequired: boolean;
  }>;
};
```

## Error Contract

- `400`: invalid query, body includes `error` and `details`.
- `401`: missing or invalid app session on `/api/market/occupation-insight` only.
- `404`: no occupation match, `code=market_no_match`.
- `429`: provider rate limit, `code=market_provider_rate_limited`.
- `502`: provider unavailable, unauthorized, timeout, or invalid payload.
- `503`: provider not configured.

Error bodies include:

```ts
{
  error: string;
  code?: string;
}
```

## Providers

- CareerOneStop supplies wage, demand, projection, skill, and attribution facts.
- O*NET is used for occupation matching and source metadata when available.
- O*NET failures do not block the response if CareerOneStop can still return a matching occupation.

## Attribution

All client surfaces that display these facts must show source attribution. CareerOneStop responses set `logoRequired: true`; screens using this endpoint must render the required provider logo/copy where the market facts appear. The mobile shared `MarketSourceFooter` renders the compact CareerOneStop icon when any visible source has `provider=careeronestop` or `logoRequired=true`.

The public compliance surface now lives in `../horojob-landing`:

- route: `app/market-tools/role-outlook/page.tsx`
- backend contract: `GET /api/public/market/occupation-insight`
- env handoff: `HOROJOB_API_BASE_URL` in `../horojob-landing/.env.example`

Do not phrase Horojob or astrology recommendations as provider endorsements. Use language equivalent to:

```text
Market data provided by CareerOneStop. Horojob guidance is independently generated.
```

### Astrology Market Career Context

```text
GET /api/astrology/market-career-context
```

Auth:

- Requires the current app auth session.
- Anonymous app sessions are allowed.
- Raw market facts are not premium-gated.
- Requires a stored birth profile and generated natal chart.

Response:

```ts
type MarketCareerContext = {
  algorithmVersion: 'market_career_context.v1';
  generatedAt: string;
  location: 'US' | string;
  sourceNote: string;
  marketCareerPaths: Array<{
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
    marketGradient: 'high_upside' | 'steady_growth' | 'stable_floor' | 'niche_path' | 'limited_data';
    marketScoreLabel: string | null;
    demandLabel: string | null;
    sourceRoleTitle: string | null;
    market: OccupationInsightResponse | null;
  }>;
  negotiationPrep: {
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
};
```

Consumers:

- Natal Chart market-backed paths section.
- Dashboard free Negotiation Prep card and detail page.
- Full Career Blueprint market context and market gradients section.

Contract notes:

- Scanner/job history is intentionally not used in this endpoint.
- Provider failures degrade paths to chart-only cards with `market=null`; they should not break natal chart rendering.
- Full Natal Analysis receives a compact prompt context derived from this payload and has a prompt guard against provider endorsement language.
- Public no-login web surface is now implemented in `../horojob-landing`; remaining release work is U.S.-hosted smoke plus provider runbook documentation.
