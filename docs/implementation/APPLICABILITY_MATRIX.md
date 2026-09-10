# Normative applicability matrix

This matrix applies the document-selection rules from
`C:\.projects\exocortex\.docs\UNIFICATION_SPECIFICATION.md` to Saturn.

| Document / major section | Status | Reason and evidence | Planned stage |
| --- | --- | --- | --- |
| Unification Specification | Applicable | Orchestrates scope, divergence handling, evidence and handoff for all work | 0-14 |
| Part I §§1-6 UI foundations | Applicable | Saturn has login, settings, collections, file lists and protected mutations | 6-14 |
| Part I §9 responsive/accessibility | Applicable | Web UI supports desktop, narrow screen, keyboard and reduced motion | 6-14 |
| Part II observability/audit/export | Applicable | File mutations, auth, shares, backups and admin actions require bounded structured evidence | 2-14 |
| Part III backup/recovery | Applicable | PostgreSQL, metadata and the bounded local Drop queue are authoritative operator-managed state | 5, 13-14 |
| Part IV bootstrap/deployment | Applicable | Gateway is deployed outside a developer workstation | 2, 13-14 |
| Part V CI/releases/local updates | Applicable | Production releases, migrations and rollback are in scope | 2, 13-14 |
| Part VI unified acceptance | Applicable | Always applicable; exclusions require evidence | 0-14 |
| Part VII security/exposure | Applicable | Saturn has secrets, public endpoints, private state and deployment boundaries | 0-14 |
| Outer Connections: Telegram | Applicable through Gryphon | Gryphon owns Telegram; Saturn issues and revokes Drop access through an authenticated neutral adapter | 7 |
| SEO/GEO public/indexable rules | Requires investigation | Authentication, Drop and Share are public non-indexable. Laboratory assets may be public, but indexable HTML pages require an explicit operator decision | 12 |
| Perimetr Excalidraw | Informative | Provides conceptual context for fields, gates and selective exposure; it is not linked as normative by the orchestrator | 0-14 |

## Required non-applicable evidence

SEO/GEO remains `requires investigation` for intentionally indexable
Laboratory wrapper pages. Private files, owner UI, Drop, WebDAV, backup API and
share capability URLs are never made indexable by this unresolved decision.
