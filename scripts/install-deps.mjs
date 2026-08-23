#!/usr/bin/env node
/**
 * SessionStart hook: ensure the MCP server's runtime dependencies are
 * installed into ${CLAUDE_PLUGIN_DATA}, which survives plugin updates
 * (unlike ${CLAUDE_PLUGIN_ROOT}, which is a cache and gets overwritten).
 *
 * Strategy:
 *   1. If ${CLAUDE_PLUGIN_ROOT}/node_modules exists (local dev clone), do nothing.
 *   2. Otherwise, install into ${CLAUDE_PLUGIN_DATA}/node_modules using npm
 *      (npm ships with Node; yarn may not be available on the user's machine).
 *   3. Idempotent: skip if the dependency lock already matches.
 */
import { execSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PLUGIN_ROOT;
const data = process.env.CLAUDE_PLUGIN_DATA;

if (!root) {
  // Not running under Claude Code — nothing to do.
  process.exit(0);
}

const rootNodeModules = join(root, 'node_modules');

/**
 * Node ESM does NOT honor NODE_PATH, so the MCP server (which lives in ROOT)
 * must find its dependencies via a `node_modules` directory next to it.
 * Since ROOT is a cache that gets wiped on plugin update, we install deps
 * into DATA (persistent) and symlink ROOT/node_modules -> DATA/node_modules.
 * The symlink gets recreated on every session start; the modules themselves
 * are only reinstalled when the plugin version changes.
 */

// Local dev checkout: a real node_modules already exists in ROOT — leave it.
if (existsSync(rootNodeModules)) {
  const stat = lstatSync(rootNodeModules);
  if (!stat.isSymbolicLink() && existsSync(join(rootNodeModules, '@libraz', 'coverwise'))) {
    process.exit(0);
  }
}

if (!data) {
  process.stderr.write(
    '[coverwise-mcp] CLAUDE_PLUGIN_DATA not set; cannot install runtime deps.\n',
  );
  process.exit(0);
}

const pkgSrc = join(root, 'package.json');
const pkgDst = join(data, 'package.json');
const marker = join(data, '.installed-version');
const dataNodeModules = join(data, 'node_modules');

const pkgJson = JSON.parse(readFileSync(pkgSrc, 'utf8'));
const currentVersion = pkgJson.version ?? '0.0.0';
const installed = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;

const depsPresent =
  installed === currentVersion && existsSync(join(dataNodeModules, '@libraz', 'coverwise'));

if (!depsPresent) {
  mkdirSync(data, { recursive: true });

  // Write a minimal package.json containing only runtime deps (no devDeps, no scripts).
  const runtimePkg = {
    name: pkgJson.name,
    version: pkgJson.version,
    private: true,
    type: 'module',
    dependencies: pkgJson.dependencies ?? {},
  };
  writeFileSync(pkgDst, `${JSON.stringify(runtimePkg, null, 2)}\n`);

  process.stderr.write('[coverwise-mcp] installing runtime dependencies...\n');
  try {
    execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
      cwd: data,
      stdio: 'inherit',
    });
    writeFileSync(marker, currentVersion);
    process.stderr.write('[coverwise-mcp] dependencies installed.\n');
  } catch (err) {
    process.stderr.write(`[coverwise-mcp] install failed: ${err?.message ?? err}\n`);
    process.exit(0); // Do not block the session on install failure.
  }
}

// (Re)create the symlink from ROOT/node_modules -> DATA/node_modules so that
// ESM module resolution from mcp/server.mjs finds the installed packages.
try {
  if (existsSync(rootNodeModules) || lstatSync(rootNodeModules, { throwIfNoEntry: false })) {
    const stat = lstatSync(rootNodeModules);
    if (stat.isSymbolicLink()) {
      unlinkSync(rootNodeModules);
    }
  }
} catch {
  // ignore
}
if (!existsSync(rootNodeModules)) {
  try {
    symlinkSync(dataNodeModules, rootNodeModules, 'dir');
  } catch (err) {
    process.stderr.write(
      `[coverwise-mcp] failed to symlink node_modules: ${err?.message ?? err}\n`,
    );
    process.exit(0);
  }
}
