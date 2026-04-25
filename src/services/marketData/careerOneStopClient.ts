import { env } from '../../config/env.js';
import { codeForHttpStatus, MarketProviderError } from './providerErrors.js';

type FetchLike = typeof fetch;

export type CareerOneStopWageEntry = {
  RateType?: string;
  Pct10?: string;
  Pct25?: string;
  Median?: string;
  Pct75?: string;
  Pct90?: string;
  AreaName?: string;
};

export type CareerOneStopOccupationDetail = {
  OnetTitle?: string;
  OnetCode?: string;
  OnetDescription?: string | null;
  Wages?: {
    NationalWagesList?: CareerOneStopWageEntry[];
    StateWagesList?: CareerOneStopWageEntry[];
    BLSAreaWagesList?: CareerOneStopWageEntry[];
    WageYear?: string;
    SocWageInfo?: {
      SocCode?: string;
      SocTitle?: string;
      SocDescription?: string | null;
    };
  };
  BrightOutlook?: string | null;
  BrightOutlookCategory?: string | null;
  SocInfo?: {
    SocCode?: string;
    SocTitle?: string;
    SocDescription?: string | null;
  };
  Projections?: {
    EstimatedYear?: string;
    ProjectedYear?: string;
    Projections?: Array<{
      StateName?: string;
      ProjectedAnnualJobOpening?: string;
      PerCentChange?: string;
      EstimatedYear?: string;
      ProjectedYear?: string;
    }>;
  };
  SkillsDataList?: Array<{
    ElementName?: string;
    ElementDescription?: string;
  }>;
};

export type CareerOneStopMetadata = {
  LastAccessDate?: string;
  CitationSuggested?: string;
  DataSource?: Array<{
    DataName?: string;
    DataSourceName?: string;
    DataSourceUrl?: string;
    DataSourceCitation?: string;
  }>;
};

export type CareerOneStopOccupationResponse = {
  OccupationDetail?: CareerOneStopOccupationDetail[] | CareerOneStopOccupationDetail;
  RecordCount?: number;
  MetaData?: CareerOneStopMetadata;
};

export type CareerOneStopClientConfig = {
  baseUrl: string;
  userId?: string;
  token?: string;
  timeoutMs: number;
  fetchFn: FetchLike;
};

export function createCareerOneStopClient(config: Partial<CareerOneStopClientConfig> = {}) {
  const clientConfig: CareerOneStopClientConfig = {
    baseUrl: config.baseUrl ?? env.CAREERONESTOP_BASE_URL,
    userId: config.userId ?? env.CAREERONESTOP_USER_ID,
    token: config.token ?? env.CAREERONESTOP_TOKEN,
    timeoutMs: config.timeoutMs ?? env.CAREERONESTOP_REQUEST_TIMEOUT_MS,
    fetchFn: config.fetchFn ?? fetch,
  };

  const fetchOccupation = async (input: { keyword: string; location: string }) => {
    const userId = clientConfig.userId?.trim();
    const token = clientConfig.token?.trim();
    if (!userId || !token) {
      throw new MarketProviderError(
        'market_provider_unconfigured',
        'CareerOneStop credentials are not configured',
        503,
      );
    }

    const url = new URL(
      `v1/occupation/${encodeURIComponent(userId)}/${encodeURIComponent(input.keyword)}/${encodeURIComponent(input.location)}`,
      `${clientConfig.baseUrl.replace(/\/+$/, '')}/`,
    );
    url.searchParams.set('wages', 'true');
    url.searchParams.set('projectedEmployment', 'true');
    url.searchParams.set('skills', 'true');
    url.searchParams.set('enableMetaData', 'true');

    let response: Response;
    try {
      response = await clientConfig.fetchFn(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(clientConfig.timeoutMs),
      });
    } catch (error) {
      const code = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'market_provider_timeout'
        : 'market_provider_unavailable';
      throw new MarketProviderError(code, 'CareerOneStop request failed', 502, null);
    }

    const rawText = await response.text();
    const payload = parseJson(rawText);
    if (!response.ok) {
      throw new MarketProviderError(
        codeForHttpStatus(response.status),
        'CareerOneStop upstream request failed',
        response.status,
        payload,
      );
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new MarketProviderError(
        'market_provider_invalid_payload',
        'CareerOneStop returned an invalid payload',
        502,
        payload,
      );
    }

    return payload as CareerOneStopOccupationResponse;
  };

  return { fetchOccupation };
}

function parseJson(input: string) {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return { raw: input };
  }
}
