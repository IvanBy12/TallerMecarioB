import { setTimeout as delay } from 'node:timers/promises';
import type { ZodType } from 'zod';
import {
  assertNoRawPaymentInstrument,
  normalizeWompiTransaction,
  wompiMerchantResponseSchema,
  wompiPaymentSourceResponseSchema,
  wompiTransactionResponseSchema,
  type NormalizedWompiTransaction,
} from './contracts.js';
import { createTransactionIntegritySignature } from './crypto.js';
import { WompiAdapterError } from './errors.js';

export interface WompiAdapterConfig {
  environment: 'test' | 'production';
  baseUrl: string;
  privateKey: string;
  publicKey?: string;
  integritySecret: string;
  maxAttempts?: number;
  timeoutMs?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  allowCustomBaseUrl?: boolean;
}

export interface CreatePaymentSourceInput {
  type: 'CARD' | 'NEQUI';
  token: string;
  customerEmail: string;
  acceptanceToken: string;
  personalDataAuthToken?: string;
}

export interface CreateTransactionInput {
  acceptanceToken: string;
  personalDataAuthToken?: string;
  amountMinor: number;
  currency: 'COP';
  customerEmail: string;
  paymentMethod: Record<string, unknown>;
  paymentMethodType?: string;
  reference: string;
  paymentSourceId?: string | number;
  recurrent?: boolean;
}

export interface AcceptanceTokens {
  acceptanceToken: string;
  personalDataAuthToken?: string;
}

/** Mockable provider boundary consumed by billing/outbox code. */
export interface WompiProvider {
  getAcceptanceTokens(): Promise<AcceptanceTokens>;
  createPaymentSource(input: CreatePaymentSourceInput): Promise<{ id: string; status?: string }>;
  createTransaction(input: CreateTransactionInput): Promise<NormalizedWompiTransaction>;
  getTransaction(providerTransactionId: string): Promise<NormalizedWompiTransaction>;
}

type FetchLike = typeof fetch;
type Sleep = (milliseconds: number) => Promise<unknown>;

function validateConfig(config: WompiAdapterConfig): void {
  const url = new URL(config.baseUrl);
  const expectedHost = config.environment === 'test' ? 'sandbox.wompi.co' : 'production.wompi.co';
  if (!config.allowCustomBaseUrl && (url.protocol !== 'https:' || url.hostname !== expectedHost)) {
    throw new Error('WOMPI_ENVIRONMENT_BASE_URL_MISMATCH');
  }
  const expectedKeyPrefix = config.environment === 'test' ? 'prv_test_' : 'prv_prod_';
  const expectedIntegrityPrefix = config.environment === 'test' ? 'test_integrity_' : 'prod_integrity_';
  if (!config.privateKey.startsWith(expectedKeyPrefix)) throw new Error('WOMPI_PRIVATE_KEY_ENVIRONMENT_MISMATCH');
  if (!config.integritySecret.startsWith(expectedIntegrityPrefix)) {
    throw new Error('WOMPI_INTEGRITY_SECRET_ENVIRONMENT_MISMATCH');
  }
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function normalizePaymentSourceId(value: string | number): number {
  let normalized: number;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) throw new Error('WOMPI_PAYMENT_SOURCE_ID_INVALID');
    normalized = Number(value);
  } else {
    normalized = value;
  }
  if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new Error('WOMPI_PAYMENT_SOURCE_ID_INVALID');
  return normalized;
}

export class WompiAdapter implements WompiProvider {
  readonly config: Required<Pick<WompiAdapterConfig,
    'maxAttempts' | 'timeoutMs' | 'baseRetryDelayMs' | 'maxRetryDelayMs'>> & WompiAdapterConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly random: () => number;

  constructor(
    config: WompiAdapterConfig,
    dependencies: { fetch?: FetchLike; sleep?: Sleep; random?: () => number } = {},
  ) {
    validateConfig(config);
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      maxAttempts: config.maxAttempts ?? 4,
      timeoutMs: config.timeoutMs ?? 8_000,
      baseRetryDelayMs: config.baseRetryDelayMs ?? 250,
      maxRetryDelayMs: config.maxRetryDelayMs ?? 10_000,
    };
    if (this.config.maxAttempts < 1 || this.config.maxAttempts > 10) throw new Error('WOMPI_MAX_ATTEMPTS_INVALID');
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.sleep = dependencies.sleep ?? delay;
    this.random = dependencies.random ?? Math.random;
  }

  async getAcceptanceTokens(): Promise<AcceptanceTokens> {
    if (!this.config.publicKey) throw new Error('WOMPI_PUBLIC_KEY_REQUIRED');
    const response = await this.request('GET', `/merchants/${encodeURIComponent(this.config.publicKey)}`, undefined,
      wompiMerchantResponseSchema, false);
    return {
      acceptanceToken: response.data.presigned_acceptance.acceptance_token,
      personalDataAuthToken: response.data.presigned_personal_data_auth?.acceptance_token,
    };
  }

  async createPaymentSource(input: CreatePaymentSourceInput): Promise<{ id: string; status?: string }> {
    assertNoRawPaymentInstrument(input);
    const payload = {
      type: input.type,
      token: input.token,
      customer_email: input.customerEmail,
      acceptance_token: input.acceptanceToken,
      ...(input.personalDataAuthToken ? { accept_personal_auth: input.personalDataAuthToken } : {}),
    };
    const response = await this.request('POST', '/payment_sources', payload, wompiPaymentSourceResponseSchema, true);
    return { id: String(response.data.id), status: response.data.status };
  }

  async createTransaction(input: CreateTransactionInput): Promise<NormalizedWompiTransaction> {
    assertNoRawPaymentInstrument(input);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('WOMPI_AMOUNT_INVALID');
    const signature = createTransactionIntegritySignature({
      reference: input.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      integritySecret: this.config.integritySecret,
    });
    const payload = {
      acceptance_token: input.acceptanceToken,
      ...(input.personalDataAuthToken ? { accept_personal_auth: input.personalDataAuthToken } : {}),
      amount_in_cents: input.amountMinor,
      currency: input.currency,
      customer_email: input.customerEmail,
      payment_method: input.paymentMethod,
      ...(input.paymentMethodType ? { payment_method_type: input.paymentMethodType } : {}),
      reference: input.reference,
      signature,
      ...(input.paymentSourceId === undefined ? {} : { payment_source_id: normalizePaymentSourceId(input.paymentSourceId) }),
      ...(input.recurrent === undefined ? {} : { recurrent: input.recurrent }),
    };
    const response = await this.request('POST', '/transactions', payload, wompiTransactionResponseSchema, true);
    return normalizeWompiTransaction(response.data);
  }

  async getTransaction(providerTransactionId: string): Promise<NormalizedWompiTransaction> {
    if (!providerTransactionId || providerTransactionId.length > 255) throw new Error('WOMPI_TRANSACTION_ID_INVALID');
    const response = await this.request('GET', `/transactions/${encodeURIComponent(providerTransactionId)}`,
      undefined, wompiTransactionResponseSchema, false);
    return normalizeWompiTransaction(response.data);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    responseSchema: ZodType<T>,
    usePrivateKey: boolean,
  ): Promise<T> {
    let lastError: WompiAdapterError | undefined;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            ...(usePrivateKey ? { authorization: `Bearer ${this.config.privateKey}` } : {}),
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          const retryable = response.status === 429 || response.status >= 500;
          throw new WompiAdapterError({
            code: response.status === 429 ? 'WOMPI_RATE_LIMITED'
              : response.status === 422 ? 'WOMPI_VALIDATION_REJECTED'
                : response.status >= 500 ? 'WOMPI_PROVIDER_UNAVAILABLE' : 'WOMPI_REQUEST_REJECTED',
            category: response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'provider' : 'functional',
            retryable,
            httpStatus: response.status,
            retryAfterMs,
          });
        }
        let decoded: unknown;
        try {
          decoded = await response.json();
        } catch {
          throw new WompiAdapterError({ code: 'WOMPI_RESPONSE_INVALID', category: 'contract', retryable: false });
        }
        const parsed = responseSchema.safeParse(decoded);
        if (!parsed.success) {
          throw new WompiAdapterError({ code: 'WOMPI_RESPONSE_INVALID', category: 'contract', retryable: false });
        }
        return parsed.data;
      } catch (error) {
        if (error instanceof WompiAdapterError) lastError = error;
        else if (controller.signal.aborted) {
          lastError = new WompiAdapterError({ code: 'WOMPI_TIMEOUT', category: 'timeout', retryable: true });
        } else lastError = new WompiAdapterError({ code: 'WOMPI_NETWORK_ERROR', category: 'network', retryable: true });
      } finally {
        clearTimeout(timeout);
      }
      if (!lastError.retryable || attempt === this.config.maxAttempts) throw lastError;
      const exponential = this.config.baseRetryDelayMs * (2 ** (attempt - 1));
      const jittered = exponential * (0.5 + this.random() * 0.5);
      await this.sleep(Math.min(lastError.retryAfterMs ?? jittered, this.config.maxRetryDelayMs));
    }
    throw lastError ?? new WompiAdapterError({ code: 'WOMPI_REQUEST_FAILED', category: 'provider', retryable: false });
  }
}
