# Normative applicability matrix

This matrix applies the document-selection rules from
[Part 00](../../../.docs/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md) to Saturn.

| Document / major section | Status | Reason and evidence | Planned stage |
| --- | --- | --- | --- |
| [Part 00](../../../.docs/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md) | Applicable | Orchestrates scope, divergence handling, evidence and handoff for all work | 0-14 |
| [Part 01](../../../.docs/PART_01_INTERFACE_AND_INTERACTION_UNIFICATION.md) §§1–6 UI foundations | Applicable | Saturn has login, settings, collections, file lists and protected mutations | 6-14 |
| [Part 01](../../../.docs/PART_01_INTERFACE_AND_INTERACTION_UNIFICATION.md) responsive/accessibility contract | Applicable | Web UI supports desktop, narrow screen, keyboard and reduced motion | 6-14 |
| [Part 02](../../../.docs/PART_02_OBSERVABILITY_AUDIT_AND_LOG_EXPORT.md) observability/audit/export | Applicable | File mutations, auth, shares, backups and admin actions require bounded structured evidence | 2-14 |
| [Part 03](../../../.docs/PART_03_BACKUP_AND_RECOVERY.md) backup/recovery | Applicable | PostgreSQL, metadata and the bounded local Drop queue are authoritative operator-managed state | 5, 13-14 |
| [Part 04](../../../.docs/PART_04_BOOTSTRAP_AND_DEPLOYMENT.md) bootstrap/deployment | Applicable | Gateway is deployed outside a developer workstation | 2, 13-14 |
| [Part 05](../../../.docs/PART_05_CI_RELEASES_AND_LOCAL_UPDATES.md) CI/releases/local updates | Applicable | Production releases, migrations and rollback are in scope | 2, 13-14 |
| [Part 06](../../../.docs/PART_06_UNIFIED_ACCEPTANCE_CHECKLIST.md) unified acceptance | Applicable | Always applicable; exclusions require evidence | 0-14 |
| [Part 07](../../../.docs/PART_07_SECURITY_AND_EXPOSURE_CONTROL.md) security/exposure | Applicable | Saturn has secrets, public endpoints, private state and deployment boundaries | 0-14 |
| [Part 09](../../../.docs/PART_09_SERVICE_AGENTS_DEPLOYMENT_AND_LIFECYCLE.md) Telegram/Gryphon | Applicable | Gryphon owns Telegram; Saturn issues and revokes Drop access through an authenticated service adapter | 7 |
| [Part 08](../../../.docs/PART_08_SEO_AND_GEO.md) public/indexable rules | Requires investigation | Authentication, Drop and Share are public non-indexable. Laboratory assets may be public, but indexable HTML pages require an explicit operator decision | 12 |
| Perimetr Excalidraw | Informative | Provides conceptual context for fields, gates and selective exposure; it is not linked as normative by the orchestrator | 0-14 |

## Required non-applicable evidence

SEO/GEO remains `requires investigation` for intentionally indexable
Laboratory wrapper pages. Private files, owner UI, Drop, WebDAV, backup API and
share capability URLs are never made indexable by this unresolved decision.
