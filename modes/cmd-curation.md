# Mode: curation — Batch Step 2

Build (or refresh) the curation gate from triage results, display scores ranked by fit, and help the user make APPROVE / SKIP decisions before Step 3 deep eval runs.

## Steps

1. **Run the curation builder**
   ```bash
   node batch/build-curation.mjs
   ```
   This merges all `batch/triage-output/*.json` into `batch/curation.tsv`, sorted by `fit_score` descending. Existing decisions are preserved — new rows are appended with blank decision.

2. **Read `batch/curation.tsv`**
   Columns: `id | url | company | role | fit_score | recommendation | comp_signal | legitimacy_tier | decision | summary`

3. **Display ranked table**

   Group by recommendation tier, highest scores first:

   ```
   Curation Gate — {N} jobs to review
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   
   ★ STRONG_MATCH  (score ≥ 4.5)
   ──────────────────────────────────────────────────────────────
   #  ID  Score  Company          Role                        Comp        Decision
   1   7  4.8    Anthropic        Staff SWE, Dev Productivity  $300-380K   [blank]
   2  12  4.6    Remitly          Senior Backend Engineer       $200-260K   [blank]
   
   ✓ MATCH  (score 3.5–4.4)
   ──────────────────────────────────────────────────────────────
   3   3  4.2    Smartsheet       Senior SWE, Platform         $180-240K   [blank]
   4  19  3.8    ExtraHop         Senior SWE, Cloud            unknown     [blank]
   
   ~ WEAK_MATCH  (score 2.5–3.4)
   ──────────────────────────────────────────────────────────────
   5   8  3.1    Outreach         Staff SWE, Backend           $185-240K   [blank]
   
   ✗ SKIP  (score < 2.5 or already marked SKIP by triage)
   ──────────────────────────────────────────────────────────────
   6   2  2.0    easybill GmbH    Senior SWE PHP               unknown     SKIP (auto)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   N decided  |  N pending  |  N APPROVE  |  N SKIP
   ```

   Show the `summary` field (1–2 sentences from triage) under each row if space permits.

4. **Prompt for decisions**

   ```
   Decisions needed for N jobs.

   Options:
     • Type "approve 7 12 3" to approve by ID
     • Type "skip 8 19" to skip by ID
     • Type "approve all strong" to approve all STRONG_MATCH
     • Type "skip all weak" to skip all WEAK_MATCH and SKIP tiers
     • Type "done" when finished — I'll write decisions and show what goes to deep eval
   ```

5. **Apply decisions**

   For each decision, update the `decision` column in `batch/curation.tsv` — `APPROVE` or `SKIP`. Write the file after each batch of changes.

   Show a running tally: `✓ 5 approved, 8 skipped, 2 pending`

6. **Final summary before handing off**

   Once the user says "done" (or all rows have decisions):
   ```
   Ready for deep eval
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Approved:  N jobs → will get full reports
   Skipped:   N jobs → archived
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Approved jobs:
     • Anthropic — Staff SWE, Dev Productivity (4.8)
     • Remitly — Senior Backend Engineer (4.6)
     • ...

   → Run /career-ops eval to generate full reports for approved jobs.
   ```

## Edge cases

- If `batch/triage-output/` is empty or missing: tell the user to run `/career-ops triage` first
- If all rows already have decisions: skip steps 4–5, go straight to the final summary
- If user approves a SKIP-tier job: allow it but note "low triage score — applying anyway"
- `build-curation.mjs` never overwrites existing decisions — safe to re-run
