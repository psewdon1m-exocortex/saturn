-- Durable browser originals. No HTTP capability, runtime grants or executor is
-- enabled by this schema. Namespace execution requires separately qualified0110.
-- Ordinary Drop rows must not require privileges on the new tree tables.
ALTER TABLE drop_uploads ADD COLUMN browser_tree_managed boolean NOT NULL DEFAULT false;
CREATE TABLE browser_upload_trees (
 id uuid PRIMARY KEY,
 principal_kind text NOT NULL CHECK(principal_kind IN ('owner','drop')),
 scope_id text NOT NULL,
 root_id uuid NOT NULL REFERENCES resources(id),
 backend_identity text NOT NULL,
 backend_generation uuid NOT NULL,
 item_count integer NOT NULL DEFAULT 0 CHECK(item_count BETWEEN 0 AND 20000),
 directory_count integer NOT NULL DEFAULT 0 CHECK(directory_count BETWEEN 0 AND 10000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((principal_kind='owner' AND scope_id='owner') OR
       (principal_kind='drop' AND scope_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' AND root_id='00000000-0000-7000-8000-000000000002'))
);
CREATE INDEX browser_upload_tree_scope ON browser_upload_trees(principal_kind,scope_id);
CREATE TABLE browser_upload_jobs (
 tree_id uuid NOT NULL REFERENCES browser_upload_trees(id),
 id uuid NOT NULL,
 intent_sha256 text NOT NULL CHECK(intent_sha256 ~ '^[a-f0-9]{64}$'),
 admitted_session_id uuid NOT NULL,
 admitted_credential_revision text CHECK(admitted_credential_revision IS NULL OR admitted_credential_revision ~ '^[1-9][0-9]*$'),
 state text NOT NULL CHECK(state IN ('accepted','running','unknown','completed','cancelled')),
 item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 16),
 payload_bytes integer NOT NULL CHECK(payload_bytes BETWEEN 0 AND 3145728),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tree_id,id)
);
CREATE INDEX browser_upload_pending_jobs ON browser_upload_jobs(tree_id,state) WHERE state NOT IN ('completed','cancelled');
CREATE TABLE browser_upload_items (
 tree_id uuid NOT NULL,
 job_id uuid NOT NULL,
 item_id uuid NOT NULL,
 parent_item_id uuid,
 relative_path text NOT NULL CHECK(octet_length(relative_path) BETWEEN 1 AND 4096),
 path_key text NOT NULL CHECK(octet_length(path_key) BETWEEN 1 AND 4096),
 kind text NOT NULL CHECK(kind IN ('directory','file')),
 operation_id uuid NOT NULL UNIQUE,
 resource_id uuid NOT NULL UNIQUE,
 version_id uuid UNIQUE,
 write_task_id uuid UNIQUE,
 publish_task_id uuid NOT NULL UNIQUE,
 staging_path text,
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 0 AND 262144),
 sha256 text CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
 content bytea,
 state text NOT NULL CHECK(state IN ('reserved','materializing','verified','publishing','unknown','published','cancelled')),
 receipt jsonb,
 drop_upload_id uuid UNIQUE REFERENCES drop_uploads(id),
 drop_mutation_tx xid8,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tree_id,item_id),
 UNIQUE(tree_id,path_key),
 FOREIGN KEY(tree_id,job_id) REFERENCES browser_upload_jobs(tree_id,id),
 FOREIGN KEY(tree_id,parent_item_id) REFERENCES browser_upload_items(tree_id,item_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='directory' AND size_bytes=0 AND sha256 IS NULL AND content IS NULL AND version_id IS NULL AND write_task_id IS NULL AND staging_path IS NULL AND drop_upload_id IS NULL)
   OR(kind='file' AND sha256 IS NOT NULL AND version_id IS NOT NULL AND write_task_id IS NOT NULL AND staging_path='_system/incoming/'||operation_id::text||'.part'
     AND ((state IN ('published','cancelled') AND content IS NULL) OR (content IS NOT NULL AND octet_length(content)=size_bytes AND encode(sha256(content),'hex')=sha256)))),
 CHECK((state='published')=(receipt IS NOT NULL))
);
CREATE INDEX browser_upload_items_job ON browser_upload_items(tree_id,job_id);
CREATE INDEX browser_upload_items_pending ON browser_upload_items(state,created_at) WHERE state NOT IN ('published','cancelled');

CREATE FUNCTION browser_upload_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'browser_tree_original_retained'; END IF;
 IF TG_TABLE_NAME='browser_upload_trees' THEN
   IF (to_jsonb(OLD)-ARRAY['item_count','directory_count'])<>(to_jsonb(NEW)-ARRAY['item_count','directory_count']) THEN RAISE EXCEPTION 'browser_tree_identity_changed'; END IF;
 ELSIF TG_TABLE_NAME='browser_upload_jobs' THEN
   IF (to_jsonb(OLD)-ARRAY['state','updated_at'])<>(to_jsonb(NEW)-ARRAY['state','updated_at'])
     OR OLD.state IN ('completed','cancelled') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'browser_tree_identity_changed'; END IF;
 ELSE
   IF (to_jsonb(OLD)-ARRAY['state','receipt','content','drop_mutation_tx','updated_at'])<>(to_jsonb(NEW)-ARRAY['state','receipt','content','drop_mutation_tx','updated_at'])
     OR OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt
     OR OLD.state IN ('published','cancelled') AND NEW.state<>OLD.state
     OR NEW.content IS DISTINCT FROM OLD.content AND NOT(NEW.content IS NULL AND NEW.state IN ('published','cancelled'))
     THEN RAISE EXCEPTION 'browser_tree_identity_changed'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER browser_upload_tree_identity BEFORE UPDATE OR DELETE ON browser_upload_trees FOR EACH ROW EXECUTE FUNCTION browser_upload_identity_guard();
CREATE TRIGGER browser_upload_job_identity BEFORE UPDATE OR DELETE ON browser_upload_jobs FOR EACH ROW EXECUTE FUNCTION browser_upload_identity_guard();
CREATE TRIGGER browser_upload_item_identity BEFORE UPDATE OR DELETE ON browser_upload_items FOR EACH ROW EXECUTE FUNCTION browser_upload_identity_guard();

-- Legacy Drop status/cancel/drain must not release a tree job's reservation or
-- adopt its source. The fixed tree transaction supplies its own same-TX mark.
CREATE FUNCTION browser_upload_drop_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.browser_tree_managed IS DISTINCT FROM OLD.browser_tree_managed THEN RAISE EXCEPTION 'browser_tree_managed_upload'; END IF;
 IF OLD.browser_tree_managed THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'browser_tree_managed_upload'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.browser_upload_items i WHERE i.drop_upload_id=OLD.id
     AND i.drop_mutation_tx=pg_current_xact_id_if_assigned()) THEN RAISE EXCEPTION 'browser_tree_managed_upload'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER browser_upload_drop_identity BEFORE UPDATE OR DELETE ON drop_uploads FOR EACH ROW EXECUTE FUNCTION browser_upload_drop_guard();
REVOKE ALL ON browser_upload_trees,browser_upload_jobs,browser_upload_items FROM PUBLIC;
