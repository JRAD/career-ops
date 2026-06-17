#!/usr/bin/env node
/**
 * pre-triage.mjs — Zero-cost pre-filter for pipeline.md
 *
 * Applies portals.yml rules (title_filter, company_blocklist) to every
 * pending entry in data/pipeline.md without any LLM calls. Entries that
 * fail a rule are moved to a ## Pre-filtered section with a reason tag,
 * reducing the payload for the API-based batch triage step.
 *
 * Usage:
 *   node pre-triage.mjs            # filter and write changes
 *   node pre-triage.mjs --dry-run  # preview without writing
 *   node pre-triage.mjs --verbose  # show every filtered entry
 */

import { readFileSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PIPELINE_PATH  = join(__dirname, 'data/pipeline.md');
const PORTALS_PATH   = join(__dirname, 'portals.yml');
const PRE_FILTERED_MARKER = '## Pre-filtered';

const dryRun  = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');

// ── Filters ───────────────────────────────────────────────────────────

/**
 * Returns { pass: true } or { pass: false, reason: string }.
 */
function buildTitleCheck(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const matchedNeg = negative.find(k => lower.includes(k));
    if (matchedNeg) return { pass: false, reason: `title:neg:${matchedNeg}` };
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    if (!hasPositive) return { pass: false, reason: 'title:no-match' };
    return { pass: true };
  };
}

function buildCompanyCheck(blocklist) {
  const blocked = (blocklist || []).map(k => k.toLowerCase());
  return (company) => {
    if (!blocked.length) return { pass: true };
    const lower = (company || '').toLowerCase();
    const matched = blocked.find(k => lower.includes(k));
    return matched
      ? { pass: false, reason: `company:${matched}` }
      : { pass: true };
  };
}

// ── Line parser ───────────────────────────────────────────────────────

/**
 * Parse "- [ ] url | company | title" → { url, company, title } or null.
 * Handles trailing whitespace and entries with extra pipe-separated fields.
 */
function parsePendingLine(line) {
  const m = line.match(/^- \[ \] (https?:\/\/\S+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$/);
  if (!m) return null;
  return { url: m[1].trim(), company: m[2].trim(), title: m[3].trim() };
}

// ── Main ──────────────────────────────────────────────────────────────

const config     = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
const titleCheck = buildTitleCheck(config.title_filter);
const companyCheck = buildCompanyCheck(config.company_blocklist);

const text  = readFileSync(PIPELINE_PATH, 'utf-8');
const lines = text.split('\n');

// Split off any existing Pre-filtered section so we don't double-process it.
const existingMarkerIdx = lines.findIndex(l => l.trim() === PRE_FILTERED_MARKER);
const mainLines          = existingMarkerIdx === -1 ? lines : lines.slice(0, existingMarkerIdx);
const existingFiltered   = existingMarkerIdx === -1 ? []
  : lines.slice(existingMarkerIdx + 1).filter(l => l.trim() !== '');

const keptLines      = [];
const newlyFiltered  = [];
const reasons        = {};

let totalPending  = 0;
let totalSurvived = 0;
let totalUnparsed = 0;

for (const line of mainLines) {
  if (!line.startsWith('- [ ]')) {
    keptLines.push(line);
    continue;
  }

  totalPending++;
  const parsed = parsePendingLine(line);

  if (!parsed) {
    // Can't extract url|company|title — keep it, flag for manual review
    keptLines.push(line);
    totalUnparsed++;
    totalSurvived++;
    continue;
  }

  // 1. Company blocklist
  const cr = companyCheck(parsed.company);
  if (!cr.pass) {
    newlyFiltered.push(`- [s] ${parsed.url} | ${parsed.company} | ${parsed.title}  ← [${cr.reason}]`);
    reasons[cr.reason] = (reasons[cr.reason] || 0) + 1;
    continue;
  }

  // 2. Title filter
  const tr = titleCheck(parsed.title);
  if (!tr.pass) {
    newlyFiltered.push(`- [s] ${parsed.url} | ${parsed.company} | ${parsed.title}  ← [${tr.reason}]`);
    reasons[tr.reason] = (reasons[tr.reason] || 0) + 1;
    continue;
  }

  keptLines.push(line);
  totalSurvived++;
}

// ── Build output ──────────────────────────────────────────────────────

const allPreFiltered = [...newlyFiltered, ...existingFiltered];
let output = keptLines.join('\n').trimEnd();
if (allPreFiltered.length > 0) {
  output += `\n\n${PRE_FILTERED_MARKER}\n` + allPreFiltered.join('\n') + '\n';
}

// ── Report ────────────────────────────────────────────────────────────

const filtered = totalPending - totalSurvived;
console.log(`\n📋 Pipeline entries scanned: ${totalPending}`);
console.log(`✅ Survived (sent to batch triage): ${totalSurvived}`);
console.log(`🚫 Pre-filtered: ${filtered} (${Math.round(filtered / totalPending * 100)}%)`);
if (totalUnparsed > 0) {
  console.log(`⚠️  Unparsed (kept, manual review): ${totalUnparsed}`);
}

if (Object.keys(reasons).length > 0) {
  console.log('\nBreakdown by rule:');
  const sorted = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted) {
    console.log(`  ${reason.padEnd(35)} ${count}`);
  }
}

if (dryRun) {
  console.log('\n(dry run — no changes written)');
  if (verbose && newlyFiltered.length) {
    console.log('\nWould filter:');
    for (const l of newlyFiltered) console.log(' ', l);
  }
} else {
  writeFileSync(PIPELINE_PATH, output, 'utf-8');
  console.log('\n✅ pipeline.md updated');
  if (verbose && newlyFiltered.length) {
    console.log('\nFiltered entries:');
    for (const l of newlyFiltered) console.log(' ', l);
  }
}
