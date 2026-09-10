DROP TABLE IF EXISTS neptune_agent_commands;
DROP TABLE IF EXISTS neptune_agents;
DROP INDEX IF EXISTS backup_services_active_namespace_deployment_unique;

ALTER TABLE backup_services
  ADD CONSTRAINT backup_services_namespace_deployment_unique
  UNIQUE (namespace_slug, deployment_id);
