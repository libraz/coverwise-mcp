#!/usr/bin/env node
/**
 * coverwise-mcp MCP server.
 *
 * Exposes the @libraz/coverwise combinatorial test engine over stdio
 * so Claude Code can analyze, generate, and extend pairwise / t-wise
 * test suites while writing tests.
 *
 * The tool surface is deliberately one level above the engine's own API:
 * a parameter model can be written as a plain `{ name: [values] }` map,
 * suites travel as `columns` + positional `rows` (which map straight onto a
 * table-driven test and cost fewer tokens than repeating key names), values
 * come back in the JSON types they were declared with, every tool reports
 * coverage in one shape with uncovered tuples as display strings, and the
 * extend tool carries the diagnostics that would otherwise need a second
 * analyze call.
 */
import { analyzeCoverage, estimateModel, extendTests, generate, init } from '@libraz/coverwise';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PACKAGE_VERSION } from './version.mjs';

// --- WASM initialization -------------------------------------------------
// Defer reporting init failures until the first tool call so the client
// sees a structured error instead of a silent stdio disconnect.
let initError = null;
try {
  await init();
} catch (err) {
  initError = err;
}

const server = new Server(
  { name: 'coverwise', version: PACKAGE_VERSION },
  { capabilities: { tools: {} } },
);

// --- Shared JSON Schema fragments ---------------------------------------

/** A single parameter value: primitive or { value, invalid?, aliases?, class? } object. */
const parameterValueSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    {
      type: 'object',
      properties: {
        value: {
          oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        },
        invalid: {
          type: 'boolean',
          description: 'If true, this value triggers a negative test (single-fault).',
        },
        aliases: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Alternate names that match this value in constraints.',
        },
        class: {
          type: 'string',
          description:
            'Equivalence class name. Values sharing a class are interchangeable for the class-coverage metric, surfaced as result.classCoverage.',
        },
      },
      required: ['value'],
      additionalProperties: false,
    },
  ],
};

const boundaryFields = {
  type: {
    type: 'string',
    enum: ['integer', 'float'],
    description:
      'Boundary value expansion type. With `range`, expands the value set to min-1/min/min+1 and max-1/max/max+1 (spaced by `step` for "float").',
  },
  range: {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
    description: 'Inclusive [min, max] range driving boundary value expansion. Requires `type`.',
  },
  step: {
    type: 'number',
    exclusiveMinimum: 0,
    description: 'Step size for "float" boundary expansion (default 1.0).',
  },
};

const modelSchema = {
  type: 'object',
  description:
    'Parameter model as a { paramName: values } map, in column order. A value list is an array; a numeric parameter can instead be { "type": "integer", "range": [min, max] } to get boundary values injected. Example: { "os": ["win", "mac"], "retries": { "type": "integer", "range": [0, 5] }, "verbose": [true, false] }.',
  minProperties: 1,
  additionalProperties: {
    oneOf: [
      { type: 'array', items: parameterValueSchema },
      {
        type: 'object',
        properties: {
          values: { type: 'array', items: parameterValueSchema },
          ...boundaryFields,
        },
        additionalProperties: false,
      },
    ],
  },
};

const constraintsSchema = {
  type: 'array',
  description:
    'Constraints, AND-ed together. Grammar: `[IF cond THEN] cond [ELSE cond]`; a cond compares a parameter with `=`, `!=`, `<`, `<=`, `>`, `>=`, `IN {a, b}` or `LIKE pre*`, and combines with NOT > AND > OR plus parentheses. Keywords, names and values are case-insensitive; quote values with spaces or symbols ("us-east-1"). Examples: "IF os = mac THEN browser != ie", "IF plan IN {free, trial} THEN seats <= 5", "browser != ie". Pass the same list to every tool for the same model.',
  items: { type: 'string' },
};

const primitiveSchema = {
  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
};

const testCaseSchema = {
  type: 'object',
  description: 'A test case as a { paramName: value } map.',
  additionalProperties: primitiveSchema,
};

const testCasesSchema = {
  type: 'array',
  description:
    "Test cases, either as { paramName: value } maps or as positional rows ([value, ...]) in the model's parameter order. The `rows` array returned by pairwise_generate can be passed straight back in.",
  items: {
    oneOf: [testCaseSchema, { type: 'array', items: primitiveSchema }],
  },
};

const weightsSchema = {
  type: 'object',
  description:
    'Per-parameter value weights to bias generation. Shape: { paramName: { value: weight, ... } }.',
  additionalProperties: {
    type: 'object',
    additionalProperties: { type: 'number', exclusiveMinimum: 0 },
  },
};

const subModelsSchema = {
  type: 'array',
  description:
    'Mixed-strength sub-models. Each entry raises the strength for a named subset of parameters (e.g. boost critical groups to 3-wise while the rest stays pairwise).',
  items: {
    type: 'object',
    properties: {
      parameters: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'string', minLength: 1 },
      },
      strength: { type: 'integer', minimum: 1 },
    },
    required: ['parameters', 'strength'],
    additionalProperties: false,
  },
};

/** Fields shared by every tool that takes a parameter model. */
const modelInputFields = {
  model: modelSchema,
  constraints: constraintsSchema,
  strength: {
    type: 'integer',
    minimum: 1,
    description: 'Interaction strength t. 2 = pairwise (default), 3 = triple-wise, etc.',
    default: 2,
  },
};

/** Fields shared by pairwise_generate / pairwise_extend. */
const generateInputFields = {
  ...modelInputFields,
  seed: {
    type: 'integer',
    minimum: 0,
    maximum: 4294967295,
    description: 'Unsigned 32-bit RNG seed for deterministic output.',
  },
  weights: weightsSchema,
  requiredRows: {
    ...testCasesSchema,
    description:
      'Test cases that must appear in the generated suite, such as a known regression case. Unrelated to the RNG `seed`.',
  },
  subModels: subModelsSchema,
  maxTests: {
    type: 'integer',
    minimum: 0,
    maximum: 4294967295,
    description: 'Optional cap on test count. Coverage may be < 1.0 if set too low.',
  },
};

// --- Tool definitions ---------------------------------------------------
//
// Keep every inputSchema free of top-level combinators (anyOf/oneOf/allOf): a
// client whose backing API rejects them drops the tool silently, and the server
// still answers tools/list, so the loss shows up only as missing tools.

const tools = [
  {
    name: 'pairwise_generate',
    description:
      'USE BEFORE hand-picking test cases whenever the code under test takes 3 or more independent parameters — CLI flags, config options, enum arguments, query params, feature flags, form fields, state-machine inputs. This applies even when the request is simply "write tests" and says nothing about coverage, combinations, or pairwise testing; choosing combinations by eye is exactly the failure this prevents. Builds the minimum t-wise (default pairwise) covering array from a parameter model plus optional constraints, and returns `columns` + `rows` that map 1:1 onto a table-driven test (test.each / t.Run table / pytest.mark.parametrize). Values come back in the JSON type they were declared with. Constraint-unreachable tuples are excluded after checking whether each partial tuple can extend to a valid complete test.',
    inputSchema: {
      type: 'object',
      properties: generateInputFields,
      required: ['model'],
    },
  },
  {
    name: 'pairwise_analyze',
    description:
      "USE BEFORE calling a test suite finished, whenever the code under test takes 3 or more independent parameters. Reports which parameter interactions an EXISTING (AI- or hand-written) suite never exercises, in the same coverage shape pairwise_generate returns: `coverage`, `stats`, `uncovered` as display strings (capped at 1000 entries), the authoritative `uncoveredCount`, `omittedUncovered`, plus `invalidTests` for rows that do not match the model. Reading the test file cannot answer this question; this tool can. Pass `constraints` when the model has them — tuples that cannot extend to a valid complete test are removed from the coverage universe, matching the generator's semantics.",
    inputSchema: {
      type: 'object',
      properties: {
        ...modelInputFields,
        tests: { ...testCasesSchema, description: 'Test cases to analyze.' },
      },
      required: ['model', 'tests'],
    },
  },
  {
    name: 'pairwise_extend',
    description:
      'USE when tests already exist and must be kept as they are. Appends the minimum extra rows needed to reach full t-wise coverage, preserving every existing row verbatim at the head of the suite. Returns `newRows` (just the additions, ready to append to the file) and `before` — the coverage diagnostics of the suite as it stands today — so no separate pairwise_analyze call is needed to explain why the additions exist.',
    inputSchema: {
      type: 'object',
      properties: {
        existing: {
          ...testCasesSchema,
          description: 'Test cases already written — will be preserved as-is.',
        },
        ...generateInputFields,
      },
      required: ['model', 'existing'],
    },
  },
  {
    name: 'pairwise_estimate',
    description:
      'Pre-flight sizing only: report parameter count and the raw t-tuple count WITHOUT generating anything. Worth a call when the model is large (roughly 8 or more parameters, or a parameter with many values) and a tuple explosion needs catching first. `estimatedTests` is a coarse heuristic, not a bound in either direction, and often well above what pairwise_generate produces — never report it as the suite size. For ordinary models skip this tool: pairwise_generate returns the real counts in `stats`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...modelInputFields,
        subModels: subModelsSchema,
      },
      required: ['model'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// --- Model normalization -------------------------------------------------

/** Build a structured INVALID_INPUT error, matching the engine's error shape. */
function invalidInput(message) {
  return Object.assign(new Error(message), { code: 'INVALID_INPUT' });
}

/** Convert the `model` map into the engine's `parameters` array. */
function parametersFromModel(model) {
  if (model === undefined) {
    throw invalidInput('Provide the parameter model as `model`.');
  }
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw invalidInput('`model` must be an object mapping parameter names to their values.');
  }
  const entries = Object.entries(model);
  if (entries.length === 0) {
    throw invalidInput('`model` must declare at least one parameter.');
  }
  return entries.map(([name, spec]) => {
    if (Array.isArray(spec)) {
      return { name, values: spec };
    }
    if (spec && typeof spec === 'object') {
      const { values = [], ...rest } = spec;
      return { name, values, ...rest };
    }
    throw invalidInput(
      `model.${name} must be an array of values or a { type, range } object, got ${typeof spec}.`,
    );
  });
}

// --- Value type restoration ---------------------------------------------

/**
 * Build a decoder that maps an engine-returned string back to the JSON type the
 * value was declared with. The engine works on stringified values, so a model
 * written with numbers or booleans would otherwise come back as `"1"` / `"true"`
 * and every caller would have to cast by hand.
 *
 * Boundary expansion invents values that were never declared (0/1/2/99/100/101
 * for an integer range), so a declared-type fallback covers what the lookup
 * table cannot. The lookup itself is unambiguous because the engine rejects a
 * parameter whose values collide once stringified (`1` alongside `"1"`).
 */
function buildDecoder(param) {
  const byString = new Map();
  const kinds = new Set();

  for (const entry of param.values ?? []) {
    const value = entry && typeof entry === 'object' ? entry.value : entry;
    kinds.add(typeof value);
    byString.set(String(value), value);
  }

  const numeric = param.type === 'integer' || param.type === 'float';
  const homogeneous = kinds.size === 1 ? [...kinds][0] : null;

  return (raw) => {
    if (typeof raw !== 'string') {
      return raw;
    }
    if (byString.has(raw)) {
      return byString.get(raw);
    }
    if (numeric || homogeneous === 'number') {
      const parsed = Number(raw);
      return Number.isNaN(parsed) ? raw : parsed;
    }
    if (homogeneous === 'boolean' && (raw === 'true' || raw === 'false')) {
      return raw === 'true';
    }
    return raw;
  };
}

function buildDecoders(parameters) {
  const decoders = {};
  for (const param of parameters) {
    decoders[param.name] = buildDecoder(param);
  }
  return decoders;
}

/**
 * Build a predicate telling whether an engine-returned value is invalid for
 * `param`: a declared value (or alias) marked `invalid`, or a boundary value the
 * expansion generated outside `range`. A declared value keeps its own flag even
 * outside the range, matching the engine.
 */
function buildInvalidCheck(param) {
  const declared = new Map();
  for (const entry of param.values ?? []) {
    const spec = entry && typeof entry === 'object' ? entry : { value: entry };
    for (const name of [spec.value, ...(spec.aliases ?? [])]) {
      declared.set(String(name), spec.invalid === true);
    }
  }
  const [min, max] = param.range ?? [];
  return (raw) => {
    const text = String(raw);
    if (declared.has(text)) {
      return declared.get(text);
    }
    return param.range !== undefined && (Number(text) < min || Number(text) > max);
  };
}

// --- Suite shape conversion ----------------------------------------------

/** Accept both { paramName: value } maps and positional rows on input. */
function toTestMaps(cases, columns, field) {
  if (!Array.isArray(cases)) {
    // Not our shape to validate — let the engine produce its own error.
    return cases;
  }
  return cases.map((entry, index) => {
    if (!Array.isArray(entry)) {
      return entry;
    }
    if (entry.length !== columns.length) {
      throw invalidInput(
        `${field}[${index}] has ${entry.length} values but the model has ${columns.length} parameters (${columns.join(', ')}).`,
      );
    }
    return Object.fromEntries(columns.map((name, i) => [name, entry[i]]));
  });
}

/** Render engine test maps as positional rows with their declared types restored. */
function toRows(cases, columns, decoders) {
  return (cases ?? []).map((testCase) => columns.map((name) => decoders[name](testCase[name])));
}

/** Uncovered diagnostics as their display strings, the only field a reader acts on. */
function toDisplays(uncovered) {
  return (uncovered ?? []).map((entry) => entry.display);
}

/**
 * Coverage fields shared by every tool result. An engine CoverageReport carries
 * the same numbers as a GenerateResult under different names, so analyze and
 * extend's `before` are mapped onto the generate shape here.
 */
function toCoverageFields(result) {
  return {
    coverage: result.coverage,
    strength: result.strength,
    stats: result.stats,
    uncovered: toDisplays(result.uncovered),
    uncoveredCount: result.uncoveredCount,
    omittedUncovered: result.omittedUncovered,
  };
}

/** Shape an engine CoverageReport for `testCount` analyzed rows. */
function toCoverageReport(report, testCount, strength) {
  return {
    ...toCoverageFields({
      coverage: report.coverageRatio,
      uncovered: report.uncovered,
      uncoveredCount: report.uncoveredCount,
      omittedUncovered: report.omittedUncovered,
      strength,
      stats: {
        totalTuples: report.totalTuples,
        coveredTuples: report.coveredTuples,
        testCount,
      },
    }),
    invalidTests: report.invalidTests,
  };
}

/**
 * Single-fault negative rows, each tagged with the parameter holding its one
 * invalid value so a test can assert that specific rejection.
 */
function toNegativeRows(cases, parameters, decoders) {
  const columns = parameters.map((param) => param.name);
  const checks = parameters.map(buildInvalidCheck);
  return cases.map((testCase) => ({
    invalid: columns.find((name, i) => checks[i](testCase[name])),
    row: columns.map((name) => decoders[name](testCase[name])),
  }));
}

/**
 * Shape a generate/extend result; `rowFields` carries the suite rows to return.
 * The engine's `stats.testCount` adds the negative rows in, while its tuple
 * counts describe the positive suite alone, so the count is restated here as
 * positive rows to keep every `stats` field about the same suite.
 */
function toSuitePayload(result, parameters, decoders, rowFields) {
  const payload = {
    columns: parameters.map((param) => param.name),
    ...rowFields,
    ...toCoverageFields({
      ...result,
      stats: { ...result.stats, testCount: result.tests?.length ?? 0 },
    }),
    warnings: result.warnings,
  };
  if (result.negativeTests?.length) {
    payload.negativeRows = toNegativeRows(result.negativeTests, parameters, decoders);
    const { coverageRatio, totalTuples, coveredTuples, omittedTuples } = result.negativeCoverage;
    payload.negativeCoverage = {
      coverage: coverageRatio,
      totalTuples,
      coveredTuples,
      omittedTuples,
    };
  }
  if (result.classCoverage) {
    const { classCoverageRatio, totalClassTuples, coveredClassTuples } = result.classCoverage;
    payload.classCoverage = {
      coverage: classCoverageRatio,
      totalTuples: totalClassTuples,
      coveredTuples: coveredClassTuples,
    };
  }
  return payload;
}

const isScalar = (value) => value === null || typeof value !== 'object';

/** An array of scalars, or an object whose fields are scalars or such arrays. */
function isFlat(value) {
  if (Array.isArray(value)) {
    return value.every(isScalar);
  }
  return Object.values(value).every(
    (field) => isScalar(field) || (Array.isArray(field) && field.every(isScalar)),
  );
}

/**
 * Serialize a tool result for the model reading it. Objects are indented, but an
 * array of scalars stays on one line and each flat row or entry of an array gets
 * one line, so a suite costs about one line per test instead of one per value.
 */
function formatJson(value, indent = '') {
  if (isScalar(value)) {
    return JSON.stringify(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      return JSON.stringify(value);
    }
    const items = value.map((item) =>
      isFlat(item) ? JSON.stringify(item) : formatJson(item, inner),
    );
    return `[\n${items.map((item) => inner + item).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length === 0) {
    return '{}';
  }
  const fields = entries.map(
    ([key, item]) => `${inner}${JSON.stringify(key)}: ${formatJson(item, inner)}`,
  );
  return `{\n${fields.join(',\n')}\n${indent}}`;
}

// --- Call dispatch ------------------------------------------------------

function toErrorPayload(err) {
  // CoverwiseError carries a structured `code` and an optional `detail`.
  const code = err && typeof err === 'object' && 'code' in err ? err.code : 'INVALID_INPUT';
  const payload = { code, message: err?.message ? String(err.message) : String(err) };
  if (err?.detail) {
    payload.detail = err.detail;
  }
  return payload;
}

/** Engine options for generate and extend, picked from the tool arguments by name. */
function toEngineOptions(args, parameters, columns) {
  const { constraints, strength, seed, weights, subModels, maxTests, requiredRows } = args;
  return {
    parameters,
    constraints,
    strength,
    seed,
    weights,
    subModels,
    maxTests,
    seeds:
      requiredRows === undefined ? undefined : toTestMaps(requiredRows, columns, 'requiredRows'),
  };
}

const toolNames = new Set(tools.map((tool) => tool.name));

function runTool(name, args) {
  if (!toolNames.has(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const parameters = parametersFromModel(args.model);
  const columns = parameters.map((param) => param.name);

  switch (name) {
    case 'pairwise_generate': {
      const decoders = buildDecoders(parameters);
      const result = generate(toEngineOptions(args, parameters, columns));
      return toSuitePayload(result, parameters, decoders, {
        rows: toRows(result.tests, columns, decoders),
      });
    }
    case 'pairwise_analyze': {
      const tests = toTestMaps(args.tests, columns, 'tests');
      const report = analyzeCoverage(parameters, tests, args.strength, args.constraints);
      return toCoverageReport(report, tests?.length ?? 0, args.strength ?? 2);
    }
    case 'pairwise_extend': {
      const decoders = buildDecoders(parameters);
      const existing = toTestMaps(args.existing, columns, 'existing');
      const result = extendTests(existing, toEngineOptions(args, parameters, columns));
      const kept = Array.isArray(existing) ? existing.length : 0;
      const payload = toSuitePayload(result, parameters, decoders, {
        newRows: toRows(result.tests.slice(kept), columns, decoders),
      });
      return { ...payload, before: analyzeExisting(parameters, existing, args) };
    }
    case 'pairwise_estimate': {
      const { constraints, strength, subModels } = args;
      return estimateModel({ parameters, constraints, strength, subModels });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Coverage of the suite before extension, folded into the extend result so the
 * caller does not need a second round trip to explain the additions. A failure
 * here must not sink the extension itself, so it degrades to an omitted field.
 */
function analyzeExisting(parameters, existing, args) {
  try {
    const report = analyzeCoverage(parameters, existing, args.strength, args.constraints);
    return toCoverageReport(report, existing.length, args.strength ?? 2);
  } catch {
    return undefined;
  }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (initError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: formatJson({
            code: 'INVALID_INPUT',
            message: `coverwise WASM init failed: ${initError?.message ?? initError}`,
          }),
        },
      ],
    };
  }

  const { name, arguments: args = {} } = req.params;
  try {
    return {
      content: [{ type: 'text', text: formatJson(runTool(name, args)) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: formatJson(toErrorPayload(err)) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
