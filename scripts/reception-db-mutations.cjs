'use strict';

const cases = [
  ['transition', "IF OLD.status <> 'open' OR NEW.status NOT IN ('open', 'closed')", 'IF false', '0024_reception_close_without_signature.sql'],
  ['parent_open', "IF v_status IS DISTINCT FROM 'open' THEN", 'IF false THEN'],
  ['signature_append_only', "IF TG_OP <> 'INSERT' THEN", 'IF false THEN', '0023_s3_reception_signature_retention.sql'],
  ['signature_media', "IF v_type IS DISTINCT FROM 'signature' OR v_media_status IS DISTINCT FROM 'active'\n    OR (NEW.reception_id IS NOT NULL AND v_retention_class IS DISTINCT FROM 'authorization_evidence')\n    OR v_deleted_at IS NOT NULL OR v_purged_at IS NOT NULL THEN", 'IF false THEN', '0023_s3_reception_signature_retention.sql'],
  ['open_unique', "CREATE UNIQUE INDEX receptions_one_open_vehicle_uq\n  ON public.receptions (tenant_id, vehicle_id) WHERE status = 'open';", 'SELECT 1;'],
  ['mileage', 'IF v_mileage IS NOT NULL AND NEW.mileage_km < v_mileage THEN', 'IF false THEN', '0024_reception_close_without_signature.sql'],
  ['initial_order_state', "IF TG_OP = 'INSERT' AND (NEW.status IS DISTINCT FROM 'reception'\n    OR NEW.version IS DISTINCT FROM 1 OR NEW.closed_at IS NOT NULL) THEN", 'IF false THEN'],
  ['insert_must_start_open', "IF TG_OP = 'INSERT' AND NEW.status <> 'open' THEN", 'IF false THEN', '0024_reception_close_without_signature.sql'],
  ['media_share_lock_removed', 'AND m.id = NEW.signature_media_id FOR SHARE;', 'AND m.id = NEW.signature_media_id;', '0023_s3_reception_signature_retention.sql'],
  ['signature_reception_unique_removed',
    'CREATE UNIQUE INDEX signatures_one_reception_uq\n  ON public.signatures (tenant_id, reception_id) WHERE reception_id IS NOT NULL;',
    'SELECT 1;'],
  ['signature_media_unique_removed',
    'CREATE UNIQUE INDEX signatures_one_media_uq\n  ON public.signatures (tenant_id, signature_media_id);',
    'SELECT 1;', '0021_s3_05_signature_media_single_use.sql'],
  ['signed_media_quarantine_frozen',
    "AND NOT (OLD.status='active' AND NEW.status='quarantined')",
    'AND NOT false', '0029_s4_b06_media_delete_purge.sql'],
  ['reception_retention_removed', "OR (NEW.reception_id IS NOT NULL AND v_retention_class IS DISTINCT FROM 'authorization_evidence')",
    'OR false', '0023_s3_reception_signature_retention.sql'],
  ['signed_retention_immutable_removed', 'OR NEW.retention_class IS DISTINCT FROM OLD.retention_class',
    'OR false', '0029_s4_b06_media_delete_purge.sql'],
  ['signed_retention_trigger_removed', 'checksum_sha256, status, retention_class,',
    'checksum_sha256, status,', '0023_s3_reception_signature_retention.sql'],
  // S3-04.5: each mutant must migrate successfully and be rejected by a
  // behavioral assertion in tests/reception/privacy-contract-db.test.cjs.
  ['owner_guard_removed', 'IF v_owner IS DISTINCT FROM NEW.customer_id THEN', 'IF false THEN', '0020_s3_04_5_reception_privacy_contract.sql'],
  ['vehicle_lock_removed', 'AND v.id = NEW.vehicle_id FOR NO KEY UPDATE;', 'AND v.id = NEW.vehicle_id;', '0020_s3_04_5_reception_privacy_contract.sql'],
  ['consent_customer_removed', 'IF v_customer IS DISTINCT FROM NEW.customer_id', 'IF false', '0020_s3_04_5_reception_privacy_contract.sql'],
  ['consent_purpose_removed', "OR v_purpose IS DISTINCT FROM 'service_provision'", 'OR false', '0020_s3_04_5_reception_privacy_contract.sql'],
  // The status/revoked_at CHECK makes either condition redundant alone. Remove
  // both to make a meaningful mutant of the eligibility invariant.
  ['consent_state_removed', "OR v_status IS DISTINCT FROM 'granted'\n    OR v_revoked_at IS NOT NULL", 'OR false\n    OR false', '0020_s3_04_5_reception_privacy_contract.sql'],
  ['consent_share_lock_removed', 'AND c.id = NEW.privacy_consent_id FOR SHARE;', 'AND c.id = NEW.privacy_consent_id;', '0020_s3_04_5_reception_privacy_contract.sql'],
  ['consent_created_order_removed', 'OR v_created_at > NEW.created_at', 'OR false', '0020_s3_04_5_reception_privacy_contract.sql'],
];

function replaceMigration(source, from, to, name) {
  const normalized = source.replace(/\r\n/gu, '\n');
  if (!normalized.includes(from)) throw new Error(`RECEPTION_MUTATION_ANCHOR_NOT_FOUND ${name}`);
  return normalized.replace(from, to);
}

module.exports = { cases, replaceMigration };
