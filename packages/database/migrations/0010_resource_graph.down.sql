DROP TABLE IF EXISTS graph_index_runs;
DROP TRIGGER IF EXISTS subjects_prevent_dangling ON subjects;
DROP FUNCTION IF EXISTS vault_prevent_subject_dangling_edges();
DROP TRIGGER IF EXISTS graph_edges_validate_nodes ON graph_edges;
DROP FUNCTION IF EXISTS vault_validate_graph_edge_nodes();
DROP TABLE IF EXISTS graph_edges;
DROP TABLE IF EXISTS subjects;
DROP TABLE IF EXISTS graph_relation_types;

