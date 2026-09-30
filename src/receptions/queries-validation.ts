import { ApiError } from '../api/app.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';

const QUERY_KEYS = new Set(['limit', 'cursor', 'status', 'vehicleId', 'customerId']);
const LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const invalid = () => new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request query is invalid.');

export interface ListReceptionsQuery {
  readonly limit: number;
  readonly afterId?: string;
  readonly status?: 'open' | 'closed';
  readonly vehicleId?: string;
  readonly customerId?: string;
}

export function encodeReceptionCursor(id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): string | undefined {
  if (!CURSOR_PATTERN.test(raw)) return undefined;
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes('v') || !keys.includes('id')) return undefined;
  const { v, id } = payload as { v: unknown; id: unknown };
  if (v !== 1 || typeof id !== 'string') return undefined;
  const canonical = parseCanonicalUuid(id);
  return canonical === id ? canonical : undefined;
}

export function parseListReceptionsQuery(query: unknown): ListReceptionsQuery {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    if (!QUERY_KEYS.has(key) || typeof value !== 'string') throw invalid();
    values[key] = value;
  }
  let limit = 25;
  if (values.limit !== undefined) {
    if (!LIMIT_PATTERN.test(values.limit)) throw invalid();
    limit = Number(values.limit);
    if (limit > 100) throw invalid();
  }
  const afterId = values.cursor === undefined ? undefined : decodeCursor(values.cursor);
  if (values.cursor !== undefined && afterId === undefined) throw invalid();
  if (values.status !== undefined && values.status !== 'open' && values.status !== 'closed') throw invalid();
  const vehicleId = values.vehicleId === undefined ? undefined : parseCanonicalUuid(values.vehicleId);
  const customerId = values.customerId === undefined ? undefined : parseCanonicalUuid(values.customerId);
  if ((values.vehicleId !== undefined && !vehicleId) || (values.customerId !== undefined && !customerId)) throw invalid();
  return { limit, ...(afterId === undefined ? {} : { afterId }),
    ...(values.status === undefined ? {} : { status: values.status as 'open' | 'closed' }),
    ...(vehicleId === undefined ? {} : { vehicleId }),
    ...(customerId === undefined ? {} : { customerId }) };
}
