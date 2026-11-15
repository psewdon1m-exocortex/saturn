DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_migration_plans) OR EXISTS(SELECT 1 FROM sync_backend_handoffs) OR EXISTS(SELECT 1 FROM catalog_guard_roots WHERE active_runtime->>'schema'='saturn.catalog-active.v2') THEN
   RAISE EXCEPTION 'Adoption plans/publications require a compatible binary rollback';
 END IF;
END $$;
DO $$ DECLARE saved record; BEGIN FOR saved IN SELECT definition FROM sync_extension_function_backup WHERE revision=65 LOOP EXECUTE saved.definition; END LOOP; END $$;
DELETE FROM sync_extension_function_backup WHERE revision=65;
DROP FUNCTION catalog_guard_activation_preflight(catalog_guard_roots);
ALTER FUNCTION catalog_guard_activation_preflight_v1(catalog_guard_roots) RENAME TO catalog_guard_activation_preflight;
ALTER TABLE catalog_guard_roots DROP CONSTRAINT catalog_guard_active_shape;
DROP FUNCTION catalog_guard_active_shape(jsonb);
ALTER FUNCTION catalog_guard_active_shape_v1(jsonb) RENAME TO catalog_guard_active_shape;
ALTER TABLE catalog_guard_roots ADD CONSTRAINT catalog_guard_active_shape CHECK(active_runtime IS NULL OR catalog_guard_active_shape(active_runtime));
DROP TABLE sync_migration_progress;
DROP TABLE sync_migration_plans;
DROP TABLE sync_scrub_progress;
DROP TABLE sync_backend_handoffs;
