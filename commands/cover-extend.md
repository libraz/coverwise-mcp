---
description: Extend an existing test suite with the minimum additional tests needed to reach full combinatorial coverage.
argument-hint: "[test-file]"
---

Add the minimum new tests required to bring an existing suite to 100% pairwise (or t-wise) coverage, keeping all current tests untouched.

Target: $ARGUMENTS (path to the test file to extend).

Steps:

1. Read the target test file. Extract every existing test case. Ask the user if the extraction is ambiguous.
2. Build the full `model` map, including values not yet used in the existing tests. See the `coverwise` skill for parameter modeling guidance.
3. Derive any necessary constraints from the code under test.
4. Call `coverwise.pairwise_extend` with:
   - `existing`: the extracted test cases (`{paramName: value}` maps, or positional rows in model order)
   - `model` / `constraints` / `strength`: the model
5. Report the gaps from the returned `before` block — that is the coverage of the suite as it stands, and it explains why each addition exists. No separate analyze call is needed.
6. Append `newRows` to the file, matching its existing style and framework. Values arrive in their declared JSON types, so they can be written out as-is. Existing rows are preserved verbatim at the head of `rows`; verify that prefix still matches what the file contains.
7. Verify `coverage === 1.0`. If coverage is incomplete, report `uncoveredCount`, every returned `uncovered[].display`, and `omittedUncovered` when non-zero. Constraint-unreachable tuples are already removed from the coverage universe.

Do NOT rewrite, reorder, or delete existing tests — only append. If the user's existing tests have drifted from the parameter model (e.g. they use a value that no longer exists), stop and ask rather than silently "fixing" them.
