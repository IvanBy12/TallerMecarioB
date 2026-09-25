/**
 * Clerk runtime configuration (ADR-006). Values are read from the environment
 * only; nothing here is ever logged. Error messages name the variable, never
 * its value.
 *
 *   CLERK_SECRET_KEY                 Backend API (profile / lifecycle fetch)
 *   CLERK_PUBLISHABLE_KEY            (falls back to NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
 *   CLERK_JWT_KEY                    PEM public key: networkless session verification
 *   CLERK_AUTHORIZED_PARTIES         comma-separated frontend origins (azp allowlist)
 *   CLERK_ISSUER_URL                 optional; defaults to https://<frontend API of the publishable key>
 *   CLERK_WEBHOOK_SIGNING_SECRET     Svix signing secret (API webhook route only)
 *   CLERK_BACKEND_API_TIMEOUT_MS     optional; finite Backend API timeout (default 5000)
 */

export class ClerkConfigurationError extends Error {
  constructor(readonly variable: string, reason: string) {
    super(`CLERK_CONFIGURATION_INVALID ${variable}: ${reason}`);
    this.name = 'ClerkConfigurationError';
  }
}

export interface ClerkAuthenticationConfig {
  readonly secretKey: string;
  readonly publishableKey: string;
  readonly jwtKey: string;
  readonly authorizedParties: readonly string[];
  readonly issuer: string;
  readonly backendApiTimeoutMs: number;
}

export interface ClerkBackendConfig {
  readonly secretKey: string;
  readonly backendApiTimeoutMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_BACKEND_API_TIMEOUT_MS = 5000;
const MAX_BACKEND_API_TIMEOUT_MS = 30_000;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ClerkConfigurationError(name, 'is required');
  }
  return value.trim();
}

function secretKeyFrom(env: Environment): string {
  const secretKey = required(env, 'CLERK_SECRET_KEY');
  if (!/^sk_(test|live)_\S+$/u.test(secretKey)) {
    throw new ClerkConfigurationError('CLERK_SECRET_KEY', 'has an unexpected format');
  }
  return secretKey;
}

function timeoutFrom(env: Environment): number {
  const raw = env.CLERK_BACKEND_API_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BACKEND_API_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > MAX_BACKEND_API_TIMEOUT_MS) {
    throw new ClerkConfigurationError('CLERK_BACKEND_API_TIMEOUT_MS', `must be an integer in 1..${MAX_BACKEND_API_TIMEOUT_MS}`);
  }
  return value;
}

/**
 * Clerk publishable keys are `pk_(test|live)_<base64(frontendApiHost + '$')>`.
 * Returns the https issuer the instance's session tokens carry in `iss`.
 */
export function issuerFromPublishableKey(publishableKey: string): string {
  const match = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/u.exec(publishableKey);
  if (!match) throw new ClerkConfigurationError('CLERK_PUBLISHABLE_KEY', 'has an unexpected format');
  const decoded = Buffer.from(match[2], 'base64').toString('utf8');
  if (!decoded.endsWith('$')) throw new ClerkConfigurationError('CLERK_PUBLISHABLE_KEY', 'has an unexpected format');
  const host = decoded.slice(0, -1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(host)) {
    throw new ClerkConfigurationError('CLERK_PUBLISHABLE_KEY', 'does not encode a frontend API host');
  }
  return `https://${host.toLowerCase()}`;
}

function normalizeIssuer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ClerkConfigurationError('CLERK_ISSUER_URL', 'must be an absolute https URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ClerkConfigurationError('CLERK_ISSUER_URL', 'must be an https origin');
  }
  return url.origin;
}

/**
 * Explicit origin allowlist for the `azp` claim. `*`, paths, credentials and
 * non-http(s) schemes are rejected; the list must not be empty.
 */
export function parseAuthorizedParties(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ClerkConfigurationError('CLERK_AUTHORIZED_PARTIES', 'is required');
  }
  const parties = raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
  if (parties.length === 0) throw new ClerkConfigurationError('CLERK_AUTHORIZED_PARTIES', 'is required');
  const origins = parties.map((party) => {
    if (party.includes('*')) throw new ClerkConfigurationError('CLERK_AUTHORIZED_PARTIES', 'wildcards are not allowed');
    let url: URL;
    try {
      url = new URL(party);
    } catch {
      throw new ClerkConfigurationError('CLERK_AUTHORIZED_PARTIES', 'entries must be origins');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '') || party.endsWith('/')) {
      throw new ClerkConfigurationError('CLERK_AUTHORIZED_PARTIES', 'entries must be bare http(s) origins');
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function jwtKeyFrom(env: Environment): string {
  // .env files commonly carry the PEM with literal "\n" sequences.
  const jwtKey = required(env, 'CLERK_JWT_KEY').replace(/\\n/gu, '\n').trim();
  if (!/^-----BEGIN PUBLIC KEY-----\s[\s\S]+\s-----END PUBLIC KEY-----$/u.test(jwtKey)) {
    throw new ClerkConfigurationError('CLERK_JWT_KEY', 'must be a PEM public key');
  }
  return jwtKey;
}

export function loadClerkAuthenticationConfig(env: Environment = process.env): ClerkAuthenticationConfig {
  const secretKey = secretKeyFrom(env);
  const publishableKey = (env.CLERK_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').trim();
  if (publishableKey === '') throw new ClerkConfigurationError('CLERK_PUBLISHABLE_KEY', 'is required');
  const derivedIssuer = issuerFromPublishableKey(publishableKey);
  const issuer = env.CLERK_ISSUER_URL && env.CLERK_ISSUER_URL.trim() !== ''
    ? normalizeIssuer(env.CLERK_ISSUER_URL.trim())
    : derivedIssuer;
  return Object.freeze({
    secretKey,
    publishableKey,
    jwtKey: jwtKeyFrom(env),
    authorizedParties: Object.freeze(parseAuthorizedParties(env.CLERK_AUTHORIZED_PARTIES)),
    issuer,
    backendApiTimeoutMs: timeoutFrom(env),
  });
}

export function loadClerkBackendConfig(env: Environment = process.env): ClerkBackendConfig {
  return Object.freeze({ secretKey: secretKeyFrom(env), backendApiTimeoutMs: timeoutFrom(env) });
}

export function loadClerkWebhookSigningSecret(env: Environment = process.env): string {
  const secret = required(env, 'CLERK_WEBHOOK_SIGNING_SECRET');
  if (!/^whsec_[A-Za-z0-9+/=]+$/u.test(secret)) {
    throw new ClerkConfigurationError('CLERK_WEBHOOK_SIGNING_SECRET', 'has an unexpected format');
  }
  return secret;
}

/** True when any Clerk variable is present: then the full config is mandatory (fail closed). */
export function clerkConfigured(env: Environment = process.env): boolean {
  return ['CLERK_SECRET_KEY', 'CLERK_JWT_KEY', 'CLERK_AUTHORIZED_PARTIES', 'CLERK_WEBHOOK_SIGNING_SECRET']
    .some((name) => typeof env[name] === 'string' && env[name]!.trim() !== '');
}
