import {
  assertNoRawPaymentInstrument,
  wompiWebhookSchema,
  type WompiWebhook,
} from './contracts.js';
import { constantTimeEqualHex, createWebhookChecksum, sha256Hex } from './crypto.js';

export type WompiWebhookRejection = 'payload' | 'signature' | 'environment';

export class WompiWebhookError extends Error {
  constructor(readonly reason: WompiWebhookRejection) {
    super(`WOMPI_WEBHOOK_${reason.toUpperCase()}_INVALID`);
    this.name = 'WompiWebhookError';
  }
}

export interface VerifiedWompiWebhook {
  event: WompiWebhook;
  payloadHash: string;
  providerEventId: string;
  headerChecksum: string;
}

export function verifyWompiWebhook(input: {
  rawBody: Buffer;
  headerChecksum: string | undefined;
  eventSecret: string;
  expectedEnvironment: 'test' | 'production';
}): VerifiedWompiWebhook {
  if (!input.headerChecksum) throw new WompiWebhookError('signature');
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    throw new WompiWebhookError('payload');
  }
  const parsed = wompiWebhookSchema.safeParse(decoded);
  if (!parsed.success) throw new WompiWebhookError('payload');
  try {
    assertNoRawPaymentInstrument(parsed.data);
  } catch {
    throw new WompiWebhookError('payload');
  }

  const expectedProviderEnvironment = input.expectedEnvironment === 'test' ? 'test' : 'prod';
  if (parsed.data.environment !== expectedProviderEnvironment) throw new WompiWebhookError('environment');

  let calculated: string;
  try {
    calculated = createWebhookChecksum(parsed.data, input.eventSecret);
  } catch {
    throw new WompiWebhookError('signature');
  }
  if (!constantTimeEqualHex(calculated, input.headerChecksum)
    || !constantTimeEqualHex(calculated, parsed.data.signature.checksum)) {
    throw new WompiWebhookError('signature');
  }
  const payloadHash = sha256Hex(input.rawBody);
  return {
    event: parsed.data,
    payloadHash,
    providerEventId: sha256Hex(`wompi|${payloadHash}`),
    headerChecksum: input.headerChecksum.toLowerCase(),
  };
}
