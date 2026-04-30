# career-ops Batch Pipeline

Three-step evaluation pipeline: scan → triage → human curation → deep eval.

---

## Overview

| Step | Command | Output | Cost |
|------|---------|--------|------|
| 0 — Scan | `node scan.mjs` | `batch/batch-input.tsv` | Zero (API direct, no LLM) |
| 1 — Triage | `./batch/batch-runner.sh --mode=triage` | `batch/triage-output/{id}.json` | Low (~1–2k tokens/job, cached) |
| 2 — Curation | `node batch/build-curation.mjs` + edit TSV | `batch/curation.tsv` | Zero (no LLM) |
| 3 — Deep Eval | `./batch/batch-runner.sh --mode=deep` | `reports/`, `batch/tracker-additions/` | Full (8–15k tokens/job) |

**The human curation step is the cost gate.** Only APPROVE the jobs you actually intend to apply to. Triage is cheap; deep eval is not.

---

## Prerequisites

```bash
# Install dependencies
npm install

# Required env vars
export ANTHROPIC_API_KEY="sk-ant-..."

# Optional (enables comp research in deep eval Block D)
export BRAVE_API_KEY="BSA..."

# Optional: override default model
export CAREER_OPS_MODEL="claude-sonnet-4-5"   # default
# export CAREER_OPS_MODEL="claude-haiku-4-5"  # faster/cheaper for triage
```

---

## Step 0 — Scan

Hits Greenhouse, Lever, and Ashby job APIs directly. Zero LLM cost.

```bash
node scan.mjs
```

Output: `batch/batch-input.tsv` — one row per job, columns: `id | url | source | notes`

To add jobs manually, append rows to `batch/batch-input.tsv`:
```
42	https://jobs.example.com/posting/123	manual
```

---

## Step 1 — Triage

Runs Blocks A (role facts) + B (CV match, abbreviated) + G (legitimacy, text-only) + comp signal on every pending job. Uses Anthropic SDK with prompt caching — the system prompt and candidate context are cached across all jobs in a batch, so only the first job pays the full token cost.

```bash
# Triage all pending jobs (sequential)
./batch/batch-runner.sh --mode=triage

# Preview what would run
./batch/batch-runner.sh --mode=triage --dry-run

# Run 3 workers in parallel (faster, costs the same)
./batch/batch-runner.sh --mode=triage --parallel 3

# Retry only failed jobs
./batch/batch-runner.sh --mode=triage --retry-failed

# Skip jobs before ID 20
./batch/batch-runner.sh --mode=triage --start-from 20
```

**Output:** `batch/triage-output/{id}.json` per job, `batch/triage-state.tsv` for resumability.

Each JSON contains: `company`, `role`, `archetype`, `fit_score` (1.0–5.0), `recommendation` (`STRONG_MATCH | MATCH | WEAK_MATCH | SKIP`), `top_matches`, `top_gaps`, `comp_signal`, `legitimacy_tier`, `summary`.

**Stderr logs** show cache metrics — look for `cache_read=N` on the second+ job to confirm caching is working.

---

## Step 2 — Curation

Merge all triage JSON files into a single TSV sorted by `fit_score` descending.

```bash
node batch/build-curation.mjs
```

This creates (or updates) `batch/curation.tsv`. **Open it and fill in the `decision` column:**

| Value | Meaning |
|-------|---------|
| `APPROVE` | Send to deep eval (Step 3) |
| `SKIP` | Do not evaluate further |
| *(blank)* | Not yet reviewed |

Re-running `build-curation.mjs` after adding new triage results will append new rows and **never overwrite** existing decisions.

**Tip:** Sort by `recommendation` first — STRONG_MATCH/MATCH are the obvious approvals. Review WEAK_MATCH for anything worth a shot. Auto-SKIP anything the triage already marked SKIP.

---

## Step 3 — Deep Eval

Runs Blocks C (level strategy) + D (comp & demand, with web search) + E (CV personalization) + F (interview plan + STAR+R stories) + G (full legitimacy with layoff/hiring-freeze research) on every APPROVE row in `curation.tsv`.

```bash
# Deep eval all approved jobs
./batch/batch-runner.sh --mode=deep

# Preview what would run
./batch/batch-runner.sh --mode=deep --dry-run

# Retry failed jobs
./batch/batch-runner.sh --mode=deep --retry-failed
```

**Output per job:**
- `reports/{num}-{company-slug}-{date}.md` — full evaluation report
- `batch/tracker-additions/{num}-{company-slug}.tsv` — tracker line for merge
- `interview-prep/story-bank.md` — updated with new STAR+R stories (append-only)

After all jobs complete, the runner automatically calls:
```bash
node merge-tracker.mjs     # merge tracker TSV lines into data/applications.md
node verify-pipeline.mjs   # check pipeline integrity
```

---

## Post-batch workflow

```bash
# If merge didn't auto-run (e.g., dry-run was used):
node merge-tracker.mjs

# Health check
node verify-pipeline.mjs

# Dedup if duplicates exist
node dedup-tracker.mjs

# Normalize any non-canonical statuses
node normalize-statuses.mjs
```

---

## File layout

```
batch/
├── README.md                    ← this file
├── batch-runner.sh              ← orchestrator (triage + deep)
├── batch-worker-triage.mjs      ← Step 1 SDK worker
├── batch-worker-deep.mjs        ← Step 3 SDK worker
├── build-curation.mjs           ← Step 2 curation gate builder
├── batch-prompt.md              ← DEPRECATED (old claude -p prompt, kept for reference)
├── lib/
│   ├── worker-utils.mjs         ← shared utilities (readProjectFile, runAgentLoop, etc.)
│   └── smoke-test.mjs           ← SDK foundation smoke test
├── batch-input.tsv              ← input jobs (gitignored)
├── triage-state.tsv             ← triage progress (gitignored)
├── batch-state.tsv              ← deep eval progress (gitignored)
├── curation.tsv                 ← human curation decisions (gitignored)
├── triage-output/               ← per-job triage JSON (gitignored)
├── tracker-additions/           ← per-job tracker TSV lines (gitignored)
└── logs/                        ← per-job stderr logs (gitignored)
```

System prompts live alongside other mode files:

```
modes/
├── triage.md                    ← Step 1 system prompt
├── deep-eval.md                 ← Step 3 system prompt
└── ...                          ← interactive mode prompts
```

---

## Prompt caching

Both workers use Anthropic's prompt caching to minimize cost on large batches.

**Two cache checkpoints per worker:**

1. **System prompt** (`modes/triage.md` or `modes/deep-eval.md`) — cached on every call; all jobs in a session reuse this.
2. **Candidate context block** (`cv.md` + `config/profile.yml` + `modes/_profile.md` + `article-digest.md` + `config/archetypes.yml`) — cached once per batch; identical for every job.

**Per-job task block** (the job URL, JD content, triage summary) is never cached — it's unique to each job.

On the first job: cache is populated (you see `cache_write=N` in stderr).
On subsequent jobs: cache is read (you see `cache_read=N`). Cost reduction ~80–90% on the static context.

The cache TTL is 5 minutes. For large batches with `--parallel 1` and slow jobs, the cache may expire. Use `--parallel 3` to keep throughput high enough to stay within the TTL window.

---

## Model selection

The default model is `claude-sonnet-4-5`. Override with:

```bash
# Per run
./batch/batch-runner.sh --mode=triage  # reads CAREER_OPS_MODEL env var
node batch/batch-worker-triage.mjs --model=claude-haiku-4-5 --id=1 --url=...

# Globally for the session
export CAREER_OPS_MODEL="claude-haiku-4-5"
```

**Triage:** `claude-haiku-4-5` is worth benchmarking. The task is structured (JSON output, explicit schema) and classification-heavy. If quality is acceptable, the cost reduction is substantial (~5–8×).

**Deep eval:** Sonnet is recommended. Block D (comp research synthesis), Block E (CV rewriting), and Block F (STAR+R stories) benefit from stronger reasoning. Haiku tends to produce generic stories and shallower personalization plans.

---

## Troubleshooting

**Triage worker exits 1: "Output is not valid JSON"**
Check `batch/logs/triage-{id}.log` for the raw output. Common cause: the JD URL was unreachable, so the model wrote an apology instead of JSON. Verify the URL is live, or pre-fetch the JD and pass `--jd-file=/tmp/jd.txt`.

**Deep worker exceeds 25 iterations**
The agent is looping, likely failing a `write_file` call. Check `batch/logs/deep-{id}.log`. Re-run with `--retry-failed`.

**Cache shows `cache_write` on every job (no hits)**
The batch is running slower than the 5-minute cache TTL. Use `--parallel 3` to increase throughput, or verify that `cv.md` / `archetypes.yml` are not changing between runs (they must be byte-identical to hit the cache checkpoint).

**`merge-tracker.mjs` reports duplicates**
Two deep eval jobs wrote tracker TSV files for the same company+role. Run `node dedup-tracker.mjs` to resolve.

**`verify-pipeline.mjs` fails after batch**
Usually a missing `**URL:**` field in a report header, or a non-canonical status. Open the flagged report, fix the header manually, then re-run the verifier.
