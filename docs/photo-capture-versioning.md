# Capture-specific photo evidence

A retake previously reused `jobs/<visit>/<room>-<kind>.jpg`. The local queue rejected an older capture's completion, but a delayed Storage overwrite could still replace the newer image. A receipt for the shared path did not identify the bytes.

New captures use `jobs/<visit>/<room>-<kind>/<revision>.jpg` with `upsert: false`. The revision is durable before uploading; a legacy queued capture receives one in an atomic local transaction without changing its Blob. Retrying an already-existing upload proceeds only to server verification. The phone hashes its durable Blob and requires a receipt with the same visit, slot, revision, digest, replacement history and actual object identity/version before deletion.

The server validates the Cleaner assignment and saved visit scope before signing a private read. It streams and hashes the actual stored bytes with a body-inclusive deadline. The recording routine locks the visit, repeats authorization, and locks/rechecks the exact object identity, version and size observed before hashing. A changed object cannot pass the recording step.

Each capture carries the revisions it intentionally replaces. A current slot can change only from one of those known ancestors; device clocks do not decide. An accepted older receipt can replay without updating the current slot. An unknown competing branch fails closed and keeps its phone copy. Local replacement history and confirmed-version markers survive both capture screens and reopening; known older observations cannot downgrade them. At the unresolved-history limit, a new save is refused without truncating history or deleting existing bytes. The Cleaner is told to reconnect and finish saved uploads.

Private append-only receipts retain accepted capture identities. New fields on current photo rows bind those receipts to live Storage objects. Cleaner reads, service-draft evidence and Management issuance use those bindings. Existing canonical photos remain explicitly legacy evidence; migration does not claim their historical bytes were hashed or rewrite their rows. Direct signed-in writes to photo rows and the old service photo-recording entry point are revoked. Done remains independent of outstanding photos.

## Release and recovery

This change depends on the reviewed manual-issuance migration in PR47. Deploy the complete database migration before the matching application. Earlier application versions will keep photos queued because their path-only receipt protocol cannot be confirmed. Their queued Blobs remain available to the upgraded app. The static recovery asset cache version is bumped. Do not weaken receipt validation to accommodate a mixed deployment.

Keep automatic collection off for the pilot. A production rollout still needs the actual backup/restore and upgrade rehearsal, exact candidate/configuration verification and approval. SQL tests use synthetic metadata, not provider object delivery. Hosted byte/version checks, authenticated browser acceptance and real iPhone/Android weak-signal/offline/restart/session/storage/reassignment tests remain required. An immutable path and green CI alone do not complete launch acceptance.
