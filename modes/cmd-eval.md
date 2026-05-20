# Mode: eval — Batch Step 3

Run deep evaluation on all APPROVE rows in `batch/curation.tsv`. Generates full A–G reports, CV personalization, STAR+R stories, and tracker entries. Full token cost — only approved jobs run.

## Parse flags from user input

| User says | Flag to add |
|-----------|-------------|
| "dry run" / "--dry-run" | `--dry-run` |
| "retry" / "--retry-failed" | `--retry-failed` |

Default: process all APPROVE rows not yet in `batch/batch-state.tsv` as completed.

## Steps

1. **Check state**
   - Read `batch/curation.tsv` — count APPROVE rows
   - Read `batch/batch-state.tsv` if it exists — count completed, failed, pending
   - If no APPROVE rows: report and stop:
     ```
     ✗ No approved jobs found in batch/curation.tsv.
     → Run /career-ops curation first to review triage scores and approve jobs.
     ```
   - If all approved rows already completed: report and stop:
     ```
     ✓ All N approved jobs already have reports.
     → Run node merge-tracker.mjs if you haven't merged yet.
     ```

2. **Show pre-run summary**
   ```
   Deep Eval — Step 3 of 3
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Approved:   N jobs
   Pending:    N jobs (not yet run)
   Completed:  N jobs (already done)
   Failed:     N jobs
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Jobs to evaluate:
     • Company — Role (score)
     • ...
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Estimated cost: ~$0.10–0.20 per job at Sonnet rates (prompt caching active)
   ```

3. **Confirm before running** (only if N > 3 and not dry-run)
   ```
   About to run deep eval on N jobs. Proceed? (yes / no)
   ```
   Wait for confirmation. Skip confirmation for N ≤ 3 or if user already said "go" / "yes" in their message.

4. **Run deep eval**
   Execute via Bash:
   ```bash
   ./batch/batch-runner.sh --mode=deep [flags]
   ```
   Stream output to the user as it runs.

5. **Post-run summary**
   After the script exits, read `batch/batch-state.tsv` and `batch/tracker-additions/`:
   ```
   Deep Eval complete
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Completed:  N  (N new reports in reports/)
   Failed:     N
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   New reports:
     • reports/005-remitly-2026-05-05.md  (score: 4.3/5)
     • reports/006-anthropic-dev-prod-2026-05-05.md  (score: 4.7/5)
   ```

6. **Post-batch cleanup** (auto-runs unless --dry-run)

   The batch runner calls these automatically, but confirm they ran:
   ```bash
   node merge-tracker.mjs     # merge tracker-additions → applications.md
   node verify-pipeline.mjs   # integrity check
   ```
   If either exits non-zero, show the error and suggest the manual fix.

7. **Final prompt**
   ```
   → Review new reports in reports/
   → Run /career-ops tracker to see updated application status
   → Run /career-ops {URL} on any report to generate a tailored CV + cover letter
   ```

## Error handling

- If `batch/curation.tsv` does not exist: tell the user to run `/career-ops curation` first
- If `ANTHROPIC_API_KEY` is not set: `export ANTHROPIC_API_KEY=sk-ant-...`
- If a job fails: note its ID and suggest `--retry-failed`
- If `merge-tracker.mjs` reports duplicates: `node dedup-tracker.mjs`
- If `verify-pipeline.mjs` fails: open the flagged report, fix the `**URL:**` or status field, re-run verifier
