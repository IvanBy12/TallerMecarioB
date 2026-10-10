import type postgres from 'postgres';
import { MediaError, MediaLineageChangedError } from './errors.js';

/** Only the DB entry point has destructive grants; no retention input or R2 I/O. */
export async function removeUnattachedMedia(sql: postgres.ReservedSql, mediaAssetId: string): Promise<{
  mediaAssetId: string; deletionState: 'deleted' | 'purged';
}> {
  try {
    await sql`SET LOCAL lock_timeout='2s'`;
    await sql`SET LOCAL statement_timeout='8s'`;
    const [row] = await sql<{ state: 'deleted' | 'purged' }[]>`SELECT app.remove_unattached_media(${mediaAssetId}::uuid) AS state`;
    return { mediaAssetId, deletionState: row.state };
  } catch (error) {
    const db = error as { code?: string; message?: string };
    if (db.code === '40001') throw new MediaLineageChangedError();
    if (db.message === 'MEDIA_ASSET_NOT_FOUND') throw new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'The media asset was not found.');
    if (db.message === 'MEDIA_LEGAL_HOLD') throw new MediaError(409, 'MEDIA_LEGAL_HOLD', 'The media asset is protected by a legal hold.');
    if (db.message === 'MEDIA_PURGE_BUSY' || ['55P03','57014'].includes(db.code ?? ''))
      throw new MediaError(503, 'MEDIA_DELETE_RETRY', 'The media command is temporarily unavailable. Retry later.');
    if (db.message === 'MEDIA_DELETE_NOT_ELIGIBLE')
      throw new MediaError(409, 'MEDIA_DELETE_NOT_ELIGIBLE', 'The media asset cannot be removed.');
    if (db.message === 'PERMISSION_DENIED') throw new MediaError(403, 'PERMISSION_DENIED', 'Permission denied.');
    throw error;
  }
}
