# 3-Step Evaluation Pipeline — Specification

**Status:** Draft  
**Created:** 2026-04-28  
**Scope:** Restructure the batch evaluation pipeline from a monolithic single-pass flow into a three-stage process with a human curation gate between lightweight triage and full deep evaluation.

---

## 1. Problem Statement

The current batch pipeline runs full evaluation (Blocks A–G + PDF + tracker entry) on every job offer discovered by the scanner. This has three consequences:

1. **Expensive work on low-fit jobs.** Deep evaluation blocks (C: level strategy, D: comp research, E: personalization, F: interview prep) run even on jobs that score 2.5/5 on CV fit. These blocks are the most token-intensive and the least reusable across jobs.

2. **No user gate before expensive work.** There is no point in the pipeline where a human decides which jobs are worth pursuing before PDFs are generated and tracker entries are written.

3. **Prompt caching not applicable.** Workers run via `claude -p`, which does not expose `cache_control` headers. The system prompt and CV/profile data — identical across every job in a batch — are re-tokenized from scratch for every worker.

---

## 2. Goals

- Reduce total token cost per batch by ~50–60% through pipeline separation and prompt caching
- Insert an explicit human curation step between triage and deep evaluation
- Generate PDFs and tracker entries only for jobs the user has approved
- Replace `claude -p` workers with Anthropic SDK workers that support prompt caching
- Preserve the existing orchestration infrastructure (`batch-runner.sh` state management, parallelism, locking, retry logic)

---

## 3. Non-Goals

- Replacing or modifying `scan.mjs` (Step 0 is out of scope)
- Changes to the evaluation *logic* of interactive modes (`oferta`, `pipeline`, etc.) — translation to English is in scope for Phase 0, logic changes are not
- Building a UI for the curation step — editing a TSV file is sufficient
- Removing `batch-prompt.md` or the `claude -p` path immediately — deprecated, not deleted

---

## 4. Target Architecture

```
Step 0 — Scan (existing)
  scan.mjs hits Greenhouse/Ashby/Lever APIs
  → batch/batch-input.tsv (candidate URLs, zero AI cost)

Step 1 — Triage
  batch-runner.sh --mode=triage
  batch-worker-triage.mjs (SDK + prompt caching)
  Blocks: A (role summary) + B (CV match + gaps) + G-text (JD quality) + comp signal from JD
  → batch/triage-output/{id}.json  (one file per job)
  → batch/triage-state.tsv         (orchestration state)

Step 2 — Curation (human)
  node batch/build-curation.mjs
  → batch/curation.tsv  (generated from triage output)
  User fills `decision` column: APPROVE or SKIP

Step 3 — Deep Evaluation
  batch-runner.sh --mode=deep
  batch-worker-deep.mjs (SDK + prompt caching)
  Reads: curation.tsv (APPROVE rows only) + triage-output/{id}.json (re-uses Blocks A+B)
  Blocks: C (level strategy) + D (comp research) + E (personalization) + F (interview prep) + G-full (incl. layoff check)
  → reports/{num}-{slug}-{date}.md
  → output/cv-candidate-{slug}-{date}.pdf
  → batch/tracker-additions/{id}.tsv
  → merge-tracker.mjs → data/applications.md
```

### What changes vs. today

| Aspect | Current | Target |
|---|---|---|
| Workers | `claude -p` (no caching) | Anthropic SDK with `cache_control` |
| Triage | None — all jobs get full eval | New: Blocks A+B+G-text+comp signal only |
| Deep eval | Every scanned job | Approved jobs only (~20–30% of triage volume) |
| PDF generation | Every job | Approved jobs only |
| WebSearch | Available via `claude -p` | Optional via Brave Search API (gated on env var); WebFetch fallback |
| Human gate | None | `curation.tsv` approval step |
| Block A+B in deep | Re-run from scratch | Imported from triage JSON — not re-run |

---

## 5. Step Specifications

### Step 1 — Triage

**Purpose:** Determine fit quickly and cheaply. The output is enough signal for a human to decide whether to invest in full evaluation.

**What triage runs:**

| Block | Description | Requires WebSearch? |
|---|---|---|
| Archetype detection | Classify into one of 6 archetypes (read `config/archetypes.yml`) | No |
| Block A | Role summary: archetype, domain, function, seniority, remote, TL;DR | No |
| Block B | CV match score + top 3 matches (cited from cv.md) + top 3 gaps (with severity) | No |
| Block G (text-only) | JD description quality, reposting check against scan-history.tsv | No |
| Comp signal | Read compensation cues from JD text only — explicit range, contractor vs FTE, structural flags | No |

**What triage explicitly does NOT run:** Blocks C, D, E, F. No PDF. No tracker entry. No WebSearch.

**Input:**
- `--id`, `--url`, `--jd-file` (optional pre-fetched JD), `--date`
- Reads: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `config/archetypes.yml`
- Uses `web_fetch` to retrieve JD if `--jd-file` is absent or empty

**Output:** `batch/triage-output/{id}.json`

```json
{
  "id": "42",
  "url": "https://jobs.example.com/staff-ai-engineer",
  "company": "Acme Corp",
  "role": "Staff AI Engineer",
  "date": "2026-04-28",
  "archetype": "AI Platform / LLMOps",
  "archetype_confidence": "high",
  "fit_score": 4.2,
  "recommendation": "STRONG_MATCH",
  "top_matches": [
    "3 years production LLM pipeline work — matches 'observability platform' requirement directly",
    "RAG system over 12k docs — addresses retrieval scaling requirement"
  ],
  "top_gaps": [
    { "gap": "No Kubernetes experience mentioned in CV", "severity": "blocker" },
    { "gap": "Scala not listed in skills", "severity": "nice-to-have" }
  ],
  "comp_signal": "not_stated",
  "comp_note": "No salary range in JD. Staff-level role at public company — market rate likely $180–220k base.",
  "legitimacy_tier": "High Confidence",
  "legitimacy_signals": [
    { "signal": "Specific tech stack named (Ray, Prometheus, OTel)", "weight": "Positive" },
    { "signal": "Named team structure and reporting line", "weight": "Positive" },
    { "signal": "No prior appearances in scan-history.tsv", "weight": "Positive" }
  ],
  "summary": "Strong LLMOps match with direct overlap on observability and RAG pipelines. K8s gap is real but likely bridgeable given adjacent infra experience. Posting appears genuine."
}
```

**Recommendation thresholds:**

| Value | Fit Score |
|---|---|
| `STRONG_MATCH` | ≥ 4.0 |
| `MATCH` | 3.5 – 3.9 |
| `WEAK_MATCH` | 3.0 – 3.4 |
| `SKIP` | < 3.0 |

**Comp signal values:** `above_market` · `at_market` · `below_market` · `not_stated` · `contractor_only` · `equity_heavy`

**Prompt caching strategy:**
- System (`modes/triage.md`) → `cache_control: ephemeral` — identical for all jobs in batch
- User message block 1 (CV + profile + archetypes) → `cache_control: ephemeral` — identical for all jobs
- User message block 2 (per-job task + JD content) → no cache — unique per job

**State file:** `batch/triage-state.tsv` (same schema as `batch/batch-state.tsv`)

**Available tools:** `read_file`, `web_fetch`  
**Max agent iterations:** 10 (triage is lightweight — should complete in 2–4 turns)

---

### Step 2 — Curation

**Purpose:** Human decision point. The user reviews triage output and marks which jobs to invest in.

**How it works:**

1. Run `node batch/build-curation.mjs` after triage completes
2. Script reads all `batch/triage-output/*.json` and generates or updates `batch/curation.tsv`
3. User opens `curation.tsv` and fills the `decision` column for each row
4. Only rows where `decision = APPROVE` proceed to Step 3

**`batch/curation.tsv` format** (tab-separated):

```
id	url	company	role	score	recommendation	legitimacy	comp_signal	decision	notes
42	https://...	Acme Corp	Staff AI Engineer	4.2	STRONG_MATCH	High Confidence	not_stated		
17	https://...	Other Co	Product Manager	3.1	WEAK_MATCH	Proceed with Caution	below_market		
```

`decision` values: `APPROVE` | `SKIP` (blank = not yet reviewed)

**`build-curation.mjs` behavior:**
- Adds new rows for any triage JSON not already in `curation.tsv`
- Preserves existing `decision` and `notes` values — never overwrites a filled decision
- Rows sorted by `score` descending for easier review
- Exits with a summary: `N new jobs added. M jobs already have decisions. K jobs pending review.`

---

### Step 3 — Deep Evaluation

**Purpose:** Full evaluation on approved jobs only. Produces the report, tailored PDF, and tracker entry.

**What deep eval runs:**

| Block | Description | Requires WebSearch? |
|---|---|---|
| Block A | Imported from triage JSON — not re-run | No |
| Block B | Imported from triage JSON — not re-run | No |
| Block C | Level & strategy: positioning, downlevel plan | No |
| Block D | Comp & demand: live market data, company comp reputation | Yes (optional) |
| Block E | Personalization plan: top CV + LinkedIn changes | No |
| Block F | Interview prep: 6–10 STAR+R stories mapped to JD requirements | No |
| Block G (full) | Full legitimacy including layoff/freeze search | Yes (optional) |

**WebSearch handling:**
- If `BRAVE_API_KEY` env var is set: Block D and Block G layoff check use Brave Search API
- If not set: Block D uses training knowledge + JD text signals; Block G layoff check is skipped with a note: `"Layoff check skipped — BRAVE_API_KEY not configured"`
- Evaluation quality is not materially affected for the fit assessment (Blocks A–C, E–F are unaffected)

**Input:**
- Reads `batch/curation.tsv` filtered to `decision = APPROVE`
- Per job: `--id`, `--url`, `--triage-file` (path to triage JSON), `--report-num`, `--date`
- Reads: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `config/archetypes.yml`, `templates/cv-template.html`

**Block A+B injection:** Deep worker loads the triage JSON and injects Blocks A and B results into the prompt context as "already completed — build on these, do not re-run." If triage JSON is missing (e.g., job added to curation manually), worker runs Blocks A+B from scratch.

**Output:**
- `reports/{num}-{slug}-{date}.md` — full A–G report (same format as today)
- `output/cv-candidate-{slug}-{date}.pdf` — tailored PDF
- `batch/tracker-additions/{id}.tsv` — for merge into `applications.md`

**Prompt caching strategy:** Same as triage — system prompt and CV/profile block cached.

**State file:** `batch/batch-state.tsv` (existing, unchanged)

**Available tools:** `read_file`, `write_file`, `bash`, `web_fetch`, `web_search` (if Brave key present)  
**Max agent iterations:** 50

---

## 6. Worker Architecture

### Shared library: `batch/lib/worker-utils.mjs`

Both workers import shared utilities to avoid duplication:

```
batch/lib/worker-utils.mjs
  exports:
    readProjectFile(relPath, required?)  → string | null
    buildCachedContext(files[])          → content blocks with cache_control
    toolDefinitions(toolNames[])         → Anthropic tool schema array
    executeTool(name, input, projectDir) → string (tool result)
    runAgentLoop(client, model, system, messages, tools, maxIter) → final text
    logCacheMetrics(usage)               → stderr output
```

**Tool inventory:**

| Tool | Available in triage | Available in deep |
|---|---|---|
| `read_file` | Yes | Yes |
| `write_file` | No | Yes |
| `bash` | No | Yes |
| `web_fetch` | Yes | Yes |
| `web_search` | No | Yes (if Brave key) |

Triage intentionally has no `write_file` or `bash` — the worker returns JSON to stdout and the orchestrator writes the output file. This keeps triage workers stateless.

### `batch/batch-worker-triage.mjs`

```
Args: --id --url [--jd-file] --date [--model]
Reads: modes/triage.md, cv.md, config/profile.yml, modes/_profile.md,
       article-digest.md, config/archetypes.yml
Outputs to stdout: triage JSON
Orchestrator writes: batch/triage-output/{id}.json
```

### `batch/batch-worker-deep.mjs`

```
Args: --id --url --triage-file --report-num --date [--model]
Reads: batch/batch-system.md, cv.md, config/profile.yml, modes/_profile.md,
       article-digest.md, config/archetypes.yml, batch/triage-output/{id}.json
Outputs: reports/, output/, batch/tracker-additions/
```

### Orchestrator: `batch/batch-runner.sh`

Add `--mode` parameter (default: `triage`):

```bash
./batch/batch-runner.sh --mode=triage              # Step 1
./batch/batch-runner.sh --mode=deep                # Step 3
./batch/batch-runner.sh --mode=triage --parallel=3 # Parallel triage
```

**Mode=triage:** reads `batch/batch-input.tsv`, dispatches to `batch-worker-triage.mjs`, writes state to `batch/triage-state.tsv`. After all jobs complete, prints: `Triage complete. Run 'node batch/build-curation.mjs' to generate curation list.`

**Mode=deep:** reads `batch/curation.tsv` filtered to `decision = APPROVE`, dispatches to `batch-worker-deep.mjs`, writes state to `batch/batch-state.tsv`. After all jobs complete, runs `merge-tracker.mjs` and `verify-pipeline.mjs` as today.

**No-mode (backward compat):** Print a migration warning and exit:
```
The batch pipeline has been restructured. Use:
  --mode=triage   Run Step 1 (fit assessment on all scanned jobs)
  --mode=deep     Run Step 3 (full evaluation on approved jobs)
See batch/README.md for the full workflow.
```

---

## 7. File Inventory

### New system-layer files (auto-updatable)

| File | Description |
|---|---|
| `modes/triage.md` | System prompt for triage worker |
| `batch/batch-system.md` | System prompt for deep eval worker |
| `batch/batch-worker-triage.mjs` | Step 1 SDK worker |
| `batch/batch-worker-deep.mjs` | Step 3 SDK worker |
| `batch/lib/worker-utils.mjs` | Shared worker utilities |
| `batch/build-curation.mjs` | Generates/updates curation.tsv from triage output |

### New user-layer files (never auto-updated)

| File | Description |
|---|---|
| `batch/curation.tsv` | Step 2 decisions — user fills `decision` column |
| `batch/triage-output/{id}.json` | Triage result per job |
| `batch/triage-state.tsv` | Triage orchestration state |

### Modified files

| File | Change |
|---|---|
| `batch/batch-runner.sh` | Add `--mode` parameter; dispatch to appropriate worker |
| `package.json` | Add `@anthropic-ai/sdk` dependency |
| `CLAUDE.md` | Update pipeline section to describe 3-step flow |
| `batch/README.md` | Rewrite for new workflow |

### Deprecated (retained, not deleted)

| File | Notes |
|---|---|
| `batch/batch-prompt.md` | Add deprecation header; retained for manual `claude -p` use |

### Deleted in Phase 0

| File / Directory | Reason |
|---|---|
| `modes/de/` | Language variant unused; ~200 lines of context noise |
| `modes/fr/` | Language variant unused; ~200 lines of context noise |
| `modes/ja/` | Language variant unused; ~220 lines of context noise |
| `modes/pt/` | Language variant unused; ~215 lines of context noise |
| `modes/ru/` | Language variant unused; ~215 lines of context noise |
| `update-system.mjs` (disabled, not deleted) | Upstream update check points to `santifer/career-ops`; will conflict with system-layer changes made in Phases 1–5. Remove the session-start invocation from `CLAUDE.md`; retain the file itself in case the user wants to re-purpose it for their own versioning later. |
| `gemini-eval.mjs` | Remove if Gemini CLI is not in use; confirm with user before deleting |
| `.gemini/commands/` | Remove if Gemini CLI is not in use; confirm with user before deleting |
| `.opencode/commands/` | Remove if OpenCode is not in use; confirm with user before deleting |

---

## 8. Implementation Plan

### Phase 0 — Fork Cleanup

Establish clean ownership of the codebase before any new code is written. Two tiers:

**Blocking — must complete before Phase 1:**
- Remove the upstream update check invocation from `CLAUDE.md` (the `node update-system.mjs check` silent session-start call). The mechanism points at `santifer/career-ops`; applying an upstream update during Phase 1–5 work would overwrite new system-layer files. Retain `update-system.mjs` itself for potential re-use.
- Delete all unused language variant directories: `modes/de/`, `modes/fr/`, `modes/ja/`, `modes/pt/`, `modes/ru/`. Roughly 1,050 lines of evaluation logic in languages not in use. No functional impact — these directories are only loaded when `language.modes_dir` is set in `profile.yml`, which it isn't.

**Non-blocking — complete before Phase 2:**
- Translate all primary interactive modes to English. These are used in one-off interactive sessions (paste a URL, ask for a PDF). They still function in Spanish but produce Spanish-language evaluation output and create friction when inspecting or modifying them. Files: `modes/oferta.md`, `modes/pdf.md`, `modes/apply.md`, `modes/contacto.md`, `modes/pipeline.md`, `modes/scan.md`, `modes/batch.md`, `modes/deep.md`, `modes/ofertas.md`, `modes/tracker.md`, `modes/patterns.md`, `modes/followup.md`, `modes/interview-prep.md`, `modes/training.md`, `modes/project.md`, `modes/latex.md`, `modes/auto-pipeline.md`. Translate prose and instructions; do not change evaluation logic.
- Update `config/archetypes.yml` to reflect the user's actual target roles. The current archetypes mirror santifer's AI/automation career. This file drives archetype detection in every triage and deep eval run — getting it right before Phase 2 means the triage system prompt is calibrated from day one.
- Update `CLAUDE.md` origin section — remove or replace the santifer attribution and portfolio link.
- Confirm and remove unused CLI tooling: `gemini-eval.mjs` and `.gemini/commands/` if not using Gemini CLI; `.opencode/commands/` if not using OpenCode. Ask the user before deleting.

### Phase 1 — SDK Foundation

Prerequisite for both workers. No changes to the evaluation pipeline yet.

- Add `@anthropic-ai/sdk` to `package.json`
- Create `batch/lib/` directory
- Write `batch/lib/worker-utils.mjs`
  - `readProjectFile` / `writeProjectFile` utilities
  - Tool definitions object (read_file, write_file, bash, web_fetch, web_search)
  - `executeTool` dispatcher
  - `runAgentLoop` (send → tool calls → results → repeat until end_turn)
  - `logCacheMetrics` (logs to stderr: input tokens, cache read, cache write)
- Smoke test: minimal SDK call with cache_control, verify cache metrics appear in stderr

### Phase 2 — Triage Pipeline

- Write `modes/triage.md` (system prompt: archetype detection, Blocks A+B, G-text, comp signal, JSON output schema)
- Write `batch/batch-worker-triage.mjs`
- Write `batch/build-curation.mjs`
- Add `--mode=triage` to `batch/batch-runner.sh`
- End-to-end test: 3–5 jobs through full triage flow
- Validate: triage JSON schema, prompt cache hit on jobs 2+, curation.tsv generation

### Phase 3 — Curation Workflow

- Document `curation.tsv` format in `batch/README.md`
- Test `build-curation.mjs` idempotency (re-running does not overwrite filled decisions)
- Manual walkthrough: triage → build-curation → fill decisions → verify APPROVE rows

### Phase 4 — Deep Eval Pipeline

- Write `batch/batch-system.md` (system prompt: full Blocks C–G, output formats, global rules)
- Write `batch/batch-worker-deep.mjs` (reads triage JSON for A+B, runs C–G, generates report + PDF + TSV)
- Add `--mode=deep` to `batch/batch-runner.sh`
- Implement optional Brave Search tool (gated on `BRAVE_API_KEY`)
- End-to-end test: approved jobs through full deep eval → report, PDF, tracker entry

### Phase 5 — Integration & Cleanup

- Update `CLAUDE.md` pipeline section
- Add deprecation notice to `batch/batch-prompt.md`
- Remove resolved-prompt temp file logic from `batch-runner.sh` (no longer needed)
- Full end-to-end test: scan → triage → curation → deep eval → merge → verify
- Update `batch/README.md` with full workflow documentation

---

## 9. Task List

### Phase 0 — Fork Cleanup

**Blocking (complete before Phase 1):**
- [ ] Remove `node update-system.mjs check` invocation from `CLAUDE.md` session-start instructions
- [ ] Delete `modes/de/`
- [ ] Delete `modes/fr/`
- [ ] Delete `modes/ja/`
- [ ] Delete `modes/pt/`
- [ ] Delete `modes/ru/`

**Non-blocking (complete before Phase 2):**
- [ ] Confirm with user: remove `gemini-eval.mjs` and `.gemini/commands/`?
- [ ] Confirm with user: remove `.opencode/commands/`?
- [ ] Translate `modes/oferta.md` to English
- [ ] Translate `modes/pdf.md` to English
- [ ] Translate `modes/apply.md` to English
- [ ] Translate `modes/contacto.md` to English
- [ ] Translate `modes/pipeline.md` to English
- [ ] Translate `modes/scan.md` to English
- [ ] Translate `modes/batch.md` to English
- [ ] Translate `modes/deep.md` to English
- [ ] Translate `modes/ofertas.md` to English
- [ ] Translate `modes/tracker.md` to English
- [ ] Translate `modes/patterns.md` to English
- [ ] Translate `modes/followup.md` to English
- [ ] Translate `modes/interview-prep.md` to English
- [ ] Translate `modes/training.md` to English
- [ ] Translate `modes/project.md` to English
- [ ] Translate `modes/latex.md` to English
- [ ] Translate `modes/auto-pipeline.md` to English
- [ ] Update `config/archetypes.yml` — replace santifer's AI/automation archetypes with user's actual target roles
- [ ] Update `CLAUDE.md` origin section — remove santifer attribution and portfolio link
- [ ] Verify `modes/_shared.md` and `modes/_profile.md` read cleanly in English context after language variants removed

### Phase 1 — SDK Foundation

- [ ] Add `@anthropic-ai/sdk` to `package.json`
- [ ] Run `npm install` and confirm SDK resolves
- [ ] Create `batch/lib/` directory
- [ ] Write `batch/lib/worker-utils.mjs`
  - [ ] `readProjectFile(relPath, required)` utility
  - [ ] `writeProjectFile(relPath, content)` utility
  - [ ] Tool definitions: `read_file`, `write_file`, `bash`, `web_fetch`
  - [ ] Optional tool definition: `web_search` (Brave API)
  - [ ] `executeTool(name, input, projectDir)` dispatcher with error handling
  - [ ] `runAgentLoop(client, params)` — handles tool_use loop until end_turn or maxIter
  - [ ] `logCacheMetrics(usage)` — stderr output of input/cache_read/cache_write tokens
- [ ] Write minimal smoke test confirming SDK call works and cache metrics log

### Phase 2 — Triage Pipeline

- [ ] Write `modes/triage.md`
  - [ ] Intro: worker role and output contract
  - [ ] Sources of truth section (cv.md, profile.yml, _profile.md, archetypes.yml)
  - [ ] Archetype detection instruction (read `config/archetypes.yml`)
  - [ ] Block A specification (role summary table)
  - [ ] Block B specification (CV match score, top matches, top gaps with severity)
  - [ ] Block G text-only specification (description quality, reposting check)
  - [ ] Comp signal specification (6 values, read from JD text only)
  - [ ] JSON output schema (matches spec section 5)
  - [ ] Tool use instructions (`read_file` for scan-history.tsv, `web_fetch` for JD)
  - [ ] Global rules (NEVER invent, NEVER hardcode metrics)
- [ ] Write `batch/batch-worker-triage.mjs`
  - [ ] CLI arg parsing (`--id`, `--url`, `--jd-file`, `--date`, `--model`)
  - [ ] Load and assemble cached context (cv.md, profile.yml, _profile.md, article-digest.md, archetypes.yml)
  - [ ] Build per-job task message
  - [ ] Call `runAgentLoop` via worker-utils
  - [ ] Parse JSON from final response (handle markdown code fences)
  - [ ] Write `batch/triage-output/{id}.json`
  - [ ] Print compact summary to stdout for orchestrator log
  - [ ] Print cache metrics to stderr
- [ ] Write `batch/build-curation.mjs`
  - [ ] Read all `batch/triage-output/*.json`
  - [ ] Read existing `batch/curation.tsv` if present (preserve filled decisions)
  - [ ] Generate/update `curation.tsv` sorted by score descending
  - [ ] Print summary: new rows added, existing decisions preserved, pending count
- [ ] Modify `batch/batch-runner.sh`
  - [ ] Add `--mode` parameter to arg parsing (default: print migration warning)
  - [ ] Add `--mode=triage` dispatch: reads `batch-input.tsv`, calls `batch-worker-triage.mjs`
  - [ ] `triage-state.tsv` init, update, and state check functions
  - [ ] Post-triage message: prompt user to run `build-curation.mjs`
- [ ] End-to-end triage test with 3–5 real jobs
- [ ] Verify prompt cache hit on jobs 2+ (check stderr cache_read > 0)

### Phase 3 — Curation Workflow

- [ ] Document `curation.tsv` format and workflow in `batch/README.md`
- [ ] Test `build-curation.mjs` idempotency: run twice, confirm no decisions overwritten
- [ ] Manual walkthrough: fill decisions in curation.tsv, confirm APPROVE rows are correct input for Step 3

### Phase 4 — Deep Eval Pipeline

- [ ] Write `batch/batch-system.md`
  - [ ] Sources of truth (same as triage, plus cv-template.html)
  - [ ] Note: Blocks A+B will be provided in context from triage — do not re-run
  - [ ] Block C specification (level & strategy)
  - [ ] Block D specification (comp research — WebSearch if available, else training knowledge + JD signals)
  - [ ] Block E specification (personalization plan)
  - [ ] Block F specification (interview prep, STAR+R stories, story bank update)
  - [ ] Block G full specification (all signals including layoff check)
  - [ ] Report output format (full A–G report, same schema as `oferta.md`)
  - [ ] PDF generation instructions
  - [ ] Tracker TSV instructions
  - [ ] Global rules (NUNCA/SIEMPRE)
- [ ] Write `batch/batch-worker-deep.mjs`
  - [ ] CLI arg parsing (`--id`, `--url`, `--triage-file`, `--report-num`, `--date`, `--model`)
  - [ ] Load triage JSON and inject Blocks A+B into prompt context
  - [ ] Cold-start handling: if triage JSON missing, run Blocks A+B from scratch
  - [ ] Load and assemble cached context
  - [ ] Build per-job task message (reference injected A+B, instruct C–G)
  - [ ] Optional Brave Search tool (check `BRAVE_API_KEY` env var)
  - [ ] Call `runAgentLoop` with full tool set
  - [ ] Print JSON summary to stdout
- [ ] Modify `batch/batch-runner.sh`
  - [ ] Add `--mode=deep` dispatch: reads `curation.tsv`, filters `decision = APPROVE`
  - [ ] Deep mode uses `batch-state.tsv` (existing schema, unchanged)
  - [ ] Post-deep run: call `merge-tracker.mjs` and `verify-pipeline.mjs`
- [ ] End-to-end deep eval test with 2–3 approved jobs
- [ ] Verify: report created, PDF generated, tracker TSV written, merge succeeds

### Phase 5 — Integration & Cleanup

- [ ] Update `CLAUDE.md` pipeline section with 3-step flow description
- [ ] Add deprecation header to `batch/batch-prompt.md`
- [ ] Remove resolved-prompt temp file logic from `batch-runner.sh`
- [ ] Rewrite `batch/README.md` (new workflow, new commands, curation step)
- [ ] Full end-to-end run: scan → triage (5+ jobs) → curation → deep eval (2+ jobs) → merge → verify
- [ ] Run `node verify-pipeline.mjs` — confirm clean output
- [ ] Review cache metrics across a full batch: confirm savings match estimate

---

## 10. Open Questions

| # | Question | Default if unresolved |
|---|---|---|
| 1 | **Model selection:** Same model for triage and deep, or cheaper model (Haiku/Sonnet) for triage and Opus for deep? Triage is lightweight; a faster model compounds savings. | Both default to `claude-sonnet-4-6`; override via `--model` arg or `CAREER_OPS_MODEL` env var |
| 2 | **Brave Search integration timing:** Include in Phase 4 or Phase 5? Adds complexity but recovers the WebSearch capability lost from `claude -p`. | Phase 4 — implement as optional, gated on env var, so it doesn't block the phase |
| 3 | **Triage re-run behavior:** If a job is already in `triage-state.tsv` as completed, should re-running triage skip it or re-evaluate? | Skip (same as deep eval behavior today) |
| 4 | **curation.tsv conflict on re-run:** If triage runs again on new jobs added to `batch-input.tsv`, `build-curation.mjs` should add new rows. Confirmed behavior: new rows appended, existing decisions never touched. | Confirmed — document clearly |
| 5 | **Deep eval without prior triage:** If a job appears in `curation.tsv` with `APPROVE` but has no triage JSON (manually added), deep worker runs Blocks A+B from scratch. Accept the duplication. | Confirmed — cold start path |
| 6 | **Deprecation window for `batch-prompt.md`:** How long to maintain the `claude -p` path before removing? | Keep through one complete pipeline cycle post-Phase 5. Remove in a follow-up. |
