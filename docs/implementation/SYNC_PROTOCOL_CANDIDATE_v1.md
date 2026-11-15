# Shared sync protocol candidate

Status: inactive proposed contract. This document follows specification7.1/7.4–7.10 and CJ02/CJ05/CJ06. The existing `/api/v1/sync/uploads` publication receipt and legacy metadata endpoints retain their contracts. The new module is deliberately unexported by `@saturn/contracts` and has no live controller imports. Snapshot/feed/conditional/new-engine capabilities remain false.

The candidate lives in [TypeScript](C:/.projects/exocortex/saturn/packages/contracts/src/sync-protocol.ts), [JSON Schema](C:/.projects/exocortex/saturn/packages/contracts/schemas/sync-protocol.candidate.v1.schema.json) and [shared golden fixture](C:/.projects/exocortex/saturn/packages/contracts/fixtures/sync-protocol.candidate.v1.golden.json). Consumers must qualify C#/Go parsing against the same bytes before wire freeze; this candidate is not their completed implementation.

Every root response binds protocol, descriptor schema, persistent server identity, root ID, catalog epoch, policy version and root `binding_version`. These identifiers are independent. Root qualification/backend availability transitions renew the binding UUID and invalidate the whole cached scope without rewriting every descendant or fabricating a permission revision. Returning to a qualified root must never revive the old binding. Decimal integer64 strings include exact values beyond2^53; negative, floating, padded and overflow values fail before state mutation. Opaque signed cursors bind the same complete scope; a client never fabricates one from an integer.

`saturn.current-namespace.v1` exposes stable node/parent/name/type, exact aggregate size, content hash/current content-version ID, metadata `version` and availability. `version` is an opaque UUID renewed only by a meaningful public descriptor mutation in its catalog transaction. It is neither legacy ETag nor content version nor root sequence. Folder aggregate changes renew its metadata version. AVAILABLE files require known content identity; UNKNOWN/UNAVAILABLE remain namespace entries and never become absence. This metadata statement does not prove current physical readback on every read.

An upsert carries the complete new descriptor. A confirmed namespace tombstone carries the complete retained pre-state, its `before_version`, and a distinct opaque deletion metadata `version`; backend errors, hidden scope, missing ancestor or depth/cycle failure cannot emit this tombstone. A descriptor cannot be its own parent. Complete ancestry/membership and root parent:null still require server proof. This tombstone shape must be qualified with actual CJ02 adapters before freeze. A same-byte content replacement retains its distinct content-version ID and updates metadata version; stale CAS cannot substitute a newly read value.

Snapshot READY is immutable at D after a bounded stable-node scan plus complete contiguous overlay(C,D]. Transactions close between pages. The same binding and D start feed import. The client atomically persists R, derived dirty/replan work and next cursor. Any gap, epoch/policy/server identity mismatch or expiry preserves B/operations and requests reconciliation. Neither this validator nor a historical upload receipt grants B adoption/local completeness authority.

Limits:500 page items,4MiB raw uncompressed response,1020 UTF-8 bytes per name, signed-positive integer64 upper bound9223372036854775807. Raw parsing rejects malformed UTF-8, duplicate/escaped duplicate keys, unpaired surrogates and value depth>32, counting the root as0; an empty container at depth32 is allowed. One leading UTF-8 BOM is ignored after charging its bytes. Forward response fields may be ignored, but count/byte limits include them; known enum fields must be strings and semantic write unions reject additional fields. Incoming limits use the received bytes: re-serializing JSON can expand numeric spellings. Producers must use the bounded `encodeSyncJson` on the actual outgoing representation. JSON Schema covers shape and exact integer range; the semantic validator additionally checks page contiguity, expected binding, lease relations and UTF-8 bounds. Neither validates a server cursor signature on the client.

| Gate | Acceptance |
|---|---|
| WIRE01 | TS exact64/duplicate/UTF8/known enum/forward response/strict expected/page-gap/budget tests |
| WIRE02 | JSON Schema differential fixtures and C#/Go readers against the shared golden bytes |
| WIRE03 | CJ02 actual SQL metadata version/noop/delete/UNKNOWN and all public policy projection semantics |
| WIRE04 | All runtime writers/membership and old-binary write fencing before ACTIVE root |
| WIRE05 | Actual snapshot concurrent mutation/crash/retention and signed feed continuity/reconciliation |
| WIRE06 | Real Windows/Pluto L/B/R adoption, source continuity and conditional publication |

WIRE01 and the TS/JSON Schema part of WIRE02 are locally qualified. The shared C#/Go readers and runtime gates remain OPEN. The protocol does not alter the paused production profile or announce a public API rollout.
