import { createHash } from 'node:crypto';
import { hasValidUnicode } from '../platform/unicode-text.js';

export const RECEPTION_ACCEPTANCE_VERSION = 'reception_acceptance_es-CO_v1';

// Published evidence: any byte change to v1 requires a new version.
export const RECEPTION_ACCEPTANCE_TEXT = `ACEPTACIÓN DE RECEPCIÓN DEL VEHÍCULO

Declaro que entrego voluntariamente al taller el vehículo identificado en esta recepción y que tuve la oportunidad de revisar la información registrada al momento de la entrega, incluyendo kilometraje, nivel de combustible, observaciones y el estado o daños que hayan sido consignados.

Autorizo al taller a realizar las inspecciones y actividades de diagnóstico necesarias para evaluar el vehículo y preparar una cotización. Esta aceptación no autoriza reparaciones, instalación de repuestos, trabajos adicionales ni cargos; cualquiera de esas actuaciones requerirá una autorización posterior e independiente cuando corresponda.

Reconozco que esta firma se conserva como evidencia de la recepción del vehículo y del contenido exacto de esta aceptación.

Esta aceptación no sustituye autorizaciones de tratamiento de datos personales, marketing, WhatsApp, cotizaciones, reparaciones ni otros consentimientos o autorizaciones que deban obtenerse por separado.`;

export function canonicalAcceptanceBytes(text: string): Buffer {
  if (!hasValidUnicode(text)) throw new Error('ACCEPTANCE_TEXT_INVALID');
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return Buffer.from(withoutBom.replace(/\r\n?/gu, '\n').normalize('NFC'), 'utf8');
}

export function acceptanceHash(text: string): string {
  return createHash('sha256').update(canonicalAcceptanceBytes(text)).digest('hex');
}

const published = Object.freeze({
  version: RECEPTION_ACCEPTANCE_VERSION,
  text: RECEPTION_ACCEPTANCE_TEXT,
  hash: acceptanceHash(RECEPTION_ACCEPTANCE_TEXT),
});

/** The client must name the version it displayed; no latest-version fallback. */
export function receptionAcceptanceDocument(version: string): typeof published | null {
  return version === published.version ? published : null;
}
