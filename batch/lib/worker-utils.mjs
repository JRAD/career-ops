/**
 * batch/lib/worker-utils.mjs — Shared utilities for SDK-based batch workers
 *
 * Exports:
 *   readProjectFile(relPath, required?)      Read a file from project root; null if missing (throws if required)
 *   buildCachedContext(fileSpecs[])          Build Anthropic content blocks with cache_control on the last block
 *   toolDefinitions(toolNames[])             Return Anthropic tool schema objects for the named subset
 *   executeTool(name, input, projectDir?)    Execute a tool call and return the string result
 *   runAgentLoop(client, model, system, messages, tools, maxIter)  Standard agentic tool-use loop
 *   logCacheMetrics(usage)                   Write cache hit/miss metrics to stderr
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

// Project root is two levels up from batch/lib/
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PROJECT_DIR = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// readProjectFile
// ---------------------------------------------------------------------------

/**
 * Read a file relative to the project root.
 *
 * @param {string}  relPath   Path relative to project root (e.g. 'cv.md')
 * @param {boolean} required  If true, throw when the file does not exist
 * @returns {Promise<string|null>}  File contents as UTF-8 string, or null if missing and not required
 */
export async function readProjectFile(relPath, required = false) {
  const fullPath = join(PROJECT_DIR, relPath);
  try {
    return await readFile(fullPath, 'utf-8');
  } catch (err) {
    if (required) {
      throw new Error(`Required file not found: ${relPath} (${err.message})`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// buildCachedContext
// ---------------------------------------------------------------------------

/**
 * Read a list of project files and return them as Anthropic content blocks,
 * with cache_control: { type: 'ephemeral' } applied to the LAST block in the
 * array. This is the Anthropic "cache checkpoint" pattern — everything up to
 * and including that block is cached as a single unit.
 *
 * Files that do not exist and are not required are silently skipped.
 *
 * @param {Array<{ path: string, required?: boolean, label?: string }>} fileSpecs
 * @returns {Promise<Array>}  Array of Anthropic text content blocks
 *
 * @example
 * const blocks = await buildCachedContext([
 *   { path: 'cv.md',               required: true  },
 *   { path: 'config/profile.yml',  required: true  },
 *   { path: 'modes/_profile.md',   required: false },
 *   { path: 'article-digest.md',   required: false },
 *   { path: 'config/archetypes.yml', required: true },
 * ]);
 * // blocks[-1].cache_control === { type: 'ephemeral' }
 */
export async function buildCachedContext(fileSpecs) {
  const blocks = [];

  for (const spec of fileSpecs) {
    const content = await readProjectFile(spec.path, spec.required ?? false);
    if (content === null) continue;

    const label = spec.label ?? spec.path;
    blocks.push({
      type: 'text',
      text: `<file path="${label}">\n${content}\n</file>`,
    });
  }

  if (blocks.length > 0) {
    blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_SCHEMAS = {
  read_file: {
    name: 'read_file',
    description:
      'Read a file from the project directory. Path is relative to the project root.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to project root (e.g. "cv.md", "data/applications.md")',
        },
      },
      required: ['path'],
    },
  },

  write_file: {
    name: 'write_file',
    description:
      'Write content to a file in the project directory. Creates intermediate directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to project root',
        },
        content: {
          type: 'string',
          description: 'UTF-8 content to write',
        },
      },
      required: ['path', 'content'],
    },
  },

  bash: {
    name: 'bash',
    description:
      'Execute a bash command in the project directory. Returns combined stdout and stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Bash command to execute (runs in the project root directory)',
        },
      },
      required: ['command'],
    },
  },

  web_fetch: {
    name: 'web_fetch',
    description:
      'Fetch the text content of a URL. Returns up to 50,000 characters. Use for fetching job descriptions from static pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to fetch',
        },
      },
      required: ['url'],
    },
  },

  web_search: {
    name: 'web_search',
    description:
      'Search the web via Brave Search API. Returns titles, URLs, and descriptions. Requires BRAVE_API_KEY env var.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default: 10, max: 20)',
        },
      },
      required: ['query'],
    },
  },
};

/**
 * Return Anthropic tool schema objects for the named subset of tools.
 *
 * @param {string[]} toolNames  Names from: read_file, write_file, bash, web_fetch, web_search
 * @returns {Array}  Array of Anthropic tool definition objects
 */
export function toolDefinitions(toolNames) {
  return toolNames.map((name) => {
    const schema = TOOL_SCHEMAS[name];
    if (!schema) throw new Error(`Unknown tool name: "${name}". Valid: ${Object.keys(TOOL_SCHEMAS).join(', ')}`);
    return schema;
  });
}

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

/**
 * Execute a tool call and return the string result.
 *
 * @param {string} name         Tool name (read_file | write_file | bash | web_fetch | web_search)
 * @param {object} input        Tool input matching the schema
 * @param {string} [projectDir] Project root directory (defaults to PROJECT_DIR)
 * @returns {Promise<string>}   Tool result as a string (errors are returned as strings, not thrown)
 */
export async function executeTool(name, input, projectDir = PROJECT_DIR) {
  switch (name) {
    case 'read_file': {
      const fullPath = join(projectDir, input.path);
      try {
        return await readFile(fullPath, 'utf-8');
      } catch (err) {
        return `Error reading file "${input.path}": ${err.message}`;
      }
    }

    case 'write_file': {
      const fullPath = join(projectDir, input.path);
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, input.content, 'utf-8');
        return `File written successfully: ${input.path}`;
      } catch (err) {
        return `Error writing file "${input.path}": ${err.message}`;
      }
    }

    case 'bash': {
      return new Promise((resolve) => {
        const proc = spawn('bash', ['-c', input.command], {
          cwd: projectDir,
          env: process.env,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk) => { stdout += chunk; });
        proc.stderr.on('data', (chunk) => { stderr += chunk; });

        proc.on('close', (code) => {
          const out = stdout.trimEnd();
          const err = stderr.trimEnd();
          if (code !== 0) {
            const parts = [`Exit code: ${code}`];
            if (out) parts.push(`stdout:\n${out}`);
            if (err) parts.push(`stderr:\n${err}`);
            resolve(parts.join('\n'));
          } else {
            // Return stdout; include stderr as a note if non-empty
            resolve(err ? `${out}\n[stderr]: ${err}` : (out || '(no output)'));
          }
        });

        proc.on('error', (err) => resolve(`Spawn error: ${err.message}`));
      });
    }

    case 'web_fetch': {
      try {
        const res = await fetch(input.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; career-ops/2.0; +https://github.com/JRAD/career-ops)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.5',
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!res.ok) {
          return `HTTP ${res.status} ${res.statusText} for ${input.url}`;
        }

        const text = await res.text();
        // Truncate to avoid overwhelming the context window
        const MAX = 50_000;
        if (text.length > MAX) {
          return text.slice(0, MAX) + `\n\n[TRUNCATED — original length: ${text.length} chars]`;
        }
        return text;
      } catch (err) {
        return `Error fetching "${input.url}": ${err.message}`;
      }
    }

    case 'web_search': {
      const apiKey = process.env.BRAVE_API_KEY;
      if (!apiKey) {
        return 'web_search unavailable — BRAVE_API_KEY environment variable not set. Proceed without live search data.';
      }
      try {
        const count = Math.min(input.count ?? 10, 20);
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=${count}`;
        const res = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          return `Brave Search API error: HTTP ${res.status} ${res.statusText}`;
        }

        const data = await res.json();
        const results = data.web?.results ?? [];

        if (results.length === 0) {
          return `No results found for: "${input.query}"`;
        }

        return results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description ?? '(no description)'}`)
          .join('\n\n');
      } catch (err) {
        return `web_search error: ${err.message}`;
      }
    }

    default:
      return `Unknown tool: "${name}". Valid tools: ${Object.keys(TOOL_SCHEMAS).join(', ')}`;
  }
}

// ---------------------------------------------------------------------------
// runAgentLoop
// ---------------------------------------------------------------------------

/**
 * Standard Anthropic agentic tool-use loop.
 *
 * Sends the initial request, handles tool_use blocks, accumulates tool_result
 * messages, and stops on end_turn or maxIter. Returns the final assistant text.
 *
 * @param {import('@anthropic-ai/sdk').default} client     Anthropic SDK client
 * @param {string}    model      Model identifier (e.g. 'claude-sonnet-4-6')
 * @param {string|Array} system  System prompt — string or array of content blocks (supports cache_control)
 * @param {Array}     messages   Initial messages array
 * @param {Array}     tools      Tool definitions from toolDefinitions()
 * @param {number}    [maxIter]  Max agent iterations before giving up (default: 50)
 * @param {string}    [projectDir]  Project root for tool execution (default: PROJECT_DIR)
 * @returns {Promise<string>}    Final assistant text output
 */
export async function runAgentLoop(
  client,
  model,
  system,
  messages,
  tools,
  maxIter = 50,
  projectDir = PROJECT_DIR,
) {
  const msgs = [...messages];
  let iterations = 0;

  while (iterations < maxIter) {
    iterations++;

    const requestParams = {
      model,
      max_tokens: 8192,
      system,
      messages: msgs,
    };

    if (tools && tools.length > 0) {
      requestParams.tools = tools;
    }

    const response = await client.messages.create(requestParams);
    const { stop_reason, content, usage } = response;

    // Log cache metrics on every turn so they appear in the worker's stderr log
    logCacheMetrics(usage, iterations);

    // Append the assistant turn to the running conversation
    msgs.push({ role: 'assistant', content });

    if (stop_reason === 'end_turn') {
      const textBlock = content.find((b) => b.type === 'text');
      return textBlock?.text ?? '';
    }

    if (stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of content) {
        if (block.type !== 'tool_use') continue;
        process.stderr.write(`[tool] ${block.name}(${JSON.stringify(block.input).slice(0, 120)})\n`);
        const result = await executeTool(block.name, block.input, projectDir);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: String(result),
        });
      }
      msgs.push({ role: 'user', content: toolResults });
      continue;
    }

    // max_tokens, stop_sequence, or other terminal stop reasons
    const textBlock = content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }

  throw new Error(
    `Agent loop exceeded max iterations (${maxIter}). Increase maxIter or simplify the task.`,
  );
}

// ---------------------------------------------------------------------------
// logCacheMetrics
// ---------------------------------------------------------------------------

/**
 * Write Anthropic usage / cache metrics to stderr in a consistent one-line format.
 *
 * Output example:
 *   [cache:turn=1] in=1842 out=312 cache_write=14820 cache_read=0
 *   [cache:turn=2] in=1842 out=218 cache_write=0 cache_read=14820
 *
 * @param {object} usage       Anthropic usage object from response
 * @param {number} [turn]      Optional turn number for multi-turn labeling
 */
export function logCacheMetrics(usage, turn) {
  if (!usage) return;

  const {
    input_tokens = 0,
    output_tokens = 0,
    cache_creation_input_tokens = 0,
    cache_read_input_tokens = 0,
  } = usage;

  const label = turn != null ? `[cache:turn=${turn}]` : '[cache]';
  const parts = [
    `in=${input_tokens}`,
    `out=${output_tokens}`,
  ];

  if (cache_creation_input_tokens > 0) parts.push(`cache_write=${cache_creation_input_tokens}`);
  if (cache_read_input_tokens > 0) parts.push(`cache_read=${cache_read_input_tokens}`);

  const saved = cache_read_input_tokens > 0
    ? ` (saved ~${Math.round(cache_read_input_tokens * 0.1 * 100) / 100} tokens-equiv cost)`
    : '';

  process.stderr.write(`${label} ${parts.join(' ')}${saved}\n`);
}
