---
name: coverwise
description: Combinatorial (pairwise / t-wise) coverage for tests. Use whenever you write, review, or extend tests for a function, endpoint, CLI, component, or config surface that takes 3 or more independent parameters — including when the request is only "write tests", "add test cases", or "improve the tests" and says nothing about coverage or combinations. Also use when asked about pairwise, t-wise, covering arrays, combinatorial testing, or a test matrix.
---

# coverwise — Combinatorial Coverage for Tests

This skill wraps the `coverwise` MCP server, which exposes four tools backed by a WASM pairwise / t-wise engine:

- `pairwise_generate` — build a minimal test suite from a parameter model + constraints
- `pairwise_analyze` — check an existing test suite for missing interactions
- `pairwise_extend` — add the minimum extra tests needed to reach 100% coverage
- `pairwise_estimate` — pre-flight sizing for a model that might be too wide

## When to reach for this

Whenever the system under test has **3 or more independent parameters with 2 or more values each**, build a parameter model and let the engine choose the combinations. A cartesian product of 4 parameters × 3 values = 81 tests; pairwise covers every 2-way interaction in ~9. Choosing a handful of plausible-looking combinations by hand is the failure mode these tools exist to prevent, and it is invisible in the finished test file — the suite looks thorough either way.

This applies to the ordinary request, not just the explicit one. "Write tests for `render(theme, density, locale, dir)`" is a combinatorial task even though it names no coverage concept.

Typical shapes: CLI flags, REST query params, feature flag matrices, form validation, state machines, build configuration matrices, component props.

## The recommended workflow

1. **Extract parameters** from the code or spec, and write them as a `model` map.
   - Enums and unions → list every variant
   - Booleans → `[true, false]`
   - Numeric ranges → declare `{"type": "integer", "range": [min, max]}` and let boundary values be injected; do not enumerate the range by hand
   - Nullable → add an explicit `null`-ish value only if null behavior matters
2. **Write constraints** for impossible combinations (see the DSL below). Fewer is better — each constraint shrinks the reachable space.
3. **Call the right tool**:
   - New suite → `pairwise_generate`
   - Reviewing or finishing an existing suite → `pairwise_analyze`
   - Filling gaps while keeping the current tests → `pairwise_extend`
4. **Verify** `coverage` is `1.0`. If not, report `uncoveredCount` as the authoritative total, every returned `uncovered` entry, and `omittedUncovered` when diagnostics were truncated. Constraint-unreachable tuples are removed from the coverage universe and never appear in `uncovered`.
5. **Translate to the target framework.** The result is `columns` (parameter names) plus `rows` (positional values, in their declared JSON types). That maps 1:1 onto a table-driven test — `test.each` in vitest/jest, `pytest.mark.parametrize`, a Go table `[]struct`. Emit the rows as the table and write one body that consumes them.

Skip `pairwise_estimate` for ordinary models: `pairwise_generate` already reports the same counts in `stats`. Reach for it only when the model is large (roughly 8+ parameters, or a parameter with many values) and a tuple explosion needs catching before it happens.

## Writing the model

The `model` map is the preferred input form: parameter name → values.

```json
{
  "model": {
    "theme": ["light", "dark", "hc"],
    "density": ["compact", "cozy"],
    "retries": { "type": "integer", "range": [0, 5] },
    "verbose": [true, false]
  }
}
```

Key order is column order: `columns` and positional rows follow the order the parameters are written in.

### Boundary value expansion

A numeric parameter declared with `type` (`"integer"` or `"float"`) and `range: [min, max]` expands to `min-1, min, min+1, max-1, max, max+1` (spaced by `step`, default `1.0`, for `"float"`) — the off-by-one neighbours that catch most boundary bugs. The two outside the range (`min-1`, `max+1`) are invalid: they come back in `negativeRows`, never in `rows`, so assert rejection for them. Any explicit `values` you list are kept alongside the generated boundaries with their own `invalid` flag. Prefer this over passing a long literal list.

### Equivalence classes

When several values are interchangeable for the behavior under test (every 4xx is "client error"), tag them with the same `class`. The result then carries a `classCoverage` block (`coverage`, `totalTuples`, `coveredTuples`) over class tuples, which lets you argue "all error categories are covered" without exhaustively testing every status code.

```json
{
  "model": {
    "status": [
      { "value": 400, "class": "client_error" },
      { "value": 404, "class": "client_error" },
      { "value": 500, "class": "server_error" },
      { "value": 200, "class": "ok" }
    ],
    "method": ["GET", "POST"]
  }
}
```

### Negative values and single-fault tests

Tag a value with `invalid: true` when it is supposed to make the system under test reject the input (an out-of-range quantity, a malformed token, an unsupported format).

```json
{ "model": { "qty": [1, 50, { "value": -1, "invalid": true }] } }
```

Invalid values are kept out of the positive suite. They come back in a separate `negativeRows` array, built single-fault: each row carries exactly one invalid value with every other parameter valid, so a failing test points at one cause. Each entry is `{ "invalid": "qty", "row": [-1, "json", "a"] }` — `invalid` names the parameter holding the fault, so the test can assert the rejection that parameter should produce. The result then also carries `negativeCoverage` (`coverage`, `totalTuples`, `coveredTuples`, `omittedTuples`).

Translate the two arrays differently: `rows` assert the success path, `negativeRows` assert the specific rejection (error code, exception, status). Never merge them into one loop that expects success.

## Reading the result

`pairwise_generate` returns:

```json
{
  "columns": ["os", "browser", "retries"],
  "rows": [["win", "chrome", 0], ["mac", "safari", 5]],
  "coverage": 1.0,
  "stats": { "totalTuples": 18, "coveredTuples": 18, "testCount": 6 },
  "uncovered": [],
  "uncoveredCount": 0,
  "omittedUncovered": 0,
  "warnings": []
}
```

Every tool reports coverage in this same shape: `coverage`, `strength`, `stats`, and `uncovered` as display strings such as `"os=linux, browser=safari"`. Every `stats` field describes the positive suite; `testCount` does not include `negativeRows`. When `maxTests` stops generation short, pass the returned `rows` to `pairwise_extend` to get the minimal set of additions.

Values come back in the JSON type they were declared with — `0`, not `"0"`; `true`, not `"true"` — so a row can be emitted into test code as-is.

`pairwise_extend` returns `newRows` in place of `rows`, plus `before`:

- `newRows` — only the appended rows, ready to add to the file. The existing rows are preserved verbatim ahead of them and are not echoed back.
- `before` — the coverage diagnostics of the suite as it stood. Use it to explain why the additions exist; a separate `pairwise_analyze` call is unnecessary.

An existing row that does not match the model is kept in the suite all the same, and `warnings` names the offending value (`value '9' is not declared by parameter a`). Report that row: it stays in the file, but it does not count toward coverage, so the additions were sized as if it were not there.

`pairwise_analyze` returns the same coverage fields plus `invalidTests`:

```json
{
  "coverage": 0.888,
  "strength": 2,
  "stats": { "totalTuples": 36, "coveredTuples": 32, "testCount": 7 },
  "uncovered": ["os=linux, browser=safari"],
  "uncoveredCount": 4,
  "omittedUncovered": 3,
  "invalidTests": []
}
```

Report the `uncovered` strings as they are — each is the shortest faithful description of what is missing. `uncovered` is capped at 1,000 diagnostic entries, so always report `uncoveredCount` as the authoritative total and `omittedUncovered` when it is non-zero. Report `invalidTests` separately; those rows were excluded from coverage accounting.

## Passing existing tests in

`tests` (analyze) and `existing` (extend) accept either form:

- `{"paramName": value}` maps — natural when reading tests out of a file
- positional rows in the model's parameter order — so the `rows` array from `pairwise_generate` can be passed straight back with no reshaping

## Constraint DSL — quick reference

Constraints are strings. Multiple are passed as an array and are AND-ed.

### Conditional

```
IF os = macOS THEN browser != IE
IF os = macOS THEN browser = Safari ELSE browser != Safari
```

`ELSE` is optional. Names and values are case-insensitive.

### Logical operators

```
IF os = Windows AND device = phone THEN browser = Edge
IF os = macOS OR os = iOS      THEN browser = Safari
IF NOT os = Linux              THEN arch IN {x64, arm64}
```

Precedence: `NOT` > `AND` > `OR`. Parenthesize to override:

```
IF (os = Windows OR os = Linux) AND device = desktop THEN browser != Safari
```

### Operators

- Equality: `=`, `!=`
- Relational (numeric): `<`, `<=`, `>`, `>=`
- Set membership: `IN {a, b, c}`
- Pattern: `LIKE chrome*` (`*` matches any substring)
- Parameter-to-parameter: `IF source = target THEN mode = copy`

### Unconditional

Drop the `IF` for constraints that always apply:

```
browser != IE
os IN {Windows, macOS, Linux}
```

### String values with spaces or special chars

Quote them:

```
IF region = "us-east-1" THEN provider = aws
```

## Constraint patterns (recipes)

| Intent | Pattern |
|---|---|
| Exclusion | `IF a = x THEN b != y` |
| Dependency | `IF feature = enabled THEN plan IN {pro, enterprise}` |
| Mutual implication | Two constraints: `IF os = iOS THEN browser = Safari` + `IF browser = Safari THEN os IN {iOS, macOS}` |
| Forbidden triple | `IF os = Windows AND browser = Chrome AND arch = arm64 THEN mode = compatibility` |
| Numeric bucket dependency | Bucket the number first (e.g. `age` → `[child, adult, senior]`), then `IF age = child THEN plan != business` |

## Anti-patterns (what AI gets wrong)

- **Picking combinations by hand.** The most common failure is never building a model at all — writing six test cases that look representative and stopping. Six hand-picked cases across four parameters typically leave a third of the pairs untouched, and nothing in the finished file shows it.
- **Too many constraints.** Each constraint subtracts from the reachable space. If coverage cannot reach 1.0, the first thing to check is whether constraints contradict each other.
- **Type mismatch.** `"1"` (string) and `1` (number) are the same token to the engine; declaring both in one parameter is rejected as a duplicate. Pick one type per parameter and be consistent.
- **Raw continuous ranges.** Don't pass `values: [0, 1, 2, ..., 100]`. Declare `type` + `range` and let boundary expansion inject the interesting values.
- **Regenerating instead of extending.** When the user has hand-written tests they want to keep, use `pairwise_extend`, not `pairwise_generate` — otherwise you throw their tests away.
- **Strength inflation.** Default to `strength: 2` (pairwise). Only bump to 3 when three-way interactions genuinely matter (security, money, critical state machines). Test count grows fast with strength.
- **Treating constraint-unreachable tuples as gaps.** With the same constraints supplied to every operation, tuples that cannot extend to a valid complete test are removed from the coverage universe. They do not appear in `uncovered`; every returned tuple is a real coverage gap.
- **Folding `negativeRows` into the positive suite.** Rows produced from `invalid: true` values belong in tests that assert rejection. Appending them to the positive loop turns a negative case into a false success expectation.
- **Ignoring invalid existing rows.** `pairwise_analyze` excludes malformed or out-of-model rows from coverage accounting and reports them in `invalidTests`. Surface these rows separately instead of counting them as coverage.

## Analyzing a constrained model

When the parameter model has constraints, **pass them to `pairwise_analyze` too** — not just to `pairwise_generate`. Without constraints, the analyzer cannot know that some tuples are impossible and will report them as `never covered`, polluting the "what's missing" list.

With constraints supplied, impossible tuples are **removed from the coverage universe entirely** — including partial tuples that do not directly violate a constraint but cannot be extended to any valid complete test. They do not appear in `stats.totalTuples`, `stats.coveredTuples`, or `uncovered`. This matches the generator's semantics, so analyzing a suite that `pairwise_generate` produced for the same model + constraints yields `coverage === 1.0`.

Rule of thumb: use the same `constraints` array across `pairwise_analyze` / `pairwise_generate` / `pairwise_extend` for the same model.

## Input validation and guarantees

- `strength` must be a positive integer and cannot exceed the usable model strength. Pairwise generation therefore needs at least two parameters.
- `seed` and `maxTests` must be unsigned 32-bit integers. Weights must be finite and positive, seed rows must contain exactly the model parameters, and sub-models must name valid parameters with a valid strength.
- All public surfaces return structured `INVALID_INPUT` errors for invalid options. Repeat the offending field and message instead of retrying with silently altered input.
- `pairwise_extend` uses strict mode: existing rows are preserved verbatim, and only the additions are returned, as `newRows`.

## Error codes

- `INVALID_INPUT` — malformed model/options, or a typo in a parameter value
- `CONSTRAINT_ERROR` — malformed constraint syntax or contradictory constraints. Fix syntax errors verbatim; ask the user to loosen contradictory constraints.
- `INSUFFICIENT_COVERAGE` — the `maxTests` cap was too tight. Raise it or drop the cap.
- `TUPLE_EXPLOSION` — strength × parameter count is too large. Lower strength or split into sub-models.

When a constraint error occurs, repeat back the failing constraint to the user; don't silently rewrite it.

## One-shot example

User: *"Write tests for `render(theme, density, locale, dir)` where theme ∈ {light, dark, hc}, density ∈ {compact, cozy}, locale ∈ {en, ja, ar}, dir ∈ {ltr, rtl}. Arabic must be RTL; everything else LTR."*

Call `pairwise_generate`:

```json
{
  "model": {
    "theme": ["light", "dark", "hc"],
    "density": ["compact", "cozy"],
    "locale": ["en", "ja", "ar"],
    "dir": ["ltr", "rtl"]
  },
  "constraints": [
    "IF locale = ar THEN dir = rtl",
    "IF locale IN {en, ja} THEN dir = ltr"
  ]
}
```

Then emit `columns` as the table header and `rows` as the table body of a single parametrized test.
