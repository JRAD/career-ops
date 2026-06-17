#!/usr/bin/env node
/**
 * prune-pipeline.mjs — ATS liveness check for pipeline.md
 *
 * For every pending - [ ] entry whose URL maps to a standard Greenhouse,
 * Ashby, or Lever board, fetches that board's current job list and removes
 * any job that no longer appears. Non-ATS URLs (Okta custom domain, BuiltIn
 * Seattle, etc.) are left untouched — they can't be verified this way.
 *
 * Expired entries move to ## Pre-filtered with reason [liveness:expired].
 * Zero LLM tokens. Zero Playwright. Pure REST.
 *
 * Usage:
 *   node prune-pipeline.mjs            # check and write
 *   node prune-pipeline.mjs --dry-run  # preview without writing
 *   node prune-pipeline.mjs --verbose  # show each checked URL
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH    = join(__dirname, 'data/pipeline.md');
const PRE_FILTERED_MARKER = '## Pre-filtered';

const dryRun  = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');

// ── ATS URL parser (mirrors extractJobInfo in scan.mjs) ───────────────

function extractJobInfo(url) {
  // Standard Greenhouse (US + EU boards)
  let m = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  if (m) return { ats: 'greenhouse', slug: m[1], id: m[2] };

  // Legacy Greenhouse boards URL
  m = url.match(/boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  if (m) return { ats: 'greenhouse', slug: m[1], id: m[2] };

  // Lever
  m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([a-f0-9-]{36})/);
  if (m) return { ats: 'lever', slug: m[1], id: m[2] };

  // Ashby
  m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([a-f0-9-]{36})/);
  if (m) return { ats: 'ashby', slug: m[1], id: m[2] };

  return null; // custom domain or unknown — skip
}

// ── ATS board fetchers ────────────────────────────────────────────────

async function fetchActiveIds(ats, slug) {
  const endpoints = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    ashby:      `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    lever:      `https://api.lever.co/v0/postings/${slug}?mode=json`,
  };

  const url = endpoints[ats];
  if (!url) return null;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'career-ops-pipeline-pruner/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      // 404 = board itself is gone — treat all its jobs as expired
      if (res.status === 404) return new Set();
      return null; // other error — skip to avoid false positives
    }

    const json = await res.json();

    if (ats === 'greenhouse') {
      return new Set((json.jobs || []).map(j => String(j.id)));
    }
    if (ats === 'ashby') {
      return new Set((json.jobs || []).map(j => j.id));
    }
    if (ats === 'lever') {
      return new Set(Array.isArray(json) ? json.map(j => j.id) : []);
    }
  } catch {
    return null; // timeout or network error — skip
  }

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────

const text  = readFileSync(PIPELINE_PATH, 'utf-8');
const lines = text.split('\n');

// Split off existing Pre-filtered section
const markerIdx       = lines.findIndex(l => l.trim() === PRE_FILTERED_MARKER);
const mainLines       = markerIdx === -1 ? lines : lines.slice(0, markerIdx);
const existingFiltered = markerIdx === -1 ? []
  : lines.slice(markerIdx + 1).filter(l => l.trim() !== '');

// Collect pending entries with parsed ATS info
const pending = [];
for (const line of mainLines) {
  if (!line.startsWith('- [ ]')) continue;
  const m = line.match(/^- \[ \] (https?:\/\/\S+)/);
  if (!m) continue;
  const info = extractJobInfo(m[1]);
  pending.push({ line, url: m[1], info });
}

// Group verifiable entries by (ats, slug) to minimise API calls
const boards = new Map(); // key: "ats::slug" → { ats, slug }
for (const { info } of pending) {
  if (!info) continue;
  const key = `${info.ats}::${info.slug}`;
  if (!boards.has(key)) boards.set(key, info);
}

console.log(`\n🔍 Pipeline: ${pending.length} pending entries`);
console.log(`📡 Unique ATS boards to check: ${boards.size}`);
const unverifiable = pending.filter(p => !p.info).length;
if (unverifiable > 0) {
  console.log(`⚠️  Unverifiable (custom domain / non-ATS): ${unverifiable} — left as-is`);
}
console.log();

// Fetch active ID sets for each board
const boardActiveIds = new Map();
let boardErrors = 0;

for (const [key, { ats, slug }] of boards) {
  process.stdout.write(`  Fetching ${ats}/${slug} ... `);
  const ids = await fetchActiveIds(ats, slug);
  if (ids === null) {
    process.stdout.write('⚠️  error (skipped)\n');
    boardErrors++;
  } else {
    process.stdout.write(`✅ ${ids.size} active jobs\n`);
    boardActiveIds.set(key, ids);
  }
}

// Check each pending entry
const keptLines    = [];
const newlyExpired = [];
let checkedCount   = 0;
let expiredCount   = 0;
let skippedCount   = 0;

for (const line of mainLines) {
  if (!line.startsWith('- [ ]')) {
    keptLines.push(line);
    continue;
  }

  const m = line.match(/^- \[ \] (https?:\/\/\S+)/);
  if (!m) { keptLines.push(line); continue; }

  const info = extractJobInfo(m[1]);
  if (!info) {
    keptLines.push(line); // unverifiable — keep
    skippedCount++;
    continue;
  }

  const key = `${info.ats}::${info.slug}`;
  const activeIds = boardActiveIds.get(key);
  if (!activeIds) {
    keptLines.push(line); // board errored — keep to avoid false positives
    skippedCount++;
    continue;
  }

  checkedCount++;
  if (!activeIds.has(info.id)) {
    newlyExpired.push(`${line}  ← [liveness:expired]`);
    expiredCount++;
    if (verbose) console.log(`  ❌ expired: ${m[1]}`);
  } else {
    keptLines.push(line);
  }
}

// Build output
const allPreFiltered = [...newlyExpired, ...existingFiltered];
let output = keptLines.join('\n').trimEnd();
if (allPreFiltered.length > 0) {
  output += `\n\n${PRE_FILTERED_MARKER}\n` + allPreFiltered.join('\n') + '\n';
}

// Summary
console.log(`\n📊 Results:`);
console.log(`  Checked via ATS API:  ${checkedCount}`);
console.log(`  Expired (removed):    ${expiredCount}`);
console.log(`  Skipped (kept):       ${skippedCount}`);
console.log(`  Board errors (kept):  ${boardErrors} boards`);
if (boardErrors > 0) {
  console.log(`  (entries from errored boards are kept to avoid false positives)`);
}

if (dryRun) {
  console.log('\n(dry run — no changes written)');
} else if (expiredCount > 0) {
  writeFileSync(PIPELINE_PATH, output, 'utf-8');
  console.log('\n✅ pipeline.md updated');
} else {
  console.log('\nNo changes needed.');
}
