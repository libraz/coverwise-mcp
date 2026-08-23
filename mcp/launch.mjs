#!/usr/bin/env node
/**
 * MCP server launcher.
 *
 * Ensures runtime dependencies are installed before the server starts,
 * closing a race between Claude Code's SessionStart hook and MCP server
 * startup: on a fresh plugin cache directory (e.g. right after a version
 * bump), the server may be spawned before the hook has created the
 * node_modules symlink, causing import resolution to fail.
 *
 * Running install-deps synchronously here is idempotent and cheap on the
 * hot path — it just checks a marker file and returns — so we eat a
 * negligible cost on every connect in exchange for robustness.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const installScript = join(here, '..', 'scripts', 'install-deps.mjs');

const result = spawnSync(process.execPath, [installScript], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});

if (result.status !== 0) {
  process.stderr.write('[coverwise-mcp] install-deps failed, aborting launch\n');
  process.exit(result.status ?? 1);
}

await import('./server.mjs');
