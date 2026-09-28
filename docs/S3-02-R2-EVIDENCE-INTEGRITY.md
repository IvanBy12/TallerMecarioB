# S3-02: write-once presigned uploads

Presigned upload URLs are single-write capabilities. They remain valid until
their SigV4 expiry, but a successful PUT cannot be replayed to replace the
same R2 object. Every presigned PUT includes `If-None-Match: *` in
`X-Amz-SignedHeaders`. Clients must send the `uploadHeaders` returned by
`POST /api/v1/media/upload-sessions` with `uploadMethod: PUT`.

R2 accepts the first conditional PUT when the key is absent and returns
`412 PreconditionFailed` once the key exists. Omitting or changing the signed
condition invalidates the signature. The URL is **not revoked** after upload.

Each new session uses a fresh random media asset UUID in a tenant-scoped,
PII-free object key. PostgreSQL's `(storage_provider, bucket, object_key)`
UNIQUE constraint rejects a collision in application data; R2's conditional
PUT is the physical backstop. An idempotent retry of a pending session gets
the same key and a fresh URL with the same signed condition.

A `412` is not proof that the existing object is the expected upload. A
client may call the existing complete endpoint, which checks that an object
exists and is within the media type's size bounds, and must not treat `412` alone
as completion. The current complete flow does not verify object bytes against
the client-supplied SHA-256; it stores that value. Stronger byte-level
attestation is separate from this S3-02 replay fix. The media integration
test verifies original bytes through a signed GET after replay attempts.
