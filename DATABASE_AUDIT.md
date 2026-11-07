# MATRIX database audit

## Canonical database

Firestore, accessed by the Firebase Admin SDK on the server. Firebase Auth holds account identities. Cloudinary holds uploaded media. There is no active PostgreSQL/Supabase runtime in the checked-in application despite historical comments and `seed/0007_seed.sql`; that SQL file must not be treated as a current migration. No production database connection or data dump was available.

## Record families

- Identity/access: `profiles`, `user_security_settings`, `guardian_consents`, `identity_verifications`, `admin_roles`, `admin_permissions`, `admin_role_permissions`, `admin_role_assignments`, `admin_access_grants`, `user_sessions`.
- Conversations: `conversations/{id}/messages`, `conversation_summaries`, `user_memories`, `attachments`, `ai_usage_logs`, `ai_request_dedup`, `ai_safety_events`.
- Projects: `projects` with `files`, `versions/{id}/files`; `build_runs`, `deployments`, `published_sites/{slug}/files`.
- Family: `families`, `family_members`, `family_invitations`.
- Devices: `pairing_challenges`, `devices`.
- Automation/agent: `automations`, `automation_runs`, `agent_tasks/{id}/checkpoints`.
- Other: courses/modules/lessons/quizzes/answers/attempts/progress, certificates/verifications, scam content/reports/resources, countries, document chunks, notifications, security events, audit logs, counters, GitHub connections and system settings.

## Ownership and integrity findings

1. Most user records use `user_id`; projects/deployments use `owner_id`; family membership combines UID/family ID. Keep these conventions.
2. Browser Firestore writes are denied. Server handlers must validate ownership themselves; Admin SDK bypasses rules.
3. Pairing and invitation consumption use transactions. Automation execution lacks an atomic claim/due-time lease and can double-run when a scheduler is introduced.
4. Project versions exist, but a general visual canvas document/revision model does not. Do not store production canvas state in localStorage.
5. `user_sessions` contains generated random references rather than a binding to the minted session. Device `scopes` are stored but not used as an authorization boundary.
6. Several rules permit public reads of lesson/quiz/module records without checking parent publication; review content exposure before changing rules. Family read rules check membership existence rather than active status in some paths; server APIs remain the authoritative workflow.
7. Provider API keys are stored as plaintext server-only Firestore fields. Browser rules deny access, but encryption at rest/application-layer access auditing should be improved without losing existing keys.
8. Firestore indexes are declared in `firestore.indexes.json`; actual deployed index state was not inspected. New composite queries require matching indexes. Single-field owner queries with bounded in-memory sorting are common and need pagination at scale.

## Migration policy

Use additive Firestore fields with backward-compatible defaults and explicit indexes/rules. Do not delete collections, reset Auth, overwrite family memberships or automatically transfer device ownership. Back up/export and rehearse any data migration in staging. Schema validation is performed in TypeScript/Zod and storage rules, not SQL migrations. New feature records must reference canonical Firebase UIDs and existing project/device IDs.
