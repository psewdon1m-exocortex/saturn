ALTER TABLE share_access_events
  DROP CONSTRAINT share_access_events_action_check;

ALTER TABLE share_access_events
  ADD CONSTRAINT share_access_events_action_check
  CHECK (action IN ('metadata', 'unlock', 'browse', 'thumbnail', 'content', 'package_create', 'package_content'));
