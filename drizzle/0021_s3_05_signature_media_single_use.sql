-- A signature image is evidence for one signing event. The existing
-- signatures_one_reception_uq prevents two signatures on one reception;
-- this index prevents the same image being presented as separate evidence.
-- Existing duplicates fail the migration rather than being rewritten.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE UNIQUE INDEX signatures_one_media_uq
  ON public.signatures (tenant_id, signature_media_id);
--> statement-breakpoint
RESET ROLE;
