import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, getTenantRequestContext } from '../api/app.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import { capturePrivacyConsent, mapPrivacyConsentDbError, type PrivacyConsentDependencies,
  PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES } from './consent-service.js';
import { capturePrivacyConsentBodySchema, parseCapturePrivacyConsent,
  PRIVACY_CONSENT_BODY_LIMIT } from './validation.js';

async function noStore(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
}
async function requireJson(request: FastifyRequest): Promise<void> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
}

/**
 * S3-04.5 minimal online capture. Production dependencies fail closed until the
 * canonical privacy copy and the rights channel source are published.
 * Revocation has no route: no canonical permission exists yet (DOC_GAP).
 */
export function registerPrivacyConsentRoutes(app: FastifyInstance,
  dependencies: PrivacyConsentDependencies = PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES): void {
  app.post('/api/v1/customers/:customerId/privacy-consents', { bodyLimit: PRIVACY_CONSENT_BODY_LIMIT,
    config: { permission: 'privacy_consents.capture' }, schema: { body: capturePrivacyConsentBodySchema },
    onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    const customerId = parseCanonicalUuid((request.params as { customerId?: unknown }).customerId);
    const input = parseCapturePrivacyConsent(customerId ?? '', request.body);
    if (!customerId) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'The customer was not found.');
    let privacyConsent;
    try {
      privacyConsent = await capturePrivacyConsent(getTenantRequestContext(request), input, dependencies,
        { requestId: request.id, ipAddress: request.ip });
    } catch (error) {
      throw mapPrivacyConsentDbError(error) ?? error;
    }
    return reply.code(201).send({ privacyConsent });
  });
}
