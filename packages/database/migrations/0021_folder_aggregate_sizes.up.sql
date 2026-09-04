WITH RECURSIVE descendants AS (
  SELECT
    folder.id AS folder_id,
    child.id,
    child.type,
    child.size_bytes
  FROM resources AS folder
  INNER JOIN resources AS child
    ON child.parent_id = folder.id
   AND child.status = 'active'
  WHERE folder.type = 'folder'
    AND folder.status = 'active'

  UNION ALL

  SELECT
    descendants.folder_id,
    child.id,
    child.type,
    child.size_bytes
  FROM descendants
  INNER JOIN resources AS child
    ON child.parent_id = descendants.id
   AND child.status = 'active'
), totals AS (
  SELECT folder_id, COALESCE(SUM(size_bytes) FILTER (WHERE type = 'file'), 0) AS size_bytes
  FROM descendants
  GROUP BY folder_id
)
UPDATE resources AS folder
SET size_bytes = COALESCE(computed.size_bytes, 0),
    updated_at = now()
FROM (
  SELECT candidate.id, totals.size_bytes
  FROM resources AS candidate
  LEFT JOIN totals ON totals.folder_id = candidate.id
  WHERE candidate.type = 'folder'
    AND candidate.status = 'active'
) AS computed
WHERE folder.id = computed.id;
