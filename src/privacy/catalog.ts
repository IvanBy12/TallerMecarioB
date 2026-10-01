/**
 * D-PRIV-02 server-owned, versioned privacy document catalog (in code; the MVP
 * has no privacy_notice_versions table). A published version is immutable:
 * changing its text requires a new version, and a version stays published
 * while historical evidence or an acceptable bundle may reference it.
 */
import { canonicalizeText } from './canonical-text.js';

/** Diccionario 04 §1.1 initial purpose catalog. Only service_provision gates receptions. */
export const PRIVACY_PURPOSE_CODES = [
  'service_provision',
  'service_notifications_whatsapp',
  'appointment_reminders',
  'marketing',
  'image_use',
] as const;
export type PrivacyPurposeCode = (typeof PRIVACY_PURPOSE_CODES)[number];
export const RECEPTION_PURPOSE_CODE: PrivacyPurposeCode = 'service_provision';

/** Fits varchar(40); ASCII so it can never collide with the 0x00 preimage separator. */
export const PRIVACY_DOCUMENT_VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/u;

export interface PrivacyNoticeEntry { readonly version: string; readonly text: string; }
export interface AuthorizationTextEntry {
  readonly purposeCode: PrivacyPurposeCode;
  readonly version: string;
  /** Includes the D-PRIV-04 adult attestation wording for this purpose. */
  readonly text: string;
}
export interface PublishedPrivacyDocuments {
  readonly notices: readonly PrivacyNoticeEntry[];
  readonly authorizations: readonly AuthorizationTextEntry[];
}
export interface ResolvedPrivacyDocuments { noticeText: string; authorizationText: string; }

export class PrivacyCatalogDefinitionError extends Error {
  constructor(reason: string) {
    super(`PRIVACY_CATALOG_DEFINITION_INVALID ${reason}`);
    this.name = 'PrivacyCatalogDefinitionError';
  }
}

export function isPrivacyPurposeCode(value: unknown): value is PrivacyPurposeCode {
  return typeof value === 'string' && (PRIVACY_PURPOSE_CODES as readonly string[]).includes(value);
}

export class PrivacyDocumentCatalog {
  readonly #notices: ReadonlyMap<string, string>;
  readonly #authorizations: ReadonlyMap<string, string>;

  constructor(documents: PublishedPrivacyDocuments) {
    const notices = new Map<string, string>();
    for (const entry of documents.notices) {
      assertPublishable(entry.version, entry.text);
      if (notices.has(entry.version)) throw new PrivacyCatalogDefinitionError('duplicate notice version');
      notices.set(entry.version, entry.text);
    }
    const authorizations = new Map<string, string>();
    for (const entry of documents.authorizations) {
      if (!isPrivacyPurposeCode(entry.purposeCode)) throw new PrivacyCatalogDefinitionError('unknown purpose');
      assertPublishable(entry.version, entry.text);
      const key = authorizationKey(entry.purposeCode, entry.version);
      if (authorizations.has(key)) throw new PrivacyCatalogDefinitionError('duplicate authorization version');
      authorizations.set(key, entry.text);
    }
    this.#notices = notices;
    this.#authorizations = authorizations;
    Object.freeze(this);
  }

  /** Exact published text, or null: never a fallback to a "current" version. */
  noticeText(version: string): string | null {
    return this.#notices.get(version) ?? null;
  }

  authorizationText(purposeCode: PrivacyPurposeCode, version: string): string | null {
    return this.#authorizations.get(authorizationKey(purposeCode, version)) ?? null;
  }

  resolve(purposeCode: PrivacyPurposeCode, noticeVersion: string,
    authorizationVersion: string): ResolvedPrivacyDocuments | null {
    const noticeText = this.noticeText(noticeVersion);
    const authorizationText = this.authorizationText(purposeCode, authorizationVersion);
    return noticeText === null || authorizationText === null ? null : { noticeText, authorizationText };
  }

  /** Published entries, for known-hash pinning tests. */
  published(): { notices: PrivacyNoticeEntry[]; authorizations: AuthorizationTextEntry[] } {
    return {
      notices: [...this.#notices].map(([version, text]) => ({ version, text })),
      authorizations: [...this.#authorizations].map(([key, text]) => {
        const [purposeCode, version] = key.split('\u0000') as [PrivacyPurposeCode, string];
        return { purposeCode, version, text };
      }),
    };
  }
}

function authorizationKey(purposeCode: string, version: string): string {
  return `${purposeCode}\u0000${version}`;
}

function assertPublishable(version: string, text: string): void {
  if (typeof version !== 'string' || !PRIVACY_DOCUMENT_VERSION_PATTERN.test(version))
    throw new PrivacyCatalogDefinitionError('invalid version');
  // The catalog stores the exact canonical bytes that were presented.
  if (typeof text !== 'string' || text.trim().length === 0 || canonicalizeText(text) !== text)
    throw new PrivacyCatalogDefinitionError('text is not canonical');
}

/** Approved Sprint 3 v1 copy; any text change requires a new version. */
export const PRODUCTION_PRIVACY_DOCUMENT_CATALOG = new PrivacyDocumentCatalog({
  "notices": [
    {
      "version": "privacy_notice_es-CO_v1",
      "text": "Información sobre el tratamiento de datos personales\n\nEl Responsable del Tratamiento es el taller que presta el servicio y cuyos datos de identificación, dirección y contacto se presentan junto con este aviso.\n\nLos datos personales suministrados serán tratados para gestionar la prestación y documentación del servicio de taller, incluyendo la identificación y contacto del cliente, la vinculación con el vehículo, la recepción del vehículo, diagnóstico, elaboración y gestión de cotizaciones, autorizaciones relacionadas con el servicio, reparación, control de calidad, entrega, historial del servicio, las comunicaciones estrictamente necesarias para ejecutar y documentar dicho servicio y, cuando corresponda, la documentación operativa del estado del vehículo mediante fotografías, video y firma.\n\nComo Titular de los datos personales, usted tiene derecho a conocer, actualizar y rectificar sus datos; solicitar prueba de la autorización otorgada; ser informado sobre el uso dado a sus datos; presentar consultas y reclamos; revocar la autorización y/o solicitar la supresión de los datos cuando legalmente proceda; y acceder gratuitamente a los datos personales que hayan sido objeto de tratamiento.\n\nPuede ejercer estos derechos mediante el canal indicado en la información del Responsable que acompaña este aviso.\n\nLa Política de Tratamiento de Datos Personales del Responsable puede consultarse o solicitarse a través de ese mismo canal.\n\nLa información y la autorización otorgada serán conservadas durante el tiempo necesario para documentar la relación de servicio y mientras subsistan las obligaciones legales o contractuales aplicables.\n\nLas finalidades de marketing, uso promocional de imágenes, recordatorios o comunicaciones no indispensables para la prestación del servicio no se entienden autorizadas mediante este documento y, cuando correspondan, requerirán una autorización independiente."
    }
  ],
  "authorizations": [
    {
      "purposeCode": "service_provision",
      "version": "service_provision_es-CO_v1",
      "text": "Autorización para el tratamiento de datos personales — prestación del servicio\n\nAutorizo de manera previa, expresa e informada al taller identificado como Responsable del Tratamiento para recolectar, almacenar, usar, consultar, actualizar y tratar mis datos personales exclusivamente para las finalidades de prestación y documentación del servicio descritas en el aviso de privacidad `privacy_notice_es-CO_v1`.\n\nDeclaro haber tenido acceso a la información sobre las finalidades del tratamiento, la identificación y datos de contacto del Responsable, mis derechos como Titular y el canal dispuesto para ejercerlos.\n\nEntiendo que esta autorización para el tratamiento de datos personales no constituye autorización para realizar reparaciones, instalar repuestos, ejecutar trabajos adicionales ni generar cargos. Las decisiones comerciales y técnicas sobre el vehículo requieren sus respectivas autorizaciones dentro del proceso de servicio.\n\nDeclaro que soy mayor de edad y que otorgo esta autorización de forma libre e informada."
    }
  ]
});
