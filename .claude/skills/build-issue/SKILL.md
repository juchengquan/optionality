---
name: build-issue
description: Build a GitHub issue of this repository from branch to merged-and-deployed — choose whether the main session or a background agent builds it, set up its worktree, brief the builder, gate it (make check, review, mutation checks), and clean up after the owner merges. Use when the owner says "run #N", "build #N", "run #A and #B in parallel", "check the merge conflicts" on stacked PRs, or "merged" / "deploy and check" for a PR built this way.
---

# Build an issue

The owner names an issue; it comes back as a PR the owner can merge without re-checking it. The owner
merges every PR and decides every deploy. Everything here serves that: what reaches the owner as
"ready" has passed the whole gate on exactly the commit they will merge.

## 1. Who builds it

**The main session** builds it when it is light:
- one area, a handful of files, no migration and no second backend;
- a rebase, a conflict, a merge clean-up, a deploy check;
- anything the owner is waiting on in the conversation.

**A background agent** builds it when:
- the owner asks for parallel work ("run #A and #B in parallel" — one agent each);
- it spans both backends, a migration, golden cases or door scenarios;
- it will run long and the owner wants the conversation free meanwhile.

**An issue with open forks** (its text says "to decide", or investigation could change the plan) is
built in two phases: the builder investigates and STOPS with a report and the forks, each with a
recommendation; the owner decides (AskUserQuestion, at most four questions); the decisions are
recorded as a comment on the issue; then the build goes on. #380 is the model.

**When light turns out heavy** — the fix reaches the sweep, the samples, the schema or the other
backend — stop, tell the owner what was found, and hand it to an agent.

Two issues can run in parallel when they touch different files. A sweeping rename or move runs
alone, or as a pure-rename commit first so a later rebase stays mechanical (#383).

## 2. The worktree

Never build in the live tree, `~/_repository/optionality`: Caddy serves its `frontend/dist` and the
API runs its TypeScript (see CLAUDE.md, and never pull or fast-forward it — only `make deploy` moves
it). Each build gets a worktree BESIDE the repository:

```sh
git fetch -q origin
git worktree add -q -b <type>/<slug> ../optionality-<short> origin/main
cd ../optionality-<short> && npm install --silent && uv sync --all-packages --locked -q
```

`<type>` is `feat`, `fix`, `refactor` or `docs`. Scratch files go in the job's tmp directory or inside
the worktree (deleted before committing), never `/tmp`.

## 3. The brief

The builder knows only what the brief says. Point it at the issue (`gh issue view N --comments`),
at CLAUDE.md and the ADRs that bear on it, and give it:
- the worktree path and branch, and that it works only there;
- any decisions already made, and what the parallel builder is touching, so it keeps clear;
- the practice below, and the hard constraints, verbatim:

> No requests to 127.0.0.1:31415 (at most GET, and prefer none); the live database only through
> `sqlite3 -readonly`. Never `pgrep -f`/`pkill` — wait on your own jobs by PID or file. Never
> `make deploy`, `make use` or `launchctl`. Never merge or push to main. Never echo `.env`.

**Practice the brief requires:** TDD; generated files only through `make cases` / `make scenarios`
/ `make build-ui` (never by hand); both backends in lockstep where the change reaches them; a
mutation check for every guard or rule the change adds (undo it, show which tests fail, restore);
`make check` on exactly the committed tree; `npm test --workspace frontend` three times in a row
(the jsdom suite has had load flakes); a DRAFT PR whose body says what each decision built, the
mutation results, and `Closes #N` (or `Part of #N`).

Commits end with the attribution lines the session gives; PR bodies end with the
"Generated with Claude Code" line. No bare `@name` anywhere on GitHub.

## 4. The gate, before "ready"

1. **Review**, for anything medium or large: a SECOND agent, given the PR and the issue — not the
   builder's account of it — asked for ranked confirmed findings with evidence. For a migration,
   it runs the migration on an online backup of the live database
   (`node backend/tools/backup/backup.ts <live db> <scratch copy>`, never `cp`) in BOTH backends and
   compares every row. Send the findings back to the builder; a finding that changes a decision
   goes to the owner first.
2. **Re-run it yourself** on the pushed head: `make check`, and the jsdom suite three times. A
   builder's "passes" is a claim; #326 failed for us where its builder said it passed.
3. `gh pr ready N`, then confirm `MERGEABLE CLEAN` (poll while it reads UNKNOWN).
4. Tell the owner: what it does, what was checked and by whom, and anything they will notice live.
   If two open PRs touch the same files, say which to merge first and why
   (`git merge-tree --write-tree --name-only origin/<a> origin/<b>`).

## 5. After "merged"

1. Confirm it, chained, before deleting anything — a squash merge makes the branch tip no evidence:
   ```sh
   m=$(gh pr view N --json state,mergeCommit -q '.state+" "+.mergeCommit.oid') && echo $m &&
   git merge-base --is-ancestor ${m#* } origin/main &&
   git worktree remove ../optionality-<short> && git branch -D <branch> &&
   git push -q origin --delete <branch>
   ```
   If the owner says "merged" and `state` is OPEN, it did not merge — usually a conflict. Say so
   and rebase it.
2. **Stacked or conflicting PRs:** `git rebase origin/main`, or `git rebase --onto origin/main
   <old base>` after the base was squash-merged. Resolve source conflicts by reading both sides;
   `frontend/dist` is never hand-merged — `make resolve-ui` (or `make build-ui`) and commit. Then
   the gate's step 2 again, push `--force-with-lease`, and note the rebase in the PR body.
3. Stop. No pull, no deploy, unless the owner asks.

## 6. "Deploy and check"

Only when the owner says so. From the live tree: `make deploy`, then show:
- `/health`: db, provider, last sweep ok, and `golden_cases` equal to `typescript/src/golden.ts`;
- the API's start time (`ps -o lstart= -p $(lsof -tiTCP:31415 -sTCP:LISTEN)`) and a fresh
  `data/optionality-ts.db.bak-<stamp>`;
- a migration: `pragma table_info` of what changed, every row survived, `pragma integrity_check`;
- the bundle on the real tailnet URL and its cache headers (`no-store` on the page, `immutable` on
  assets);
- the page itself, read-only (Playwright, every non-GET request aborted), at desk width and on the
  iPhone 13 profile: console errors, failed requests, horizontal overflow, and the screenshots read.

A change to live DATA (a row to correct, as with #380's 0.00 sample) is the owner's call each time:
take a named backup first (`…db.bak-pre-<what>-<stamp>`, kept for good), change exactly the rows
named, and show them after.
