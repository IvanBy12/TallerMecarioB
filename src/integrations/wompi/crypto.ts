import { createHash, timingSafeEqual } from 'node:crypto';
import type { WompiWebhook } from './contracts.js';

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createTransactionIntegritySignature(input: {
  reference: string;
  amountMinor: number;
  currency: 'COP';
  integritySecret: string;
}): string {
  return sha256Hex(`${input.reference}${input.amountMinor}${input.currency}${input.integritySecret}`);
}

function resolveSignedProperty(data: Record<string, unknown>, path: string): string {
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (!segment || !current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error('WOMPI_SIGNATURE_PROPERTY_INVALID');
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) throw new Error('WOMPI_SIGNATURE_PROPERTY_MISSING');
    current = (current as Record<string, unknown>)[segment];
  }
  if (!['string', 'number', 'boolean'].includes(typeof current)) {
    throw new Error('WOMPI_SIGNATURE_PROPERTY_INVALID');
  }
  return String(current);
}

export function createWebhookChecksum(event: WompiWebhook, eventSecret: string): string {
  const properties = event.signature.properties.map((property) => resolveSignedProperty(event.data, property)).join('');
  return sha256Hex(`${properties}${event.timestamp}${eventSecret}`);
}

export function constantTimeEqualHex(expected: string, received: string): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(expected) || !/^[a-fA-F0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected.toLowerCase(), 'hex'), Buffer.from(received.toLowerCase(), 'hex'));
}
