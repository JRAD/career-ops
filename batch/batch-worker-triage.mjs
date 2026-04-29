#!/usr/bin/env node
/**
 * batch/batch-worker-triage.mjs — Step 1 Triage Worker
 *
 * Runs Blocks A, B (abbreviated), G (text-only), and comp signal on a single
 * job posting. Outputs one valid JSON object to stdout. The orchestrator
 * (batch-runner.sh --mode=triage) captures stdout and writes it to
 * batch/triage-output/{id}.json.
 *
 * Prompt caching strategy:
 *   - System prompt  (modes/triage.md)           → cache_control: ephemeral
 *   - User block 1   (cv.md + profile + archetypes) → cache_control: ephemeral on last block
 *   - User block 2   (per-job task + JD)          → NOT cached (unique per job)
 *
 * Usage:
 *   node batch/batch-worker-triage.mjs \
 *     --id=42 \
 *     --url=https://jobs.example.com/posting/123 \
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

const id   = args.id;
const url  = args.url;
const jdFile = args['jd-file'] ?? null;
const date = args.date ?? new Date().toISOString().slice(0, 10);
const model = args.model ?? process.env.CAREER_OPS_MODEL ?? 'claude-sonnet-4-5';
// Open Question 1: benchmark claude-haiku-4-5 vs claude-sonnet-4-5 for triage quality.
// Override with: --model=claude-haiku-4-5 or CAREER_OPS_MODEL=claude-haiku-4-5

if (!id || !url) {
  process.stderr.write(
    'Usage: batch-worker-triage.mjs --id=<id> --url=<url>' +
    ' [--jd-file=<path>] [--date=YYYY-MM-DD] [--model=<model>]\n',
  );
  process.exit(1);
}

process.stderr.write(`[triage:${id}] start url=${url} model=${model}\n`);

// ── System prompt (cached) ───────────────────────────────────────────────────

const triageMd = await readProjectFile('modes/triage.md', true);

const system = [
  {
    type: 'text',
    text: triageMd,
    cache_control: { type: 'ephemeral' },
  },
];

// ── User block 1 — candidate context (cached) ────────────────────────────────
//
// These files are identical for every job in a batch, so they get cached as a
// single checkpoint. The last block in the array receives cache_control.

const contextBlocks = await buildCachedContext([
  { path: 'cv.md',                 required: false },
  { path: 'config/profile.yml',    required: false },
  { path: 'modes/_profile.md',     required: false },
  { path: 'article-digest.md',     required: false },
  { path: 'config/archetypes.yml', required: true  },
]);

if (contextBlocks.length === 0) {
  process.stderr.write(
    `[triage:${id}] WARN: No context files found. ` +
    'At minimum, config/archetypes.yml must exist.\n',
  );
}

// ── User block 2 — per-job task (NOT cached) ─────────────────────────────────

let jdContent = '';

if (jdFile) {
  try {
    const raw = await readFile(jdFile, 'utf-8');
    if (raw.trim().length >= 100) {
      jdContent = raw;
      process.stderr.write(`[triage:${id}] JD loaded from file (${jdContent.length} chars)\n`);
    } else {
      process.stderr.write(`[triage:${id}] JD file too short (${raw.length} chars), will fetch\n`);
    }
  } catch (err) {
    process.stderr.write(`[triage:${id}] Could not read JD file: ${err.message}. Will fetch.\n`);
  }
}

const jdSection = jdContent
  ? `<jd_content>\n${jdContent}\n</jd_content>`
  : `<jd_url>${url}</jd_url>
The JD was not pre-fetched. Use the web_fetch tool to retrieve the job description from the URL above before proceeding.`;

const taskBlock = {
  type: 'text',
  text: `## Triage Task

**Job ID:** ${id}
**URL:** ${url}
**Date:** ${date}

${jdSection}

Analyze this job posting against the candidate's CV and profile (in your context above). Follow your system prompt exactly.

Output a single valid JSON object — no markdown fences, no explanation, no text before or after the JSON.`,
};

// ── Run agent loop ────────────────────────────────────────────────────────────

const client = new Anthropic();
// API key from ANTHROPIC_API_KEY env var (standard SDK behavior)

const messages = [
  {
    role: 'user',
    content: [...contextBlocks, taskBlock],
  },
];

const tools = toolDefinitions(['read_file', 'web_fetch']);

let rawOutput;
try {
  rawOutput = await runAgentLoop(client, model, system, messages, tools, 10);
} catch (err) {
  process.stderr.write(`[triage:${id}] Agent loop error: ${err.message}\n`);
  process.exit(1);
}

// ── Parse and validate JSON output ───────────────────────────────────────────

// Strip markdown code fences if the model wrapped the JSON despite instructions
const cleaned = rawOutput
  .replace(/^```(?:json)?\s*/im, '')
  .replace(/\s*```\s*$/m, '')
  .trim();

// If the response contains multiple JSON objects (shouldn't happen), take the
// last complete one — the model sometimes reasons before outputting JSON
let jsonStr = cleaned;
const lastBrace = cleaned.lastIndexOf('{');
if (lastBrace > 0) {
  // Check if everything before the last { is non-JSON reasoning text
  const before = cleaned.slice(0, lastBrace).trim();
  if (before.length > 0 && !before.endsWith(',')) {
    jsonStr = cleaned.slice(lastBrace);
    process.stderr.write(`[triage:${id}] WARN: Stripped preamble text before JSON\n`);
  }
}

let parsed;
try {
  parsed = JSON.parse(jsonStr);
} catch (err) {
  process.stderr.write(`[triage:${id}] Output is not valid JSON: ${err.message}\n`);
  process.stderr.write(`[triage:${id}] Raw output (first 600 chars):\n${rawOutput.slice(0, 600)}\n`);
  process.exit(1);
}

// Validate required fields
const REQUIRED_FIELDS = [
  'company', 'role', 'archetype', 'fit_score', 'recommendation',
  'top_matches', 'top_gaps', 'comp_signal', 'legitimacy_tier', 'summary',
];
const missing = REQUIRED_FIELDS.filter((f) => !(f in parsed));
if (missing.length > 0) {
  process.stderr.write(`[triage:${id}] JSON missing required fields: ${missing.join(', ')}\n`);
  process.exit(1);
}

// Validate recommendation value
const VALID_RECS = ['STRONG_MATCH', 'MATCH', 'WEAK_MATCH', 'SKIP'];
if (!VALID_RECS.includes(parsed.recommendation)) {
  process.stderr.write(
    `[triage:${id}] Invalid recommendation: "${parsed.recommendation}". ` +
    `Must be one of: ${VALID_RECS.join(', ')}\n`,
  );
  process.exit(1);
}

// Validate fit_score is a number in range
if (typeof parsed.fit_score !== 'number' || parsed.fit_score < 1 || parsed.fit_score > 5) {
  process.stderr.write(
    `[triage:${id}] Invalid fit_score: ${parsed.fit_score}. Must be a number 1.0–5.0\n`,
  );
  process.exit(1);
}

// Inject orchestrator-supplied fields (overwrite anything the model put here)
parsed.id   = id;
parsed.url  = url;
parsed.date = date;

// ── Output ────────────────────────────────────────────────────────────────────

process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
process.stderr.write(
  `[triage:${id}] done — ${parsed.company} / ${parsed.role}` +
  ` fit=${parsed.fit_score} rec=${parsed.recommendation}` +
  ` legitimacy="${parsed.legitimacy_tier}"\n`,
);
