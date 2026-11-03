/**
 * Tests for the dependency install hook (scripts/install-deps.mjs).
 *
 * Runs the script against throwaway plugin ROOT/DATA directories with a fake
 * `npm` first on PATH, so no network install happens. The fake records each
 * call and writes a package.json for every dependency, as a real install does.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '..', 'scripts', 'install-deps.mjs');
const DEPS = ['@libraz/coverwise', '@modelcontextprotocol/sdk'];
const VERSION = '9.9.9';

let dir;
let root;
let data;
let bin;
let npmLog;

/** Create a package directory, optionally without its package.json. */
async function writePackage(nodeModules, name, { manifest = true } = {}) {
  const pkgDir = join(nodeModules, name);
  await mkdir(join(pkgDir, 'dist'), { recursive: true });
  await writeFile(join(pkgDir, 'dist', 'index.js'), '');
  if (manifest) {
    await writeFile(join(pkgDir, 'package.json'), `{"name":"${name}"}`);
  }
}

/** Lay out a data directory as a previous successful install leaves it. */
async function seedInstalled({ brokenDep } = {}) {
  const nodeModules = join(data, 'node_modules');
  for (const name of DEPS) {
    await writePackage(nodeModules, name, { manifest: name !== brokenDep });
  }
  await writeFile(join(data, '.installed-version'), VERSION);
}

function runHook() {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
        PATH: `${bin}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => done({ code, stderr }));
    child.on('error', fail);
  });
}

async function npmCalls() {
  if (!existsSync(npmLog)) {
    return [];
  }
  return (await readFile(npmLog, 'utf8')).split('\n').filter(Boolean);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coverwise-deps-'));
  root = join(dir, 'root');
  data = join(dir, 'data');
  bin = join(dir, 'bin');
  npmLog = join(dir, 'npm.log');
  await mkdir(root, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'coverwise-mcp',
      version: VERSION,
      dependencies: Object.fromEntries(DEPS.map((d) => [d, '*'])),
    }),
  );
  // Fake npm: log whether a stale tree was still there, then install every dep.
  const installs = DEPS.map(
    (d) => `mkdir -p "node_modules/${d}" && echo '{}' > "node_modules/${d}/package.json"`,
  ).join('\n');
  await writeFile(
    join(bin, 'npm'),
    `#!/bin/sh\nif [ -d node_modules ]; then echo "install stale-tree" >> "${npmLog}"; else echo "install clean" >> "${npmLog}"; fi\n${installs}\n`,
  );
  await chmod(join(bin, 'npm'), 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('install-deps', () => {
  it('skips npm when the installed version matches and every dependency is complete', async () => {
    await seedInstalled();
    const { code } = await runHook();
    expect(code).toBe(0);
    expect(await npmCalls()).toEqual([]);
    expect(existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))).toBe(true);
  });

  it('reinstalls from a clean tree when a dependency lacks its package.json', async () => {
    await seedInstalled({ brokenDep: '@modelcontextprotocol/sdk' });
    const { code } = await runHook();
    expect(code).toBe(0);
    // npm reports a partly extracted package as up to date, so the tree must be removed first.
    expect(await npmCalls()).toEqual(['install clean']);
    expect(
      existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')),
    ).toBe(true);
  });

  it('installs when the plugin version changed', async () => {
    await seedInstalled();
    await writeFile(join(data, '.installed-version'), '0.0.1');
    const { code } = await runHook();
    expect(code).toBe(0);
    expect(await npmCalls()).toEqual(['install clean']);
    expect((await readFile(join(data, '.installed-version'), 'utf8')).trim()).toBe(VERSION);
  });
});
