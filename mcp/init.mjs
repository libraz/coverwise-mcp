/**
 * Install helper for the coverwise MCP server.
 *
 * Writes (or removes) an `mcpServers.coverwise` entry into the config files of
 * common MCP clients so the server can be used outside the Claude Code plugin
 * mechanism — e.g. with Codex CLI, Claude Desktop, Cursor, Cline, or Gemini
 * CLI. Inside Claude Code the plugin marketplace is still the recommended
 * path; this helper exists for everything else.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

/** Package specifier written into generated config snippets. */
const PACKAGE_SPEC = 'github:libraz/coverwise-mcp';

/** Server key used under `mcpServers` / `[mcp_servers.*]`. */
const SERVER_NAME = 'coverwise';

/** The MCP entry shared by every supported client. coverwise needs no env. */
const buildEntry = () => ({
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
});

/**
 * Mode the rewritten file should end up with: the existing file's, or the
 * umask default for a new one.
 *
 * Writes go through a fresh temp file, which would otherwise silently widen
 * the permissions of a config the user (or another installer) had restricted.
 *
 * @param {string} path Absolute path to the config file.
 * @returns {Promise<number | undefined>} Mode bits, or undefined for a new file.
 */
const targetFileMode = async (path) => {
  const stats = await stat(path).catch(() => null);
  return stats ? stats.mode & 0o777 : undefined;
};

/**
 * Write `data` to `path` via a sibling temp file and an atomic rename.
 *
 * These configs can be large and actively read by a running client
 * (`~/.claude.json` in particular), so a partial in-place write would corrupt
 * them.
 *
 * @param {string} path Absolute destination path.
 * @param {string} data File contents.
 * @param {number} [mode] Mode bits for the temp file.
 * @returns {Promise<void>}
 */
const writeFileAtomic = async (path, data, mode) => {
  const tmp = `${path}.coverwise-mcp.tmp`;
  try {
    await writeFile(tmp, data, mode !== undefined ? { mode } : {});
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {
      /* Best effort: nothing to clean up when the temp file was never created. */
    });
    throw err;
  }
};

/**
 * Merge a `coverwise` MCP entry into a JSON config that keys its servers under
 * `mcpServers` (Claude Code, Claude Desktop, Cursor, Cline, Gemini CLI),
 * preserving every other key. Creates the file (and parent dirs) when missing.
 *
 * @param {string} path Absolute path to the JSON config file.
 * @returns {Promise<void>}
 */
export const writeJsonConfig = async (path) => {
  let data = {};
  if (existsSync(path)) {
    const raw = await readFile(path, 'utf8');
    if (raw.trim().length > 0) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(
          `Failed to parse existing JSON at ${path}. Fix or move it before re-running init.`,
        );
      }
    }
  }
  data.mcpServers = data.mcpServers ?? {};
  data.mcpServers[SERVER_NAME] = buildEntry();
  await mkdir(dirname(path), { recursive: true });
  const mode = await targetFileMode(path);
  await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, mode);
};

/**
 * Matches the `[mcp_servers.coverwise]` header and any of its sub-tables, e.g.
 * the `[mcp_servers.coverwise.env]` form a hand-written Codex config may use.
 * Leaving a sub-table behind would attach to whichever section follows and
 * make the document invalid TOML.
 */
const CODEX_HEADER = new RegExp(
  `^[ \\t]*\\[mcp_servers\\.${SERVER_NAME}(?:\\.[^\\]]+)?\\][ \\t]*$`,
);

/** Same matcher applied line-by-line to a whole document. */
const CODEX_HEADER_ANYWHERE = new RegExp(CODEX_HEADER.source, 'm');

/**
 * Remove the `[mcp_servers.coverwise]` block, and every
 * `[mcp_servers.coverwise.*]` sub-table, from a TOML document. Stops skipping
 * at the next unrelated `[section]` header; lines outside those blocks are
 * kept as-is.
 *
 * @param {string} content Raw TOML document.
 * @returns {string} The document without the coverwise blocks.
 */
const stripCodexSection = (content) => {
  const lines = content.split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (CODEX_HEADER.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSection = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

/**
 * Append or replace the `[mcp_servers.coverwise]` block in a Codex CLI TOML
 * config. Other sections are kept verbatim.
 *
 * @param {string} path Absolute path to the TOML config file.
 * @returns {Promise<void>}
 */
export const writeCodexConfig = async (path) => {
  let existing = '';
  if (existsSync(path)) {
    existing = await readFile(path, 'utf8');
  }
  const stripped = stripCodexSection(existing).replace(/\n*$/, '');
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '';
  const entry = buildEntry();
  const args = entry.args.map((a) => `"${a}"`).join(', ');
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${entry.command}"`,
    `args = [${args}]`,
  ].join('\n');
  await mkdir(dirname(path), { recursive: true });
  const mode = await targetFileMode(path);
  await writeFileAtomic(path, `${prefix}${block}\n`, mode);
};

/**
 * Render a filesystem path with `~` substituted for the user's home directory.
 * Display-only; the actual writes always use the absolute path.
 *
 * @param {string} path Absolute path.
 * @returns {string} Path with the home directory collapsed to `~`.
 */
export const displayPath = (path) => {
  const home = homedir();
  if (path === home) {
    return '~';
  }
  if (path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`;
  }
  return path;
};

/**
 * One-word status describing what `init` will do to a config file.
 *
 * @param {string} path Absolute path to the config file.
 * @returns {Promise<string>} `(new)`, `(replace coverwise)`, or `(merge)`.
 */
export const previewWriteImpact = async (path) => {
  if (!existsSync(path)) {
    return '(new)';
  }
  const raw = await readFile(path, 'utf8').catch(() => '');
  if (raw.trim().length === 0) {
    return '(new)';
  }
  try {
    const data = JSON.parse(raw);
    return data.mcpServers && SERVER_NAME in data.mcpServers ? '(replace coverwise)' : '(merge)';
  } catch {
    /* fall through to TOML heuristic */
  }
  return CODEX_HEADER_ANYWHERE.test(raw) ? '(replace coverwise)' : '(merge)';
};

/**
 * One-word status describing what `uninstall` will do to a config file.
 *
 * @param {string} path Absolute path to the config file.
 * @returns {Promise<string>} `(no file; skip)`, `(no coverwise; skip)`, or `(remove coverwise)`.
 */
export const previewRemoveImpact = async (path) => {
  if (!existsSync(path)) {
    return '(no file; skip)';
  }
  const raw = await readFile(path, 'utf8').catch(() => '');
  if (raw.trim().length === 0) {
    return '(no coverwise; skip)';
  }
  try {
    const data = JSON.parse(raw);
    return data.mcpServers && SERVER_NAME in data.mcpServers
      ? '(remove coverwise)'
      : '(no coverwise; skip)';
  } catch {
    /* fall through to TOML heuristic */
  }
  return CODEX_HEADER_ANYWHERE.test(raw) ? '(remove coverwise)' : '(no coverwise; skip)';
};

/** @typedef {'removed' | 'absent' | 'no-file'} RemoveOutcome */

/**
 * Remove the `coverwise` MCP entry from a JSON config. Preserves every other
 * top-level key and every other server entry.
 *
 * @param {string} path Absolute path to the JSON config file.
 * @returns {Promise<RemoveOutcome>} Whether anything was actually changed.
 */
export const removeFromJsonConfig = async (path) => {
  if (!existsSync(path)) {
    return 'no-file';
  }
  const raw = await readFile(path, 'utf8');
  if (raw.trim().length === 0) {
    return 'absent';
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Failed to parse existing JSON at ${path}. Fix or move it before re-running uninstall.`,
    );
  }
  if (!data.mcpServers?.[SERVER_NAME]) {
    return 'absent';
  }
  delete data.mcpServers[SERVER_NAME];
  const mode = await targetFileMode(path);
  await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, mode);
  return 'removed';
};

/**
 * Remove the `[mcp_servers.coverwise]` block from a Codex CLI TOML config.
 *
 * @param {string} path Absolute path to the TOML config file.
 * @returns {Promise<RemoveOutcome>} Whether anything was actually changed.
 */
export const removeFromCodexConfig = async (path) => {
  if (!existsSync(path)) {
    return 'no-file';
  }
  const existing = await readFile(path, 'utf8');
  if (!CODEX_HEADER_ANYWHERE.test(existing)) {
    return 'absent';
  }
  const stripped = stripCodexSection(existing).replace(/\n*$/, '');
  const mode = await targetFileMode(path);
  await writeFileAtomic(path, stripped.length > 0 ? `${stripped}\n` : '', mode);
  return 'removed';
};

/**
 * Per-platform base directory for application configuration, used by the
 * clients that store their config outside the home directory root.
 *
 * @returns {string} Absolute path to the platform's app-config directory.
 */
const appConfigDir = () => {
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
};

/**
 * Where to install / uninstall the coverwise MCP entry.
 *
 * @typedef {'claude-user' | 'claude-project' | 'codex' | 'claude-desktop' | 'cursor' | 'cline' | 'gemini'} TargetKind
 */

/**
 * Supported clients, in menu order. Everything except Codex CLI stores MCP
 * servers as JSON under an `mcpServers` key, so they share one writer.
 */
const TARGET_OPTIONS = [
  {
    key: '1',
    kind: 'claude-user',
    label: 'Claude Code',
    format: 'json',
    resolvePath: () => join(homedir(), '.claude.json'),
  },
  {
    key: '2',
    kind: 'claude-project',
    label: 'Claude Code (project)',
    format: 'json',
    resolvePath: () => join(process.cwd(), '.mcp.json'),
  },
  {
    key: '3',
    kind: 'codex',
    label: 'Codex CLI',
    format: 'toml',
    resolvePath: () => join(homedir(), '.codex', 'config.toml'),
  },
  {
    key: '4',
    kind: 'claude-desktop',
    label: 'Claude Desktop',
    format: 'json',
    resolvePath: () => join(appConfigDir(), 'Claude', 'claude_desktop_config.json'),
  },
  {
    key: '5',
    kind: 'cursor',
    label: 'Cursor',
    format: 'json',
    resolvePath: () => join(homedir(), '.cursor', 'mcp.json'),
  },
  {
    key: '6',
    kind: 'cline',
    label: 'Cline (VS Code)',
    format: 'json',
    resolvePath: () =>
      join(
        appConfigDir(),
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json',
      ),
  },
  {
    key: '7',
    kind: 'gemini',
    label: 'Gemini CLI',
    format: 'json',
    resolvePath: () => join(homedir(), '.gemini', 'settings.json'),
  },
];

/** Selector matching every target, used as the `uninstall` default. */
const ALL_TARGET_KEYS = TARGET_OPTIONS.map((o) => o.key).join(',');

/**
 * Parse a comma-separated target selector like `"1,3"` into a deduplicated list
 * of target kinds. Falls back to `defaultRaw` when the input is blank.
 *
 * @param {string} raw User input.
 * @param {string} defaultRaw Fallback selector when input is blank.
 * @returns {TargetKind[]} Deduplicated, ordered target kinds.
 */
export const parseTargetChoice = (raw, defaultRaw) => {
  const input = raw.trim() === '' ? defaultRaw : raw;
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error('No targets selected.');
  }
  const selected = new Set();
  for (const p of parts) {
    const opt = TARGET_OPTIONS.find((o) => o.key === p);
    if (!opt) {
      throw new Error(`Invalid choice: ${p}`);
    }
    selected.add(opt.kind);
  }
  return [...selected];
};

const writeForFormat = (format, path) =>
  format === 'toml' ? () => writeCodexConfig(path) : () => writeJsonConfig(path);

const removeForFormat = (format, path) =>
  format === 'toml' ? () => removeFromCodexConfig(path) : () => removeFromJsonConfig(path);

const pickTargets = (kinds) =>
  TARGET_OPTIONS.filter((opt) => kinds.includes(opt.kind)).map((opt) => {
    const path = opt.resolvePath();
    return { label: opt.label, path, run: writeForFormat(opt.format, path) };
  });

const pickRemoveTargets = (kinds) =>
  TARGET_OPTIONS.filter((opt) => kinds.includes(opt.kind)).map((opt) => {
    const path = opt.resolvePath();
    return { label: opt.label, path, run: removeForFormat(opt.format, path) };
  });

const renderTargetMenu = () => {
  const width = Math.max(...TARGET_OPTIONS.map((o) => o.label.length));
  return TARGET_OPTIONS.map(
    (o) => `  ${o.key}) ${o.label.padEnd(width)}  ${displayPath(o.resolvePath())}`,
  ).join('\n');
};

const promptYesNo = async (rl, question, defaultYes) => {
  const def = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await rl.question(`${question} [${def}] `)).trim().toLowerCase();
  if (ans === '') {
    return defaultYes;
  }
  return ans === 'y' || ans === 'yes';
};

/**
 * Run the interactive setup: pick which MCP client config files to update, then
 * write the `coverwise` entry into each.
 *
 * @returns {Promise<void>}
 */
export const runInit = async () => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('coverwise-mcp setup\n\n');
    stdout.write('Where to install? (pick one or more, comma-separated)\n');
    stdout.write(`${renderTargetMenu()}\n`);
    const choice = (await rl.question('Choice [1,3]: ')).trim();
    const kinds = parseTargetChoice(choice, '1,3');
    const targets = pickTargets(kinds);

    stdout.write('\nWill update:\n');
    for (const t of targets) {
      const summary = await previewWriteImpact(t.path);
      stdout.write(`  - ${displayPath(t.path)} ${summary}\n`);
    }
    stdout.write('\n');

    const confirmed = await promptYesNo(rl, 'Proceed?', true);
    if (!confirmed) {
      stdout.write('Aborted.\n');
      return;
    }

    for (const t of targets) {
      await t.run();
      stdout.write(`Wrote ${displayPath(t.path)}\n`);
    }
    stdout.write('\nDone. Restart your MCP client to pick up the new server.\n');
  } finally {
    rl.close();
  }
};

/**
 * Interactive companion to {@link runInit}: removes the `coverwise` MCP entry
 * from the selected config files. Leaves other servers/sections alone.
 *
 * @returns {Promise<void>}
 */
export const runUninstall = async () => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('coverwise-mcp uninstall\n\n');
    stdout.write('Where to remove from? (pick one or more, comma-separated)\n');
    stdout.write(`${renderTargetMenu()}\n`);
    const choice = (await rl.question(`Choice [${ALL_TARGET_KEYS}]: `)).trim();
    const kinds = parseTargetChoice(choice, ALL_TARGET_KEYS);
    const targets = pickRemoveTargets(kinds);

    stdout.write('\nWill update:\n');
    for (const t of targets) {
      const summary = await previewRemoveImpact(t.path);
      stdout.write(`  - ${displayPath(t.path)} ${summary}\n`);
    }
    stdout.write('\n');

    const confirmed = await promptYesNo(rl, 'Proceed?', true);
    if (!confirmed) {
      stdout.write('Aborted.\n');
      return;
    }

    for (const t of targets) {
      const outcome = await t.run();
      const p = displayPath(t.path);
      if (outcome === 'removed') {
        stdout.write(`Removed coverwise from ${p}\n`);
      } else if (outcome === 'absent') {
        stdout.write(`No coverwise in ${p}; skipped.\n`);
      } else {
        stdout.write(`${p} does not exist; skipped.\n`);
      }
    }
    stdout.write('\nDone. Restart your MCP client for the change to take effect.\n');
  } finally {
    rl.close();
  }
};
