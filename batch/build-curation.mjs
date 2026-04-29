#!/usr/bin/env node
/**
 * batch/build-curation.mjs — Phase 3 Curation Gate
 *
 * Reads all batch/triage-output/*.json files, merges them into
 * batch/curation.tsv, and prints a summary.
 *
 * Rules:
 *   - Triage JSON is source of truth for job data (company, role, score, etc.)
 *   - Existing decision/notes in curation.tsv are NEVER overwritten
 *   - New jobs are added with blank decision and notes
 *   - All rows sorted by fit_score descending
 *   - Comment header in curation.tsv explains decision values
 *
 * curation.tsv columns:
 *   id | url | company | role | score | recommendation | archetype |
 *   legitimacy | comp_signal | summary | decision | notes
 *
 * decision values:
 *   APPROVE — send to deep eval
 *   SKIP    — do not evaluate further
 *   (blank) — not yet reviewed
 *
 * Usage:
 *   node batch/build-curation.mjs [--triage-dir=batch/triage-output]
 *                                 [--curation-file=batch/curation.tsv]
 *                                 [--dry-run]
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ── Config ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_DIR = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      args[arg.slice(2)] = true;
    } else {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const TRIAGE_DIR    = resolve(PROJECT_DIR, args['triage-dir']    ?? 'batch/triage-output');
const CURATION_FILE = resolve(PROJECT_DIR, args['curation-file'] ?? 'batch/curation.tsv');
const DRY_RUN       = args['dry-run'] === true;

// ── TSV helpers ───────────────────────────────────────────────────────────────

const COLUMNS = [
  'id', 'url', 'company', 'role', 'score', 'recommendation',
  'archetype', 'legitimacy', 'comp_signal', 'summary', 'decision', 'notes',
];

const COMMENT_HEADER = [
  '# curation.tsv — Human curation gate for career-ops batch pipeline',
  '# Edit the "decision" column to route jobs:',
  '#   APPROVE  →  send to deep evaluation (Step 3)',
  '#   SKIP     →  do not evaluate further',
  '#   (blank)  →  not yet reviewed',
  '# The "notes" column is free text — jot why you approved/skipped.',
  '# Re-run build-curation.mjs to add new triage results; existing decisions are preserved.',
].join('\n');

const TSV_HEADER = COLUMNS.join('\t');

function rowToTsv(row) {
  return COLUMNS.map((col) => (row[col] ?? '').toString().replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t');
}

function tsvToRow(line) {
  const values = line.split('\t');
  const row = {};
  COLUMNS.forEach((col, i) => {
    row[col] = values[i] ?? '';
  });
  return row;
}

// ── Read existing curation.tsv ────────────────────────────────────────────────

/** @returns {Map<string, {decision: string, notes: string}>} keyed by id */
async function readExistingDecisions() {
  const decisions = new Map();
  if (!existsSync(CURATION_FILE)) return decisions;

  const text = await readFile(CURATION_FILE, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Skip TSV header line
    if (trimmed.startsWith('id\t')) continue;

    const row = tsvToRow(trimmed);
    if (!row.id) continue;

    // Only preserve non-empty decisions and notes
    if (row.decision || row.notes) {
      decisions.set(row.id, { decision: row.decision ?? '', notes: row.notes ?? '' });
    }
  }
  return decisions;
}

// ── Read triage output files ──────────────────────────────────────────────────

/** @returns {Array<object>} Parsed triage JSON objects */
async function readTriageOutputs() {
  let files;
  try {
    files = await readdir(TRIAGE_DIR);
  } catch {
    console.error(`[curation] Triage output directory not found: ${TRIAGE_DIR}`);
    console.error(`[curation] Run: npm run triage (or batch/batch-runner.sh --mode=triage ...) first.`);
    process.exit(1);
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    console.error(`[curation] No JSON files found in ${TRIAGE_DIR}`);
    process.exit(1);
  }

  const results = [];
  for (const file of jsonFiles) {
    const fullPath = join(TRIAGE_DIR, file);
    try {
      const text = await readFile(fullPath, 'utf-8');
      const parsed = JSON.parse(text);
      if (!parsed.id) {
        console.warn(`[curation] WARN: ${file} has no "id" field — skipping`);
        continue;
      }
      results.push(parsed);
    } catch (err) {
      console.warn(`[curation] WARN: Could not parse ${file}: ${err.message} — skipping`);
    }
  }

  return results;
}

// ── Build merged rows ─────────────────────────────────────────────────────────

function buildRows(triageOutputs, existingDecisions) {
  let newCount = 0;
  let decidedCount = 0;
  let pendingCount = 0;

  const rows = triageOutputs.map((job) => {
    const id = String(job.id);
    const existing = existingDecisions.get(id);

    const isNew = !existingDecisions.has(id);
    if (isNew) newCount++;

    const decision = existing?.decision ?? '';
    const notes    = existing?.notes    ?? '';

    if (decision) {
      decidedCount++;
    } else {
      pendingCount++;
    }

    return {
      id,
      url:            job.url            ?? '',
      company:        job.company        ?? '',
      role:           job.role           ?? '',
      score:          job.fit_score      != null ? String(job.fit_score) : '',
      recommendation: job.recommendation ?? '',
      archetype:      job.archetype      ?? '',
      legitimacy:     job.legitimacy_tier ?? '',
      comp_signal:    job.comp_signal    ?? '',
      summary:        job.summary        ?? '',
      decision,
      notes,
      // Keep fit_score as number for sorting
      _fit_score:     typeof job.fit_score === 'number' ? job.fit_score : 0,
    };
  });

  // Sort by fit_score descending (highest fit first for easy review)
  rows.sort((a, b) => b._fit_score - a._fit_score);

  // Remove internal sort key before writing
  for (const row of rows) delete row._fit_score;

  return { rows, newCount, decidedCount, pendingCount };
}

// ── Write curation.tsv ────────────────────────────────────────────────────────

async function writeCurationFile(rows) {
  const lines = [
    COMMENT_HEADER,
    TSV_HEADER,
    ...rows.map(rowToTsv),
  ];
  const content = lines.join('\n') + '\n';

  if (DRY_RUN) {
    console.log('[curation] DRY RUN — would write curation.tsv:');
    console.log('─'.repeat(60));
    console.log(content.slice(0, 2000));
    if (content.length > 2000) console.log(`... (${content.length - 2000} more chars)`);
    return;
  }

  await mkdir(dirname(CURATION_FILE), { recursive: true });
  await writeFile(CURATION_FILE, content, 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const [existingDecisions, triageOutputs] = await Promise.all([
  readExistingDecisions(),
  readTriageOutputs(),
]);

console.error(`[curation] Found ${triageOutputs.length} triage output(s), ${existingDecisions.size} existing decision(s)`);

const { rows, newCount, decidedCount, pendingCount } = buildRows(triageOutputs, existingDecisions);

await writeCurationFile(rows);

// ── Summary ───────────────────────────────────────────────────────────────────

const approveCount = rows.filter((r) => r.decision === 'APPROVE').length;
const skipCount    = rows.filter((r) => r.decision === 'SKIP').length;

console.log('');
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║                   Curation Gate Summary                     ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log(`║  Total jobs in curation.tsv : ${String(rows.length).padEnd(30)} ║`);
console.log(`║  New jobs added this run    : ${String(newCount).padEnd(30)} ║`);
console.log(`║  Already decided            : ${String(decidedCount).padEnd(30)} ║`);
console.log(`║    → APPROVE                : ${String(approveCount).padEnd(30)} ║`);
console.log(`║    → SKIP                   : ${String(skipCount).padEnd(30)} ║`);
console.log(`║  Pending review (blank)     : ${String(pendingCount).padEnd(30)} ║`);
console.log('╠══════════════════════════════════════════════════════════════╣');

if (pendingCount > 0) {
  console.log(`║  📋 Open batch/curation.tsv and fill in the "decision"       ║`);
  console.log(`║     column: APPROVE or SKIP for each pending job.            ║`);
  console.log(`║  Then run: npm run deep (Step 3 deep eval)                   ║`);
} else if (approveCount > 0) {
  console.log(`║  ✅ All jobs decided. ${approveCount} approved for deep eval.`.padEnd(63) + '║');
  console.log(`║  Run: npm run deep (Step 3 deep eval)                        ║`);
} else {
  console.log(`║  ⚠️  No jobs approved. Review curation.tsv.                  ║`);
}

console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');

if (!DRY_RUN && rows.length > 0) {
  console.log(`Written: ${CURATION_FILE}`);
}
