import asyncio
import json
import subprocess

# Edit these before a run, or leave the defaults: HEAD_REF = the checked-out commit, and
# BASE_REF = None means merge-base with origin/develop, falling back to HEAD_REF^1 (the last
# merge) when the checkout is develop itself.
REPO = "fazedordecodigo/boto"
REPO_DIR = "/home/ubuntu/repos/boto"
HEAD_REF = "HEAD"
BASE_REF = None
DEFAULT_BRANCH = "origin/develop"


def git(*args):
    return subprocess.run(["git", "-C", REPO_DIR, *args], check=True, capture_output=True, text=True).stdout.strip()


HEAD = git("rev-parse", HEAD_REF)
if BASE_REF:
    BASE = git("rev-parse", BASE_REF)
else:
    BASE = git("merge-base", HEAD, DEFAULT_BRANCH)
    if BASE == HEAD:
        BASE = git("rev-parse", f"{HEAD}^1")
TARGET = f"the changes {BASE[:12]}..{HEAD[:12]} in https://github.com/{REPO}"


def changed_text_files():
    out = subprocess.run(
        ["git", "-C", REPO_DIR, "diff", "--numstat", "--no-renames", "--diff-filter=d", BASE, HEAD],
        check=True, capture_output=True, text=True,
    ).stdout
    files = []
    for line in out.splitlines():
        added, _deleted, path = line.split("\t", 2)
        if added != "-":
            files.append(path)
    return sorted(files)


SEVERITIES = ["critical", "high", "medium", "low", "info"]

FINDING = {
    "type": "object",
    "properties": {
        "severity": {"type": "string", "enum": SEVERITIES},
        "title": {"type": "string"},
        "file": {"type": "string"},
        "lines": {"type": "string"},
        "source": {"type": "string", "description": "CONTRIBUTING.md, DESIGN.md, or both, plus the section/rule"},
        "description": {"type": "string"},
        "suggestion": {"type": "string"},
    },
    "required": ["severity", "title", "file", "source", "description"],
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "file": {"type": "string"},
        "summary": {"type": "string"},
        "findings": {"type": "array", "items": FINDING},
    },
    "required": ["file", "summary", "findings"],
}

MERGED_ITEM = {
    "type": "object",
    "properties": {
        "severity": {"type": "string", "enum": SEVERITIES},
        "title": {"type": "string"},
        "files": {"type": "array", "items": {"type": "string"}, "description": "path[:lines] for every occurrence"},
        "source": {"type": "string"},
        "description": {"type": "string"},
        "suggestion": {"type": "string"},
    },
    "required": ["severity", "title", "files", "source", "description"],
}

MERGE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {"type": "array", "items": MERGED_ITEM},
        "markdown": {"type": "string"},
        "duplicates_removed": {"type": "integer"},
        "rejected_findings": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["items", "markdown", "duplicates_removed"],
}

SEVERITY_GUIDE = (
    "Severity scale: critical = security/secret leak, data loss, or a broken build/CI; "
    "high = clear violation of an explicit CONTRIBUTING.md rule or DESIGN.md 'must'/'never' rule that ships a real defect; "
    "medium = violation of a stated guideline or design-system rule with visible/maintainability impact; "
    "low = minor deviation or inconsistency; info = nit or optional suggestion."
)


def review_prompt(path):
    return f"""You are reviewing ONE file changed by {TARGET}.
Read-only task: do NOT edit files, commit, push, open PRs, or comment on GitHub.

Setup: in your clone of {REPO}, run `git fetch origin` and `git checkout {HEAD}` (detached is fine).

File under review: `{path}`
- Changes: `git diff {BASE} {HEAD} -- '{path}'` (it may be a newly added file).
- Review the CHANGED lines of this file, using the rest of the file and nearby code only as context.

Review criteria — ONLY these two documents, as they exist at {HEAD}:
1. `CONTRIBUTING.md` (repo root)
2. `DESIGN.md` (repo root; the Rio Negro design system)
Read both fully first. Every finding must cite the specific rule/section it violates (put it in `source`).
Do not report generic style opinions, issues unrelated to these documents, or problems that only exist in other files.
If the file is a vendored asset (license text, SVG icon) or a doc, still check it against whatever the two documents say
(e.g. design tokens, naming, fonts, brand assets, docs conventions); report nothing if nothing applies.
Verify each finding against the actual code before reporting it; no speculative findings.

{SEVERITY_GUIDE}

Structured output: `file` = "{path}", `summary` = one sentence, `findings` = list (empty if none). Each finding:
`severity`, `title` (short, specific), `file` = "{path}", `lines` (e.g. "120-134"), `source` (document + section/rule),
`description` (what is wrong and why it violates the rule), `suggestion` (concrete fix).
Write findings in Portuguese (pt-BR)."""


def merge_prompt(reviews, failed):
    payload = json.dumps(reviews, sort_keys=True, ensure_ascii=False, indent=1)
    return f"""You are consolidating per-file review results for {TARGET}
(commit {HEAD}, base {BASE}). Each reviewer checked one changed file against CONTRIBUTING.md and DESIGN.md.
Read-only task: do NOT edit files, commit, push, open PRs, or comment on GitHub.

Your job:
1. Merge all findings into ONE list with NO duplicates. Two findings are duplicates when they describe the same
   underlying problem/rule violation (even across different files or with different wording) — merge them into one
   item listing every affected `path:lines` in `files`, keep the clearest description and suggestion, and take the
   HIGHEST severity among them.
2. You may check the repo at {HEAD} (clone {REPO}, `git checkout {HEAD}`) to resolve conflicts between reviewers.
   Drop a finding only if it is clearly wrong (contradicted by the code or the documents); list each dropped one
   in `rejected_findings` as "path: title — reason". Do not invent new findings.
3. Sort by severity: critical, high, medium, low, info; within the same severity, more affected files first.
4. `markdown`: the final list in Portuguese (pt-BR), grouped by severity headings, each item numbered with title,
   affected files, source rule, description and suggestion. At the end, a short line with totals per severity.
   Also mention these files whose review failed (not reviewed): {json.dumps(failed, sort_keys=True)}.
5. `duplicates_removed`: number of input findings eliminated by merging.

Severity scale used by reviewers: {SEVERITY_GUIDE}

Per-file review results (JSON):
{payload}"""


async def main():
    files = changed_text_files()
    await register_workflow({
        "name": "review-contributing-design",
        "description": f"Per-file review of {TARGET} against CONTRIBUTING.md and DESIGN.md, merged into one deduplicated list sorted by severity",
        "product": REPO,
        "soft_time_limit_minutes": 15,
        "phases": [
            {"title": "review", "detail": "One reviewer per changed text file", "labels": files},
            {"title": "merge", "detail": "Deduplicate and sort all findings by severity", "count": 1,
             "soft_time_limit_minutes": 30},
        ],
    })
    log(f"Reviewing {len(files)} files in {BASE}..{HEAD}")
    if not files:
        log("No changed text files")
        return

    async def review(path):
        try:
            res = await agent(review_prompt(path), phase="review", schema=REVIEW_SCHEMA,
                              label=path, mode="lite", repos=[REPO])
            log(f"done {path}: {len(res.get('findings', []))} findings")
            return res
        except WorkflowAgentError as e:
            log(f"FAILED {path}: {e}")
            return None

    results = await parallel([lambda p=p: review(p) for p in files])
    reviews, failed = [], []
    for path, res in zip(files, results):
        if res is None:
            failed.append(path)
        else:
            res["file"] = path
            reviews.append(res)
    total = sum(len(r["findings"]) for r in reviews)
    log(f"Reviews: {len(reviews)} ok, {len(failed)} failed, {total} raw findings")

    if total == 0:
        log("No findings to merge")
        return

    merged = await agent(merge_prompt(reviews, failed), phase="merge", schema=MERGE_SCHEMA,
                         label="merge-dedupe-sort", repos=[REPO])
    log(f"Merged items: {len(merged['items'])}, duplicates removed: {merged['duplicates_removed']}")
    log("FINAL_MARKDOWN_BEGIN\n" + merged["markdown"] + "\nFINAL_MARKDOWN_END")


asyncio.run(main())
