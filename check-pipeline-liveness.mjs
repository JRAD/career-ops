/**
 * check-pipeline-liveness.mjs
 *
 * Fetches ATS boards for all companies in pipeline.md and identifies
 * which job listings are no longer active.
 *
 * Output: JSON report + updated pipeline.md with dead entries marked [x] (removed)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PIPELINE_FILE = path.join(__dirname, 'data', 'pipeline.md');
const DELAY_MS = 300; // polite delay between requests

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── ATS fetchers ───────────────────────────────────────────────────────────

async function fetchGreenhouseJobs(slug) {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`;
    const res = await fetch(url, { headers: { 'User-Agent': 'career-ops-liveness-check/1.0' } });
    if (!res.ok) return { slug, error: `HTTP ${res.status}`, ids: new Set() };
    const data = await res.json();
    const ids = new Set((data.jobs || []).map(j => String(j.id)));
    return { slug, ids, count: ids.size };
  } catch (e) {
    return { slug, error: e.message, ids: new Set() };
  }
}

async function fetchGreenhouseEuJobs(slug) {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`;
    const res = await fetch(url, { headers: { 'User-Agent': 'career-ops-liveness-check/1.0' } });
    if (!res.ok) return { slug, error: `HTTP ${res.status}`, ids: new Set() };
    const data = await res.json();
    const ids = new Set((data.jobs || []).map(j => String(j.id)));
    return { slug, ids, count: ids.size };
  } catch (e) {
    return { slug, error: e.message, ids: new Set() };
  }
}

async function fetchLeverJobs(slug) {
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json&limit=250`;
    const res = await fetch(url, { headers: { 'User-Agent': 'career-ops-liveness-check/1.0' } });
    if (!res.ok) return { slug, error: `HTTP ${res.status}`, ids: new Set() };
    const data = await res.json();
    const jobs = Array.isArray(data) ? data : [];
    // Lever IDs are UUIDs stored in the posting URL path
    const ids = new Set(jobs.map(j => j.id));
    return { slug, ids, count: ids.size };
  } catch (e) {
    return { slug, error: e.message, ids: new Set() };
  }
}

async function fetchAshbyJobs(slug) {
  try {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'career-ops-liveness-check/1.0',
        'Accept': 'application/json',
      }
    });
    if (!res.ok) return { slug, error: `HTTP ${res.status}`, ids: new Set() };
    const data = await res.json();
    // Ashby API returns { jobs: [...], apiVersion: ... }
    // Each job has an "id" field (UUID) that matches the URL path
    const jobs = data.jobs || data.jobPostings || [];
    const ids = new Set(jobs.map(j => j.id || j.jobPostingId).filter(Boolean));
    // Also extract IDs from jobUrl if present (e.g. https://jobs.ashbyhq.com/decagon/{uuid})
    for (const j of jobs) {
      if (j.jobUrl) {
        const parts = j.jobUrl.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.includes('-')) ids.add(lastPart);
      }
    }
    return { slug, ids, count: ids.size };
  } catch (e) {
    return { slug, error: e.message, ids: new Set() };
  }
}

// ─── Parse pipeline.md ──────────────────────────────────────────────────────

function parsePipeline(content) {
  const lines = content.split('\n');
  const entries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match both [ ] and [x] entries
    const match = line.match(/^- (\[[ x]\]) (https?:\/\/[^\s|]+)(.*)/);
    if (match) {
      const checked = match[1] === '[x]';
      const url = match[2].trim();
      const rest = match[3];
      entries.push({ lineIndex: i, checked, url, rest, original: line });
    }
  }
  return entries;
}

// ─── Extract job ID from URL ─────────────────────────────────────────────────

function extractJobInfo(url) {
  // Greenhouse: job-boards.greenhouse.io/{slug}/jobs/{id}
  let m = url.match(/job-boards\.greenhouse\.io\/([^\/]+)\/jobs\/(\d+)/);
  if (m) return { ats: 'greenhouse', slug: m[1], id: m[2] };

  // EU Greenhouse
  m = url.match(/job-boards\.eu\.greenhouse\.io\/([^\/]+)\/jobs\/(\d+)/);
  if (m) return { ats: 'greenhouse', slug: m[1], id: m[2] };

  // Greenhouse via gh_jid param
  m = url.match(/[?&]gh_jid=(\d+)/);
  if (m) {
    const id = m[1];
    // Extract slug from URL domain/path
    let slug = null;
    const domainMatch = url.match(/\/\/([^\/]+)/);
    if (domainMatch) {
      const domain = domainMatch[1];
      if (domain.includes('hellofresh')) slug = 'hellofresh';
      else if (domain.includes('getyourguide')) slug = 'getyourguide';
      else if (domain.includes('n26')) slug = 'n26';
      else if (domain.includes('sumup')) slug = 'sumup';
      else if (domain.includes('traderepublic')) slug = 'traderepublic';
      else if (domain.includes('wayve')) slug = 'wayve';
      else if (domain.includes('okta')) slug = 'okta';
      else if (domain.includes('boomi')) slug = 'boomi';
      else if (domain.includes('hootsuite')) slug = 'hootsuite';
      else if (domain.includes('stability')) slug = 'stabilityai';
    }
    return { ats: 'greenhouse', slug, id };
  }

  // Lever: jobs.lever.co/{slug}/{id}
  m = url.match(/jobs\.lever\.co\/([^\/]+)\/([a-f0-9-]{36})/);
  if (m) return { ats: 'lever', slug: m[1], id: m[2] };

  // Ashby: jobs.ashbyhq.com/{slug}/{id}
  m = url.match(/jobs\.ashbyhq\.com\/([^\/]+)\/([a-f0-9-]{36})/);
  if (m) return { ats: 'ashby', slug: m[1], id: m[2] };

  // Remotive
  if (url.includes('remotive.com')) return { ats: 'remotive', slug: null, id: null };

  return { ats: 'unknown', slug: null, id: null };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const content = fs.readFileSync(PIPELINE_FILE, 'utf8');
  const entries = parsePipeline(content);

  const unchecked = entries.filter(e => !e.checked);
  console.log(`Total entries: ${entries.length}, Unchecked: ${unchecked.length}`);

  // Collect all unique company slugs by ATS
  const companiesByAts = { greenhouse: new Map(), lever: new Map(), ashby: new Map() };

  for (const entry of unchecked) {
    const info = extractJobInfo(entry.url);
    if (info.slug) {
      const map = companiesByAts[info.ats];
      if (map) {
        if (!map.has(info.slug)) map.set(info.slug, new Set());
        map.get(info.slug).add(entry.url);
      }
    }
  }

  console.log('\nCompanies to check:');
  console.log('  Greenhouse:', [...companiesByAts.greenhouse.keys()].join(', '));
  console.log('  Lever:', [...companiesByAts.lever.keys()].join(', '));
  console.log('  Ashby:', [...companiesByAts.ashby.keys()].join(', '));

  // Fetch all boards
  const activeIds = { greenhouse: new Map(), lever: new Map(), ashby: new Map() };
  const fetchErrors = [];

  console.log('\n--- Fetching Greenhouse boards ---');
  for (const slug of companiesByAts.greenhouse.keys()) {
    await sleep(DELAY_MS);
    const result = await fetchGreenhouseJobs(slug);
    if (result.error) {
      console.log(`  ❌ ${slug}: ${result.error}`);
      fetchErrors.push({ ats: 'greenhouse', slug, error: result.error });
    } else {
      console.log(`  ✅ ${slug}: ${result.count} active jobs`);
    }
    activeIds.greenhouse.set(slug, result.ids);
  }

  console.log('\n--- Fetching Lever boards ---');
  for (const slug of companiesByAts.lever.keys()) {
    await sleep(DELAY_MS);
    const result = await fetchLeverJobs(slug);
    if (result.error) {
      console.log(`  ❌ ${slug}: ${result.error}`);
      fetchErrors.push({ ats: 'lever', slug, error: result.error });
    } else {
      console.log(`  ✅ ${slug}: ${result.count} active jobs`);
    }
    activeIds.lever.set(slug, result.ids);
  }

  console.log('\n--- Fetching Ashby boards ---');
  for (const slug of companiesByAts.ashby.keys()) {
    await sleep(DELAY_MS);
    const result = await fetchAshbyJobs(slug);
    if (result.error) {
      console.log(`  ❌ ${slug}: ${result.error}`);
      fetchErrors.push({ ats: 'ashby', slug, error: result.error });
    } else {
      console.log(`  ✅ ${slug}: ${result.count} active jobs`);
    }
    activeIds.ashby.set(slug, result.ids);
  }

  // Now cross-reference
  console.log('\n--- Checking each pipeline entry ---');

  const dead = [];
  const alive = [];
  const unknown = [];

  for (const entry of unchecked) {
    const info = extractJobInfo(entry.url);

    if (info.ats === 'unknown' || info.ats === 'remotive') {
      unknown.push(entry);
      continue;
    }

    if (!info.slug || !info.id) {
      unknown.push(entry);
      continue;
    }

    const boardIds = activeIds[info.ats]?.get(info.slug);

    // If we had a fetch error for this board, skip (don't falsely mark as dead)
    if (!boardIds || boardIds.size === 0) {
      const hadError = fetchErrors.some(e => e.ats === info.ats && e.slug === info.slug);
      if (hadError) {
        unknown.push({ ...entry, reason: 'fetch-error' });
      } else {
        // Board returned 0 jobs — treat all as unknown (might be API issue)
        unknown.push({ ...entry, reason: 'empty-board' });
      }
      continue;
    }

    if (boardIds.has(info.id)) {
      alive.push(entry);
    } else {
      dead.push({ ...entry, ats: info.ats, slug: info.slug, id: info.id });
    }
  }

  console.log(`\n📊 Results:`);
  console.log(`  ✅ Still alive: ${alive.length}`);
  console.log(`  ❌ Dead/closed: ${dead.length}`);
  console.log(`  ❓ Unknown/unchecked: ${unknown.length}`);

  if (dead.length > 0) {
    console.log('\n❌ DEAD LISTINGS (to remove from pipeline):');
    for (const d of dead) {
      const label = d.rest.trim();
      console.log(`  [${d.ats}/${d.slug}] ${label.substring(0, 80)}`);
    }
  }

  // Write results to JSON
  const report = {
    generatedAt: new Date().toISOString(),
    summary: { total: unchecked.length, alive: alive.length, dead: dead.length, unknown: unknown.length },
    dead: dead.map(d => ({ url: d.url, label: d.rest.trim(), ats: d.ats, slug: d.slug, id: d.id })),
    unknown: unknown.map(u => ({ url: u.url, label: u.rest.trim(), reason: u.reason })),
    fetchErrors,
  };

  fs.writeFileSync(
    path.join(__dirname, 'data', 'pipeline-liveness-report.json'),
    JSON.stringify(report, null, 2)
  );
  console.log('\n📄 Full report saved to data/pipeline-liveness-report.json');

  // Update pipeline.md — remove dead entries
  if (dead.length > 0) {
    const lines = content.split('\n');
    const deadUrls = new Set(dead.map(d => d.url));

    const updatedLines = lines.filter(line => {
      const m = line.match(/^- \[ \] (https?:\/\/[^\s|]+)/);
      if (m) {
        const url = m[1].trim();
        return !deadUrls.has(url);
      }
      return true;
    });

    // Clean up multiple blank lines
    const cleaned = updatedLines.join('\n').replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(PIPELINE_FILE, cleaned);
    console.log(`\n✅ Removed ${dead.length} dead entries from pipeline.md`);
  }
}

main().catch(console.error);
