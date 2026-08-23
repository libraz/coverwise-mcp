#!/usr/bin/env node
/**
 * coverwise-mcp CLI entry point.
 *
 * With no arguments it starts the stdio MCP server (this is what generated
 * config entries invoke via `npx -y github:libraz/coverwise-mcp`). The
 * `init` / `uninstall` subcommands run the interactive install helper.
 */
import { runInit, runUninstall } from './init.mjs';
import { PACKAGE_VERSION } from './version.mjs';

const HELP = `coverwise-mcp ${PACKAGE_VERSION}
Pairwise / t-wise combinatorial coverage MCP server.

Usage:
  coverwise-mcp            Start the stdio MCP server.
  coverwise-mcp init       Interactive setup: write the coverwise MCP entry
                           into the config files of Claude Code, Codex CLI,
                           Claude Desktop, Cursor, Cline or Gemini CLI.
  coverwise-mcp uninstall  Interactive removal: drop the coverwise MCP entry
                           from those config files.
  coverwise-mcp --help     Show this help.
  coverwise-mcp --version  Show version.

Inside Claude Code, prefer the plugin marketplace:
  /plugin marketplace add libraz/coverwise-mcp
  /plugin install coverwise-mcp

Docs: https://github.com/libraz/coverwise-mcp
`;

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (argv[0] === 'init') {
    await runInit();
    return;
  }
  if (argv[0] === 'uninstall') {
    await runUninstall();
    return;
  }

  // Default: start the MCP server. server.mjs self-connects on import.
  await import('./server.mjs');
};

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[coverwise-mcp] ${message}\n`);
  process.exit(1);
});
