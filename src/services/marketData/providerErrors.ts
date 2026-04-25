export type MarketProviderErrorCode =
  | 'market_provider_unconfigured'
  | 'market_provider_timeout'
  | 'market_provider_unauthorized'
  | 'market_provider_rate_limited'
  | 'market_provider_unavailable'
  | 'market_provider_invalid_payload'
  | 'market_no_match';

export class MarketProviderError extends Error {
  code: MarketProviderErrorCode;
  status: number;
  payload: unknown;

  constructor(code: MarketProviderErrorCode, message: string, status: number, payload: unknown = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

export function statusForMarketProviderError(error: MarketProviderError) {
  switch (error.code) {
    case 'market_provider_unconfigured':
      return 503;
    case 'market_provider_unauthorized':
      return 502;
    case 'market_provider_rate_limited':
      return 429;
    case 'market_no_match':
      return 404;
    case 'market_provider_timeout':
    case 'market_provider_unavailable':
    case 'market_provider_invalid_payload':
      return 502;
  }
}

export function codeForHttpStatus(status: number): MarketProviderErrorCode {
  if (status === 401 || status === 403) return 'market_provider_unauthorized';
  if (status === 429) return 'market_provider_rate_limited';
  return 'market_provider_unavailable';
}
