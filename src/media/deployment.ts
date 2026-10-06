import type postgres from 'postgres';

/** Release capability used to gate BOTH the candidate and the pinned recovery
 * artifact before applying 0025. Pre-B02 images do not contain this entrypoint.
 */
export const MEDIA_INTEGRITY_WRITER_VERSION = 'v1';

export async function assertMediaIntegritySchema(database: postgres.Sql): Promise<void> {
  const [schema] = await database<{ expectation: boolean; failure: boolean; trigger: boolean; version_default: string | null }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.upload_sessions'::regclass
      AND conname='upload_sessions_integrity_expectation_check' AND convalidated) AS expectation,
      EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='public.media_assets'::regclass
      AND conname='media_assets_integrity_failure_check' AND convalidated) AS failure,
      EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.upload_sessions'::regclass
      AND tgname='upload_sessions_integrity_expectation_trg' AND tgenabled='O' AND NOT tgisinternal) AS trigger,
      (SELECT column_default FROM information_schema.columns WHERE table_schema='public'
      AND table_name='upload_sessions' AND column_name='integrity_version') AS version_default`;
  if (!schema?.expectation || !schema.failure || !schema.trigger || schema.version_default !== "'v1'::character varying") {
    throw new Error('MEDIA_INTEGRITY_SCHEMA_INCOMPATIBLE');
  }
}

if (require.main === module) {
  if (process.argv[2] !== '--artifact-capability') throw new Error('MEDIA_DEPLOYMENT_ARGUMENT_INVALID');
  process.stdout.write(`MEDIA_INTEGRITY_WRITER_${MEDIA_INTEGRITY_WRITER_VERSION}\n`);
}
