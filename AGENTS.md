# Test preservation

- Do not edit, delete, rename, or add cases to an existing test file without explicit user approval.
- Apply the same rule to existing fixtures, snapshots, golden files, and expected-output files.
- Add new coverage in a new test file by default. New test files do not require separate approval when they are in scope.
- Treat every relevant existing test as a required behavior contract. Change production code to keep it passing.
- If an existing test is demonstrably wrong or obsolete, stop, show the evidence, and request approval before changing it.
- Never weaken, bypass, skip, or delete an existing test to make a change pass.
- Before concluding, run the relevant existing tests and report the exact commands and outcomes.
