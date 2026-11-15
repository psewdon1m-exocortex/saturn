# Guarded mutation HTTP candidate

This is an opt-in candidate adapter, not a production capability advertisement. Server CJ04, modern folder topology, exact SQL roles/functions, old physical-executor drain, client integration and common acceptance remain separate gates. Existing legacy WebDAV/receipt bytes are unchanged.

The adapter is `apps/api/src/guarded-sync-upload-http.ts`. It restores each original sealed upload from SQL and obtains a fresh private device proof on every request. It never exports `Prepared.execution`, physical paths or the private publication claim token.

| Request | Body | Result |
|---|---|---|
| POST `/sync/v1/roots/:rootId/catalog-uploads/prepare` | Strict JSON `{binding,input,upload_id?}` | Public `{session,result?,replayed}` |
| POST `.../inspect` | Strict JSON `{binding,input,upload_id}` | Same public status; inspect original outcome after uncertain acknowledgement |
| POST `.../complete` | Strict JSON `{binding,input,upload_id}` | Historical sealed publication result, or explicit unresolved status |
| PATCH `.../append` | Binary frame below | Public durable progress; offsets remain decimal strings |
| POST `/sync/v1/roots/:rootId/directories/ensure-v2` | Strict JSON `{binding,input}` | Public `{replayed,result}` with historical `saturn.catalog-folder-result.v2` |

`binding` contains exactly seven current root-binding fields from the snapshot protocol. `input` is the immutable `CatalogUploadPrepareInput` with explicit `saturn.upload-intent.v2`, source-size/SHA, original operation key, target metadata CAS and ordered `parentTopology` (direct parent through root). Sibling aggregate metadata versions do not change this namespace witness. File-target CAS remains independent of SHA and content-version UUID.

An accepted original upload can retain an older input binding. The outer request binding and credentials must be current; a replayed historical result does not establish current remote presence, a local baseline or permission for a later overwrite.

Append uses Content-Type `application/vnd.saturn.sync-upload.v1`. The first four bytes are an unsigned big-endian metadata byte count, followed by that many strict UTF-8 JSON bytes, followed by raw file bytes. Metadata is `{binding,input,upload_id,offset}`, at most 40 KiB; data is 1 byte through 8 MiB. Metadata never enters HTTP headers. Duplicate keys, unknown fields, malformed UTF-8 and noncanonical/overflowing signed-BIGINT offsets are rejected. Zero-length files complete without a zero-length append.

`transferPending=true` means an original chunk has an unresolved temp-only outcome. It prohibits blind resend. `physical_pending` and `reconciliation_required` are publication uncertainty, not success. The private claim token distinguishes which executor owns the physical finalization; an unsuccessful competing completion must not mark another executor UNKNOWN.

The public result uses `saturn.catalog-upload-result.v2`; publication receipt, published description and exact `firstSeq/lastSeq` are historical evidence only. A client must preserve the original source generation, reobserve newer dirty work, import current R and apply generation-conditional acknowledgement before updating B.

The modern directory adapter is `apps/api/src/guarded-sync-folder-http.ts`. Its immutable input has exactly nine fields: `operationId,idempotencyKey,rootId,epoch,bindingVersion,parentId,name,mode,parentTopology`. The ordered topology runs from the direct parent to the assigned root, including exact names and parent IDs. An existing mapping anchor must be obtained from a qualified current snapshot/feed; a client cannot infer its authority from a name alone. The older parent-only directory route remains a separately limited fixture contract.

The folder outcome's hash includes private server intent fields, including an allocated node ID and actor. For `EXISTING`, the returned historical node ID may differ from the original allocated intent ID. A client must preserve the exact original request, validate its public operation/root/descriptor relationship and stable opaque hash, and then import current R. It must not claim to recompute that private folder intent hash from the public descriptor or treat it as current presence/CAS authority.

The 25 directory-envelope and upload-framing unit cases passed using the API package's source-resolving Vitest config. Real PostgreSQL/backend/loopback milestones are being qualified in the separate 0056 composition. Frozen common acceptance and cross-language native transport are pending; the route is not advertised by the normal production bootstrap.
