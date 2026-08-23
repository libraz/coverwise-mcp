#!/usr/bin/env node
/**
 * SessionStart hook: state that combinatorial coverage tooling is available.
 *
 * The MCP tools and the `coverwise` skill are both passive — they only surface
 * once the session has already decided the task is a combinatorial one. But the
 * request that needs them most is the plain "write tests for this", which names
 * no coverage concept at all, so nothing ever triggers the match. This hook
 * closes that gap by stating the applicability rule up front, in the one place
 * that is always in context.
 *
 * It stays quiet outside code checkouts: a session in a notes directory or a
 * home directory has nothing to test, and an unconditional message there is
 * pure noise.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Files that mark the working directory as a code project with a test story. */
const PROJECT_MANIFESTS = [
  'package.json',
  'deno.json',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'CMakeLists.txt',
];

const CONTEXT = `coverwise (combinatorial test coverage) is available in this session: the MCP tools \
pairwise_generate, pairwise_analyze, pairwise_extend and pairwise_estimate, plus the \`coverwise\` skill.

Applicability rule: whenever you write, review, or extend tests for a function, endpoint, CLI, \
component or config surface that takes 3 or more independent parameters, build a parameter model and \
use those tools instead of choosing combinations by eye. This holds even when the request is just \
"write tests" and mentions nothing about coverage, combinations, or pairwise testing — that phrasing \
is the common case, not an exception. Picking a handful of plausible-looking combinations by hand is \
the specific failure these tools exist to prevent.`;

const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

if (!PROJECT_MANIFESTS.some((manifest) => existsSync(join(cwd, manifest)))) {
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: CONTEXT,
    },
  })}\n`,
);
