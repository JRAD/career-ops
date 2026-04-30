#!/usr/bin/env node
/**
 * batch/batch-worker-deep.mjs — Step 3 Deep Eval Worker
 *
 * Runs Blocks C, D, E, F, G (full) on a pre-triaged, human-approved job.
 * Writes:
 *   - reports/{num}-{slug}-{date}.md     (full evaluation report)
 *   - batch/tracker-additions/{num}-{slug}.tsv  (tracker line for merge)
 *   - interview-prep/story-bank.md       (appended if new stories found)
 *
 * Outputs one valid JSON object to stdout. The orchestrator (batch-runner.sh
 * --mode=deep) captures stdout and updates batch-state.tsv.
 *
 * Prompt caching strategy:
 *   - System prompt  (modes/deep-eval.md)              → cache_control: ephemeral
 *   - User block 1   (cv.md + profile + archetypes)    → cache_control: ephemeral on last block
 *   - User block 2   (per-job task: triage JSON + instructions) → NOT cached (unique per job)
 *
 * Usage:
 *   node batch/batch-worker-deep.mjs \
 *     --id=42 \
 *     --url=https://jobs.example.com/posting/123 \
 *     --report-num=007 \
 *     --report-file=reports/007-acme-corp-2026-04-29.md \
 *     --tracker-tsv=batch/tracker-additions/007-acme-corp.tsv \
 *     [--triage-file=batch/triage-output/42.json] \
 *     [--jd-file=/tmp/jd-42.txt] \
 *     [--date=2026-04-29] \
 *     [--model=claude-sonnet-4-5]
 *
 * Exit codes:
 *   0 — success, valid JSON on stdout
 *   1 — failure (bad args, agent error, invalid JSON output)
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import {
  readProjectFile,
  buildCachedContext,
  toolDefinitions,
  runAgentLoop,
} from './lib/worker-utils.mjs';

// ── Arg parsing ──────────────────────────────────────────────────────────────

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

const id          = args.id;
const url         = args.url;
const reportNum   = args['report-num'];
const reportFile  = args['report-file'];
const trackerTsv  = args['tracker-tsv'];
const triageFile  = args['triage-file'] ?? null;
const jdFile      = args['jd-file'] ?? null;
const date        = args.date ?? new Date().toISOString().slice(0, 10);
const model       = args.model ?? process.env.CAREER_OPS_MODEL ?? 'claude-sonnet-4-5';

if (!id || !url || !reportNum || !reportFile || !trackerTsv) {
  process.stderr.write(
    'Usage: batch-worker-deep.mjs \\\n' +
    '  --id=<id> --url=<url> --report-num=<num> \\\n' +
    '  --report-file=<path> --tracker-tsv=<path> \\\n' +
    '  [--triage-file=<path>] [--jd-file=<path>] [--date=YYYY-MM-DD] [--model=<model>]\n',
  );
  process.exit(1);
}

process.stderr.write(`[deep:${id}] start report=${reportNum} model=${model}\n`);

// ── System prompt (cached) ───────────────────────────────────────────────────

const deepEvalMd = await readProjectFile('modes/deep-eval.md', true);

const system = [
  {
    type: 'text',
    text: deepEvalMd,
    cache_control: { type: 'ephemeral' },
  },
];

// ── User block 1 — candidate context (cached) ────────────────────────────────

const contextBlocks = await buildCachedContext([
  { path: 'cv.md',                 required: false },
  { path: 'config/profile.yml',    required: false },
  { path: 'modes/_profile.md',     required: false },
  { path: 'article-digest.md',     required: false },
  { path: 'config/archetypes.yml', required: true  },
]);

if (contextBlocks.length === 0) {
  process.stderr.write(
    `[deep:${id}] WARN: No context files found. ` +
    'At minimum, config/archetypes.yml must exist.\n',
  );
}

// ── Load triage output ────────────────────────────────────────────────────────

let triageData = null;

if (triageFile) {
  try {
    const raw = await readFile(triageFile, 'utf-8');
    triageData = JSON.parse(raw);
    process.stderr.write(`[deep:${id}] Triage data loaded from ${triageFile}\n`);
  } catch (err) {
    process.stderr.write(`[deep:${id}] WARN: Could not load triage file: ${err.message}\n`);
  }
}

// Build triage summary section for the task block
const triageSummary = triageData
  ? `## Triage Results (from Step 1)

**Company:** ${triageData.company ?? '—'}
**Role:** ${triageData.role ?? '—'}
**Archetype:** ${triageData.archetype ?? '—'} (confidence: ${triageData.archetype_confidence ?? '—'})
**Fit Score:** ${triageData.fit_score ?? '—'}/5
**Recommendation:** ${triageData.recommendation ?? '—'}
**Comp Signal:** ${triageData.comp_signal ?? '—'} — ${triageData.comp_note ?? ''}
**Initial Legitimacy:** ${triageData.legitimacy_tier ?? '—'}

### Top Matches (Block B highlights)
${(triageData.top_matches ?? []).map((m) => `- ${m}`).join('\n') || '— (none provided)'}

### Top Gaps (Block B highlights)
${(triageData.top_gaps ?? []).map((g) => `- [${g.severity}] ${g.gap}`).join('\n') || '— (none identified)'}

### Initial Legitimacy Signals
${(triageData.legitimacy_signals ?? []).map((s) => `- [${s.weight}] ${s.signal}`).join('\n') || '— (none recorded)'}

### Triage Summary
${triageData.summary ?? '—'}
`
  : `## Triage Results

No triage data was pre-loaded. If a JD is provided, extract role facts and CV match highlights yourself before proceeding to Blocks C–G.
`;

// ── Load JD content ───────────────────────────────────────────────────────────

let jdContent = '';

if (jdFile) {
  try {
    const raw = await readFile(jdFile, 'utf-8');
    if (raw.trim().length >= 100) {
      jdContent = raw;
      process.stderr.write(`[deep:${id}] JD loaded from file (${jdContent.length} chars)\n`);
    } else {
      process.stderr.write(`[deep:${id}] JD file too short, will fetch from URL\n`);
    }
  } catch (err) {
    process.stderr.write(`[deep:${id}] Could not read JD file: ${err.message}. Will fetch.\n`);
  }
}

const jdSection = jdContent
  ? `<jd_content>\n${jdContent}\n</jd_content>`
  : `<jd_url>${url}</jd_url>
The JD was not pre-fetched. Use the web_fetch tool to retrieve the full job description from the URL above before running Block E (personalization needs the full JD text).`;

// ── User block 2 — per-job task (NOT cached) ─────────────────────────────────

const taskBlock = {
  type: 'text',
  text: `## Deep Evaluation Task

**Job ID:** ${id}
**URL:** ${url}
**Date:** ${date}
**Report number:** ${reportNum}
**Report file:** ${reportFile}
**Tracker TSV:** ${trackerTsv}

---

${triageSummary}

---

${jdSection}

---

## Instructions

Run Blocks C, D, E, F, and G as defined in your system prompt.

File assignments (use these exact paths with write_file):
- Report: \`${reportFile}\`
- Tracker TSV: \`${trackerTsv}\`

After writing all files, output a single valid JSON object — no markdown fences, no explanation, no text before or after:

{
  "id": "${id}",
  "company": "<company name>",
  "role": "<job title>",
  "score": <fit_score number 1.0-5.0>,
  "recommendation": "<STRONG_MATCH|MATCH|WEAK_MATCH|SKIP>",
  "legitimacy_tier": "<High Confidence|Proceed with Caution|Suspicious>",
  "report_file": "${reportFile}",
  "tracker_tsv": "${trackerTsv}"
}`,
};

// ── Run agent loop ────────────────────────────────────────────────────────────

const client = new Anthropic();

const messages = [
  {
    role: 'user',
    content: [...contextBlocks, taskBlock],
  },
];

// Deep eval needs all tools: read + write for files, web_search for comp/legitimacy
const tools = toolDefinitions(['read_file', 'write_file', 'web_search', 'web_fetch']);

// Allow up to 25 iterations: C+D (search) + E+F (write) + G (search+write) + report+tsv + story-bank
let rawOutput;
try {
  rawOutput = await runAgentLoop(client, model, system, messages, tools, 25);
} catch (err) {
  process.stderr.write(`[deep:${id}] Agent loop error: ${err.message}\n`);
  process.exit(1);
}

// ── Parse and validate JSON output ───────────────────────────────────────────

const cleaned = rawOutput
  .replace(/^```(?:json)?\s*/im, '')
  .replace(/\s*```\s*$/m, '')
  .trim();

let jsonStr = cleaned;
const lastBrace = cleaned.lastIndexOf('{');
if (lastBrace > 0) {
  const before = cleaned.slice(0, lastBrace).trim();
  if (before.length > 0 && !before.endsWith(',')) {
    jsonStr = cleaned.slice(lastBrace);
    process.stderr.write(`[deep:${id}] WARN: Stripped preamble text before JSON\n`);
  }
}

let parsed;
try {
  parsed = JSON.parse(jsonStr);
} catch (err) {
  process.stderr.write(`[deep:${id}] Output is not valid JSON: ${err.message}\n`);
  process.stderr.write(`[deep:${id}] Raw output (first 600 chars):\n${rawOutput.slice(0, 600)}\n`);
  process.exit(1);
}

// Validate required fields
const REQUIRED_FIELDS = [
  'id', 'company', 'role', 'score', 'recommendation', 'legitimacy_tier',
  'report_file', 'tracker_tsv',
];
const missing = REQUIRED_FIELDS.filter((f) => !(f in parsed));
if (missing.length > 0) {
  process.stderr.write(`[deep:${id}] JSON missing required fields: ${missing.join(', ')}\n`);
  process.exit(1);
}

// Validate score
if (typeof parsed.score !== 'number' || parsed.score < 1 || parsed.score > 5) {
  process.stderr.write(
    `[deep:${id}] Invalid score: ${parsed.score}. Must be a number 1.0–5.0\n`,
  );
  process.exit(1);
}

// Validate recommendation
const VALID_RECS = ['STRONG_MATCH', 'MATCH', 'WEAK_MATCH', 'SKIP'];
if (!VALID_RECS.includes(parsed.recommendation)) {
  process.stderr.write(
    `[deep:${id}] Invalid recommendation: "${parsed.recommendation}"\n`,
  );
  process.exit(1);
}

// Inject orchestrator fields
parsed.id         = id;
parsed.report_num = reportNum;
parsed.date       = date;
parsed.url        = url;

// ── Output ────────────────────────────────────────────────────────────────────

process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
process.stderr.write(
  `[deep:${id}] done — ${parsed.company} / ${parsed.role}` +
  ` score=${parsed.score} rec=${parsed.recommendation}` +
  ` report=${parsed.report_file}\n`,
);
