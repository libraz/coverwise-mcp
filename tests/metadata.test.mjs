/**
 * Consistency checks for the package name and version.
 *
 * The name is restated in the npm manifest, both plugin manifests, the CLI help
 * banner and the generated config snippet; the version is restated in both
 * plugin manifests. Nothing links them at runtime, so a rename or a release
 * bump that misses one file is only visible to users. These tests catch that
 * drift, and pin the CLI and the server handshake to the manifest-derived
 * version rather than a literal of their own.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = async (relative) => JSON.parse(await readFile(join(root, relative), 'utf8'));
const readText = async (relative) => readFile(join(root, relative), 'utf8');

const pkg = await readJson('package.json');
const plugin = await readJson('.claude-plugin/plugin.json');
const marketplace = await readJson('.claude-plugin/marketplace.json');
const cli = await readText('mcp/cli.mjs');
const init = await readText('mcp/init.mjs');
const server = await readText('mcp/server.mjs');

describe('package name', () => {
  it('matches across both plugin manifests', () => {
    expect(plugin.name).toBe(pkg.name);
    expect(marketplace.name).toBe(pkg.name);
    expect(marketplace.plugins.map((p) => p.name)).toContain(pkg.name);
  });

  it('matches the repository the manifests point at', () => {
    const slug = `libraz/${pkg.name}`;
    expect(pkg.repository.url).toContain(slug);
    expect(pkg.homepage).toContain(slug);
    expect(pkg.bugs.url).toContain(slug);
    expect(plugin.homepage).toContain(slug);
    expect(plugin.repository).toContain(slug);
    expect(marketplace.plugins[0].homepage).toContain(slug);
  });

  it('matches the specifier written into generated MCP config entries', () => {
    expect(init).toContain(`const PACKAGE_SPEC = 'github:libraz/${pkg.name}';`);
  });

  it('matches the name printed in the CLI help banner', () => {
    expect(cli).toContain(`const HELP = \`${pkg.name} \${PACKAGE_VERSION}`);
  });
});

describe('package version', () => {
  it('matches across both plugin manifests', () => {
    expect(plugin.version).toBe(pkg.version);
    for (const entry of marketplace.plugins) {
      expect(entry.version).toBe(pkg.version);
    }
  });

  it('is reported by the CLI without restating the literal', async () => {
    expect(cli).toContain("import { PACKAGE_VERSION } from './version.mjs';");
    const { PACKAGE_VERSION } = await import('../mcp/version.mjs');
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it('is reported in the MCP server handshake without restating the literal', () => {
    expect(server).toContain("import { PACKAGE_VERSION } from './version.mjs';");
    expect(server).toContain("{ name: 'coverwise', version: PACKAGE_VERSION }");
  });
});

describe('plugin manifest', () => {
  it('registers the MCP server under the key the install helper writes', () => {
    expect(Object.keys(plugin.mcpServers)).toEqual(['coverwise']);
    expect(init).toContain("const SERVER_NAME = 'coverwise';");
  });
});
