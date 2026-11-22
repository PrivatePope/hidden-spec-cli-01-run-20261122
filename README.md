[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/PrivatePope/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/PrivatePope/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One command-line tool that applies the edits AI models write, in all four
formats they use: unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON.
It finds the lines an edit names even when the model drifted their
whitespace or indentation, and changes every file or none.

Entry for the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) — $100, 10 places.

## Run

`node main.ts [options] [PATCH]`

`PATCH` is the path of the patch file, relative to the working directory;
when it is absent or `-`, the patch is read from standard input. The
working directory is the root of the tree the patch applies to. Node 22
and its standard library only; nothing is installed.

Options:

- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`. The default, `auto`, detects it.
- `--check` does everything but write: the same output and exit code,
  and no file is created, changed or deleted.
- `--strict` matches lines exactly, with no whitespace forgiveness.

## What it does

Each edit in the patch is applied in order to the tree as earlier edits
left it. Lines are matched at the first of three tiers where they occur:
exact, trailing whitespace ignored, then leading and trailing whitespace
ignored (with new lines re-indented to the file's own indentation).
Unified hunks take the occurrence nearest their stated line number, so
wrong line numbers still land in the right place. A failed edit is
reported and changes nothing; edits after it still run, so every failure
is reported; and when any edit failed, no file is written at all.

On success it prints one line per changed path (`A`, `D`, `M`, or
`R old -> new` for a move), then `ok: <n> files`. On failure it prints
one `error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`. See `SPEC.md` for the whole contract.
