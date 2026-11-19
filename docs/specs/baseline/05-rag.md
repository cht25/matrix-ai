# Baseline 05 — Retrieval-augmented generation

**Status:** Partial — deterministic lexical retrieval over trusted Firestore
content is implemented. There are no embeddings, vector index, or reranking
service.

**Evidence:** `src/lib/server/rpc.ts` (`ragSearch`), `src/app/api/ai/route.ts`
(`buildRagContext`), `scripts/seed.mjs`, `tests/groq-prompts.test.ts`,
`README.md` (Firestore data model and AI pipeline sections).

## Implemented behavior

- `ragSearch(d, query, limit)` tokenizes Latin and Bengali alphanumeric terms,
  discards very short tokens, and queries four Firestore sources in parallel:
  `document_chunks` restricted to `trusted_official` / `trusted_internal`,
  active `scam_articles`, `lessons`, and active `reporting_resources`.
- Scoring is deterministic token overlap with a small title bonus. Results are
  sorted by score and limited; each result carries title, content excerpt,
  source type, and trust level. No model call is needed to retrieve.
- `buildRagContext` in the chat gateway requests four chunks, uses up to three
  in the system context, and adds country-matched active reporting resources
  when the user's profile has a country. Retrieval errors are logged and
  degrade to an empty context instead of failing the chat request.
- RAG context is included for normal chat modes and omitted in `agent` mode,
  where the build pipeline and tool results are the relevant context.
- Seed data populates knowledge chunks, scam articles, reporting resources,
  and lessons. Trust labels are data, not a claim about external truth.

## Boundaries and non-goals

- Retrieved text is grounding context, not authority. It cannot grant tool
  permissions or change user authorization.
- `POST /api/rpc` is the only client-facing path to the search helper; the
  browser does not query the knowledge collections directly for this feature.
- No claim is made about semantic similarity, freshness beyond stored records,
  or coverage of sources that were not seeded.

## Partial / planned / deprecated

- **Partial:** retrieval is lexical token overlap; synonyms and embeddings are
  not implemented. The documentation note about a former `tsvector` search is
  historical — Firestore is the current store.
- **Planned:** richer source attribution and re-ranking are not implemented.
