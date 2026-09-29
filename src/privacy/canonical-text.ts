/**
 * D-PRIV-02 canonical representation v1 of the privacy text presented to the
 * data subject (Diccionario 04 §1.1). Pure and deterministic: the same catalog
 * texts + versions + retained snapshot always rebuild the same bytes and hash.
 */
import { createHash } from 'node:crypto';
import { hasValidUnicode } from '../platform/unicode-text.js';

export const AUTHORIZATION_TEXT_HASH_DOMAIN = 'tallermecario.privacy_consent.text.v1';
/** Fixed preimage order; do not reorder (it would change every hash). */
export const CONTROLLER_NOTICE_FIELDS = ['legalName', 'address', 'phone', 'email', 'rightsChannel'] as const;
export type ControllerNoticeField = (typeof CONTROLLER_NOTICE_FIELDS)[number];
/** Hash input: any snapshot field may be NULL at the encoding level. */
export type ControllerNoticeFields = Readonly<Record<ControllerNoticeField, string | null>>;

export interface AuthorizationTextHashInput {
  purposeCode: string;
  privacyNoticeVersion: string;
  authorizationTextVersion: string;
  noticeText: string;
  authorizationText: string;
  snapshot: ControllerNoticeFields;
}

export class CanonicalTextError extends Error {
  constructor() {
    super('PRIVACY_CANONICAL_TEXT_INVALID');
    this.name = 'CanonicalTextError';
  }
}

const BYTE_ORDER_MARK = '﻿';
const NUL = '\u0000';

/** UTF-8 target form: NFC, LF line endings, no leading BOM, well-formed Unicode. */
export function canonicalizeText(value: string): string {
  if (typeof value !== 'string' || !hasValidUnicode(value)) throw new CanonicalTextError();
  const withoutBom = value.startsWith(BYTE_ORDER_MARK) ? value.slice(1) : value;
  return withoutBom.replace(/\r\n?/gu, '\n').normalize('NFC');
}

/** Separator-delimited identifiers must be non-empty and cannot contain 0x00. */
function canonicalToken(value: string): string {
  const canonical = canonicalizeText(value);
  if (canonical.length === 0 || canonical.includes(NUL)) throw new CanonicalTextError();
  return canonical;
}

function u64be(length: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(length));
  return out;
}

function lengthPrefixed(value: string): Buffer[] {
  const bytes = Buffer.from(value, 'utf8');
  return [u64be(bytes.length), bytes];
}

/** NULL = 0x00; STRING = 0x01 || u64be(len(utf8)) || utf8. NULL != "". */
function snapshotField(value: string | null): Buffer[] {
  if (value === null) return [Buffer.from([0x00])];
  return [Buffer.from([0x01]), ...lengthPrefixed(canonicalizeText(value))];
}

export function authorizationTextPreimage(input: AuthorizationTextHashInput): Buffer {
  const separator = Buffer.from([0x00]);
  const parts: Buffer[] = [
    Buffer.from(AUTHORIZATION_TEXT_HASH_DOMAIN, 'utf8'), separator,
    Buffer.from(canonicalToken(input.purposeCode), 'utf8'), separator,
    Buffer.from(canonicalToken(input.privacyNoticeVersion), 'utf8'), separator,
    Buffer.from(canonicalToken(input.authorizationTextVersion), 'utf8'), separator,
    ...lengthPrefixed(canonicalizeText(input.noticeText)),
    ...lengthPrefixed(canonicalizeText(input.authorizationText)),
  ];
  for (const field of CONTROLLER_NOTICE_FIELDS) {
    const value = input.snapshot[field];
    if (value !== null && typeof value !== 'string') throw new CanonicalTextError();
    parts.push(...snapshotField(value));
  }
  return Buffer.concat(parts);
}

/** SHA-256 lowercase hex (64 chars). Server-side only: never accepted from a client. */
export function computeAuthorizationTextHash(input: AuthorizationTextHashInput): string {
  return createHash('sha256').update(authorizationTextPreimage(input)).digest('hex');
}
