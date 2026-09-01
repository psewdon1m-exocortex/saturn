CREATE TABLE graph_relation_types (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  directed_default boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO graph_relation_types (key, label, directed_default) VALUES
  ('associated_with','Associated with',false), ('belongs_to','Belongs to',true), ('depicts','Depicts',true),
  ('created_for','Created for',true), ('part_of','Part of',true), ('references','References',true),
  ('derived_from','Derived from',true), ('version_of','Version of',true), ('related_to','Related to',false),
  ('located_at','Located at',true), ('created_by','Created by',true);

CREATE TABLE subjects (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX subjects_name_idx ON subjects(lower(name), id);

CREATE TABLE graph_edges (
  id uuid PRIMARY KEY,
  from_node_kind text NOT NULL CHECK (from_node_kind IN ('resource','subject')),
  from_node_id uuid NOT NULL,
  to_node_kind text NOT NULL CHECK (to_node_kind IN ('resource','subject')),
  to_node_id uuid NOT NULL,
  relation_type text NOT NULL REFERENCES graph_relation_types(key),
  direction text NOT NULL CHECK (direction IN ('directed','undirected')),
  source text NOT NULL CHECK (source IN ('manual','derived')),
  propagate boolean NOT NULL DEFAULT false,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties) = 'object'),
  derivation_owner_resource_id uuid REFERENCES resources(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (from_node_kind <> to_node_kind OR from_node_id <> to_node_id),
  CHECK ((source = 'manual' AND derivation_owner_resource_id IS NULL) OR (source = 'derived' AND derivation_owner_resource_id IS NOT NULL AND propagate = false))
);
CREATE UNIQUE INDEX graph_edges_identity_idx ON graph_edges (
  from_node_kind, from_node_id, to_node_kind, to_node_id, relation_type, direction, source,
  coalesce(derivation_owner_resource_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX graph_edges_from_idx ON graph_edges(from_node_kind, from_node_id, relation_type);
CREATE INDEX graph_edges_to_idx ON graph_edges(to_node_kind, to_node_id, relation_type);
CREATE INDEX graph_edges_derivation_idx ON graph_edges(derivation_owner_resource_id) WHERE source = 'derived';

CREATE FUNCTION vault_validate_graph_edge_nodes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.from_node_kind = 'resource' THEN
    IF NOT EXISTS (SELECT 1 FROM resources WHERE id = NEW.from_node_id AND status <> 'purged') THEN RAISE EXCEPTION 'graph source resource not found' USING ERRCODE='23503'; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM subjects WHERE id = NEW.from_node_id) THEN RAISE EXCEPTION 'graph source subject not found' USING ERRCODE='23503'; END IF;
  IF NEW.to_node_kind = 'resource' THEN
    IF NOT EXISTS (SELECT 1 FROM resources WHERE id = NEW.to_node_id AND status <> 'purged') THEN RAISE EXCEPTION 'graph target resource not found' USING ERRCODE='23503'; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM subjects WHERE id = NEW.to_node_id) THEN RAISE EXCEPTION 'graph target subject not found' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER graph_edges_validate_nodes BEFORE INSERT OR UPDATE OF from_node_kind,from_node_id,to_node_kind,to_node_id ON graph_edges FOR EACH ROW EXECUTE FUNCTION vault_validate_graph_edge_nodes();

CREATE FUNCTION vault_prevent_subject_dangling_edges() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM graph_edges WHERE (from_node_kind='subject' AND from_node_id=OLD.id) OR (to_node_kind='subject' AND to_node_id=OLD.id)) THEN
    RAISE EXCEPTION 'subject has graph edges' USING ERRCODE='23503';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER subjects_prevent_dangling BEFORE DELETE ON subjects FOR EACH ROW EXECUTE FUNCTION vault_prevent_subject_dangling_edges();

CREATE TABLE graph_index_runs (
  id uuid PRIMARY KEY,
  root_resource_id uuid NOT NULL REFERENCES resources(id),
  state text NOT NULL CHECK (state IN ('running','complete','failed')),
  files_scanned integer NOT NULL DEFAULT 0 CHECK (files_scanned >= 0),
  edges_written integer NOT NULL DEFAULT 0 CHECK (edges_written >= 0),
  skipped_links integer NOT NULL DEFAULT 0 CHECK (skipped_links >= 0),
  error_code text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX graph_index_runs_started_idx ON graph_index_runs(started_at DESC);

