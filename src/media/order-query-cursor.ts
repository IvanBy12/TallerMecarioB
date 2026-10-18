import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MediaError } from './errors.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';

export type OrderMediaPosition = [0 | 1, string, number, string, 'intake_evidence' | 'damage_evidence'];
export interface OrderMediaCursorContext {
  tenantId: string; orderId: string; userId: string; membershipId: string; limit: number;
}
export interface OrderMediaCursor {
  encode(context: OrderMediaCursorContext, position: OrderMediaPosition): string;
  decode(token: string, context: OrderMediaCursorContext): OrderMediaPosition;
}
const invalid = () => new MediaError(400, 'REQUEST_VALIDATION_FAILED', 'The request query is invalid.');
const configuration = () => new Error('MEDIA_ORDER_CURSOR_CONFIGURATION_INVALID');
const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const base64Pattern = /^[A-Za-z0-9_-]+$/;
const TTL_MS = 15 * 60 * 1000;
function bytes(value: string): Buffer {
  if (!base64Pattern.test(value)) throw invalid();
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value) throw invalid();
  return result;
}
function position(value: unknown): value is OrderMediaPosition {
  if (!Array.isArray(value) || value.length !== 5) return false;
  const [rank, sourceId, sortOrder, assetId, purpose] = value;
  return (rank === 0 || rank === 1) && typeof sourceId === 'string' && parseCanonicalUuid(sourceId) === sourceId
    && Number.isSafeInteger(sortOrder) && sortOrder >= 0 && sortOrder <= 2147483647
    && typeof assetId === 'string' && parseCanonicalUuid(assetId) === assetId
    && purpose === (rank === 0 ? 'intake_evidence' : 'damage_evidence');
}

/** Key material stays inside the codec closure. Tokens reveal no skipped IDs.
 * Retain old key IDs during rotation; retiring one safely invalidates its cursors. */
export function createOrderMediaCursor(activeKeyId: string, keys: ReadonlyMap<string, Buffer>, now = Date.now): OrderMediaCursor {
  if (!keyIdPattern.test(activeKeyId) || !keys.has(activeKeyId) || !keys.size || keys.size > 8
    || [...keys].some(([id, key]) => !keyIdPattern.test(id) || key.length !== 32)
    || new Set([...keys.values()].map(key => key.toString('hex'))).size !== keys.size) throw configuration();
  const keyring = new Map([...keys].map(([id, key]) => [id, Buffer.from(key)]));
  return Object.freeze({
    encode(context: OrderMediaCursorContext, last: OrderMediaPosition) {
      if (!position(last)) throw invalid();
      const issuedAt = now();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keyring.get(activeKeyId)!, iv);
      cipher.setAAD(Buffer.from(`order-media:v1:${activeKeyId}`));
      const payload = JSON.stringify({ version: 1, ...context, position: last, issuedAt, expiresAt: issuedAt + TTL_MS });
      const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
      return ['v1', activeKeyId, iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    },
    decode(token: string, context: OrderMediaCursorContext) {
      try {
        if (typeof token !== 'string' || token.length > 2048) throw invalid();
        const parts = token.split('.');
        if (parts.length !== 5 || parts[0] !== 'v1' || !keyIdPattern.test(parts[1])) throw invalid();
        const key = keyring.get(parts[1]), iv = bytes(parts[2]), tag = bytes(parts[4]);
        if (!key || iv.length !== 12 || tag.length !== 16) throw invalid();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(`order-media:v1:${parts[1]}`));
        decipher.setAuthTag(tag);
        const payload = JSON.parse(Buffer.concat([decipher.update(bytes(parts[3])), decipher.final()]).toString('utf8'));
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).sort().join(',') !== 'expiresAt,issuedAt,limit,membershipId,orderId,position,tenantId,userId,version'
          || payload.version !== 1 || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
          || payload.issuedAt > now() || payload.expiresAt <= now() || payload.expiresAt - payload.issuedAt !== TTL_MS
          || Object.entries(context).some(([key, value]) => payload[key] !== value) || !position(payload.position)) throw invalid();
        return payload.position;
      } catch { throw invalid(); }
    },
  });
}

/** JSON.parse silently overwrites duplicate names, including escaped aliases.
 * Reject ambiguity before accepting a rotation: the last key must not silently
 * replace the operator's intended material. Syntax is validated by JSON.parse;
 * tokens track object scopes and decode key escapes for duplicate detection. */
function parseConfiguration(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const objects: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') objects.push(new Set());
    else if (token === '[') objects.push(null);
    else if (token === '}' || token === ']') objects.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = objects.at(-1);
      const key: string = JSON.parse(token);
      if (!keys || keys.has(key)) throw configuration();
      keys.add(key);
    }
  }
  return value;
}

/** Missing configuration leaves the new route disabled. A partial/invalid keyring
 * fails startup before DB access. No fallback or process-random production key. */
export function loadOrderMediaCursor(env: NodeJS.ProcessEnv): OrderMediaCursor | undefined {
  if (env.MEDIA_ORDER_CURSOR_KEY === undefined) return undefined;
  try {
    const value = parseConfiguration(env.MEDIA_ORDER_CURSOR_KEY) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'activeKeyId,keys' || typeof value.activeKeyId !== 'string'
      || !value.keys || typeof value.keys !== 'object' || Array.isArray(value.keys)) throw configuration();
    const keys = new Map<string, Buffer>();
    for (const [id, key] of Object.entries(value.keys)) {
      if (typeof key !== 'string') throw configuration();
      keys.set(id, bytes(key));
    }
    return createOrderMediaCursor(value.activeKeyId, keys);
  } catch { throw configuration(); }
}
