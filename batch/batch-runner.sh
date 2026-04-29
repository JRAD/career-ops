#!/usr/bin/env bash
set -euo pipefail

# career-ops batch runner — standalone orchestrator for claude -p workers
# Reads batch-input.tsv, delegates each offer to a claude -p worker,
# tracks state in batch-state.tsv for resumability.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$BATCH_DIR/batch-prompt.md"
LOGS_DIR="$BATCH_DIR/logs"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

# Defaults
MODE=""
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0

usage() {
  cat <<'USAGE'
career-ops batch runner — 3-step evaluation pipeline orchestrator

Usage: batch-runner.sh --mode=<mode> [OPTIONS]

Modes:
  --mode=triage        Step 1 — run fit assessment on all scanned jobs
  --mode=deep          Step 3 — run full evaluation on approved jobs [Phase 4]

Options:
  --parallel N         Number of parallel workers (default: 1, triage only)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry jobs marked as "failed" in state
  --start-from N       Start from job ID N (skip earlier IDs)
  --max-retries N      Max retry attempts per job (default: 2)
  -h, --help           Show this help

Workflow:
  Step 0  node scan.mjs                          → batch/batch-input.tsv
  Step 1  ./batch/batch-runner.sh --mode=triage  → batch/triage-output/{id}.json
  Step 2  node batch/build-curation.mjs          → fill batch/curation.tsv
  Step 3  ./batch/batch-runner.sh --mode=deep    → reports/ + output/ + tracker

Files:
  batch-input.tsv          Input jobs (id, url, source, notes)
  triage-state.tsv         Triage progress (auto-managed)
  batch-state.tsv          Deep eval progress (auto-managed)
  triage-output/{id}.json  Per-job triage result
  curation.tsv             Human curation decisions (APPROVE / SKIP)
  logs/                    Per-job logs
  tracker-additions/       Tracker TSV lines for post-batch merge

Examples:
  # See what triage jobs are pending
  ./batch-runner.sh --mode=triage --dry-run

  # Run triage on all pending jobs
  ./batch-runner.sh --mode=triage

  # Run triage with 3 workers in parallel
  ./batch-runner.sh --mode=triage --parallel 3

  # After filling curation.tsv, run deep eval on approved jobs
  ./batch-runner.sh --mode=deep
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode=*) MODE="${1#--mode=}"; shift ;;
    --mode) MODE="$2"; shift 2 ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --parallel=*) PARALLEL="${1#--parallel=}"; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --start-from=*) START_FROM="${1#--start-from=}"; shift ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --max-retries=*) MAX_RETRIES="${1#--max-retries=}"; shift ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --min-score=*) MIN_SCORE="${1#--min-score=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Lock file to prevent double execution
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE"
}

trap release_lock EXIT

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi

  if ! command -v claude &>/dev/null; then
    echo "ERROR: 'claude' CLI not found in PATH."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"
}

# Initialize state file if it doesn't exist
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR"
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

# Get status of an offer from state file
get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

# Get retry count for an offer
get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

# Calculate next report number.
# Caller must hold STATE_LOCK_DIR while this runs.
next_report_num_unlocked() {
  local max_num=0
  if [[ -d "$REPORTS_DIR" ]]; then
    for f in "$REPORTS_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      local basename
      basename=$(basename "$f")
      local num="${basename%%-*}"
      num=$((10#$num)) # Remove leading zeros for arithmetic
      if (( num > max_num )); then
        max_num=$num
      fi
    done
  fi
  # Also check state file for assigned report numbers
  if [[ -f "$STATE_FILE" ]]; then
    while IFS=$'\t' read -r _ _ _ _ _ rnum _ _ _; do
      [[ "$rnum" == "report_num" || "$rnum" == "-" || -z "$rnum" ]] && continue
      local n=$((10#$rnum))
      if (( n > max_num )); then
        max_num=$n
      fi
    done < "$STATE_FILE"
  fi
  printf '%03d' $((max_num + 1))
}

# Update or insert state for an offer.
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local found=false

  # Write header
  head -1 "$STATE_FILE" > "$tmp"

  # Process existing lines
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue  # skip header
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  local report_num=""
  if report_num=$(next_report_num_unlocked); then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

# Process a single offer
process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")
  local report_num
  report_num=$(reserve_report_num "$id" "$url" "$started_at" "$retries")
  local date
  date=$(date +%Y-%m-%d)
  local jd_file="/tmp/batch-jd-${id}.txt"

  echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))"

  # Build the prompt with placeholders replaced
  local prompt
  prompt="Procesa esta oferta de empleo. Ejecuta el pipeline completo: evaluación A-F + report .md + PDF + tracker line."
  prompt="$prompt URL: $url"
  prompt="$prompt JD file: $jd_file"
  prompt="$prompt Report number: $report_num"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"

  local log_file="$LOGS_DIR/${report_num}-${id}.log"

  # Prepare system prompt with placeholders resolved
  local resolved_prompt="$BATCH_DIR/.resolved-prompt-${id}.md"
  # Escape sed delimiter characters in variables to prevent substitution breakage
  local esc_url esc_jd_file esc_report_num esc_date esc_id
  esc_url="${url//\\/\\\\}"
  esc_url="${esc_url//|/\\|}"
  esc_jd_file="${jd_file//\\/\\\\}"
  esc_jd_file="${esc_jd_file//|/\\|}"
  esc_report_num="${report_num//|/\\|}"
  esc_date="${date//|/\\|}"
  esc_id="${id//|/\\|}"
  sed \
    -e "s|{{URL}}|${esc_url}|g" \
    -e "s|{{JD_FILE}}|${esc_jd_file}|g" \
    -e "s|{{REPORT_NUM}}|${esc_report_num}|g" \
    -e "s|{{DATE}}|${esc_date}|g" \
    -e "s|{{ID}}|${esc_id}|g" \
    "$PROMPT_FILE" > "$resolved_prompt"

  # Launch claude -p worker (uses default model from Claude Max subscription)
  local exit_code=0
  claude -p \
    --dangerously-skip-permissions \
    --append-system-prompt-file "$resolved_prompt" \
    "$prompt" \
    > "$log_file" 2>&1 || exit_code=$?

  # Cleanup resolved prompt
  rm -f "$resolved_prompt"

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $exit_code -eq 0 ]]; then
    # Try to extract score from worker output
    local score="-"
    local score_match
   score_match=$(sed -nE 's/.*"score":[[:space:]]*([0-9.]+).*/\1/p' "$log_file" 2>/dev/null | head -1 || true)
    if [[ -n "$score_match" ]]; then
      score="$score_match"
    fi

    # Check min-score gate
    if [[ "$score" != "-" && -n "$score" ]] && (( $(echo "$MIN_SCORE > 0" | bc -l) )); then
      if (( $(echo "$score < $MIN_SCORE" | bc -l) )); then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "below-min-score" "$retries"
        echo "    ⏭️  Skipped (score: $score < min-score: $MIN_SCORE)"
        continue
      fi
    fi

    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$score" "-" "$retries"
    echo "    ✅ Completed (score: $score, report: $report_num)"
  else
    retries=$((retries + 1))
    local error_msg
    error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
    echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
  fi
}

# ── Triage state helpers ─────────────────────────────────────────────────────
# Triage uses the same 9-column TSV schema as batch-state.tsv.
# report_num is always "-" for triage (not applicable).

TRIAGE_STATE_FILE="$BATCH_DIR/triage-state.tsv"
TRIAGE_OUTPUT_DIR="$BATCH_DIR/triage-output"

init_triage_state() {
  if [[ ! -f "$TRIAGE_STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$TRIAGE_STATE_FILE"
  fi
}

get_triage_status() {
  local id="$1"
  if [[ ! -f "$TRIAGE_STATE_FILE" ]]; then echo "none"; return; fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$TRIAGE_STATE_FILE")
  echo "${status:-none}"
}

get_triage_retries() {
  local id="$1"
  if [[ ! -f "$TRIAGE_STATE_FILE" ]]; then echo "0"; return; fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$TRIAGE_STATE_FILE")
  echo "${retries:-0}"
}

update_triage_state() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" score="$6" error="$7" retries="$8"

  if [[ ! -f "$TRIAGE_STATE_FILE" ]]; then init_triage_state; fi

  local tmp="$TRIAGE_STATE_FILE.tmp"
  local found=false

  head -1 "$TRIAGE_STATE_FILE" > "$tmp"

  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "-" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$TRIAGE_STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "-" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$TRIAGE_STATE_FILE"
}

# ── Triage mode ───────────────────────────────────────────────────────────────

run_triage() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Run 'node scan.mjs' first to populate it."
    exit 1
  fi

  if ! command -v node &>/dev/null; then
    echo "ERROR: 'node' not found in PATH."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRIAGE_OUTPUT_DIR"
  init_triage_state

  local today
  today=$(date +%Y-%m-%d)

  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  echo "=== career-ops triage ==="
  echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  echo "Input: $total_input jobs in $INPUT_FILE"
  echo ""

  # Build list of jobs to triage
  local -a pending_ids=()
  local -a pending_urls=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue
    [[ -z "$id" || -z "$url" ]] && continue
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    (( id < START_FROM )) && continue

    local status
    status=$(get_triage_status "$id")

    if [[ "$RETRY_FAILED" == "true" ]]; then
      [[ "$status" != "failed" ]] && continue
      local retries
      retries=$(get_triage_retries "$id")
      (( retries >= MAX_RETRIES )) && { echo "SKIP #$id: max retries reached"; continue; }
    else
      [[ "$status" == "completed" ]] && continue
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_triage_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No jobs to triage."
    triage_summary
    exit 0
  fi

  echo "Pending: $pending_count jobs"
  echo ""

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN ==="
    for i in "${!pending_ids[@]}"; do
      local s
      s=$(get_triage_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} (status: $s)"
    done
    echo ""
    echo "Would triage $pending_count jobs."
    exit 0
  fi

  # Acquire process lock to prevent double execution
  acquire_lock

  # Process jobs (sequential or parallel)
  triage_job() {
    local id="$1" url="$2"
    local started_at
    started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local retries
    retries=$(get_triage_retries "$id")
    local log_file="$LOGS_DIR/triage-${id}.log"
    local tmp_out="/tmp/career-ops-triage-${id}.json"

    echo "--- Triage #$id: $url"

    local exit_code=0
    node "$PROJECT_DIR/batch/batch-worker-triage.mjs" \
      --id="$id" \
      --url="$url" \
      --date="$today" \
      > "$tmp_out" \
      2>> "$log_file" \
      || exit_code=$?

    local completed_at
    completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    if [[ $exit_code -eq 0 ]]; then
      local out_file="$TRIAGE_OUTPUT_DIR/${id}.json"
      mv "$tmp_out" "$out_file"
      local score rec company role
      score=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$out_file','utf8'));console.log(j.fit_score);}catch(e){console.log('-');}" 2>/dev/null || echo "-")
      rec=$(node   -e "try{const j=JSON.parse(require('fs').readFileSync('$out_file','utf8'));console.log(j.recommendation);}catch(e){console.log('?');}" 2>/dev/null || echo "?")
      company=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$out_file','utf8'));console.log(j.company);}catch(e){console.log('?');}" 2>/dev/null || echo "?")
      role=$(node    -e "try{const j=JSON.parse(require('fs').readFileSync('$out_file','utf8'));console.log(j.role);}catch(e){console.log('?');}" 2>/dev/null || echo "?")
      update_triage_state "$id" "$url" "completed" "$started_at" "$completed_at" "$score" "-" "$retries"
      echo "    ✅ $company — $role | score=$score rec=$rec"
    else
      rm -f "$tmp_out"
      local err_msg
      err_msg=$(tail -3 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "exit code $exit_code")
      retries=$((retries + 1))
      update_triage_state "$id" "$url" "failed" "$started_at" "$completed_at" "-" "$err_msg" "$retries"
      echo "    ❌ Failed (attempt $retries) — see $log_file"
    fi
  }

  if (( PARALLEL <= 1 )); then
    for i in "${!pending_ids[@]}"; do
      triage_job "${pending_ids[$i]}" "${pending_urls[$i]}"
    done
  else
    local running=0
    local -a pids=()
    for i in "${!pending_ids[@]}"; do
      while (( running >= PARALLEL )); do
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            running=$((running - 1))
          fi
        done
        pids=("${pids[@]}")
        sleep 1
      done
      triage_job "${pending_ids[$i]}" "${pending_urls[$i]}" &
      pids+=($!)
      running=$((running + 1))
    done
    for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  fi

  triage_summary

  echo ""
  echo "Triage complete. Next step:"
  echo "  node batch/build-curation.mjs"
  echo "Then review batch/curation.tsv and mark jobs APPROVE or SKIP."
  echo "Finally: ./batch/batch-runner.sh --mode=deep"
}

triage_summary() {
  echo ""
  echo "=== Triage Summary ==="
  if [[ ! -f "$TRIAGE_STATE_FILE" ]]; then echo "No state file."; return; fi

  local total=0 completed=0 failed=0
  local strong=0 match=0 weak=0 skip=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1)) ;;
      failed)    failed=$((failed + 1)) ;;
    esac
  done < "$TRIAGE_STATE_FILE"

  # Count recommendations from output files
  if [[ -d "$TRIAGE_OUTPUT_DIR" ]]; then
    for f in "$TRIAGE_OUTPUT_DIR"/*.json; do
      [[ -f "$f" ]] || continue
      local rec
      rec=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$f','utf8'));console.log(j.recommendation);}catch(e){}" 2>/dev/null || true)
      case "$rec" in
        STRONG_MATCH) strong=$((strong + 1)) ;;
        MATCH)        match=$((match + 1)) ;;
        WEAK_MATCH)   weak=$((weak + 1)) ;;
        SKIP)         skip=$((skip + 1)) ;;
      esac
    done
  fi

  echo "Total: $total | Completed: $completed | Failed: $failed"
  if (( completed > 0 )); then
    echo "Recommendations: STRONG_MATCH=$strong MATCH=$match WEAK_MATCH=$weak SKIP=$skip"
  fi
}

# ── Merge tracker additions into applications.md
merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

# Print summary
print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 failed=0 pending=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if [[ "$sscore" != "-" && -n "$sscore" ]]; then
          score_sum=$(echo "$score_sum + $sscore" | bc 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      failed) failed=$((failed + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Failed: $failed | Pending: $pending"

  if (( score_count > 0 )); then
    local avg
    avg=$(echo "scale=1; $score_sum / $score_count" | bc 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
}

# Main
main() {
  case "$MODE" in
    triage)
      run_triage
      return
      ;;
    deep)
      echo "ERROR: --mode=deep is not yet implemented (Phase 4)."
      echo ""
      echo "To run full evaluations manually:"
      echo "  claude -p --dangerously-skip-permissions \\"
      echo "    --append-system-prompt-file batch/batch-prompt.md \\"
      echo "    'Process this job. URL: <url>'"
      echo ""
      echo "See batch/README.md for the current workflow."
      exit 1
      ;;
    "")
      echo ""
      echo "⚠️  The batch pipeline has been restructured. --mode is now required."
      echo ""
      echo "  --mode=triage   Step 1 — fit assessment on all scanned jobs"
      echo "  --mode=deep     Step 3 — full evaluation on approved jobs [Phase 4]"
      echo ""
      echo "Workflow:"
      echo "  node scan.mjs"
      echo "  ./batch/batch-runner.sh --mode=triage"
      echo "  node batch/build-curation.mjs  →  fill batch/curation.tsv"
      echo "  ./batch/batch-runner.sh --mode=deep"
      echo ""
      echo "See batch/README.md for details."
      exit 1
      ;;
    *)
      echo "Unknown mode: $MODE"
      usage
      exit 1
      ;;
  esac
}

# Legacy deep-eval main body — preserved for Phase 4 refactor
_legacy_main() {
  check_prerequisites

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
  fi

  init_state

  # Count input offers (skip header, ignore blank lines)
  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  echo "Input: $total_input offers"
  echo ""

  # Build list of offers to process
  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue  # skip header
    [[ -z "$id" || -z "$url" ]] && continue

    # Guard against non-numeric id values
    [[ "$id" =~ ^[0-9]+$ ]] || continue

    # Skip if before start-from
    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$RETRY_FAILED" == "true" ]]; then
      # Only process failed offers
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      # Check retry limit
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      # Skip completed offers
      if [[ "$status" == "completed" ]]; then
        continue
      fi
      # Skip failed offers that hit retry limit (unless --retry-failed)
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  # Dry run: just list
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  # Process offers
  if (( PARALLEL <= 1 )); then
    # Sequential processing
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
    done
  else
    # Parallel processing with job control
    local running=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      # Wait if we're at parallel limit
      while (( running >= PARALLEL )); do
        # Wait for any child to finish
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        # Compact arrays
        pids=("${pids[@]}")
        pid_ids=("${pid_ids[@]}")
        sleep 1
      done

      # Launch worker in background
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    # Wait for remaining workers
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  # Merge tracker additions
  merge_tracker

  # Print summary
  print_summary
}

main "$@"
