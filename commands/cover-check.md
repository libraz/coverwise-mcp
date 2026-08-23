---
description: Analyze combinatorial coverage of the current / specified test file and report missing parameter interactions.
argument-hint: "[test-file-or-directory]"
---

Analyze the pairwise (or higher) coverage of an existing test suite.

Target: $ARGUMENTS (a path to a test file or directory, or empty to infer from context).

Steps:

1. Read the target test file(s). Identify the function or endpoint under test and the parameters it accepts.
2. Build the `model` map: for each parameter, the discrete values that appear in the tests AND any additional values that exist in the type / enum but are missing from them.
3. Derive any constraints that hold for the code under test, so impossible combinations are not reported as gaps.
4. Call `coverwise.pairwise_analyze` with:
   - `model`: the full parameter model, including values that are currently untested
   - `tests`: the test cases already present, as `{paramName: value}` maps or positional rows in model order
   - `constraints`: as derived above
   - `strength`: 2 unless the user specified otherwise
5. Report:
   - Current coverage ratio
   - The authoritative `uncoveredCount`, plus every returned tuple using its `display` string
   - `omittedUncovered` when non-zero (the diagnostic list is capped at 1,000 entries)
   - Every `invalidTests` entry separately; these rows were excluded from coverage accounting
   - The constraints used. Constraint-unreachable tuples are removed from the coverage universe, so every tuple returned in `uncovered` is a real miss
6. If there are real gaps, offer to run `/cover-extend` to generate the minimum additional tests.

Follow the guidance in the `coverwise` skill for the constraint DSL and common pitfalls.
