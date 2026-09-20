# Application-owned schedules and scoped readers

Migration `0037_service_backup_policy` adds authoritative per-service policy operations with revision checks and idempotency. Existing intervals and pipeline identities remain the starting state. An application authenticates through its local Neptune registration and producer identity; it cannot select another producer by supplying an ID in the request body.

The `/api/v1/neptune/agent/policy` and `/policy/runs` interfaces are the authoritative backend for the application's Settings. Central Synchronization keeps registration, identities, quotas, health and desired/applied state. Its old schedule and manual-run writes return 410. Do not downgrade to an old central writer while the new application-owned policy is active.

Restoring Saturn's control-plane state marks recovered policies paused and advances their control revisions. The same hold applies after startup detects an interrupted restore. Services resume their own policies only after enrollment/source/destination verification; stale queued manual commands must not become new backup requests after restore.

Migration `0038_neptune_resource_reader` adds the distinct reader identity used by full archive/mirror/reader enrollment. Reader requests are bounded and scoped; replacement or revocation invalidates the previous reader. Keep this migration after the existing share-capability and policy migrations; do not reuse their numbers.

Upgrade compatible Neptune and Updater builds before enabling this interface. Apply the Saturn release, then the application releases that expose their own policy controls. Qualify the whole signed tuple and verify existing registrations/next-run values; do not replace them with example values during installation.
