# 3-Step Evaluation Pipeline — Implementation Plan

**Status:** Draft  
**Created:** 2026-04-28

**Related documents:**
- [Specification](3-step-pipeline.spec.md)
- [Task List](3-step-pipeline.tasks.md)

---

## Phase 0 — Fork Cleanup

**Goal:** Remove upstream noise that inflates context and conflicts with the new architecture before writing any new code.

**Blocking tasks (must complete before Phase 1):**
- Delete unused language mode directories (`modes/de/`, `modes/fr/`, `modes/ja/`, `modes/pt/`, `modes/ru/`) — ~1,050 lines of context noise
- Delete Gemini CLI files (`.gemini/commands/`, `gemini-eval.mjs`, `GEMINI.md`) — 319-line eval script + 15 command TOMLs
- Delete OpenCode command files (`.opencode/commands/`) — 14 markdown command files
- Replace santifer archetypes with Backend/SDET archetypes in `config/archetypes.yml`
- Update `modes/_shared.md` to reference `config/archetypes.yml` instead of inlining the archetype table
- Update `batch/batch-prompt.md` similarly
- Strip irrelevant sections from `CLAUDE.md`: OpenCode commands, Gemini CLI commands, language modes, CI/CD, community/governance, update checker invocation

**Non-blocking tasks (complete before Phase 2):**
- Translate all 17 interactive modes from Spanish to English (`modes/oferta.md`, `modes/pdf.md`, `modes/apply.md`, `modes/contacto.md`, `modes/pipeline.md`, `modes/scan.md`, `modes/batch.md`, `modes/deep.md`, `modes/ofertas.md`, `modes/tracker.md`, `modes/patterns.md`, `modes/followup.md`, `modes/interview-prep.md`, `modes/training.md`, `modes/project.md`, `modes/latex.md`, `modes/auto-pipeline.md`)

**Outcome:** Clean repo scoped to Claude Code only, with Backend/SDET archetypes. Interactive modes are in English.

---

## Phase 1 — SDK Foundation

**Goal:** Install the Anthropic SDK and create the shared worker utilities library that both triage and deep workers will import. No end-to-end behavior changes yet.

**What to build:**

1. **Add `@anthropic-ai/sdk`** to `package.json` and install. Pin to a specific version.

2. **Create `batch/lib/worker-utils.mjs`** — shared utilities exported to both workers:
   - `readProjectFile(relPath, required?)` — reads a file relative to project root; throws if `required=true` and missing
   - `buildCachedContext(files[])` — reads the given files and returns them as Anthropic content blocks with `cache_control: { type: "ephemeral" }` applied to the last block in the array (cache checkpoint pattern)
   - `toolDefinitions(toolNames[])` — returns Anthropic tool schema objects for the named subset of tools (`read_file`, `write_file`, `bash`, `web_fetch`, `web_search`)
   - `executeTool(name, input, projectDir)` — executes a tool call and returns the string result; handles path resolution, error capture, and stdout/stderr for bash
   - `runAgentLoop(client, model, system, messages, tools, maxIter)` — standard agentic tool-use loop: sends request, handles `tool_use` blocks, accumulates `tool_result` messages, stops on `end_turn` or `maxIter`; returns the final assistant text
   - `logCacheMetrics(usage)` — writes cache hit/miss metrics to stderr in a consistent format for monitoring

3. **Smoke test** the library by writing a minimal `batch/lib/smoke-test.mjs` that calls `readProjectFile` on `cv.md` and prints the first 5 lines.

**Outcome:** SDK is installed. Shared library exists and is testable. Neither worker exists yet.

---

## Phase 2 — Triage Worker

**Goal:** Build Step 1 end-to-end: scan input → triage JSON output per job.

**What to build:**

1. **`modes/triage.md`** — system prompt for the triage worker. Instructs the model to run archetype detection + Blocks A, B, and G-text only. No PDF. No tracker entry. Output MUST be a single valid JSON object matching the schema in the spec. Includes the JSON schema inline so the model knows exactly what fields are required.

2. **`batch/batch-worker-triage.mjs`** — SDK worker:
   - Parses args: `--id`, `--url`, `--jd-file` (optional), `--date`, `--model` (optional, default `claude-sonnet-4-6`)
   - Reads and caches: `modes/triage.md` (system), then `cv.md` + `config/profile.yml` + `modes/_profile.md` + `article-digest.md` + `config/archetypes.yml` (user block 1, cached)
   - Per-job user block 2: task instruction + JD content (not cached)
   - Tools available: `read_file`, `web_fetch`
   - Max iterations: 10
   - On completion: validates that stdout is parseable JSON; exits non-zero if not
   - Outputs triage JSON to **stdout only** — orchestrator writes the file

3. **Update `batch/batch-runner.sh`** to support `--mode=triage`:
   - Reads `batch/batch-input.tsv`
   - Dispatches each row to `batch-worker-triage.mjs`
   - Captures stdout and writes to `batch/triage-output/{id}.json`
   - Writes orchestration state to `batch/triage-state.tsv` (same schema as `batch-state.tsv`)
   - After all jobs complete: prints `Triage complete. Run 'node batch/build-curation.mjs' to generate curation list.`
   - Preserves existing parallelism, locking, and retry logic

**Validation:** Run triage on 2–3 jobs from `batch-input.tsv` (or a test fixture). Confirm JSON files appear in `batch/triage-output/`. Confirm `triage-state.tsv` is written. Check cache metrics in stderr — second job in same batch should show cache hits on system + CV block.

**Outcome:** Step 1 is functional. Triage runs cheaply with prompt caching verified.

---

## Phase 3 — Curation Gate

**Goal:** Build Step 2: convert triage JSON output into a reviewable TSV the user can fill in.

**What to build:**

1. **`batch/build-curation.mjs`**:
   - Reads all `batch/triage-output/*.json`
   - Generates or updates `batch/curation.tsv`
   - New rows are appended; existing rows with a filled `decision` are never modified
   - Rows sorted by `fit_score` descending
   - On exit, prints: `N new jobs added. M jobs already have decisions. K jobs pending review.`

2. **`curation.tsv` format documentation** — add a comment header row to the file explaining valid `decision` values (`APPROVE` / `SKIP`) so the user knows what to fill in without consulting the spec.

**Validation:** Run `build-curation.mjs` after a triage run. Confirm all triage outputs appear as rows, sorted by score. Manually fill a few `APPROVE`/`SKIP` decisions and re-run — confirm existing decisions are preserved.

**Outcome:** The human curation gate works. Step 2 is complete.

---

## Phase 4 — Deep Eval Worker

**Goal:** Build Step 3: full evaluation on approved jobs only.

**What to build:**

1. **`batch/batch-system.md`** — system prompt for the deep eval worker. Covers Blocks C, D, E, F, and G-full. Imports Blocks A+B from injected triage context — instructs the model to treat them as already complete and build on them. Same PDF generation rules as today's `batch-prompt.md`. Includes explicit note: if `BRAVE_API_KEY` is not set, skip Block D WebSearch and Block G layoff check, noting `"Layoff check skipped — BRAVE_API_KEY not configured"`.

2. **`batch/batch-worker-deep.mjs`** — SDK worker:
   - Parses args: `--id`, `--url`, `--triage-file`, `--report-num`, `--date`, `--model`
   - Reads triage JSON from `--triage-file`; injects Blocks A+B into user context
   - If `--triage-file` is missing or unreadable: runs Blocks A+B from scratch (cold start path)
   - Reads and caches: `batch/batch-system.md` (system), then `cv.md` + `config/profile.yml` + `modes/_profile.md` + `article-digest.md` + `config/archetypes.yml` + `templates/cv-template.html` (user block 1, cached)
   - Per-job user block 2: task instruction + triage JSON summary + JD content
   - Tools available: `read_file`, `write_file`, `bash`, `web_fetch`, `web_search` (only if `BRAVE_API_KEY` set)
   - Max iterations: 50
   - Outputs: `reports/`, `output/`, `batch/tracker-additions/`

3. **Update `batch/batch-runner.sh`** to support `--mode=deep`:
   - Reads `batch/curation.tsv`, filters to `decision = APPROVE`
   - Dispatches each row to `batch-worker-deep.mjs` with the triage JSON path
   - After all jobs complete: runs `node merge-tracker.mjs` and `node verify-pipeline.mjs`
   - Writes state to `batch/batch-state.tsv` (existing state file, unchanged)

4. **No-mode warning:** If `batch-runner.sh` is invoked without `--mode`, print the migration warning from the spec (Section 6) and exit non-zero.

**Validation:** Run full pipeline on 1–2 approved jobs. Confirm report `.md` is written, PDF is generated, tracker addition TSV exists. Run `merge-tracker.mjs` and confirm `applications.md` is updated. Compare token usage vs. a baseline full eval — deep worker should show cache hits; total batch cost should be significantly lower.

**Outcome:** All three steps are functional end-to-end.

---

## Phase 5 — Integration, Validation, and Cleanup

**Goal:** Harden the pipeline, update documentation, and deprecate the old path.

**What to do:**

1. **End-to-end integration test:** Run a full batch cycle from scan through deep eval on a realistic set of 10+ jobs. Validate output quality, token metrics, and pipeline integrity (`verify-pipeline.mjs` passes).

2. **Update `CLAUDE.md`** pipeline section to describe the 3-step flow as the canonical path. Update skill mode table so "Batch processes offers" → describes the new 3-step workflow.

3. **Write `batch/README.md`** with the step-by-step workflow:
   ```
   Step 0: node scan.mjs               → batch/batch-input.tsv
   Step 1: ./batch/batch-runner.sh --mode=triage
   Step 2: node batch/build-curation.mjs → fill batch/curation.tsv
   Step 3: ./batch/batch-runner.sh --mode=deep
   ```

4. **Deprecate `batch/batch-prompt.md`:** Add a header comment:
   ```
   # DEPRECATED — This prompt is retained for manual claude -p use only.
   # The canonical batch pipeline now uses batch-worker-triage.mjs and batch-worker-deep.mjs.
   # See batch/README.md for the current workflow.
   ```

5. **Optional — Brave Search API integration:** If `BRAVE_API_KEY` is available in the environment, wire up a `web_search` tool implementation in `worker-utils.mjs` that calls the Brave Search API. Gate it cleanly so absence of the key produces a graceful fallback, not an error.

6. **Model selection review (Open Question 1):** Benchmark triage quality using `claude-haiku-4-5` vs. `claude-sonnet-4-6`. If Haiku produces acceptable triage JSON quality, document the `--model` override and update the default recommendation.

**Outcome:** Pipeline is production-ready. Old path is deprecated with clear migration guidance. Documentation matches reality.
