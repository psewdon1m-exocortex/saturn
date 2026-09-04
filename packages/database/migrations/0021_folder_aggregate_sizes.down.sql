UPDATE resources
SET size_bytes = 0,
    updated_at = now()
WHERE type = 'folder';
