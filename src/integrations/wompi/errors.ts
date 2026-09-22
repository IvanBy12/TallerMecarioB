export type WompiErrorCategory = 'network' | 'timeout' | 'rate_limit' | 'provider' | 'functional' | 'contract';

export class WompiAdapterError extends Error {
  readonly code: string;
  readonly category: WompiErrorCategory;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(options: {
    code: string;
    category: WompiErrorCategory;
    retryable: boolean;
    httpStatus?: number;
    retryAfterMs?: number;
  }) {
    super(options.code);
    this.name = 'WompiAdapterError';
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}
