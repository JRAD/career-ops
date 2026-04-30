# 3-Step Evaluation Pipeline — Task List

**Status:** Complete ✅  
**Created:** 2026-04-28  
**Completed:** 2026-04-30

**Related documents:**
- [Specification](3-step-pipeline.spec.md)
- [Implementation Plan](3-step-pipeline.implementation.md)

---

## Phase 0 — Fork Cleanup

### Blocking (must complete before Phase 1)

- [x] Delete `modes/de/` — German language variant
- [x] Delete `modes/fr/` — French language variant
- [x] Delete `modes/ja/` — Japanese language variant
- [x] Delete `modes/pt/` — Portuguese language variant
- [x] Delete `modes/ru/` — Russian language variant
- [x] Delete `.gemini/commands/` — Gemini CLI command files
- [x] Delete `gemini-eval.mjs` — Gemini evaluation script
- [x] Delete `GEMINI.md` — Gemini CLI context file
- [x] Delete `.opencode/commands/` — OpenCode command files
- [x] Replace santifer archetypes with Backend/SDET archetypes in `config/archetypes.yml`
- [x] Update `modes/_shared.md` — replace inline archetype table with reference to `config/archetypes.yml`
- [x] Update `batch/batch-prompt.md` — replace inline archetype + framing tables with reference to `config/archetypes.yml` and `modes/_profile.md`
- [x] Strip `CLAUDE.md`: remove OpenCode commands table, Gemini CLI commands table, language modes section, CI/CD section, community/governance section, update checker invocation

### Non-Blocking (complete before Phase 2)

- [x] Translate `modes/oferta.md` from Spanish to English
- [x] Translate `modes/pdf.md` from Spanish to English
- [x] Translate `modes/apply.md` from Spanish to English
- [x] Translate `modes/contacto.md` from Spanish to English
- [x] Translate `modes/pipeline.md` from Spanish to English
- [x] Translate `modes/scan.md` from Spanish to English
- [x] Translate `modes/batch.md` from Spanish to English
- [x] Translate `modes/deep.md` from Spanish to English
- [x] Translate `modes/ofertas.md` from Spanish to English
- [x] Translate `modes/tracker.md` from Spanish to English
- [x] Translate `modes/patterns.md` from Spanish to English
- [x] Translate `modes/followup.md` from Spanish to English
- [x] Translate `modes/interview-prep.md` from Spanish to English
- [x] Translate `modes/training.md` from Spanish to English
- [x] Translate `modes/project.md` from Spanish to English
- [x] Translate `modes/latex.md` from Spanish to English
- [x] Translate `modes/auto-pipeline.md` from Spanish to English

---

## Phase 1 — SDK Foundation

- [x] Add `@anthropic-ai/sdk` to `package.json` (pin to specific version)
- [x] Run `npm install`
- [x] Create `batch/lib/` directory
- [x] Create `batch/lib/worker-utils.mjs` with exports:
  - [x] `readProjectFile(relPath, required?)`
  - [x] `buildCachedContext(files[])`
  - [x] `toolDefinitions(toolNames[])`
  - [x] `executeTool(name, input, projectDir)`
  - [x] `runAgentLoop(client, model, system, messages, tools, maxIter)`
  - [x] `logCacheMetrics(usage)`
- [x] Create `batch/lib/smoke-test.mjs` — reads `cv.md`, prints first 5 lines
- [x] Run smoke test, confirm output

---

## Phase 2 — Triage Worker

- [x] Create `modes/triage.md` — system prompt for triage worker (archetype detection + Blocks A, B, G-text; JSON output schema inline)
- [x] Create `batch/batch-worker-triage.mjs`:
  - [x] Arg parsing (`--id`, `--url`, `--jd-file`, `--date`, `--model`)
  - [x] Read + cache system prompt (`modes/triage.md`)
  - [x] Read + cache user block 1 (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `config/archetypes.yml`)
  - [x] Build per-job user block 2 (task instruction + JD content)
  - [x] Register tools: `read_file`, `web_fetch`
  - [x] Run agent loop (max 10 iterations)
  - [x] Validate stdout is parseable JSON; exit non-zero if not
  - [x] Output triage JSON to stdout
- [x] Update `batch/batch-runner.sh` — add `--mode=triage`:
  - [x] Read `batch/batch-input.tsv`
  - [x] Dispatch rows to `batch-worker-triage.mjs`
  - [x] Capture stdout, write to `batch/triage-output/{id}.json`
  - [x] Write state to `batch/triage-state.tsv`
  - [x] Print completion message after all jobs
- [x] Validation run: triage 2–3 jobs, confirm JSON output files and state file
- [x] Verify cache metrics in stderr — second job should show cache hits

---

## Phase 3 — Curation Gate

- [x] Create `batch/build-curation.mjs`:
  - [x] Read all `batch/triage-output/*.json`
  - [x] Generate or update `batch/curation.tsv`
  - [x] Append new rows; never overwrite filled `decision` values
  - [x] Sort rows by `fit_score` descending
  - [x] Print summary on exit (`N new, M decided, K pending`)
- [x] Add comment header to `curation.tsv` output explaining valid `decision` values
- [x] Validation: run after triage, confirm rows appear sorted; fill decisions, re-run, confirm no overwrites

---

## Phase 4 — Deep Eval Worker

- [x] Create `batch/batch-system.md` — system prompt for deep eval worker (Blocks C, D, E, F, G-full; triage import instructions; WebSearch fallback notes)
- [x] Create `batch/batch-worker-deep.mjs`:
  - [x] Arg parsing (`--id`, `--url`, `--triage-file`, `--report-num`, `--date`, `--model`)
  - [x] Load triage JSON from `--triage-file`; inject Blocks A+B into context
  - [x] Handle cold start path (no triage file — run Blocks A+B from scratch)
  - [x] Read + cache system prompt (`batch/batch-system.md`)
  - [x] Read + cache user block 1 (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `config/archetypes.yml`, `templates/cv-template.html`)
  - [x] Build per-job user block 2 (triage summary + task instruction + JD content)
  - [x] Register tools: `read_file`, `write_file`, `bash`, `web_fetch`, (`web_search` if `BRAVE_API_KEY` set)
  - [x] Run agent loop (max 50 iterations)
  - [x] Confirm outputs written: `reports/`, `output/`, `batch/tracker-additions/`
- [x] Update `batch/batch-runner.sh` — add `--mode=deep`:
  - [x] Read `batch/curation.tsv`, filter `decision = APPROVE`
  - [x] Dispatch to `batch-worker-deep.mjs` with triage file path
  - [x] Write state to `batch/batch-state.tsv`
  - [x] Run `merge-tracker.mjs` and `verify-pipeline.mjs` after all jobs complete
- [x] Add no-mode migration warning to `batch/batch-runner.sh`
- [x] Validation run: approve 1–2 jobs in curation.tsv, run deep eval, confirm report + PDF + tracker addition

---

## Phase 5 — Integration, Validation, and Cleanup

- [x] Full end-to-end test: scan → triage → curation → deep on 10+ jobs
- [x] Confirm `verify-pipeline.mjs` passes after full cycle
- [x] Compare token usage vs. pre-restructure baseline; confirm ~50–60% reduction target
- [x] Update `CLAUDE.md` pipeline section to describe 3-step flow
- [x] Update skill mode table in `CLAUDE.md` — "Batch processes offers" entry
- [x] Write `batch/README.md` with step-by-step workflow commands
- [x] Add deprecation header to `batch/batch-prompt.md`
- [x] Resolve Open Question 1: benchmark Haiku vs. Sonnet for triage quality; document result
- [x] Optional: implement Brave Search API in `worker-utils.mjs` if `BRAVE_API_KEY` is available
- [x] Final commit — tag as `v2.0.0` or equivalent
