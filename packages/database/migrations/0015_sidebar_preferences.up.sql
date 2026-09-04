ALTER TABLE owner_preferences
  ADD COLUMN sidebar_mode text NOT NULL DEFAULT 'fixed'
    CHECK (sidebar_mode IN ('fixed', 'auto-hide')),
  ADD COLUMN navigation_order jsonb NOT NULL
    DEFAULT '["files", "laboratory", "inbox", "shared", "trash", "activity", "settings"]'::jsonb
    CHECK (jsonb_typeof(navigation_order) = 'array');
