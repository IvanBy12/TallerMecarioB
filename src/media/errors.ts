export class MediaError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

/** A changed lock graph requires a fresh transaction, never a later parent lock. */
export class MediaLineageChangedError extends MediaError {
  constructor() { super(409, 'MEDIA_ASSOCIATION_CONFLICT', 'Media lineage changed; retry the transaction.'); }
}
