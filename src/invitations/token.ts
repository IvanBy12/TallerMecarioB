import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * S1-04 invitation token material.
 *
 * The raw token is never persisted in any form (ERD: "el token crudo ... nunca
 * se guarda"; Security Baseline: approval/magic tokens are never stored as a
 * reversible value). The email is sent asynchronously by the worker (ADR-004),
 * so the worker must be able to reproduce the exact token without it being
 * stored, and every retry must reproduce the SAME token:
 *
 *   nonce  = 256 bits from the CSPRNG, stored only in the outbox payload
 *   token  = base64url(HMAC-SHA256(server secret, domain || invitation id || nonce))
 *   stored = token_hash = hex(SHA-256(token))           (membership_invitations)
 *
 * A database-only leak yields a nonce and a hash (no token). The server secret
 * alone yields nothing without the nonce. The token is a 256-bit PRF output
 * keyed by a secret the database never sees: unpredictable, URL-safe, 43
 * characters.
 */

export const INVITATION_TOKEN_KEY_VERSION = 1;
const TOKEN_DOMAIN = 'tallermecario.membership_invitation.token.v1';

/** base64url of 32 bytes, no padding. */
export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export interface InvitationTokenKey {
  readonly version: number;
  readonly secret: Buffer;
}

export const MIN_TOKEN_SECRET_BYTES = 32;

export function createInvitationTokenKey(secret: Buffer, version = INVITATION_TOKEN_KEY_VERSION): InvitationTokenKey {
  if (!Buffer.isBuffer(secret) || secret.length < MIN_TOKEN_SECRET_BYTES) {
    throw new Error('MEMBERSHIP_INVITATION_TOKEN_SECRET_INVALID');
  }
  return Object.freeze({ version, secret: Buffer.from(secret) });
}

export function newInvitationTokenNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function isInvitationTokenNonce(value: unknown): value is string {
  return typeof value === 'string' && INVITATION_TOKEN_PATTERN.test(value);
}

export function deriveInvitationToken(key: InvitationTokenKey, invitationId: string, nonce: string): string {
  if (!isInvitationTokenNonce(nonce)) throw new Error('INVITATION_TOKEN_NONCE_INVALID');
  return createHmac('sha256', key.secret)
    .update(`${TOKEN_DOMAIN}\u0000${invitationId}\u0000${nonce}`)
    .digest('base64url');
}

export function isInvitationTokenFormat(value: unknown): value is string {
  return typeof value === 'string' && INVITATION_TOKEN_PATTERN.test(value);
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of a token against a stored hash. */
export function invitationTokenMatchesHash(token: string, storedHash: string): boolean {
  if (!isInvitationTokenFormat(token) || typeof storedHash !== 'string' || !TOKEN_HASH_PATTERN.test(storedHash)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(hashInvitationToken(token), 'hex'), Buffer.from(storedHash, 'hex'));
}

/**
 * Link delivered by email. The token travels in the URL FRAGMENT: browsers
 * never send it to the PWA host (static hosting/CDN logs) and never put it in
 * a Referer header. The PWA reads it client-side and POSTs it to
 * /api/v1/membership-invitations/accept.
 */
export function invitationAcceptUrl(acceptBaseUrl: string, token: string): string {
  const url = new URL(acceptBaseUrl);
  url.hash = `token=${token}`;
  return url.toString();
}
