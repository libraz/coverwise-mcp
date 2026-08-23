---
description: Generate a minimal pairwise test suite for a function or component from its parameters.
argument-hint: "[function-name-or-file]"
---

Generate a minimum-size pairwise (or t-wise) test matrix.

Target: $ARGUMENTS (a function name, file path, or free-form description of what to test).

Steps:

1. Locate the target code. Read it to understand inputs: parameters, enums, flags, config.
2. Build a `model` map (parameter name → values):
   - Enums and unions → list every variant
   - Booleans → `[true, false]`
   - Numeric ranges → `{"type": "integer", "range": [min, max]}` so boundary neighbours are injected; do NOT enumerate the range by hand
   - Interchangeable values (e.g. every 4xx is a client error) → tag with a shared `class` to get class-coverage reporting
   - Nullable inputs → add an explicit null value only if null behavior matters
3. Derive constraints from the code (invariants, guards, mutually exclusive flags). Use the DSL documented in the `coverwise` skill. Prefer fewer, sharper constraints.
4. Call `coverwise.pairwise_generate` with the model. Use `strength: 2` (pairwise) unless the user explicitly asks for higher. For a large model (roughly 8+ parameters, or a parameter with many values), call `coverwise.pairwise_estimate` first and adjust if `estimatedTests` looks unreasonable.
5. Verify `coverage === 1.0`. If not, report `uncoveredCount`, every returned `uncovered[].display`, and `omittedUncovered` when non-zero. Constraint-unreachable tuples are already removed from the coverage universe, so every returned tuple is a real problem.
6. Emit the suite as one table-driven test in the user's framework (vitest / jest / pytest / Go table test), matching the file's existing style: `columns` becomes the table header and `rows` the table body. Values arrive in their declared JSON types, so they can be written out as-is. If the model had `invalid` values, emit `negativeRows` as separate cases asserting rejection — never fold them into the positive loop.
7. Write the tests to the appropriate test file, or print them if the user hasn't specified a destination.

Follow the `coverwise` skill for constraint syntax, anti-patterns, and strength selection.
