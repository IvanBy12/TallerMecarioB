/**
 * ADR-006 ClerkIdentityProvider. The ONLY module (with ./webhook.ts) allowed to
 * import the Clerk SDK; the rest of the application sees the provider-neutral
 * contracts in ../identity-provider.ts.
 *
 *   verifyRequest        per-request hot path. Networkless: session token in
 *                        `Authorization: Bearer` verified with the instance PEM
 *                        (`jwtKey`), `authorizedParties` (azp allowlist) and
 *                        `acceptsToken: 'session_token'`, then an explicit `iss`
 *                        check (the SDK has no issuer option). Cookies are never
 *                        forwarded to the SDK, so its cookie/handshake/refresh
 *                        paths (which can reach the network) are unreachable.
 *   getIdentityProfile   opt-in only (onboarding); ONE Backend API getUser with
 *                        a finite timeout.
 *   fetchIdentitySnapshot  lifecycle worker (fetch-on-process), same reader.
 *
 * Only `sub` leaves this module as identity. Session claims, metadata,
 * organizations, roles and permissions are never returned.
 */

import { createClerkClient, type ClerkClient } from '@clerk/backend';
import type { FastifyRequest } from 'fastify';
import {
  IdentityProfileNotFoundError,
  IdentityProviderRequestError,
  IdentityProviderUnavailableError,
  type IdentityLifecycleSnapshot,
  type IdentityProvider,
  type IdentitySnapshotSource,
  type VerifiedIdentity,
  type VerifiedIdentityProfile,
} from '../identity-provider.js';
import type { ClerkAuthenticationConfig, ClerkBackendConfig } from './config.js';

export const CLERK_IDENTITY_PROVIDER = 'clerk';

/* -------------------------------------------------------------------------- */
/* Backend API reader (the only network path)                                 */
/* -------------------------------------------------------------------------- */

/** Minimal structural view of the SDK `User` this module reads. */
export interface ClerkUserRecord {
  readonly id: string;
  readonly primaryEmailAddressId: string | null;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
    readonly verification: { readonly status: string } | null;
  }[];
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly banned: boolean;
  readonly locked: boolean;
}

/** Port over `clerkClient.users.getUser`; tests inject a fake. */
export interface ClerkUsersApi {
  getUser(userId: string): Promise<ClerkUserRecord>;
}

export type ClerkUserLookup =
  | { readonly kind: 'found'; readonly user: ClerkUserRecord }
  | { readonly kind: 'not_found' };

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Backend API call with a finite timeout (the SDK exposes neither a timeout
 * nor an AbortSignal for getUser, so the wait is bounded here). Outcome
 * classification: 404 -> not_found; timeout / network / 408 / 429 / 5xx /
 * 401 / 403 (provider-side auth or config) -> retryable unavailable; any
 * other 4xx -> permanent request error.
 */
export class ClerkUserReader {
  constructor(private readonly usersApi: ClerkUsersApi, private readonly timeoutMs: number) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('CLERK_TIMEOUT_INVALID');
  }

  async lookup(userId: string): Promise<ClerkUserLookup> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new IdentityProviderUnavailableError('timeout')), this.timeoutMs);
      timer.unref?.();
    });
    try {
      const user = await Promise.race([this.usersApi.getUser(userId), timeout]);
      if (!user || typeof user.id !== 'string' || user.id !== userId) {
        throw new IdentityProviderRequestError('unexpected_user');
      }
      return { kind: 'found', user };
    } catch (error) {
      if (error instanceof IdentityProviderUnavailableError || error instanceof IdentityProviderRequestError) throw error;
      const status = statusOf(error);
      if (status === 404) return { kind: 'not_found' };
      if (status === undefined || status === 408 || status === 429 || status >= 500 || status === 401 || status === 403) {
        throw new IdentityProviderUnavailableError(status === undefined ? 'network' : `http_${status}`);
      }
      throw new IdentityProviderRequestError(`http_${status}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * PRIMARY email (by `primaryEmailAddressId`, never `emailAddresses[0]`) and
 * whether that exact address is verified. Returns null when there is no
 * primary address.
 */
export function primaryEmailOf(user: ClerkUserRecord): { address: string; verified: boolean } | null {
  if (typeof user.primaryEmailAddressId !== 'string' || user.primaryEmailAddressId === '') return null;
  const primary = user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId);
  if (!primary || typeof primary.emailAddress !== 'string') return null;
  return { address: primary.emailAddress, verified: primary.verification?.status === 'verified' };
}

/** Raw display name as Clerk composes it (first + last); callers sanitize. */
export function rawFullNameOf(user: ClerkUserRecord): string | null {
  const parts = [user.firstName, user.lastName].filter((part): part is string => typeof part === 'string');
  const joined = parts.join(' ').trim();
  return joined === '' ? null : joined;
}

export function toLifecycleSnapshot(lookup: ClerkUserLookup): IdentityLifecycleSnapshot {
  if (lookup.kind === 'not_found') return { kind: 'not_found' };
  const email = primaryEmailOf(lookup.user);
  return {
    kind: 'found',
    verifiedPrimaryEmail: email?.verified ? email.address : null,
    fullName: rawFullNameOf(lookup.user),
    banned: lookup.user.banned === true,
    locked: lookup.user.locked === true,
  };
}

function sdkUsersApi(client: ClerkClient): ClerkUsersApi {
  return { getUser: (userId) => client.users.getUser(userId) };
}

/* -------------------------------------------------------------------------- */
/* Request authentication (networkless)                                       */
/* -------------------------------------------------------------------------- */

/** Minimal structural view of `clerkClient.authenticateRequest`. */
export interface ClerkRequestAuthenticator {
  authenticateRequest(request: Request, options: {
    jwtKey: string;
    authorizedParties: string[];
    acceptsToken: 'session_token';
  }): Promise<{
    isAuthenticated: boolean;
    tokenType: string | null;
    toAuth: () => unknown;
  }>;
}

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/u;
const MAX_TOKEN_LENGTH = 8192;

function bearerTokenOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 7) return null;
  const match = BEARER.exec(header);
  return match ? match[1] : null;
}

export interface ClerkIdentityProviderDependencies {
  /** Defaults to the SDK client built from the config. */
  readonly authenticator?: ClerkRequestAuthenticator;
  readonly usersApi?: ClerkUsersApi;
}

export class ClerkIdentityProvider implements IdentityProvider {
  private readonly authenticator: ClerkRequestAuthenticator;
  private readonly reader: ClerkUserReader;
  private readonly authorizedParties: string[];

  constructor(private readonly config: ClerkAuthenticationConfig, dependencies: ClerkIdentityProviderDependencies = {}) {
    if (config.authorizedParties.length === 0) throw new Error('CLERK_AUTHORIZED_PARTIES_REQUIRED');
    const client = dependencies.authenticator && dependencies.usersApi
      ? undefined
      : createClerkClient({
        secretKey: config.secretKey,
        publishableKey: config.publishableKey,
        jwtKey: config.jwtKey,
        telemetry: { disabled: true },
      });
    this.authenticator = dependencies.authenticator ?? (client as unknown as ClerkRequestAuthenticator);
    this.reader = new ClerkUserReader(dependencies.usersApi ?? sdkUsersApi(client!), config.backendApiTimeoutMs);
    this.authorizedParties = [...config.authorizedParties];
  }

  async verifyRequest(request: FastifyRequest): Promise<VerifiedIdentity | null> {
    const token = bearerTokenOf(request);
    if (token === null) return null;

    // Only the Authorization header is forwarded: no cookies, so the SDK can
    // never take its cookie/handshake/refresh branches.
    const webRequest = new Request('http://api.internal/', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    const state = await this.authenticator.authenticateRequest(webRequest, {
      jwtKey: this.config.jwtKey,
      authorizedParties: this.authorizedParties,
      acceptsToken: 'session_token',
    });
    if (state.isAuthenticated !== true || state.tokenType !== 'session_token') return null;

    const auth = state.toAuth() as { userId?: unknown; sessionClaims?: Record<string, unknown> } | null;
    const claims = auth?.sessionClaims;
    const subject = claims?.sub;
    if (!claims || typeof subject !== 'string' || subject.length === 0 || subject.length > 255) return null;
    if (auth?.userId !== subject) return null;
    // Issuer pinning: a token from another Clerk instance must fail even if
    // it were ever verifiable with the configured key.
    if (claims.iss !== this.config.issuer) return null;
    if (typeof claims.azp !== 'string' || !this.authorizedParties.includes(claims.azp)) return null;

    return { identityProvider: CLERK_IDENTITY_PROVIDER, externalSubject: subject };
  }

  async getIdentityProfile(identity: VerifiedIdentity): Promise<VerifiedIdentityProfile> {
    if (identity.identityProvider !== CLERK_IDENTITY_PROVIDER) throw new IdentityProfileNotFoundError();
    const lookup = await this.reader.lookup(identity.externalSubject);
    if (lookup.kind === 'not_found') throw new IdentityProfileNotFoundError();
    const email = primaryEmailOf(lookup.user);
    return {
      email: email?.address ?? '',
      emailVerified: email?.verified === true,
      fullName: rawFullNameOf(lookup.user),
    };
  }
}

/** Worker-side snapshot source (Backend API only; no request authentication). */
export class ClerkIdentitySnapshotSource implements IdentitySnapshotSource {
  private readonly reader: ClerkUserReader;

  constructor(config: ClerkBackendConfig, dependencies: { readonly usersApi?: ClerkUsersApi } = {}) {
    const usersApi = dependencies.usersApi
      ?? sdkUsersApi(createClerkClient({ secretKey: config.secretKey, telemetry: { disabled: true } }));
    this.reader = new ClerkUserReader(usersApi, config.backendApiTimeoutMs);
  }

  async fetchIdentitySnapshot(externalSubject: string): Promise<IdentityLifecycleSnapshot> {
    return toLifecycleSnapshot(await this.reader.lookup(externalSubject));
  }
}
