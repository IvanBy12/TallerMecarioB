/**
 * Clerk (Svix / Standard Webhooks) verification over the EXACT signed bytes.
 *
 * `@clerk/fastify/webhooks` is deliberately not used: in the installed
 * version it rebuilds the body with `JSON.stringify(req.body)`, which changes
 * the signed bytes (whitespace, escapes, number formatting). Instead the raw
 * request buffer captured by the API's JSON parser is handed to the official
 * `@clerk/backend/webhooks` `verifyWebhook` inside a Web `Request`.
 *
 * After the signature is verified, the SAME verified bytes are parsed once
 * more to read the minimal envelope (`type`, `data.id`, `timestamp`): the SDK's
 * return value drops the event `timestamp`, which is the business ordering key.
 */

import { createHash } from 'node:crypto';
import { verifyWebhook } from '@clerk/backend/webhooks';

export const SUPPORTED_CLERK_USER_EVENTS = [
  'user.created',
  'user.updated',
  'user.deleted',
  'user.banned',
  'user.unbanned',
  'user.locked',
  'user.unlocked',
] as const;

export type ClerkUserEventType = (typeof SUPPORTED_CLERK_USER_EVENTS)[number];

export type ClerkWebhookRejection = 'signature' | 'payload';

export class ClerkWebhookError extends Error {
  constructor(readonly reason: ClerkWebhookRejection) {
    super(`CLERK_WEBHOOK_${reason.toUpperCase()}_INVALID`);
    this.name = 'ClerkWebhookError';
  }
}

export interface VerifiedClerkUserEvent {
  readonly kind: 'supported';
  /** svix-id: transport/delivery identity. Never the Clerk user id. */
  readonly providerEventId: string;
  readonly eventType: ClerkUserEventType;
  /** Clerk user id (`data.id`) = users.external_subject. */
  readonly externalSubject: string;
  /** Clerk event `timestamp` (ms since epoch): the business ordering key. */
  readonly occurredAt: Date;
  /** sha256 over the exact raw body bytes. */
  readonly payloadHash: string;
  /** Allowlisted transport metadata (never the signature). */
  readonly headers: { readonly svix_id: string; readonly svix_timestamp: string };
}

export interface IgnoredClerkEvent {
  readonly kind: 'ignored';
  readonly providerEventId: string;
}

export type VerifiedClerkWebhook = VerifiedClerkUserEvent | IgnoredClerkEvent;

type HeaderValue = string | string[] | undefined;

function singleHeader(value: HeaderValue): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const SUBJECT_PATTERN = /^user_[A-Za-z0-9]{1,250}$/u;
const SVIX_ID_PATTERN = /^[A-Za-z0-9_\-.]{1,128}$/u;

export async function verifyClerkWebhook(input: {
  rawBody: Buffer;
  headers: Readonly<Record<string, HeaderValue>>;
  signingSecret: string;
}): Promise<VerifiedClerkWebhook> {
  const svixId = singleHeader(input.headers['svix-id']);
  const svixTimestamp = singleHeader(input.headers['svix-timestamp']);
  const svixSignature = singleHeader(input.headers['svix-signature']);
  if (!svixId || !svixTimestamp || !svixSignature || !SVIX_ID_PATTERN.test(svixId)) {
    throw new ClerkWebhookError('signature');
  }

  const request = new Request('http://webhooks.internal/clerk', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    },
    body: new Uint8Array(input.rawBody),
  });
  try {
    await verifyWebhook(request, { signingSecret: input.signingSecret });
  } catch {
    throw new ClerkWebhookError('signature');
  }

  // Bytes are authentic from here on.
  let envelope: unknown;
  try {
    envelope = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    throw new ClerkWebhookError('payload');
  }
  const candidate = envelope as { type?: unknown; timestamp?: unknown; data?: { id?: unknown } | null } | null;
  if (!candidate || typeof candidate !== 'object' || typeof candidate.type !== 'string') {
    throw new ClerkWebhookError('payload');
  }
  if (!(SUPPORTED_CLERK_USER_EVENTS as readonly string[]).includes(candidate.type)) {
    return { kind: 'ignored', providerEventId: svixId };
  }

  const subject = candidate.data && typeof candidate.data === 'object' ? candidate.data.id : undefined;
  const timestamp = candidate.timestamp;
  if (typeof subject !== 'string' || !SUBJECT_PATTERN.test(subject)
    || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new ClerkWebhookError('payload');
  }
  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) throw new ClerkWebhookError('payload');

  return {
    kind: 'supported',
    providerEventId: svixId,
    eventType: candidate.type as ClerkUserEventType,
    externalSubject: subject,
    occurredAt,
    payloadHash: createHash('sha256').update(input.rawBody).digest('hex'),
    headers: { svix_id: svixId, svix_timestamp: svixTimestamp },
  };
}
