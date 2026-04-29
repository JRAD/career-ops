/**
 * batch/lib/smoke-test.mjs — Phase 1 SDK foundation smoke test
 *
 * Verifies:
 *   1. @anthropic-ai/sdk imports cleanly
 *   2. worker-utils exports are all present
 *   3. readProjectFile can read cv.md
 *   4. buildCachedContext builds blocks with cache_control on the last block
 *   5. toolDefinitions returns valid schemas for all 5 tools
 *
 * Usage:
 *   node batch/lib/smoke-test.mjs
 *
 * Exits 0 on success, non-zero on failure.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  readProjectFile,
  buildCachedContext,
  toolDefinitions,
  executeTool,
  runAgentLoop,
  logCacheMetrics,
  PROJECT_DIR,
} from './worker-utils.mjs';

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label, err) {
  console.error(`  ❌ ${label}: ${err?.message ?? err}`);
  failed++;
}

console.log('\n=== career-ops Phase 1 smoke test ===\n');

// ── 1. SDK import ──────────────────────────────────────────────────────────
console.log('1. Anthropic SDK');
try {
  const client = new Anthropic({ apiKey: 'smoke-test-key' });
  if (typeof client.messages?.create === 'function') {
    ok('SDK instantiates and exposes messages.create');
  } else {
    fail('SDK missing messages.create', new Error('unexpected shape'));
  }
} catch (err) {
  fail('SDK instantiation', err);
}

// ── 2. worker-utils exports ────────────────────────────────────────────────
console.log('\n2. worker-utils exports');
const expected = ['readProjectFile', 'buildCachedContext', 'toolDefinitions', 'executeTool', 'runAgentLoop', 'logCacheMetrics'];
const imports = { readProjectFile, buildCachedContext, toolDefinitions, executeTool, runAgentLoop, logCacheMetrics };

for (const name of expected) {
  if (typeof imports[name] === 'function') {
    ok(`${name} is exported as a function`);
  } else {
    fail(`${name} export`, new Error(`got ${typeof imports[name]}`));
  }
}

// ── 3. PROJECT_DIR ─────────────────────────────────────────────────────────
console.log('\n3. PROJECT_DIR');
try {
  if (PROJECT_DIR && typeof PROJECT_DIR === 'string') {
    ok(`PROJECT_DIR = ${PROJECT_DIR}`);
  } else {
    fail('PROJECT_DIR', new Error('not a string'));
  }
} catch (err) {
  fail('PROJECT_DIR', err);
}

// ── 4. readProjectFile ─────────────────────────────────────────────────────
console.log('\n4. readProjectFile');
try {
  const cv = await readProjectFile('cv.md', false);
  if (cv === null) {
    // cv.md doesn't exist yet — that's OK for a fresh install
    ok('cv.md not found but handled gracefully (null returned)');
  } else {
    const lines = cv.split('\n').slice(0, 5).join('\n');
    ok(`cv.md read successfully (${cv.length} chars). First 5 lines:\n${lines}`);
  }
} catch (err) {
  fail('readProjectFile cv.md', err);
}

try {
  await readProjectFile('this-file-does-not-exist.txt', true);
  fail('required=true should throw', new Error('no error thrown'));
} catch (err) {
  if (err.message.includes('Required file not found')) {
    ok('required=true throws with expected message');
  } else {
    fail('required=true error message', err);
  }
}

// ── 5. buildCachedContext ──────────────────────────────────────────────────
console.log('\n5. buildCachedContext');
try {
  const blocks = await buildCachedContext([
    { path: 'package.json', required: true },
    { path: 'this-does-not-exist.txt', required: false },
  ]);
  if (blocks.length === 1) {
    ok('Missing optional file skipped; 1 block returned');
  } else {
    fail('Expected 1 block', new Error(`got ${blocks.length}`));
  }
  const last = blocks[blocks.length - 1];
  if (last?.cache_control?.type === 'ephemeral') {
    ok('Last block has cache_control: { type: "ephemeral" }');
  } else {
    fail('cache_control on last block', new Error(JSON.stringify(last?.cache_control)));
  }
} catch (err) {
  fail('buildCachedContext', err);
}

// ── 6. toolDefinitions ────────────────────────────────────────────────────
console.log('\n6. toolDefinitions');
try {
  const tools = toolDefinitions(['read_file', 'write_file', 'bash', 'web_fetch', 'web_search']);
  if (tools.length === 5) {
    ok('All 5 tool schemas returned');
  } else {
    fail('tool count', new Error(`got ${tools.length}`));
  }
  for (const t of tools) {
    if (t.name && t.description && t.input_schema) {
      ok(`${t.name}: name, description, input_schema present`);
    } else {
      fail(`${t.name} schema shape`, new Error(JSON.stringify(t)));
    }
  }
} catch (err) {
  fail('toolDefinitions', err);
}

try {
  toolDefinitions(['nonexistent_tool']);
  fail('Unknown tool should throw', new Error('no error'));
} catch (err) {
  ok('Unknown tool name throws');
}

// ── 7. executeTool (read_file) ─────────────────────────────────────────────
console.log('\n7. executeTool — read_file');
try {
  const result = await executeTool('read_file', { path: 'package.json' });
  const parsed = JSON.parse(result);
  if (parsed.name === 'career-ops') {
    ok('read_file returns package.json content');
  } else {
    fail('package.json name field', new Error(parsed.name));
  }
} catch (err) {
  fail('executeTool read_file', err);
}

try {
  const result = await executeTool('read_file', { path: 'nonexistent.txt' });
  if (result.startsWith('Error reading file')) {
    ok('Missing file returns error string (not thrown)');
  } else {
    fail('Missing file error string', new Error(result));
  }
} catch (err) {
  fail('executeTool missing file', err);
}

// ── 8. logCacheMetrics ────────────────────────────────────────────────────
console.log('\n8. logCacheMetrics');
try {
  // Should write to stderr without throwing
  logCacheMetrics({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 0 }, 1);
  logCacheMetrics({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 }, 2);
  logCacheMetrics(null); // Should be a no-op
  ok('logCacheMetrics writes to stderr without throwing');
} catch (err) {
  fail('logCacheMetrics', err);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

if (failed > 0) {
  process.exit(1);
}
