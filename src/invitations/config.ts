/**
 * S1-04 membership invitation configuration. Values are read from the
 * environment only and never logged; errors name the variable, never its value.
 *
 *   MEMBERSHIP_INVITATION_TOKEN_SECRET   API + worker. base64/base64url, >= 32 bytes.
 *                                        Keys the token derivation (./token.ts).
 *   MEMBERSHIP_INVITATION_ACCEPT_URL     worker. PWA page receiving the token in the
 *                                        URL fragment (https; http only for localhost).
 *   MEMBERSHIP_INVITATION_EMAIL_FROM     worker. Verified Resend sender.
 *   RESEND_API_KEY                       worker. Resend API key.
 *   RESEND_API_BASE_URL                  worker, optional (default https://api.resend.com).
 *   RESEND_TIMEOUT_MS                    worker, optional finite timeout (default 10000).
 *
 * Fail closed: as soon as ANY of these variables is present, the variables the
 * process needs are mandatory (a half-configured deployment must not boot).
 */

import { createInvitationTokenKey, type InvitationTokenKey } from './token.js';

export class InvitationConfigurationError extends Error {
  constructor(readonly variable: string, reason: string) {
    super(`MEMBERSHIP_INVITATION_CONFIGURATION_INVALID ${variable}: ${reason}`);
    this.name = 'InvitationConfigurationError';
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const INVITATION_VARIABLES = [
  'MEMBERSHIP_INVITATION_TOKEN_SECRET',
  'MEMBERSHIP_INVITATION_ACCEPT_URL',
  'MEMBERSHIP_INVITATION_EMAIL_FROM',
  'RESEND_API_KEY',
  'RESEND_API_BASE_URL',
  'RESEND_TIMEOUT_MS',
] as const;

const DEFAULT_RESEND_BASE_URL = 'https://api.resend.com';
const DEFAULT_RESEND_TIMEOUT_MS = 10_000;
const MAX_RESEND_TIMEOUT_MS = 30_000;

export function invitationsConfigured(env: Environment = process.env): boolean {
  return INVITATION_VARIABLES.some((name) => typeof env[name] === 'string' && env[name]!.trim() !== '');
}

function required(env: Environment, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') throw new InvitationConfigurationError(name, 'is required');
  return value.trim();
}

function isLocalHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

function httpsUrl(env: Environment, name: string, fallback?: string): string {
  const raw = env[name]?.trim() || fallback;
  if (!raw) throw new InvitationConfigurationError(name, 'is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvitationConfigurationError(name, 'must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new InvitationConfigurationError(name, 'must use https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new InvitationConfigurationError(name, 'must not contain credentials, query or fragment');
  }
  return url.toString();
}

export function loadInvitationTokenKey(env: Environment = process.env): InvitationTokenKey {
  const raw = required(env, 'MEMBERSHIP_INVITATION_TOKEN_SECRET');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(raw)) {
    throw new InvitationConfigurationError('MEMBERSHIP_INVITATION_TOKEN_SECRET', 'must be base64 or base64url');
  }
  const secret = Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  try {
    return createInvitationTokenKey(secret);
  } catch {
    throw new InvitationConfigurationError('MEMBERSHIP_INVITATION_TOKEN_SECRET', 'must decode to at least 32 bytes');
  } finally {
    secret.fill(0);
  }
}

export interface InvitationEmailConfig {
  readonly tokenKey: InvitationTokenKey;
  readonly acceptUrl: string;
  readonly from: string;
  readonly resendApiKey: string;
  readonly resendBaseUrl: string;
  readonly resendTimeoutMs: number;
}

export function loadInvitationEmailConfig(env: Environment = process.env): InvitationEmailConfig {
  const from = required(env, 'MEMBERSHIP_INVITATION_EMAIL_FROM');
  if (from.length > 320 || /[\r\n]/u.test(from) || !from.includes('@')) {
    throw new InvitationConfigurationError('MEMBERSHIP_INVITATION_EMAIL_FROM', 'must be a sender address');
  }
  const resendApiKey = required(env, 'RESEND_API_KEY');
  if (!/^re_\S+$/u.test(resendApiKey)) {
    throw new InvitationConfigurationError('RESEND_API_KEY', 'has an unexpected format');
  }
  const rawTimeout = env.RESEND_TIMEOUT_MS?.trim();
  const resendTimeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_RESEND_TIMEOUT_MS;
  if (!Number.isInteger(resendTimeoutMs) || resendTimeoutMs <= 0 || resendTimeoutMs > MAX_RESEND_TIMEOUT_MS) {
    throw new InvitationConfigurationError('RESEND_TIMEOUT_MS', `must be an integer in 1..${MAX_RESEND_TIMEOUT_MS}`);
  }
  return Object.freeze({
    tokenKey: loadInvitationTokenKey(env),
    acceptUrl: httpsUrl(env, 'MEMBERSHIP_INVITATION_ACCEPT_URL'),
    from,
    resendApiKey,
    resendBaseUrl: httpsUrl(env, 'RESEND_API_BASE_URL', DEFAULT_RESEND_BASE_URL),
    resendTimeoutMs,
  });
}
