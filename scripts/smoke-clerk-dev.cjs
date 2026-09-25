'use strict';

/**
 * REAL CLERK DEV SMOKE (S1-03) — optional, local only, NOT a CI gate.
 *
 * Exercises the compiled adapter (dist/, run `npm run build` first) against
 * the Clerk Development instance configured in the local .env:
 *   - Backend API reachability (read-only list, limit 1);
 *   - real 404 -> not_found mapping; finite timeout -> retryable;
 *   - instance JWKS -> PEM (the networkless jwtKey);
 *   - a THROWAWAY synthetic user (+clerk_test address) with a Backend-API
 *     session, whose real session token is verified networklessly by
 *     ClerkIdentityProvider; wrong azp / wrong issuer are rejected;
 *     getIdentityProfile against the real user;
 *   - the throwaway user is always deleted in `finally`.
 * Real users are never modified. Output: booleans, counts and claim NAMES
 * only — never keys, tokens, emails, ids or claim values.
 */

const counter = { calls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  counter.calls += 1;
  return realFetch(...args);
};

const { createPublicKey, randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { createClerkClient, verifyToken } = require('@clerk/backend');

const dist = (path) => require(resolve('dist', path));
const { ClerkIdentityProvider, ClerkIdentitySnapshotSource } = dist('identity/clerk/clerk-identity-provider.js');
const { issuerFromPublishableKey } = dist('identity/clerk/config.js');

function fakeRequest(authorization) {
  return { headers: authorization ? { authorization } : {} };
}

function claimNames(jwt) {
  const [head, body] = jwt.split('.');
  const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return { header, claims };
}

async function main() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) throw new Error('CLERK_SMOKE_CONFIGURATION_MISSING');

  const report = {};
  const issuer = issuerFromPublishableKey(publishableKey);
  report.issuerDerivedFromPublishableKey = issuer.startsWith('https://');
  report.instanceIsDevelopment = secretKey.startsWith('sk_test_') && publishableKey.startsWith('pk_test_');
  if (!report.instanceIsDevelopment) throw new Error('CLERK_SMOKE_REFUSES_NON_DEVELOPMENT_INSTANCE');

  const client = createClerkClient({ secretKey, publishableKey, telemetry: { disabled: true } });

  const list = await client.users.getUserList({ limit: 1 });
  report.backendApiReachable = Array.isArray(list.data);

  const source = new ClerkIdentitySnapshotSource({ secretKey, backendApiTimeoutMs: 8000 });
  const missing = await source.fetchIdentitySnapshot(`user_${randomUUID().replaceAll('-', '')}zz`);
  report.real404MapsToNotFound = missing.kind === 'not_found';

  const fast = new ClerkIdentitySnapshotSource({ secretKey, backendApiTimeoutMs: 1 });
  try {
    await fast.fetchIdentitySnapshot(`user_${randomUUID().replaceAll('-', '')}`);
    report.finiteTimeoutIsRetryable = false;
  } catch (error) {
    report.finiteTimeoutIsRetryable = error?.code === 'IDENTITY_PROVIDER_UNAVAILABLE';
  }

  const jwks = await client.jwks.getJwks();
  const jwk = jwks.keys?.[0];
  const jwtKey = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();
  report.jwksToPem = jwtKey.includes('BEGIN PUBLIC KEY');

  let user;
  try {
    user = await client.users.createUser({
      emailAddress: [`tallermecario-smoke+clerk_test_${randomUUID().slice(0, 8)}@example.com`],
      skipPasswordRequirement: true,
      firstName: 'Smoke',
      lastName: 'S103',
    });
    report.throwawayUserCreated = true;

    const session = await client.sessions.createSession({ userId: user.id });
    const token = await client.sessions.getToken(session.id);
    const jwt = token.jwt;
    const { header, claims } = claimNames(jwt);
    report.sessionTokenHeaderNames = Object.keys(header).sort();
    report.sessionTokenClaimNames = Object.keys(claims).sort();
    report.sessionTokenIssMatchesDerivedIssuer = claims.iss === issuer;
    report.sessionTokenSubIsUser = claims.sub === user.id;
    report.sessionTokenHasAzp = typeof claims.azp === 'string';

    // Backend-API-minted sessions may carry no azp; a browser session carries
    // the frontend origin. Use it when present, else a placeholder origin to
    // prove that a missing azp is rejected by the allowlist.
    const party = report.sessionTokenHasAzp ? claims.azp : 'http://localhost:5173';
    const config = {
      secretKey, publishableKey, jwtKey, authorizedParties: [party], issuer, backendApiTimeoutMs: 8000,
    };
    const provider = new ClerkIdentityProvider(config);
    const before = counter.calls;
    const identity = await provider.verifyRequest(fakeRequest(`Bearer ${jwt}`));
    report.verifyRequestNetworkCalls = counter.calls - before;
    report.realTokenAccepted = identity?.externalSubject === user.id && identity?.identityProvider === 'clerk';

    const wrongParty = new ClerkIdentityProvider({ ...config, authorizedParties: ['https://not-allowed.example.test'] });
    report.wrongAzpRejected = (await wrongParty.verifyRequest(fakeRequest(`Bearer ${jwt}`))) === null;
    const wrongIssuer = new ClerkIdentityProvider({ ...config, issuer: 'https://other-instance.clerk.accounts.dev' });
    report.wrongIssuerRejected = (await wrongIssuer.verifyRequest(fakeRequest(`Bearer ${jwt}`))) === null;

    // Signature + expiry of the REAL token with the instance PEM, networkless
    // (a Backend-API-minted session has no azp, so no authorizedParties here;
    // the adapter above requires azp and rightly rejects it).
    const sdkBefore = counter.calls;
    const verified = await verifyToken(jwt, { jwtKey });
    report.realTokenSignatureValidWithJwtKey = verified.sub === user.id && verified.iss === issuer;
    report.sdkVerifyTokenNetworkCalls = counter.calls - sdkBefore;

    {
      const profileBefore = counter.calls;
      const profile = await provider.getIdentityProfile({ identityProvider: 'clerk', externalSubject: user.id });
      report.profileLookupNetworkCalls = counter.calls - profileBefore;
      report.profileHasPrimaryEmail = typeof profile.email === 'string' && profile.email.length > 0;
      report.profileEmailVerifiedFlagIsBoolean = typeof profile.emailVerified === 'boolean';
      report.profileFullNamePresent = profile.fullName !== null;
    }

    const snapshot = await source.fetchIdentitySnapshot(user.id);
    report.realSnapshotKeys = Object.keys(snapshot).sort();
    report.realSnapshotBannedFalse = snapshot.banned === false;
    report.realSnapshotLockedFalse = snapshot.locked === false;
  } finally {
    if (user) {
      await client.users.deleteUser(user.id);
      const gone = await source.fetchIdentitySnapshot(user.id);
      report.throwawayUserDeleted = gone.kind === 'not_found';
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const code = error?.message?.startsWith('CLERK_SMOKE_') ? error.message : 'CLERK_SMOKE_FAILED';
  const status = typeof error?.status === 'number' ? ` status=${error.status}` : '';
  process.stderr.write(`${code}${status}\n`);
  process.exitCode = 1;
});
