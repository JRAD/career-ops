# Mode: triage — Batch Step 1

Run the triage worker on all pending jobs in `batch/batch-input.tsv`. Uses the Anthropic SDK with prompt caching — cheap, ~1–2k tokens per job. Only processes rows not yet in `batch/triage-state.tsv`.

## Parse flags from user input

| User says | Flag to add |
|-----------|-------------|
| "dry run" / "--dry-run" | `--dry-run` |
| "parallel N" / "-p N" | `--parallel N` |
| "retry" / "--retry-failed" | `--retry-failed` |
| "from N" / "--start-from N" | `--start-from N` |
| "haiku" / "fast" / "cheap" | set `CAREER_OPS_MODEL=claude-haiku-4-5` before running |

Default (no flags): sequential, resume from last completed, Sonnet model.

## Steps

1. **Check state**
   - Read `batch/batch-input.tsv` — count total rows
   - Read `batch/triage-state.tsv` if it exists — count completed, failed, pending
   - If no pending jobs, report and stop:
     ```
     ✓ No pending triage jobs. All N jobs already processed.
     → Run /career-ops curation to build the curation gate.
     ```

2. **Show pre-run summary**
   ```
   Triage — Step 1 of 3
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Pending:    N jobs
   Completed:  N jobs (already done)
   Failed:     N jobs
   Model:      claude-sonnet-4-5 (or haiku if flagged)
   Flags:      {flags or "none"}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

3. **Run triage**
   Execute via Bash:
   ```bash
   ./batch/batch-runner.sh --mode=triage [flags]
   ```
   Stream output to the user as it runs.

4. **Post-run summary**
   After the script exits, read `batch/triage-state.tsv` and report:
   ```
   Triage complete
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Completed:  N  (N new this run)
   Failed:     N
   Skipped:    N
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   → Run /career-ops curation to review scores and approve jobs for deep eval.
   ```
   If there were failures: `→ Re-run with --retry-failed to retry N failed jobs.`

## Error handling

- If `batch/batch-input.tsv` does not exist: tell the user to run `/career-ops scan` first
- If `ANTHROPIC_API_KEY` is not set: tell the user to `export ANTHROPIC_API_KEY=sk-ant-...`
- If the script exits non-zero: show the last 20 lines of stderr and suggest `--retry-failed`
