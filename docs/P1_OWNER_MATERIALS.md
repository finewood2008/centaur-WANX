# Zhijun owner-authored materials

This extends the single-primary-companion branch with explicit, version-bound material processing. It does not migrate legacy roles or publish an application.

## Contract

- `GET /api/agents/{agent_id}/ontology/owner-documents/{kb_id}/{document_id}` returns a bounded source preview, canonical source version, current model and saved processing status.
- `POST` accepts only `mark`, `generate`, or `revoke`, with expected record version and request ID. Mark/generate require the displayed source version and model reference. The request never accepts source text, prompts, owner IDs, or another expert target.
- Both routes require the owning private primary Zhijun and an owner-only, non-shared WANX knowledge base. Administrative status does not grant access to another person's material.
- Mark persists author attribution (`written` / `spoken`) and model consent without calling a model. Generate is a separate, explicit operation, processing at most 12,000 canonical characters. The client can continue bounded requests or pause between pages.
- Only explicit, verbatim personal statements become pending claims. A one-document inference of personality is not supported. Quotations, fictional voices, transient emotions and embedded instructions should yield no claim; deterministic checks verify output shape and exact source quotations, while attribution remains subject to owner review.
- Model inputs contain the selected page only, not existing personal understanding, memory, or chat history. The server deduplicates statements locally.
- Pending claims and progress are persisted in the same ontology write. Failed writes do not report completion; stale revisions, source edits, revoked grants and model changes reject late inference results. Retrying a committed request returns its receipt rather than invoking the model again.
- `owner_document` evidence contains file/version/range/quote plus grant identity. Every ontology read checks current ownership, sharing, grant and canonical content. Owner confirmation does not bypass these source checks.
- Native memory, original files and conversations are never rewritten. Revocation preserves history and prevents use of dependent claims. New grants do not resurrect old grants or previously rejected statements.

## Migration

`PersonalOntology.owner_documents` defaults to an empty map. Existing documents deserialize without any migration job, automatic scanning or consent. All future writes retain existing model fields, claims and history. No database schema change is needed. Additional evidence fields default empty for older records.

## Validation

- `tests/unit/agents/test_zhijun_owner_documents.py`: isolated in-memory workspaces; consent, pending-only claims, exact evidence, owner confirmation, revocation, source changes, model change, idempotence, concurrency, resume, write failure and minimal model input.
- `tests/unit/knowledge/test_owner_material_boundary.py`: actual temporary knowledge files/indexes and ownership enforcement; changed original files invalidate evidence.
- `tests/integration/test_zhijun_owner_documents.py`: actual HTTP auth, no admin bypass, primary-only access, forbidden payload fields, save/readback and typed OpenAPI contract.
- Real-model acceptance uses eight synthetic cases, repeated twice with the configured DeepSeek/deepseek-v4-flash model, through `material_command`. The actual account is used only to read model configuration; source fixtures and output workspaces are isolated. No personal content enters the model request.
- UI consent, processing, pause/resume, reconciliation and legacy-service behavior are tested in the paired Zhijun client repository.

First-pass pagination can omit incomplete sentences at page boundaries. This is conservative extraction, not a guarantee of exhaustive viewpoint coverage. Owner review remains mandatory. Follow-up roadmap: decision/review loop, batch confirmation, formal extension registration, then separately authorized public-avatar work.

## Local acceptance result (2026-10-19)

Final `make all` passed: 4,802 tests passed, 17 skipped; lint/format and mypy (647 source files) passed. The initial high-concurrency run had one event-loop scheduling timeout; the isolated test and the full four-worker rerun both passed. Client server/UI/desktop suites passed (128/103/22); production build passed. Real-model synthetic cases passed 16/16. This is local validation, not publication or exhaustive model-quality certification.

The existing local native application was updated and opened. Actual-account verification was read-only: original knowledge files remained visible, consent stayed unchecked, and no owner-material grants were created. Controlled restart comparison found all 480 tables across 12 native-memory databases unchanged. No migration or WeChat switch was performed.
