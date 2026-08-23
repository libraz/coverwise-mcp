/**
 * Unit tests for the install helper (mcp/init.mjs).
 *
 * Exercises the pure config-mutation functions against throwaway temp files —
 * no interactive prompts. The interactive runInit/runUninstall flows are thin
 * wrappers over these and are covered by the CLI smoke test.
 */
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  displayPath,
  parseTargetChoice,
  previewRemoveImpact,
  previewWriteImpact,
  removeFromCodexConfig,
  removeFromJsonConfig,
  writeCodexConfig,
  writeJsonConfig,
} from '../mcp/init.mjs';

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coverwise-init-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeJsonConfig', () => {
  it('creates a fresh config (and parent dirs) when the file is missing', async () => {
    const path = join(dir, 'nested', '.claude.json');
    await writeJsonConfig(path);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.mcpServers.coverwise.command).toBe('npx');
    expect(parsed.mcpServers.coverwise.args).toEqual(['-y', 'github:libraz/coverwise-mcp']);
  });

  it('preserves other servers and unrelated top-level keys', async () => {
    const path = join(dir, '.claude.json');
    await writeFile(
      path,
      JSON.stringify({
        otherTopLevel: { keep: true },
        mcpServers: { notcoverwise: { command: 'foo', args: ['bar'] } },
      }),
    );
    await writeJsonConfig(path);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.otherTopLevel).toEqual({ keep: true });
    expect(parsed.mcpServers.notcoverwise.command).toBe('foo');
    expect(parsed.mcpServers.coverwise.command).toBe('npx');
  });

  it('throws on malformed existing JSON rather than clobbering it', async () => {
    const path = join(dir, '.claude.json');
    await writeFile(path, '{ not json');
    await expect(writeJsonConfig(path)).rejects.toThrow(/Failed to parse/);
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });

  it('carries over the existing file mode instead of widening it', async () => {
    const path = join(dir, '.claude.json');
    await writeFile(path, '{}');
    await chmod(path, 0o600);
    await writeJsonConfig(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', async () => {
    const path = join(dir, '.claude.json');
    await writeJsonConfig(path);
    expect(await readdir(dir)).toEqual(['.claude.json']);
  });
});

describe('writeCodexConfig', () => {
  it('writes a coverwise block into a fresh TOML file', async () => {
    const path = join(dir, 'config.toml');
    await writeCodexConfig(path);
    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('[mcp_servers.coverwise]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "github:libraz/coverwise-mcp"]');
  });

  it('replaces an existing coverwise block while keeping other sections', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      [
        '[mcp_servers.other]',
        'command = "x"',
        '',
        '[mcp_servers.coverwise]',
        'command = "old"',
        '',
      ].join('\n'),
    );
    await writeCodexConfig(path);
    const toml = await readFile(path, 'utf8');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).not.toContain('command = "old"');
    expect(toml.match(/\[mcp_servers\.coverwise\]/g)).toHaveLength(1);
  });

  it('drops a hand-written env sub-table that would collide with the new block', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      [
        '  [mcp_servers.coverwise]',
        'command = "old"',
        '',
        '[mcp_servers.coverwise.env]',
        'FOO = "bar"',
        '',
        '[mcp_servers.other]',
        'command = "x"',
        '',
      ].join('\n'),
    );
    await writeCodexConfig(path);
    const toml = await readFile(path, 'utf8');
    expect(toml).not.toContain('coverwise.env');
    expect(toml).not.toContain('FOO = "bar"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml.match(/\[mcp_servers\.coverwise\]/g)).toHaveLength(1);
  });
});

describe('removeFromJsonConfig', () => {
  it('removes only the coverwise entry and reports the outcome', async () => {
    const path = join(dir, '.claude.json');
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          coverwise: { command: 'npx', args: [] },
          keep: { command: 'y', args: [] },
        },
      }),
    );
    expect(await removeFromJsonConfig(path)).toBe('removed');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.mcpServers.coverwise).toBeUndefined();
    expect(parsed.mcpServers.keep).toBeDefined();
  });

  it('reports absent when coverwise is not present', async () => {
    const path = join(dir, '.claude.json');
    await writeFile(path, JSON.stringify({ mcpServers: { keep: {} } }));
    expect(await removeFromJsonConfig(path)).toBe('absent');
  });

  it('reports no-file when the config does not exist', async () => {
    expect(await removeFromJsonConfig(join(dir, 'missing.json'))).toBe('no-file');
  });
});

describe('removeFromCodexConfig', () => {
  it('removes the coverwise block and keeps other sections', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      [
        '[mcp_servers.coverwise]',
        'command = "npx"',
        '',
        '[mcp_servers.other]',
        'command = "x"',
        '',
      ].join('\n'),
    );
    expect(await removeFromCodexConfig(path)).toBe('removed');
    const toml = await readFile(path, 'utf8');
    expect(toml).not.toContain('[mcp_servers.coverwise]');
    expect(toml).toContain('[mcp_servers.other]');
  });

  it('reports absent when no coverwise block exists', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(path, '[mcp_servers.other]\ncommand = "x"\n');
    expect(await removeFromCodexConfig(path)).toBe('absent');
  });

  it('removes sub-tables along with the main block', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      [
        '[mcp_servers.coverwise]',
        'command = "npx"',
        '',
        '[mcp_servers.coverwise.env]',
        'FOO = "bar"',
        '',
        '[mcp_servers.other]',
        'command = "x"',
        '',
      ].join('\n'),
    );
    expect(await removeFromCodexConfig(path)).toBe('removed');
    const toml = await readFile(path, 'utf8');
    expect(toml).not.toContain('coverwise');
    expect(toml).not.toContain('FOO = "bar"');
    expect(toml).toContain('[mcp_servers.other]');
  });
});

describe('previewWriteImpact / previewRemoveImpact', () => {
  it('classifies write impact for new / merge / replace', async () => {
    const fresh = join(dir, 'new.json');
    expect(await previewWriteImpact(fresh)).toBe('(new)');

    const merge = join(dir, 'merge.json');
    await writeFile(merge, JSON.stringify({ mcpServers: { other: {} } }));
    expect(await previewWriteImpact(merge)).toBe('(merge)');

    const replace = join(dir, 'replace.json');
    await writeFile(replace, JSON.stringify({ mcpServers: { coverwise: {} } }));
    expect(await previewWriteImpact(replace)).toBe('(replace coverwise)');
  });

  it('classifies remove impact', async () => {
    expect(await previewRemoveImpact(join(dir, 'missing.json'))).toBe('(no file; skip)');

    const present = join(dir, 'present.json');
    await writeFile(present, JSON.stringify({ mcpServers: { coverwise: {} } }));
    expect(await previewRemoveImpact(present)).toBe('(remove coverwise)');
  });
});

describe('parseTargetChoice', () => {
  it('falls back to the default when input is blank', () => {
    expect(parseTargetChoice('', '1,3')).toEqual(['claude-user', 'codex']);
  });

  it('deduplicates and preserves recognized tokens', () => {
    expect(parseTargetChoice('2,2,1', '1')).toEqual(['claude-project', 'claude-user']);
  });

  it('recognizes every supported client', () => {
    expect(parseTargetChoice('1,2,3,4,5,6,7', '1')).toEqual([
      'claude-user',
      'claude-project',
      'codex',
      'claude-desktop',
      'cursor',
      'cline',
      'gemini',
    ]);
  });

  it('throws on an unrecognized token', () => {
    expect(() => parseTargetChoice('9', '1')).toThrow(/Invalid choice/);
  });
});

describe('displayPath', () => {
  it('collapses the home directory to ~', () => {
    expect(displayPath(join(process.env.HOME ?? '/tmp', 'x'))).toMatch(/^~\/x$|^\/tmp\/x$/);
  });
});
