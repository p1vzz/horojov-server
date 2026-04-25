import { env } from '../../config/env.js';
import { codeForHttpStatus, MarketProviderError } from './providerErrors.js';

type FetchLike = typeof fetch;

export type OnetSearchOccupation = {
  href?: string;
  code?: string;
  title?: string;
  tags?: {
    bright_outlook?: boolean;
  };
};

export type OnetSearchResponse = {
  start?: number;
  end?: number;
  total?: number;
  next?: string;
  occupation?: OnetSearchOccupation[];
};

export type OnetClientConfig = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetchFn: FetchLike;
};

export function createOnetClient(config: Partial<OnetClientConfig> = {}) {
  const clientConfig: OnetClientConfig = {
    baseUrl: config.baseUrl ?? env.ONET_BASE_URL,
    apiKey: config.apiKey ?? env.EFFECTIVE_ONET_API_KEY,
    timeoutMs: config.timeoutMs ?? env.ONET_REQUEST_TIMEOUT_MS,
    fetchFn: config.fetchFn ?? fetch,
  };

  const searchOccupations = async (input: { keyword: string }) => {
    const apiKey = clientConfig.apiKey?.trim();
    if (!apiKey) {
      throw new MarketProviderError('market_provider_unconfigured', 'O*NET API key is not configured', 503);
    }

    const url = new URL('online/search', `${clientConfig.baseUrl.replace(/\/+$/, '')}/`);
    url.searchParams.set('keyword', input.keyword);

    let response: Response;
    try {
      response = await clientConfig.fetchFn(url, {
        headers: {
          Accept: 'application/json',
          'X-API-Key': apiKey,
        },
        signal: AbortSignal.timeout(clientConfig.timeoutMs),
      });
    } catch (error) {
      const code = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'market_provider_timeout'
        : 'market_provider_unavailable';
      throw new MarketProviderError(code, 'O*NET request failed', 502, null);
    }

    const rawText = await response.text();
    const payload = parseJson(rawText);
    if (!response.ok) {
      throw new MarketProviderError(
        codeForHttpStatus(response.status),
        'O*NET upstream request failed',
        response.status,
        payload,
      );
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new MarketProviderError('market_provider_invalid_payload', 'O*NET returned an invalid payload', 502, payload);
    }

    return payload as OnetSearchResponse;
  };

  return { searchOccupations };
}

function parseJson(input: string) {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return { raw: input };
  }
}
