/**
 * End-to-end smoke tests for the coverwise-mcp MCP server.
 *
 * Spawns mcp/server.mjs as a subprocess and drives it with the official
 * MCP SDK client over stdio, exactly as Claude Code would. Validates that
 * every tool advertised in tools/list works on a small happy-path input.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'mcp', 'server.mjs');

/** Spawn the MCP server and return a connected SDK Client. */
async function startClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });
  const client = new Client(
    { name: 'coverwise-mcp-tests', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

/** Parse the first text content block of a tool result as JSON. */
function parseResult(result) {
  expect(result.content).toBeDefined();
  expect(result.content.length).toBeGreaterThan(0);
  const block = result.content[0];
  expect(block.type).toBe('text');
  return JSON.parse(block.text);
}

/** Zip a columns + rows suite payload back into { paramName: value } maps. */
function asMaps(out) {
  expect(Array.isArray(out.columns)).toBe(true);
  expect(Array.isArray(out.rows)).toBe(true);
  return out.rows.map((row) => Object.fromEntries(out.columns.map((name, i) => [name, row[i]])));
}

/** Assert that the existing rows plus an extension's `newRows` reach full coverage. */
async function expectExtensionCovers(client, parameters, existing, out, constraints) {
  const result = await client.callTool({
    name: 'pairwise_analyze',
    arguments: { parameters, constraints, tests: [...existing, ...out.newRows] },
  });
  const report = parseResult(result);
  expect(report.coverage).toBe(1);
  expect(report.invalidTests).toEqual([]);
}

const discreteParameters = () => [
  { name: 'a', values: ['1', '2'] },
  { name: 'b', values: ['x', 'y'] },
];

const boundaryParameters = () => [
  { name: 'qty', type: 'integer', range: [1, 100], values: [] },
  { name: 'flag', values: ['on', 'off'] },
];

const classParameters = () => [
  {
    name: 'status',
    values: [
      { value: 200, class: 'ok' },
      { value: 400, class: 'client_error' },
      { value: 500, class: 'server_error' },
    ],
  },
  { name: 'method', values: ['GET', 'POST'] },
];

describe('coverwise-mcp MCP server', () => {
  let client;
  let transport;

  beforeAll(async () => {
    ({ client, transport } = await startClient());
  });

  afterAll(async () => {
    await transport?.close();
  });

  it('lists exactly the four expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'pairwise_analyze',
      'pairwise_estimate',
      'pairwise_extend',
      'pairwise_generate',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      // A top-level schema combinator makes a client drop the tool while the
      // server still connects and still lists it, so the tool goes missing with
      // nothing to read anywhere. The model/parameters requirement it would
      // express lives in resolveParameters instead.
      for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not']) {
        expect(tool.inputSchema[keyword]).toBeUndefined();
      }
      expect(tool.inputSchema.properties.model).toBeDefined();
    }

    const generateTool = tools.find((tool) => tool.name === 'pairwise_generate');
    expect(generateTool.inputSchema.properties.strength).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(generateTool.inputSchema.properties.seed).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 4294967295,
    });
  });

  it('pairwise_estimate returns parameter statistics without running generation', async () => {
    const result = await client.callTool({
      name: 'pairwise_estimate',
      arguments: {
        parameters: [
          { name: 'os', values: ['win', 'mac', 'linux'] },
          { name: 'browser', values: ['chrome', 'firefox', 'safari'] },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    const stats = parseResult(result);
    expect(stats.parameterCount).toBe(2);
    expect(stats.totalValues).toBe(6);
    expect(stats.totalTuples).toBe(9);
    expect(stats.estimatedTests).toBeGreaterThan(0);
  });

  it('pairwise_generate produces a covering array with full pairwise coverage', async () => {
    const result = await client.callTool({
      name: 'pairwise_generate',
      arguments: {
        parameters: [
          { name: 'os', values: ['win', 'mac', 'linux'] },
          { name: 'browser', values: ['chrome', 'firefox', 'safari'] },
        ],
        seed: 42,
      },
    });
    expect(result.isError).toBeFalsy();
    const out = parseResult(result);
    expect(out.coverage).toBe(1);
    expect(out.uncovered).toEqual([]);
    expect(out.uncoveredCount).toBe(0);
    expect(out.omittedUncovered).toBe(0);
    expect(out.columns).toEqual(['os', 'browser']);
    const suite = asMaps(out);
    expect(suite.length).toBeGreaterThanOrEqual(9);
    for (const tc of suite) {
      expect(['win', 'mac', 'linux']).toContain(tc.os);
      expect(['chrome', 'firefox', 'safari']).toContain(tc.browser);
    }
  });

  it('pairwise_generate honours constraints', async () => {
    const result = await client.callTool({
      name: 'pairwise_generate',
      arguments: {
        parameters: [
          { name: 'os', values: ['win', 'mac'] },
          { name: 'browser', values: ['chrome', 'safari'] },
        ],
        constraints: ['IF os = win THEN browser != safari'],
        seed: 1,
      },
    });
    const out = parseResult(result);
    expect(out.coverage).toBe(1);
    for (const tc of asMaps(out)) {
      expect(tc.os === 'win' && tc.browser === 'safari').toBe(false);
    }
  });

  it('pairwise_analyze reports a gap in an incomplete suite', async () => {
    const result = await client.callTool({
      name: 'pairwise_analyze',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        tests: [
          { a: '1', b: 'x' },
          { a: '2', b: 'y' },
        ],
      },
    });
    const report = parseResult(result);
    expect(report.stats).toEqual({ totalTuples: 4, coveredTuples: 2, testCount: 2 });
    expect(report.strength).toBe(2);
    expect(report.uncovered).toEqual(['a=1, b=y', 'a=2, b=x']);
    expect(report.uncoveredCount).toBe(2);
    expect(report.omittedUncovered).toBe(0);
    expect(report.invalidTests).toEqual([]);
    expect(report.coverage).toBeCloseTo(0.5, 5);
  });

  it('pairwise_analyze with constraints removes impossible tuples from the universe', async () => {
    const result = await client.callTool({
      name: 'pairwise_analyze',
      arguments: {
        parameters: [
          { name: 'locale', values: ['en', 'ja', 'ar'] },
          { name: 'dir', values: ['ltr', 'rtl'] },
        ],
        tests: [
          { locale: 'en', dir: 'ltr' },
          { locale: 'ar', dir: 'rtl' },
        ],
        constraints: ['IF locale = ar THEN dir = rtl', 'IF locale IN {en, ja} THEN dir = ltr'],
      },
    });
    const report = parseResult(result);
    // Without constraints: 6 tuples. With constraints: 6 - 3 impossible = 3.
    expect(report.stats.totalTuples).toBe(3);
    expect(report.stats.coveredTuples).toBe(2);
    // The single uncovered tuple must be locale=ja × dir=ltr (the only valid one
    // not exercised); no constraint-impossible tuple may appear.
    expect(report.uncovered).toEqual(['locale=ja, dir=ltr']);
  });

  it('constraint solver excludes partial tuples that cannot extend to a valid complete test', async () => {
    const parameters = [
      { name: 'a', values: ['0', '1'] },
      { name: 'b', values: ['0', '1'] },
      { name: 'c', values: ['0', '1'] },
    ];
    const constraints = ['IF a = 0 THEN c = 0', 'IF b = 0 THEN c = 1'];
    const generated = await client.callTool({
      name: 'pairwise_generate',
      arguments: { parameters, constraints, seed: 11 },
    });
    const suite = parseResult(generated);
    expect(suite.coverage).toBe(1);

    const analyzed = await client.callTool({
      name: 'pairwise_analyze',
      // The generated rows go straight back in: no reshaping between calls.
      arguments: { parameters, constraints, tests: suite.rows },
    });
    const report = parseResult(analyzed);
    expect(report.coverage).toBe(1);
    expect(report.stats.totalTuples).toBe(9);
    expect(report.uncoveredCount).toBe(0);
    expect(report.uncovered).toEqual([]);
  });

  it('pairwise_analyze reports rows excluded from coverage accounting', async () => {
    const result = await client.callTool({
      name: 'pairwise_analyze',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        tests: [{ a: '1' }],
      },
    });
    const report = parseResult(result);
    expect(report.coverage).toBe(0);
    expect(report.invalidTests).toHaveLength(1);
    expect(report.invalidTests[0].testIndex).toBe(0);
    expect(report.invalidTests[0].reason).toMatch(/parameter b/i);
    expect(report.uncoveredCount).toBe(4);
  });

  it('pairwise_analyze reports the full gap count when diagnostics are truncated', async () => {
    const values = Array.from({ length: 40 }, (_, index) => String(index));
    const result = await client.callTool({
      name: 'pairwise_analyze',
      arguments: {
        parameters: [
          { name: 'a', values },
          { name: 'b', values },
        ],
        tests: [],
      },
    });
    const report = parseResult(result);
    expect(report.coverage).toBe(0);
    expect(report.uncoveredCount).toBe(1600);
    expect(report.uncovered).toHaveLength(1000);
    expect(report.omittedUncovered).toBe(600);
  });

  it('pairwise_generate expands boundary values from type + range', async () => {
    const result = await client.callTool({
      name: 'pairwise_generate',
      arguments: {
        parameters: [
          { name: 'qty', type: 'integer', range: [1, 100], values: [] },
          { name: 'flag', values: ['on', 'off'] },
        ],
      },
    });
    const out = parseResult(result);
    const qtys = new Set(asMaps(out).map((t) => String(t.qty)));
    // integer boundary expansion of [1, 100] → 0,1,2,99,100,101
    for (const expected of ['0', '1', '2', '99', '100', '101']) {
      expect(qtys.has(expected)).toBe(true);
    }
  });

  it('pairwise_generate reports class coverage when values carry equivalence classes', async () => {
    const result = await client.callTool({
      name: 'pairwise_generate',
      arguments: {
        parameters: [
          {
            name: 'status',
            values: [
              { value: 400, class: 'client_error' },
              { value: 404, class: 'client_error' },
              { value: 500, class: 'server_error' },
              { value: 200, class: 'ok' },
            ],
          },
          { name: 'method', values: ['GET', 'POST'] },
        ],
      },
    });
    const out = parseResult(result);
    expect(out.classCoverage).toBeDefined();
    expect(out.classCoverage.classCoverageRatio).toBe(1);
    expect(out.classCoverage.coveredClassTuples).toBe(out.classCoverage.totalClassTuples);
  });

  it('pairwise_extend preserves existing tests and reaches full coverage', async () => {
    const existing = [
      { a: '1', b: 'x' },
      { a: '2', b: 'y' },
    ];
    const result = await client.callTool({
      name: 'pairwise_extend',
      arguments: {
        existing,
        mode: 'strict',
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        seed: 7,
      },
    });
    const out = parseResult(result);
    expect(out.coverage).toBe(1);
    // Only the additions come back; the caller already holds the existing rows.
    expect(out.rows).toBeUndefined();
    expect(out.stats.testCount).toBe(existing.length + out.newRows.length);
    await expectExtensionCovers(client, discreteParameters(), existing, out);
    // Coverage of the suite as it stood, folded in to save an analyze call.
    expect(out.before.coverage).toBeCloseTo(0.5, 5);
    expect(out.before.stats.testCount).toBe(existing.length);
    expect(out.before.uncovered).toEqual(['a=1, b=y', 'a=2, b=x']);
    expect(out.before.uncoveredCount).toBe(2);
  });

  it('forwards the warnings array on a successful generation', async () => {
    // GenerateResult always carries a warnings array (empty on the happy path).
    // The MCP server must forward it verbatim so callers can inspect it.
    const result = await client.callTool({
      name: 'pairwise_generate',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
      },
    });
    const out = parseResult(result);
    expect(Array.isArray(out.warnings)).toBe(true);
  });

  it('surfaces a structured CONSTRAINT_ERROR for malformed constraint syntax', async () => {
    // A syntactically malformed constraint is a hard error in coverwise. The
    // MCP server should faithfully forward the structured error payload.
    const result = await client.callTool({
      name: 'pairwise_generate',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        constraints: ['NOT A VALID CONSTRAINT @@@'],
      },
    });
    expect(result.isError).toBe(true);
    const out = parseResult(result);
    expect(out.code).toBe('CONSTRAINT_ERROR');
    expect(out.message).toBeTruthy();
  });

  it('surfaces structured INVALID_INPUT errors for invalid generation options', async () => {
    const result = await client.callTool({
      name: 'pairwise_generate',
      arguments: {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
        ],
        weights: { a: { 1: 0 } },
      },
    });
    expect(result.isError).toBe(true);
    const out = parseResult(result);
    expect(out.code).toBe('INVALID_INPUT');
    expect(out.message).toMatch(/weight/i);
  });

  it.each([
    {
      scenario: 'class model + malformed constraint + seed + valid options',
      arguments: {
        parameters: classParameters(),
        constraints: ['NOT A VALID CONSTRAINT @@@'],
        seed: 17,
        weights: { method: { GET: 2 } },
      },
      expectedError: 'CONSTRAINT_ERROR',
    },
    {
      scenario: 'boundary model + malformed constraint + seed + invalid options',
      arguments: {
        parameters: boundaryParameters(),
        constraints: ['NOT A VALID CONSTRAINT @@@'],
        seed: 17,
        weights: { flag: { on: 0 } },
      },
      expectedError: 'INVALID_INPUT',
    },
    {
      scenario: 'class model + satisfiable constraint + no seed + invalid options',
      arguments: {
        parameters: classParameters(),
        constraints: ['IF method = POST THEN status != 500'],
        weights: { method: { GET: 0 } },
      },
      expectedError: 'INVALID_INPUT',
    },
    {
      scenario: 'boundary model + no constraint or seed + valid options',
      arguments: {
        parameters: boundaryParameters(),
        weights: { flag: { on: 2 } },
        seeds: [{ qty: 1, flag: 'on' }],
        subModels: [{ parameters: ['qty', 'flag'], strength: 2 }],
        maxTests: 0,
      },
    },
    {
      scenario: 'boundary model + satisfiable constraint + seed + valid options',
      arguments: {
        parameters: boundaryParameters(),
        constraints: ['IF flag = on THEN qty >= 0'],
        seed: 23,
        weights: { flag: { off: 2 } },
      },
    },
    {
      scenario: 'discrete model + satisfiable constraint + seed + valid options',
      arguments: {
        parameters: discreteParameters(),
        constraints: ['IF a = 1 THEN b = x'],
        seed: 29,
        weights: { a: { 1: 2 } },
        seeds: [{ a: '1', b: 'x' }],
        subModels: [{ parameters: ['a', 'b'], strength: 2 }],
        maxTests: 0,
      },
    },
  ])(
    'covers pairwise_generate interaction: $scenario',
    async ({ arguments: args, expectedError }) => {
      const result = await client.callTool({ name: 'pairwise_generate', arguments: args });
      const out = parseResult(result);
      if (expectedError) {
        expect(result.isError).toBe(true);
        expect(out.code).toBe(expectedError);
        return;
      }
      expect(result.isError).toBeFalsy();
      expect(out.coverage).toBe(1);
      expect(out.uncoveredCount).toBe(0);
    },
  );

  it('pairwise_analyze reports a complete unconstrained suite', async () => {
    const result = await client.callTool({
      name: 'pairwise_analyze',
      arguments: {
        parameters: discreteParameters(),
        tests: [
          { a: '1', b: 'x' },
          { a: '1', b: 'y' },
          { a: '2', b: 'x' },
          { a: '2', b: 'y' },
        ],
      },
    });
    const report = parseResult(result);
    expect(report.coverage).toBe(1);
    expect(report.uncoveredCount).toBe(0);
    expect(report.invalidTests).toEqual([]);
  });

  it('pairwise_analyze reports invalid rows with constraints present', async () => {
    const result = await client.callTool({
      name: 'pairwise_analyze',
      arguments: {
        parameters: discreteParameters(),
        tests: [{ a: '1' }],
        constraints: ['IF a = 1 THEN b = x'],
      },
    });
    const report = parseResult(result);
    expect(report.coverage).toBe(0);
    expect(report.invalidTests).toHaveLength(1);
    expect(report.invalidTests[0].testIndex).toBe(0);
  });

  it('pairwise_analyze truncates constrained incomplete-suite diagnostics', async () => {
    const values = Array.from({ length: 40 }, (_, index) => String(index));
    const result = await client.callTool({
      name: 'pairwise_analyze',
      arguments: {
        parameters: [
          { name: 'a', values },
          { name: 'b', values },
        ],
        tests: [],
        constraints: [`a IN {${values.join(', ')}}`],
      },
    });
    const report = parseResult(result);
    expect(report.coverage).toBe(0);
    expect(report.uncoveredCount).toBe(1600);
    expect(report.uncovered).toHaveLength(1000);
    expect(report.omittedUncovered).toBe(600);
  });

  it.each([
    { scenario: 'constraints + seed + default mode', constraints: true, seed: 31 },
    { scenario: 'no constraints or seed + default mode' },
    { scenario: 'constraints + no seed + strict mode', constraints: true, mode: 'strict' },
  ])('covers pairwise_extend interaction: $scenario', async ({ constraints, seed, mode }) => {
    const existing = [
      { a: '1', b: 'x' },
      { a: '2', b: 'y' },
    ];
    const args = { existing, parameters: discreteParameters() };
    if (constraints) {
      args.constraints = ['IF a = 1 THEN b = x'];
    }
    if (seed !== undefined) {
      args.seed = seed;
    }
    if (mode !== undefined) {
      args.mode = mode;
    }

    const result = await client.callTool({ name: 'pairwise_extend', arguments: args });
    const out = parseResult(result);
    expect(result.isError).toBeFalsy();
    expect(out.coverage).toBe(1);
    await expectExtensionCovers(client, discreteParameters(), existing, out, args.constraints);
  });

  it.each([
    {
      scenario: 'constraints + custom strength + no sub-model',
      constraints: true,
      strength: 3,
    },
    {
      scenario: 'constraints + default strength + sub-model',
      constraints: true,
      subModels: [{ parameters: ['a', 'b', 'c'], strength: 3 }],
    },
    { scenario: 'no constraints + custom strength + no sub-model', strength: 3 },
    {
      scenario: 'no constraints + custom strength + sub-model',
      strength: 1,
      subModels: [{ parameters: ['a', 'b'], strength: 2 }],
    },
  ])(
    'covers pairwise_estimate interaction: $scenario',
    async ({ constraints, strength, subModels }) => {
      const args = {
        parameters: [
          { name: 'a', values: ['1', '2'] },
          { name: 'b', values: ['x', 'y'] },
          { name: 'c', values: ['on', 'off'] },
        ],
      };
      if (constraints) {
        args.constraints = ['IF a = 1 THEN b = x'];
      }
      if (strength !== undefined) {
        args.strength = strength;
      }
      if (subModels !== undefined) {
        args.subModels = subModels;
      }

      const result = await client.callTool({ name: 'pairwise_estimate', arguments: args });
      const stats = parseResult(result);
      expect(result.isError).toBeFalsy();
      expect(stats.parameterCount).toBe(3);
      expect(stats.totalTuples).toBeGreaterThan(0);
      expect(stats.subModelCount).toBe(subModels ? 1 : 0);
    },
  );
});

describe('high-level input and output shapes', () => {
  let client;
  let transport;

  beforeAll(async () => {
    ({ client, transport } = await startClient());
  });

  afterAll(async () => {
    await transport?.close();
  });

  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, payload: parseResult(result) };
  };

  it('accepts the shorthand model and the explicit parameter list interchangeably', async () => {
    const shorthand = await call('pairwise_generate', {
      model: { os: ['win', 'mac'], browser: ['chrome', 'safari'], mode: ['fast', 'safe'] },
      seed: 5,
    });
    const explicit = await call('pairwise_generate', {
      parameters: [
        { name: 'os', values: ['win', 'mac'] },
        { name: 'browser', values: ['chrome', 'safari'] },
        { name: 'mode', values: ['fast', 'safe'] },
      ],
      seed: 5,
    });
    expect(shorthand.payload.columns).toEqual(['os', 'browser', 'mode']);
    expect(shorthand.payload).toEqual(explicit.payload);
  });

  it('accepts a { type, range } spec inside the shorthand model', async () => {
    const { payload } = await call('pairwise_generate', {
      model: { qty: { type: 'integer', range: [1, 100] }, flag: ['on', 'off'] },
    });
    const qtys = new Set(asMaps(payload).map((row) => row.qty));
    for (const expected of [0, 1, 2, 99, 100, 101]) {
      expect(qtys.has(expected)).toBe(true);
    }
  });

  it('returns values in the JSON type they were declared with', async () => {
    // The engine works on stringified values; without restoration every row
    // would come back as "1" / "true" and need casting before it can be used.
    const { payload } = await call('pairwise_generate', {
      model: { retries: [0, 1, 5], verbose: [true, false], mode: ['fast', 'safe'] },
    });
    for (const row of asMaps(payload)) {
      expect(typeof row.retries).toBe('number');
      expect(typeof row.verbose).toBe('boolean');
      expect(typeof row.mode).toBe('string');
    }
  });

  it('restores types on boundary values the model never declared', async () => {
    const { payload } = await call('pairwise_generate', {
      model: { qty: { type: 'integer', range: [1, 3] }, flag: ['on', 'off'] },
    });
    for (const row of asMaps(payload)) {
      expect(Number.isInteger(row.qty)).toBe(true);
    }
  });

  it('returns suggestions as typed positional rows', async () => {
    const { payload } = await call('pairwise_generate', {
      model: { os: ['linux', 'mac', 'win'], n: [1, 2, 3], verbose: [true, false] },
      maxTests: 2,
    });
    expect(payload.coverage).toBeLessThan(1);
    expect(payload.suggestions.length).toBeGreaterThan(0);
    for (const { description, row } of payload.suggestions) {
      expect(typeof description).toBe('string');
      expect(row).toHaveLength(3);
      expect(typeof row[1]).toBe('number');
      expect(typeof row[2]).toBe('boolean');
    }
  });

  it('prints each suite row on a single line', async () => {
    const { result, payload } = await call('pairwise_generate', {
      model: { os: ['win', 'mac'], browser: ['chrome', 'safari'], retries: [0, 3] },
    });
    const lines = result.content[0].text.split('\n').map((line) => line.trim().replace(/,$/, ''));
    for (const row of payload.rows) {
      expect(lines).toContain(JSON.stringify(row));
    }
    expect(lines).toContain('"columns": ["os","browser","retries"]');
  });

  it('reports errors as code, message and detail only', async () => {
    const { result, payload } = await call('pairwise_generate', {
      model: { os: ['linux', 'mac'], fmt: ['json', 'text'] },
      constraints: ['IF os = windows THEN fmt = json'],
    });
    expect(result.isError).toBe(true);
    expect(Object.keys(payload).sort()).toEqual(['code', 'detail', 'message']);
    expect(payload.code).toBe('CONSTRAINT_ERROR');
  });

  it('restores types on negative rows too', async () => {
    const { payload } = await call('pairwise_generate', {
      model: {
        qty: [1, 50, { value: -1, invalid: true }],
        flag: [true, false],
        mode: ['fast', 'safe'],
      },
    });
    expect(payload.negativeRows.length).toBeGreaterThan(0);
    const qtyIndex = payload.columns.indexOf('qty');
    for (const row of payload.negativeRows) {
      expect(typeof row[qtyIndex]).toBe('number');
    }
    expect(payload.negativeRows.some((row) => row[qtyIndex] === -1)).toBe(true);
  });

  it('rejects a parameter whose values collide once stringified', async () => {
    // Type restoration maps an engine token back to its declared value, which
    // only works because 1 and "1" cannot coexist in one parameter. Pin that
    // guarantee here: without it a restored row could carry the wrong type.
    const { result, payload } = await call('pairwise_generate', {
      model: { amount: [1, '1', 2], flag: ['on', 'off'] },
    });
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.message).toMatch(/duplicate value/i);
  });

  it('round-trips generated rows into analyze without reshaping', async () => {
    const model = {
      os: ['win', 'mac', 'linux'],
      browser: ['chrome', 'safari'],
      flag: [true, false],
    };
    const generated = await call('pairwise_generate', { model, seed: 3 });
    const analyzed = await call('pairwise_analyze', { model, tests: generated.payload.rows });
    expect(analyzed.payload.coverage).toBe(1);
    expect(analyzed.payload.invalidTests).toEqual([]);
  });

  it('accepts positional rows as the existing suite for extension', async () => {
    const model = { a: ['1', '2'], b: ['x', 'y'] };
    const { payload } = await call('pairwise_extend', {
      model,
      existing: [
        ['1', 'x'],
        ['2', 'y'],
      ],
    });
    expect(payload.coverage).toBe(1);
    expect(payload.columns).toEqual(['a', 'b']);
    expect(payload.newRows.length).toBeGreaterThan(0);
    for (const row of payload.newRows) {
      expect(row).toHaveLength(2);
    }
    expect(payload.before.uncoveredCount).toBe(2);
  });

  it('reports a row whose width does not match the model', async () => {
    const { result, payload } = await call('pairwise_analyze', {
      model: { a: ['1', '2'], b: ['x', 'y'] },
      tests: [['1', 'x'], ['2']],
    });
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.message).toMatch(/tests\[1\] has 1 values but the model has 2 parameters/);
  });

  it('rejects passing both input forms at once', async () => {
    const { result, payload } = await call('pairwise_generate', {
      model: { a: ['1', '2'] },
      parameters: [{ name: 'a', values: ['1', '2'] }],
    });
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.message).toMatch(/not both/);
  });

  it('rejects a call with no parameter model at all', async () => {
    const { result, payload } = await call('pairwise_generate', { seed: 1 });
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.message).toMatch(/`model`/);
  });

  it('rejects a model entry that is neither a value list nor a spec object', async () => {
    const { result, payload } = await call('pairwise_generate', { model: { a: 'oops' } });
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.message).toMatch(/model\.a/);
  });

  it('rejects an empty model', async () => {
    const { result, payload } = await call('pairwise_generate', { model: {} });
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('INVALID_INPUT');
    expect(payload.message).toMatch(/at least one parameter/);
  });

  it('reports an unknown tool name rather than a model error', async () => {
    const { result, payload } = await call('generate', { model: { a: ['1', '2'] } });
    expect(result.isError).toBe(true);
    expect(payload.message).toMatch(/Unknown tool: generate/);
  });
});

describe('CLI entry point', () => {
  it('boots the MCP server when invoked with no arguments', async () => {
    const cliPath = resolve(here, '..', 'mcp', 'cli.mjs');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
    });
    const client = new Client({ name: 'cli-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'pairwise_analyze',
        'pairwise_estimate',
        'pairwise_extend',
        'pairwise_generate',
      ]);
    } finally {
      await transport.close();
    }
  });
});

describe('install-deps hook script', () => {
  it('exits successfully with no environment variables set (no-op path)', async () => {
    const hookPath = resolve(here, '..', 'scripts', 'install-deps.mjs');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookPath], {
        env: {}, // strip CLAUDE_PLUGIN_ROOT — should exit cleanly
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('exit', (c) => resolve(c));
      child.on('error', reject);
    });
    expect(code).toBe(0);
  });
});

describe('session-context hook script', () => {
  const hookPath = resolve(here, '..', 'scripts', 'session-context.mjs');

  /** Run the hook against a working directory and capture its stdout. */
  const runIn = (projectDir) =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [hookPath], {
        env: { CLAUDE_PROJECT_DIR: projectDir },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('exit', (code) => done({ code, stdout }));
      child.on('error', fail);
    });

  it('states the applicability rule inside a code project', async () => {
    const { code, stdout } = await runIn(resolve(here, '..'));
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const context = payload.hookSpecificOutput.additionalContext;
    // The tool names must be present: they are the handle a session needs to
    // find the server when MCP schemas are loaded on demand rather than upfront.
    for (const tool of [
      'pairwise_generate',
      'pairwise_analyze',
      'pairwise_extend',
      'pairwise_estimate',
    ]) {
      expect(context).toContain(tool);
    }
    expect(context).toMatch(/3 or more independent parameters/);
  });

  it('stays silent outside a code project', async () => {
    const { code, stdout } = await runIn(tmpdir());
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });
});
