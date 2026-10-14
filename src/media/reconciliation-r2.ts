import { setTimeout as backoff } from 'node:timers/promises';
import { presignR2ListUrl, presignR2Url, type R2Config } from './r2.js';

export type StorageFailure = 'access_denied' | 'not_found' | 'rate_limited' | 'provider_failure'
  | 'timeout' | 'network_failure' | 'protocol_failure' | 'cancelled' | 'configuration';
export class ReconciliationStorageError extends Error {
  constructor(public readonly code: StorageFailure) { super('MEDIA_RECONCILIATION_STORAGE_FAILED'); }
}
export interface InventoryPage { keys: string[]; truncated: boolean; nextToken?: string }
export interface ReconciliationStorage {
  head(key: string, signal: AbortSignal): Promise<'exists' | 'missing'>;
  list(prefix: string, limit: number, token: string | undefined, signal: AbortSignal): Promise<InventoryPage>;
}
const fail = (code: StorageFailure): never => { throw new ReconciliationStorageError(code); };

/** Strict small XML reader for the LIST protocol. No DTD, entities, CDATA,
 * comments, namespaces on children, or arbitrary nesting are interpreted.
 * Unsupported provider responses fail closed; never become an empty inventory.
 */
type Xml = { name: string; text: string; children: Xml[] };
function unescapeXml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);|#\d+;|#x[\da-fA-F]+;)/u.test(value)) return fail('protocol_failure');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/gu, (_match, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity]) return named[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return fail('protocol_failure');
    return String.fromCodePoint(code);
  });
}
function xmlTree(xml: string): Xml {
  const input = xml.replace(/^\s*<\?xml\s+[^?]*\?>/u, '').trim();
  const parent: Xml = { name: '', text: '', children: [] }, stack = [parent];
  const parts = input.match(/<[^>]*>|[^<]+/gu) ?? [];
  if (parts.join('') !== input) return fail('protocol_failure');
  for (const part of parts) {
    if (!part.startsWith('<')) { stack.at(-1)!.text += unescapeXml(part); continue; }
    const end = /^<\/([A-Za-z][A-Za-z0-9]*)>$/u.exec(part);
    if (end) {
      if (stack.length < 2 || stack.pop()!.name !== end[1]) return fail('protocol_failure');
      continue;
    }
    const start = /^<([A-Za-z][A-Za-z0-9]*)(?: xmlns="http:\/\/s3.amazonaws.com\/doc\/2006-03-01\/")?(\/)?>$/u.exec(part);
    if (!start || stack.length > 4 || (part.includes(' xmlns=') && stack.length !== 1)) return fail('protocol_failure');
    const node: Xml = { name: start[1], text: '', children: [] };
    stack.at(-1)!.children.push(node);
    if (!start[2]) stack.push(node);
  }
  if (stack.length !== 1 || parent.children.length !== 1 || parent.text.trim()) return fail('protocol_failure');
  return parent.children[0];
}
function field(node: Xml, name: string, optional = false): string | undefined {
  const fields = node.children.filter(n => n.name === name);
  if (fields.length === 0 && optional) return undefined;
  if (fields.length !== 1 || fields[0].children.length) return fail('protocol_failure');
  return fields[0].text;
}
export function parseInventory(xml: string, bucket: string, prefix: string, limit: number, token?: string): InventoryPage {
  const root = xmlTree(xml);
  if (root.name !== 'ListBucketResult' || root.text.trim() || field(root, 'Name') !== bucket
    || field(root, 'EncodingType') !== 'url' || field(root, 'MaxKeys') !== String(limit)
    || field(root, 'ContinuationToken', true) !== token) return fail('protocol_failure');
  let actualPrefix: string;
  try { actualPrefix = decodeURIComponent(field(root, 'Prefix')!); } catch { return fail('protocol_failure'); }
  if (actualPrefix !== prefix || root.children.some(n => n.name === 'CommonPrefixes')) return fail('protocol_failure');
  const flag = field(root, 'IsTruncated');
  if (flag !== 'true' && flag !== 'false') return fail('protocol_failure');
  const keys = root.children.filter(n => n.name === 'Contents').map(n => {
    let key: string;
    try { key = decodeURIComponent(field(n, 'Key')!); } catch { return fail('protocol_failure'); }
    if (!key || Buffer.byteLength(key) > 1024 || !key.startsWith(prefix)) return fail('protocol_failure');
    return key;
  });
  if (keys.length > limit || new Set(keys).size !== keys.length || field(root, 'KeyCount') !== String(keys.length)) return fail('protocol_failure');
  const nextToken = field(root, 'NextContinuationToken', true);
  if (flag === 'true' && (!keys.length || !nextToken || nextToken.length > 4096 || nextToken === token)) return fail('protocol_failure');
  if (flag === 'false' && nextToken !== undefined) return fail('protocol_failure');
  return { keys, truncated: flag === 'true', nextToken };
}
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return fail('protocol_failure');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 512 * 1024) return fail('protocol_failure');
      chunks.push(chunk.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
/** Only HEAD and LIST GET. No binary GET, PUT, DELETE, credential or bucket mutation. */
export function createReconciliationStorage(config: R2Config): ReconciliationStorage {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/' || !config.bucket || config.bucket.includes('/') || !config.accessKeyId || !config.secretAccessKey) fail('configuration');
  async function read<T>(method: 'HEAD' | 'GET', url: string, signal: AbortSignal, consume: (r: Response) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) return fail('cancelled');
      const timeout = AbortSignal.timeout(2000), combined = AbortSignal.any([signal, timeout]);
      try {
        const response = await fetch(url, { method, signal: combined, redirect: 'error' });
        try {
          if (response.status === 401 || response.status === 403) return fail('access_denied');
          if (response.status === 429) return fail('rate_limited');
          if (response.status >= 500) return fail('provider_failure');
          if (response.status === 404 && method === 'GET') return fail('not_found');
          if (response.status !== 200 && !(method === 'HEAD' && response.status === 404)) return fail('protocol_failure');
          const result = await consume(response);
          if (combined.aborted) return fail(signal.aborted ? 'cancelled' : 'timeout');
          return result;
        } finally { await response.body?.cancel().catch(() => undefined); }
      } catch (error) {
        const code = signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout'
          : error instanceof ReconciliationStorageError ? error.code : 'network_failure';
        if (attempt === 2 || !['rate_limited', 'provider_failure', 'timeout', 'network_failure'].includes(code)) return fail(code);
        try { await backoff(50 * 2 ** attempt, undefined, { signal }); } catch { return fail('cancelled'); }
      }
    }
    return fail('network_failure');
  }
  return {
    head: (key, signal) => read('HEAD', presignR2Url(config, { method: 'HEAD', objectKey: key, expiresInSeconds: 60 }), signal,
      async response => response.status === 404 ? 'missing' : 'exists'),
    list: (prefix, limit, token, signal) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (token && token.length > 4096)) return fail('configuration');
      return read('GET', presignR2ListUrl(config, prefix, limit, token), signal,
        async response => parseInventory(await boundedText(response), config.bucket, prefix, limit, token));
    },
  };
}
