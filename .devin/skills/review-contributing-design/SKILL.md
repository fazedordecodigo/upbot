---
name: review-contributing-design
description: Review every file changed in a boto branch, PR, or commit range against CONTRIBUTING.md and DESIGN.md with one reviewer per file, then merge the findings into one deduplicated list sorted by severity. Use when asked for a per-file guideline/design-system review of a set of changes.
---

# Per-file review against CONTRIBUTING.md and DESIGN.md

Runs `workflow.py` (next to this file) with `run_workflow`: one read-only `lite` child
session per changed text file, then one session that removes duplicates, drops findings
that are clearly wrong, and sorts by severity (critical → info). The final list is in
pt-BR, printed in the run output between `FINAL_MARKDOWN_BEGIN` and `FINAL_MARKDOWN_END`.

## Choose what to review

Reviewers check out `HEAD` from `origin`, so the commits must be pushed.

Constants at the top of `workflow.py`:

- `HEAD_REF` (default `"HEAD"`): the tip to review. Check out the branch first, or set a
  ref/SHA.
- `BASE_REF` (default `None`): `None` uses the merge-base with `origin/develop`. If the
  checkout is develop itself, it uses `HEAD^1` instead, which is the last merge.
- `REPO_DIR` (default `/home/ubuntu/repos/boto`): the local clone used to list the files.

Edit the constants in a copy of the file, not in the repo (for example
`cp workflow.py ~/workflows/review.py`). Then pass that path as `script_path`.

Deleted files and binary files (images, fonts) are skipped. Each changed text file gets one
reviewer. Tell the user how many files that is before starting a wide range.

## Run

1. `git -C <REPO_DIR> fetch origin`, then check out the target.
2. `run_workflow(workflow_name="review-contributing-design", script_path=<path to workflow.py>)`.
3. When it finishes, save the text between the `FINAL_MARKDOWN_*` markers to a `.md` file and
   attach it for the user. Spot-check one or two findings before reporting.
