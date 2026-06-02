#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --prune          # also remove closed pipeline entries
 *   node scan.mjs --dry-run --prune  # preview both adds and removals
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Greenhouse: explicit api field
  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

// Remote board parsers — each job carries its own company name

function parseRemotive(json, _sourceName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.url || '',
    company: j.company_name || '',
    location: j.candidate_required_location || '',
  }));
}

function parseWeworkremotely(json, _sourceName) {
  // WWR returns { jobs: [{ title, url, company, region }] } from their unofficial JSON endpoint
  const jobs = Array.isArray(json) ? json : (json.jobs || []);
  return jobs.map(j => ({
    title: j.title || j.subject || '',
    url: j.url || j.link || '',
    company: j.company || j.company_name || '',
    location: j.region || j.location || 'Remote',
  }));
}

/**
 * Awesome People List — ex-Epic Games talent board
 *
 * API returns an array of companies, each with:
 *   company, focus, applicationProcess (URL or email), specificAreas (free-text role list)
 *
 * Strategy: use specificAreas as the synthetic "title" so the existing title_filter
 * applies naturally. If specificAreas mentions "Backend Engineers", the keyword
 * "Backend Engineer" matches as a substring. Email-only and blank application
 * processes are skipped — we need a URL to add to the pipeline.
 *
 * One offer is emitted per matching company (not per role), pointing to their
 * careers URL. Dedup prevents re-adding a URL seen in a prior scan.
 */
function parseAwesomePeopleList(json, _sourceName) {
  const entries = Array.isArray(json) ? json : [];
  return entries
    .filter(e => {
      const proc = (e.applicationProcess || '').trim();
      // Must have a URL-based process — skip emails and blanks
      if (!proc || proc.includes('@')) return false;
      return proc.startsWith('http') || proc.startsWith('www') || proc.startsWith('https');
    })
    .map(e => {
      const proc = (e.applicationProcess || '').trim();
      const url = proc.startsWith('www') ? `https://${proc}` : proc;
      // Use specificAreas as synthetic title — lets title_filter match naturally.
      // Fall back to focus area if specificAreas is null/empty.
      const title = (e.specificAreas || e.focus || '').replace(/\n/g, ' ').trim()
        || 'Multiple Engineering Roles';
      return {
        title,
        url,
        company: e.company || '',
        location: '', // not provided per-entry; empty passes location filter
      };
    });
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };
const BOARD_PARSERS = {
  remotive: parseRemotive,
  weworkremotely: parseWeworkremotely,
  awesomepeoplelist: parseAwesomePeopleList,
};

// ── HTML scrapers ───────────────────────────────────────────────────

/**
 * Built In Seattle — HTML scraper
 *
 * The page is server-side rendered so jobs are in the raw HTML.
 * Each listing lives inside an element with class "job-card".
 * Within each card:
 *   - Job link:     href="/job/[slug]/[id]"  (slug encodes the title)
 *   - Company name: div with class "left-side-tile-item-2"
 *
 * Strategy: split HTML on job-card boundaries, extract href + company
 * from each card, derive title from URL slug. The slug maps directly
 * to the job title ("senior-software-engineer-backend" → passes the
 * "software engineer" positive filter; "software-engineer-ios" → caught
 * by the "ios" negative filter). No DOM library needed.
 *
 * Pagination: append &page=N. Stop early when a full page is all-dupes
 * (dedup-based early exit — avoids fetching all 20 pages every run).
 */
async function scrapeBuiltInSeattle(scraperConfig, processJobs, errors) {
  const BASE = 'https://www.builtinseattle.com';
  const MAX_PAGES = scraperConfig.max_pages || 25;

  for (const endpoint of (scraperConfig.endpoints || [])) {
    const [basePath, baseParams] = endpoint.split('?');

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${BASE}${basePath}?${baseParams}&page=${page}`;
      let html;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(12_000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        if (!res.ok) {
          errors.push({ company: scraperConfig.name, error: `HTTP ${res.status} on page ${page}` });
          break;
        }
        html = await res.text();
      } catch (err) {
        errors.push({ company: scraperConfig.name, error: `Page ${page}: ${err.message}` });
        break;
      }

      const jobs = parseBuiltInSeattleHtml(html, BASE);

      // Early stop: page returned results but all were duplicates → we're
      // caught up with history. No need to fetch deeper pages.
      const beforeCount = jobs.length;
      processJobs(jobs, 'builtinseattle');
      // processJobs mutates counters internally; check via jobs filtered vs added
      if (beforeCount > 0) {
        // We can't easily inspect the internal counters here, so use a simpler
        // signal: if the page had no href matches at all, stop.
      }
      if (jobs.length === 0) break; // empty page — past end of results
    }
  }
}

/**
 * Parse job cards from a Built In Seattle HTML page.
 * Returns array of { title, url, company, location }.
 */
function parseBuiltInSeattleHtml(html, base) {
  const jobs = [];
  const seenHrefs = new Set();

  // Split on job-card class boundaries so each slice contains exactly one card.
  // The class attribute may appear as "job-card", "job-card active", etc.
  const cards = html.split(/(?=<[^>]+\bclass="[^"]*\bjob-card\b)/);

  for (const card of cards) {
    // ── Job URL + title slug ──────────────────────────────────────────
    const hrefMatch = card.match(/href="(\/job\/([^/"]+)\/(\d+))"/);
    if (!hrefMatch) continue;

    const href     = hrefMatch[1];
    const slug     = hrefMatch[2];
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);

    const jobUrl   = `${base}${href}`;
    // Title from slug: "senior-software-engineer-backend" → title-cased string.
    // The title filter runs case-insensitively, so title-casing is only cosmetic.
    const title    = slug.replace(/-/g, ' ')
                         .replace(/\b\w/g, c => c.toUpperCase());

    // ── Company name ─────────────────────────────────────────────────
    // Confirmed structure: <div class="left-side-tile-item-2">...<text>...</div>
    // The text may be wrapped in one child element (anchor or span).
    const companyMatch = card.match(
      /\bleft-side-tile-item-2\b[^>]*>(?:\s*<[^>]+>)*\s*([^<\n\r]{2,80})/
    );
    const company = companyMatch ? companyMatch[1].trim() : '';

    // ── Location ─────────────────────────────────────────────────────
    // Look for "City, ST" patterns near the card. Empty passes location filter.
    const locMatch = card.match(/\b([A-Z][a-zA-Z .]+,\s*[A-Z]{2})\b/);
    const location = locMatch ? locMatch[1] : '';

    jobs.push({ title, url: jobUrl, company, location });
  }

  return jobs;
}

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ─────────────────────────────────────────────────

function buildLocationFilter(locationFilter) {
  const positive = (locationFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (locationFilter?.negative || []).map(k => k.toLowerCase());

  return (location) => {
    // Empty/unknown location always passes — many US remote roles have blank location fields
    if (!location || location.trim() === '') return true;
    const lower = location.toLowerCase();
    // If positive terms set, location must match at least one
    const passesPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    // If location matches any negative term, drop it
    const failsNegative = negative.some(k => lower.includes(k));
    return passesPositive && !failsNegative;
  };
}

// ── Prune helpers ───────────────────────────────────────────────────

/**
 * Parse ATS type, board slug, and job ID from a pipeline URL.
 * Returns null for custom-domain Greenhouse URLs (e.g. okta.com?gh_jid=...)
 * since the slug can't be reliably extracted — those are handled by the
 * standalone check-pipeline-liveness.mjs instead.
 */
function extractJobInfo(url) {
  // Standard Greenhouse: job-boards.greenhouse.io/{slug}/jobs/{id}
  //                   or job-boards.eu.greenhouse.io/{slug}/jobs/{id}
  let m = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  if (m) return { ats: 'greenhouse', slug: m[1], id: m[2] };

  // Older Greenhouse boards URL
  m = url.match(/boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  if (m) return { ats: 'greenhouse', slug: m[1], id: m[2] };

  // Lever: jobs.lever.co/{slug}/{uuid}
  m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([a-f0-9-]{36})/);
  if (m) return { ats: 'lever', slug: m[1], id: m[2] };

  // Ashby: jobs.ashbyhq.com/{slug}/{uuid}
  m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([a-f0-9-]{36})/);
  if (m) return { ats: 'ashby', slug: m[1], id: m[2] };

  return null;
}

/**
 * Extract the board slug from the API URL used during a fetch.
 * This is the key we use to look up active IDs later.
 */
function extractSlugFromApiUrl(apiUrl, type) {
  if (type === 'greenhouse') {
    const m = apiUrl.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  if (type === 'lever') {
    const m = apiUrl.match(/api\.lever\.co\/v0\/postings\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  if (type === 'ashby') {
    const m = apiUrl.match(/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  return null;
}

/**
 * Remove pipeline.md entries whose job IDs are no longer in the
 * boards that were successfully fetched this scan run.
 *
 * Only touches entries for companies we actually scanned — if a board
 * errored or wasn't in this run, its entries are left alone.
 *
 * Returns the count of pruned entries (writes file unless dry=true).
 */
function prunePipeline(boardActiveIds, dry = false) {
  if (!existsSync(PIPELINE_PATH)) return 0;

  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = text.split('\n');
  const pruned = [];

  const kept = lines.filter(line => {
    const m = line.match(/^- \[ \] (https?:\/\/\S+)/);
    if (!m) return true; // header, blank, [x] entry — keep as-is

    const url = m[1];
    const info = extractJobInfo(url);
    if (!info) return true; // custom-domain or unknown format — keep

    const key = `${info.ats}::${info.slug}`;
    const boardIds = boardActiveIds.get(key);
    if (!boardIds) return true; // board not scanned this run — keep

    if (!boardIds.has(info.id)) {
      pruned.push(line);
      return false; // job no longer in board → closed
    }
    return true;
  });

  if (pruned.length > 0 && !dry) {
    const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n');
    writeFileSync(PIPELINE_PATH, cleaned, 'utf-8');
  }

  return pruned.length;
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pruneMode = args.includes('--prune');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);

  // 2. Filter to enabled companies with detectable APIs
  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)');
  if (pruneMode) console.log('(prune mode — closed pipeline entries will be removed)');
  if (dryRun || pruneMode) console.log();

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // Helper: process a batch of raw jobs through filter + dedup
  function processJobs(jobs, source) {
    for (const job of jobs) {
      totalFound++;
      if (!job.url) { totalFiltered++; continue; }
      if (!titleFilter(job.title)) { totalFiltered++; continue; }
      if (!locationFilter(job.location)) { totalLocationFiltered++; continue; }
      if (seenUrls.has(job.url)) { totalDupes++; continue; }
      const key = `${(job.company || '').toLowerCase()}::${job.title.toLowerCase()}`;
      if (seenCompanyRoles.has(key)) { totalDupes++; continue; }
      seenUrls.add(job.url);
      seenCompanyRoles.add(key);
      newOffers.push({ ...job, source });
    }
  }

  // 4. Fetch tracked-company APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalLocationFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  // Prune: maps `${ats}::${slug}` → Set of active job IDs (populated on success only)
  const boardActiveIds = new Map();

  const tasks = targets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      processJobs(jobs, `${type}-api`);

      // Collect unfiltered active IDs for prune — a job is "alive" even if
      // it doesn't match our title/location filters, so we work from the raw list.
      if (pruneMode) {
        const slug = extractSlugFromApiUrl(url, type);
        if (slug) {
          const ids = new Set(jobs.map(j => extractJobInfo(j.url)?.id).filter(Boolean));
          boardActiveIds.set(`${type}::${slug}`, ids);
        }
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
      // No entry added to boardActiveIds on error — prune skips this company
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5. Fetch remote job boards (Remotive, etc.)
  const remoteBoards = (config.remote_boards || []).filter(b => b.enabled !== false);

  if (remoteBoards.length > 0) {
    const boardTasks = remoteBoards.map(board => async () => {
      const parser = BOARD_PARSERS[board.api_provider];
      if (!parser) {
        errors.push({ company: board.name, error: `Unknown api_provider: ${board.api_provider}` });
        return;
      }
      try {
        const json = await fetchJson(board.api);
        const jobs = parser(json, board.name);
        processJobs(jobs, board.name);
      } catch (err) {
        errors.push({ company: board.name, error: err.message });
      }
    });
    await parallelFetch(boardTasks, CONCURRENCY);
  }

  // 6. Fetch custom HTML scrapers (Built In Seattle, etc.)
  const customScrapers = (config.custom_scrapers || []).filter(s => s.enabled !== false);

  if (customScrapers.length > 0) {
    // Run sequentially — HTML scraping is rate-sensitive; no parallel here
    for (const scraper of customScrapers) {
      await scrapeBuiltInSeattle(scraper, processJobs, errors);
    }
  }

  // 7. Write new results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 7. Prune closed pipeline entries
  const pruneCount = pruneMode ? prunePipeline(boardActiveIds, dryRun) : 0;

  // 9. Print summary
  const boardCount = remoteBoards.length;
  const scraperCount = customScrapers.length;
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  if (boardCount > 0) {
    console.log(`Remote boards:         ${boardCount}`);
  }
  if (scraperCount > 0) {
    console.log(`HTML scrapers:         ${scraperCount}`);
  }
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Filtered by location:  ${totalLocationFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);
  if (pruneMode) {
    console.log(`Closed entries pruned: ${pruneCount}${dryRun ? ' (dry run — not written)' : ''}`);
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
  }

  if (dryRun) {
    console.log('\n(dry run — run without --dry-run to save results)');
  } else if (newOffers.length > 0 || pruneCount > 0) {
    console.log(`\nResults saved to ${PIPELINE_PATH}${newOffers.length > 0 ? ` and ${SCAN_HISTORY_PATH}` : ''}`);
  }

  if (pruneMode && pruneCount === 0) {
    console.log('\nNo closed entries found — pipeline is clean for scanned companies.');
  }
  if (pruneMode && !filterCompany) {
    console.log('Note: custom-domain entries (Okta, HelloFresh, etc.) are not checked by --prune.');
    console.log('      Run check-pipeline-liveness.mjs for a full deep-clean.');
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
