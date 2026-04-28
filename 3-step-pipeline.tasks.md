# 3-Step Evaluation Pipeline — Task List

**Status:** In Progress  
**Created:** 2026-04-28

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

- [ ] Translate `modes/oferta.md` from Spanish to English
- [ ] Translate `modes/pdf.md` from Spanish to English
- [ ] Translate `modes/apply.md` from Spanish to English
- [ ] Translate `modes/contacto.md` from Spanish to English
- [ ] Translate `modes/pipeline.md` from Spanish to English
- [ ] Translate `modes/scan.md` from Spanish to English
- [ ] Translate `modes/batch.md` from Spanish to English
- [ ] Translate `modes/deep.md` from Spanish to English
- [ ] Translate `modes/ofertas.md` from Spanish to English
- [ ] Translate `modes/tracker.md` from Spanish to English
- [ ] Translate `modes/patterns.md` from Spanish to English
- [ ] Translate `modes/followup.md` from Spanish to English
- [ ] Translate `modes/interview-prep.md` from Spanish to English
- [ ] Translate `modes/training.md` from Spanish to English
- [ ] Translate `modes/project.md` from Spanish to English
- [ ] Translate `modes/latex.md` from Spanish to English
- [ ] Translate `modes/auto-pipeline.md` from Spanish to English

---

## Phase 1 — SDK Foundation

- [ ] Add `@anthropic-ai/sdk` to `package.json` (pin to specific version)
- [ ] Run `npm install`
- [ ] Create `batch/lib/` directory
- [ ] Create `batch/lib/worker-utils.mjs` with exports:
  - [ ] `readProjectFile(relPath, required?)`
  - [ ] `buildCachedContext(files[])`
  - [ ] `toolDefinitions(toolNames[])`
  - [ ] `executeTool(name, input, projectDir)`
  - [ ] `runAgentLoop(client, model, system, messages, tools, maxIter)`
  - [ ] `logCacheMetrics(usage)`
- [ ] Create `batch/lib/smoke-test.mjs` — reads `cv.md`, prints first 5 lines
- [ ] Run smoke test, confirm output

---

## Phase 2 — Triage Worker

- [ ] Create `modes/triage.md` — system prompt for triage worker (archetype detection + Blocks A, B, G-text; JSON output schema inline)
- [ ] Create `batch/batch-worker-triage.mjs`:
  - [ ] Arg parsing (`--id`, `--url`, `--jd-file`, `--date`, `--model`)
  - [ ] Read + cache system prompt (`modes/triage.md`)
  - [ ] Read + cache user block 1 (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `config/archetypes.yml`)
  - [ ] Build per-job user block 2 (task instruction + JD content)
  - [ ] Register tools: `read_file`, `web_fetch`
  - [ ] Run agent loop (max 10 iterations)
  - [ ] Validate stdout is parseable JSON; exit non-zero if not
  - [ ] Output triage JSON to stdout
- [ ] Update `batch/batch-runner.sh` — add `--mode=triage`:
  - [ ] Read `batch/batch-input.tsv`
  - [ ] Dispatch rows to `batch-worker-triage.mjs`
  - [ ] Capture stdout, write to `batch/triage-output/{id}.json`
  - [ ] Write state to `batch/triage-state.tsv`
  - [ ] Print completion message after all jobs
- [ ] Validation run: triage 2–3 jobs, confirm JSON output files and state file
- [ ] Verify cache metrics in stderr — second job should show cache hits

---

## Phase 3 — Curation Gate

- [ ] Create `batch/build-curation.mjs`:
  - [ ] Read all `batch/triage-output/*.json`
  - [ ] Generate or update `batch/curation.tsv`
  - [ ] Append new rows; never overwrite filled `decision` values
  - [ ] Sort rows by `fit_score` descending
  - [ ] Print summary on exit (`N new, M decided, K pending`)
- [ ] Add comment header to `curation.tsv` output explaining valid `decision` values
- [ ] Validation: run after triage, confirm rows appear sorted; fill decisions, re-run, confirm no overwrites

---

## Phase 4 — Deep Eval Worker

- [ ] Create `batch/batch-system.md` — system prompt for deep eval worker (Blocks C, D, E, F, G-full; triage import instructions; WebSearch fallback notes)
- [ ] Create `batch/batch-worker-deep.mjs`:
  - [ ] Arg parsing (`--id`, `--url`, `--triage-file`, `--report-num`, `--date`, `--model`)
  - [ ] Load triage JSON from `--triage-file`; inject Blocks A+B into context
  - [ ] Handle cold start path (no triage file — run Blocks A+B from scratch)
  - [ ] Read + cache system prompt (`batch/batch-system.md`)
  - [ ] Read + cache user block 1 (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `config/archetypes.yml`, `templates/cv-template.html`)
  - [ ] Build per-job user block 2 (triage summary + task instruction + JD content)
  - [ ] Register tools: `read_file`, `write_file`, `bash`, `web_fetch`, (`web_search` if `BRAVE_API_KEY` set)
  - [ ] Run agent loop (max 50 iterations)
  - [ ] Confirm outputs written: `reports/`, `output/`, `batch/tracker-additions/`
- [ ] Update `batch/batch-runner.sh` — add `--mode=deep`:
  - [ ] Read `batch/curation.tsv`, filter `decision = APPROVE`
  - [ ] Dispatch to `batch-worker-deep.mjs` with triage file path
  - [ ] Write state to `batch/batch-state.tsv`
  - [ ] Run `merge-tracker.mjs` and `verify-pipeline.mjs` after all jobs complete
- [ ] Add no-mode migration warning to `batch/batch-runner.sh`
- [ ] Validation run: approve 1–2 jobs in curation.tsv, run deep eval, confirm report + PDF + tracker addition

---

## Phase 5 — Integration, Validation, and Cleanup

- [ ] Full end-to-end test: scan → triage → curation → deep on 10+ jobs
- [ ] Confirm `verify-pipeline.mjs` passes after full cycle
- [ ] Compare token usage vs. pre-restructure baseline; confirm ~50–60% reduction target
- [ ] Update `CLAUDE.md` pipeline section to describe 3-step flow
- [ ] Update skill mode table in `CLAUDE.md` — "Batch processes offers" entry
- [ ] Write `batch/README.md` with step-by-step workflow commands
- [ ] Add deprecation header to `batch/batch-prompt.md`
- [ ] Resolve Open Question 1: benchmark Haiku vs. Sonnet for triage quality; document result
- [ ] Optional: implement Brave Search API in `worker-utils.mjs` if `BRAVE_API_KEY` is available
- [ ] Final commit — tag as `v2.0.0` or equivalent
