# Worktree Stack Reviewer

Vibecoded with assistance from Calvin Yan and Samin Zachariah.

A VS Code extension for reviewing changes across git worktrees before they
become PRs. Each worktree is diffed against its GitHub stack parent (or a
fallback base), with editable diffs, inline review comments stored as JSON,
and an inbox that lets a coding agent act on those comments, mark them
resolved, and leave notes of its own on the change.

Built for a workflow where multiple branches are in flight at once — one
worktree per branch, stacked with `gh stack`
or the `gt` CLI built on the same state — and where
review feedback is consumed by [Claude Code](https://claude.com/claude-code)
running inside the worktree.

## What it does

The **Worktree Stack Reviewer** view in the activity bar shows every worktree in the
repository. Under each one:

- **Changed files**, diffed against the worktree's base. The base is the
  branch's parent in its stack when `.git/gh-stack` tracks it, otherwise the
  `fallbackBase` setting (default `origin/main`); the worktree's tooltip names
  it and says which of the two it came from. Files open as diffs with the
  base on the left and the working tree on the right — the right side is the
  real file, so you can edit during review. An added or deleted file exists on
  only one side, so it opens as a single editor instead: the working file for
  an addition, the base version read-only for a deletion.

  Each file carries a **viewed** checkbox. Ticking it records that you have
  read that change; folder rows show how many of their files are ticked, and a
  title-bar toggle hides the ticked ones. See [Viewed state](#viewed-state) for
  what makes a tick survive or clear.
- **Stack**, every unmerged branch in the worktree's stack (trunk excluded),
  each with its open PR when one exists (via the `gh` CLI) — a branch that
  hasn't been submitted yet still shows up. Actions: open the PR in the
  browser, copy its URL, check the worktree out to that branch, or check it
  out in the [review worktree](#the-review-worktree). A row is marked for
  wherever its branch is checked out: `★` for the worktree the row is being
  read from, `◉` for the [review worktree](#the-review-worktree), and `※` for
  any other worktree, whose directory the tooltip names. All three sit in front
  of the name.

  A branch that carries review comments is marked in front of those three, with
  a character per source: `¶` for inline review comments on its PR, `✎` for
  threads written in this extension. A branch with both gets both, and the
  tooltip says how many of each. PR comment counts are read in the background
  shortly after the tree renders, so `¶` can appear a moment after the row
  does.

  Each row leads with where the branch sits in its stack, `2/3` for the second
  branch up from trunk in a stack of three, then the PR number and title. A
  stack can also be given a [name](#stack-names), which then leads the
  worktree's own row.

  A worktree sitting on trunk has no section at all: every stack shares trunk,
  so it belongs to none of them in particular.

  Stacks are read straight from `.git/gh-stack` in the git common dir — the
  file `gh stack` and `gt` both write — so no CLI is run to build the section,
  and a write to that file (`gh stack add`, `gt track`, `gt sync` marking a PR
  merged) refreshes the view. A branch whose PR has merged drops out, and the
  branch above it sits on the nearest unmerged branch below, or trunk — where
  `gt restack` would move it. The worktree's own branch stays listed even
  after it merges, so its row doesn't vanish from under it.

  Each branch row shows its **source** line counts — what that branch's own
  commits change, with tests, docs and generated files taken out. Expanding the
  branch gives a **LOC** row with the full split into `src`, `test`, `doc`, and
  `gen` alongside a file count; empty buckets are left out, and the tooltip
  carries per-bucket file counts.

  A collapsed row shows only the first 30 characters of its PR title or branch
  name. VS Code drops a row's description before it truncates the label, so a
  long name would otherwise push the counts off the row; the full name is in
  the tooltip. Expanding the row restores it, since the LOC row underneath is
  then carrying the counts.

  The counts come from `gt loc --json`, so they read the same here as in
  `gt ls` and `gt loc`, and gt's rules decide which bucket a line falls in. gt
  measures a branch from just before its oldest commit that is on neither
  trunk (local or remote) nor a branch below it, so a stale local trunk or work
  squash-merged from below does not inflate the count. A file counts toward
  every bucket it has lines in, and a binary file toward its own kind with no
  lines.

  These are committed changes only, so every row in a stack means the same
  thing. With `includeUncommitted` on, a checked-out branch's changed-file list
  further down can show more than its counts do.

  Under the LOC row, a branch with an open PR carries its **description** —
  the PR body as GitHub holds it. The row reads the opening paragraph of the
  body's "Description" section when it has one, since our template puts
  headings and the Linear link above the prose; clicking opens the whole body
  rendered in the [review preview](#the-review-preview), as a read-only
  document named after the PR, where it can be commented on like any other
  markdown. Below the body, under a **Comments** heading, the document carries
  the PR's top-level conversation: every comment on the PR and every review
  that left a summary, oldest first, each headed with its author, verdict and
  date. Inline review comments are not among them. A comment's own headings are
  pushed below its entry's, so a bot's report reads as part of its comment. The
  body comes first and unchanged, so comments written on its lines stay put.
  Bodies arrive with the PR list the Stack section already fetches; the
  conversation costs one `gh pr view` when the document opens, and both are
  re-read on each PR refresh while the tab is open.

  **Review Pull Request…** — on a PR's branch row, its description row, and
  the title bar of an open description — opens the description with a review
  dialog over it: a markdown comment box and a choice of Comment, Approve or
  Request changes, posted through `gh pr review` as the `gh` user. A comment
  is required to comment or request changes and optional to approve.
  ⌘/Ctrl+Enter submits, Esc or a click outside closes, and the draft is kept
  until it posts. A refusal from GitHub (approving your own PR, say) shows in
  the dialog with the draft intact; a posted review appears in the
  description's conversation.

  The worktree's own PR also sits directly under the worktree, after the Stack
  section and above the changed files, as the virtual file `PR-<n>.md` — the
  same document, the same name its tab carries.

  Under those, a branch with review comments carries a **Comments** section —
  the same threads the worktree's own section lists, grouped by file, but
  reachable without checking the branch out anywhere. Clicking a thread opens
  the branch's own change (where it diverged from the branch it sits on, against
  its tip) with the thread expanded on the side it was written against: the
  right for a comment on the change, the left for one on a line the change
  removed. Neither side is a file on disk, so this works for a branch no
  worktree holds; a comment on a PR description opens in the
  [review preview](#the-review-preview) instead, since no diff between two
  branches shows it.

  Beside the LOC row, the branch lists its **patches** — the amend history of
  the branch's single commit, read from the `gt-version-history` (`vh`) script
  (see [Requirements](#requirements): nothing provides it yet) — with each
  version's date, action (amend/restack/…), push marker, and delta
  vs the previous version. A patch is marked for the comments left on it, with
  the same two characters its branch row uses: `¶` for inline PR review
  comments written against that commit, `✎` for review comments written here
  while it was the tip. The tooltip says how many of each.

  A comment records the branch tip it was written against, so a restack — which
  gives a patch a new sha without making it a new patch — leaves it where it
  was. Comments written before that was recorded, and any an agent adds to
  `comments.json` by hand, are dated back to the newest patch that existed when
  they were written; one older than every patch the reflog still holds counts
  towards the oldest. Comments on a PR description are left out, since no patch
  carries them.

  Clicking a version opens its diff against its own base; right-click to
  compare it with the previous version or any other version, or use "Compare
  Versions…" on the branch to pick both sides.
  Comparisons open in VS Code's multi-file diff editor and show the honest
  interdiff (the older patch re-applied onto the newer version's parent), not
  a raw two-commit diff that would fold in restacks. When no clean interdiff
  exists, the extension offers the direct commit diff instead.

  A compare can also be opened from a link, so an agent that has just
  committed a patch can point at exactly what changed since the previous one:

  ```
  vscode://naterarmstrong.worktree-stack-reviewer/compare?branch=<branch>&a=<older>&b=<newer>[&file=<path>]
  ```

  `a` and `b` are version numbers, shas, or `base`; shas are the stable
  choice, since version numbers shift when the reflog is truncated, and
  `gt-version-history <branch> --json` lists them. `file` narrows the compare
  to one worktree-relative path; a file the two versions agree on falls back
  to the whole compare. The branch need not be checked out anywhere. Links are
  clickable in the integrated terminal and in markdown previews; from outside
  VS Code the operating system hands them to whichever window claims the
  scheme. In Insiders the scheme is `vscode-insiders://`.

  Line counts do not wait on the work behind them: the row shows `…` until they
  arrive, so no git run sits on the critical path of the first paint. Expanding
  a branch does wait on its version listing, which the background pass below has
  usually already fetched.

  Line counts are read one branch at a time shortly after the tree renders, and
  are recounted when the branch tip or its parent's local or remote tip moves —
  an amend moves the first, a restack or fetch the others. A branch that already has counts keeps
  showing them while they are being re-checked rather than blanking back to a
  spinner.

  Version listings are fetched ahead of the click. Once the view has been
  quiet for two seconds — so the initial worktree and diff load is done — the
  stack's branches are read one at a time in the background, and expanding a
  branch then reads from cache. A listing is refetched when the branch tip
  moves, which is what an amend does. Expanding a branch the background pass
  is already reading joins that fetch rather than starting a second one.
- **Comments**, the inline review threads on the branch this worktree has
  checked out, grouped by file. Clicking one opens the file on disk; the copy
  and clear actions live here. Every branch in the stack has its own copy of
  this section under its row, which is where a branch nobody has checked out
  shows its comments.

A title-bar toggle switches between reviewing the **working tree** (committed
+ staged + unstaged + untracked) and **committed changes only**
(`base...HEAD`). The view description shows which mode is active, and the
right side of each diff follows the toggle.

### Which worktrees are listed

Every worktree in the repository, minus an agent session's own while it is
still on the branch named after it. A session names its worktree
`bridge-cse_<id>` and commits an empty marker on a branch called
`worktree-bridge-cse_<id>`, so that a later sweep for unused worktrees leaves
it alone; it moves off that branch as soon as it commits work of its own. A
worktree still on one has nothing to review, and its row reads as the id and
nothing else. Set `hideAgentWorktreesOnTheirOwnBranch` to `false` to list them
anyway.

Both halves of that have to hold, which is what keeps the rule off everything
else:

- **A worktree made by hand is never left out.** `wt switch -c` names a
  worktree after the branch it holds, so its directory and its branch say the
  same thing, and no branch it could be on carries the `worktree-` prefix its
  directory would need.
- **A worktree holding some other worktree's marker branch still shows.**
  Checking one out somewhere is a deliberate act, and the row is how you see
  what is on it.

A hidden worktree is only missing a row. It keeps its [name](#worktree-names)
and its [viewed marks](#viewed-state) — nothing is pruned on the strength of a
row not being drawn — and it can still be reached as a checkout target from any
branch row.

### Viewed state

A tick is recorded against the file's **patch id**, not against the content on
either side of the diff. The patch id is derived from the change itself — the
hunk bodies, with the blob shas and the `@@` line numbers left out — so
re-applying the same change onto a different base reproduces it.

That is what decides when a tick survives:

| What happened | Tick |
| --- | --- |
| Restack or rebase, change re-applies unaltered | **kept**, row marked `rebased since viewed` |
| Something lands above the change in the same file | **kept** |
| The change itself is amended | cleared |
| The edit is amended and then reverted | **kept** — a file remembers its last few patch ids |
| Switching the working-tree/committed-only toggle | **kept** |
| An untracked file is committed for the first time | cleared once |

The `rebased since viewed` marker comes from comparing the base blob against
the one recorded at the tick. It never clears the tick on its own — it reports
that the ground under a reviewed change moved, which unticking would tell you
much less clearly.

Ticks are scoped to the **branch**, like comments, so checking a branch out in
another worktree brings its review progress along. Marks for branches that no
longer exist locally are dropped by the same periodic prune that archives
comments; unlike comments they are not archived, since a tick only records that
someone read a diff that no longer exists.

Binary files have no patch to be stable about, so theirs is keyed on the blob
shas and a restack that rewrites them clears the tick. A file whose diff git
could not render carries no checkbox at all rather than one that would never
stay ticked.

### Stack names

A stack can be given a name, which is what the worktree's row in the tree then
reads instead of its branch name; the branch moves into the description, behind
its own `2/3`. The Stack section carries the name too, and every branch row is
numbered `position/height` against it. Names are local to this extension.

**Name This Stack…**, on a worktree row or the Stack section, opens a box
prefilled with the current name. Saving names every branch in the stack;
leaving the box empty removes the name, and the rows go back to numbering
alone.

Naming a stack also pins its membership. The branches the stack held when it
was named stay counted after they merge and their branches are deleted, so a
branch reading `4/6` still reads `4/6` next week rather than sliding down to
`2/4` as the stack lands. Branches added on top extend the height and are
recorded the next time the tree draws the stack. A stack is recognised by any
one branch it still shares with the stored list, which is what lets both of
those happen without the name being lost.

Numbering shows on its own for an unnamed stack of more than one branch. A
single branch is numbered only once a name has taken the row: `1/1` beside the
branch itself says nothing the row does not already show.

Names live in `stacks.json` in the **main** worktree's state directory — one
file for the repository, since a stack's branches are usually checked out
across several worktrees and the name has to read the same from all of them.

### Worktree names

A worktree can also be given a name of its own, which its rows read in place of
its stack's. The name says what the worktree is being used for, so it stays put
when a different branch is checked out there, two worktrees on the same stack
can be told apart, and a worktree sitting on trunk can carry one — there is no
stack to name from there.

**Name This Worktree…**, on a worktree row, opens a box prefilled with the
current name. Leaving the box empty removes the name, and the row falls back to
its stack's name, or to its branch when the stack has none.

When Claude Code sessions are running in that worktree, the command lists their
conversation titles first, and picking one fills the box with it — still
editable before it is saved. The title is copied at that moment rather than
followed, so renaming the conversation later leaves the worktree's name where it
was; run the command again to take the new title. A conversation that has never
been titled is left out of the list, since the name Claude derives for it from
the directory says less than the branch name it would replace.

The title comes from the conversation's `custom-title.json`, not from the `name`
in its session file. That `name` is a copy which only some sessions keep up to
date — one running through the remote-control bridge holds the name Claude
derived at startup however often the conversation is renamed afterwards — so it
is read only when a conversation has no title file.

A worktree's own name replaces its stack's wherever that name is drawn — the
worktree row, the Stack section and the branch tooltips beneath it. The stack's
name is still stored, and still names every other worktree on the stack that
has not been named itself.

Names live in `worktree-names.json` in the **main** worktree's state
directory, beside `stacks.json` and for the same reason. A name is dropped once its worktree is
gone, which keeps the throwaway worktrees an agent session creates from
accumulating there.

### The review worktree

A worktree whose directory is named `review` — the `reviewWorktreeName`
setting — is treated as a place to check branches out for reading rather than
writing. Every branch and PR row in the Stack section gains a **Check out in
review worktree** action, so a branch can be read, diffed, and commented on
without moving the worktree it is being written in. The review worktree is
marked with an eye icon and a `review` label in the tree, and is otherwise an
ordinary worktree: it gets its own base, changed files, and comments section.

Comments and viewed marks are keyed on the branch, so a review done here is
recorded against the branch and is still there when it is checked out
somewhere else.

Whichever branch the review worktree holds is marked `◉` on its Stack row,
where the `★` for a worktree's own branch goes. The mark shows in every stack
the branch appears in, so it is visible from the worktree the branch belongs
to as well as from the review worktree's own stack.

Git allows a branch in only one worktree at a time. Asking for a branch that
another worktree already has checked out names that worktree and stops —
review it there instead. The review worktree is the exception: checking its
branch out somewhere else offers to reset it first, and the checkout goes
ahead once the branch is free. Uncommitted changes in the review worktree
travel with the switch, so the confirmation says how many there are before
moving.

The setting takes a directory name, not a branch name: checking a branch out
changes the worktree's branch, and the directory name is what stays put. Set
it to an empty string to drop the action from the menu.

**Reset review worktree to the review branch**, on the review worktree's own
row, releases the branch it is holding without going through another branch's
checkout. It checks out the local branch named after the review worktree
(`review` by default). If the repository has no such branch, it is created on
trunk and checked out, which starts it with no commits of its own and leaves
the review worktree showing no changes. An existing branch is checked out
where it stands; the action never moves it. Trunk is the one the repository's stacks in
`.git/gh-stack` sit on, or
`fallbackBase` when the repository has no local trunk branch. The same reset
is what the checkout offers when a branch is wanted back from the review
worktree.

### File decorations

VS Code decorates any tree row it recognises as a file, and the red problem
badges it draws come from whichever language server claimed that path. With
several worktrees checked out at once, a server indexing one of them reports
errors against the others' copies of the same file, so those badges mark code
that is fine.

File rows therefore carry a private URI scheme by default, which leaves the
file-icon theme working — it reads the path — while the badge lookup, keyed on
the exact URI, finds nothing. Set `showFileDecorations` to `true` to get the
normal decorations back; that also restores the git status colours, which the
same switch suppresses.

### Review comments

Comments attach to lines, ranges, or whole files on either side of the diff —
commenting on the base side is how you annotate deleted lines. Threads
support replies, editing, resolution, and deletion.

Clicking a thread in a worktree's Comments section opens its file at the
commented line and expands the thread widget there. Resolved threads open the
same way: VS Code folds a thread into the gutter when it is resolved, and the
click undoes that rather than leaving the reader to find the icon.

Clicking the same thread under a **stack branch row** opens the branch's change
against the branch it sits on instead, with the thread on it. A thread shown
that way is moved rather than copied — a comment in two places at once is a
comment you answer twice — and it goes back to the file on disk when the diff
is closed, or when the thread is clicked in the worktree's own section.

Comments are scoped to the **branch**, not the worktree: checking a branch
out in a different worktree brings its comments along, and a branch with no
worktree at all still shows its comments under its stack row. Each one also
records the branch tip it was written against, which is what marks the
[patch](#what-it-does) it was left on.

### The review preview

Markdown files have a second preview — **Markdown Review Preview**, opened
from the comment icon in the editor title bar, "Open Review Preview to the
Side", or *Open With…* — where review comments live inside the rendered page:

- Selecting text raises a floating **💬 Comment** button; clicking it opens a
  composer card right under the selection, with the selected text quoted.
  `Cmd/Ctrl+Enter` submits, `Esc` cancels, and an unsent draft survives the
  tab being backgrounded.
- Every thread on the file is drawn between the blocks it annotates:
  unresolved threads as cards with their comments, a reply box, and a resolve
  button; resolved ones as a one-line chip that expands on click. The line
  label on a card opens the source editor at that line.
- The page tracks edits to the source document live, and thread changes made
  anywhere — the text editor, the tree, an agent resolution — appear as they
  happen.

It renders through the built-in preview's own engine (the
`markdown.api.render` command), so the output carries the same source map and
markdown-it plugins, and it links the built-in preview's stylesheets.

Typography aims at how GitHub renders the same markdown rather than at how the
built-in preview does: 16px on a 1.5 line height, text set in a 900px column
(`previewColumnWidth`, `0` for full width) rather than across the whole tab,
and inline code as a chip. If you have set `markdown.preview.fontSize` or
`markdown.preview.lineHeight` yourself, your values are used instead. The built-in preview itself cannot host any of this:
its webview belongs to the built-in markdown extension, whose only inbound
channel for another extension's UI is a context-menu click.

Images are exempt from the column. An image on its own line is set at its own
size, up to the width of the tab, and centred on the column: a screenshot
pasted into a description is usually wider than the text is set, and scaling
it down to the column costs the detail it was pasted in for. An image sharing
its line with text or with other images, such as a badge row, stays in the
column with what it belongs to.

That one channel is still put to work: in the **built-in** preview,
select text, right-click, and **Add Worktree Stack Reviewer Comment** opens the
review preview beside it with the composer already sitting on that selection.

However a comment is written, the thread is anchored to the source lines
behind the rendered selection — the preview source map (the `data-line`
attributes used for scroll sync) names the block, and the selected text
narrows it to the exact lines when it appears verbatim in the source. Inline
markup (bold, links) makes rendered text diverge from source; the comment
then covers the whole block. The stored thread is the same as one written in
the text editor, so replies, resolution, the Comments section, and the JSON
export all treat it identically.

A [PR description](#what-it-does) opens in this preview too, and comments work
there the same way. Since a description is not a file, its threads are stored
under the PR's name — `PR-142.md` — and belong to the PR's own branch rather
than to whichever worktree the description was opened from, so a comment
written while reading someone else's branch still lands on theirs. The thread
is stored beside that branch: in the store file of the worktree that has it
checked out, or in the opening worktree's when nothing does.

Everything else treats the thread as ordinary. It appears in the Comments
section grouped under `#142`, replies and resolution work, the JSON export
carries it (with no `inDiff`, since whether the diff touches a description is
not a question with an answer), and an agent can resolve it through the
resolutions inbox. Clicking its row in the tree opens the description and
scrolls to the thread. Anchors behave as they do in a file: the thread records
the lines it covered and their text, and that text is what re-finds them after
the description changes on GitHub. That check runs when the description is
opened as a source editor, and marks a thread drifted rather than pointing it
at lines it never covered.

What the review preview does not do (yet): render mermaid diagrams — the
mermaid extension draws client-side inside the built-in preview's webview, so
fenced diagrams appear here as code blocks — or scroll-sync against a source
editor. When a branch is
deleted, its comments are archived (never silently dropped) by a periodic
prune.

Storage is a plain JSON file, `comments.json`, in the worktree's
[state directory](#files-written) — by default `wt-review/` inside the
worktree's own git directory — deliberately readable by anything, in
particular by an agent session running in that worktree. "Copy Comments File
Path" gives its full path. "Copy Comments as
JSON" puts an export on the clipboard that includes the branch, base, and
changed-file context an agent needs to act on the feedback.

### The agent inbox

The extension watches `resolutions.json` in each worktree's state directory
and applies whatever an agent writes there. "Copy Resolutions Inbox Path"
gives an agent the path; with the default location, an agent in the worktree
can also find it as `"$(git rev-parse --git-dir)/wt-review/resolutions.json"`. The file holds a JSON array (or
`{ "entries": [...] }`) of entries of two shapes:

- **A resolution** names an existing thread by its `id` from the comments
  export and carries `resolved` and/or a `reply` noting what was done.
- **A note** has no `id`; it names a `file` (worktree-relative) and a `body`,
  and opens a new thread there — on `startLine`..`endLine`, or on the whole
  file when neither is given. This is how an agent describes what it changed
  and where. Notes attach to the file on disk on the branch the worktree has
  checked out; `author` defaults to `Claude`.

```json
[
  { "id": "m1x9k2a", "resolved": true, "reply": "Renamed as suggested." },
  { "file": "src/sync.ts", "startLine": 40, "endLine": 52,
    "body": "Retries now back off; the loop above is what changed." }
]
```

Notes are shown with the agent's avatar and a header reading **From Claude**
rather than **For Claude**, and a `note` icon in the tree, but otherwise behave
as any thread: reply to one, resolve it to fold it away once read, or delete
it. In the comments export each carries `"kind": "note"`.

Entries the extension cannot apply — an id that matches nothing, a note on a
file that is not in the worktree or on lines past its end — are written to
`resolutions.rejected.json` with a reason, rather than dropped.

## Requirements

- `git` on PATH — for checkouts, branch creation and fetches. Everything the
  extension reads goes through `wt-core` instead (see [The core](#the-core)).
- A Rust toolchain (`cargo`) where the extension is built. `install.sh` builds
  `wt-core` for the machine it runs on and packages it into the VSIX, so a
  VSIX built on a Mac won't run in a Linux devcontainer — build it there.
- A stack in `.git/gh-stack`, made with `gh stack`
  or the sibling `gt` CLI — optional; neither needs to be on PATH, since the
  file is read directly. A branch in no stack falls back to `fallbackBase`.
- [`gh`](https://cli.github.com/) on PATH and authenticated — optional; only
  needed for PR data in the Stack section (`showPullRequests`), the
  descriptions those rows carry, and the review comments that mark a patch or
  a branch.
- [`gt`](https://github.com/naterarmstrong/gh-stack-cli) — optional; only
  needed for the line counts on stack branches (`gt loc --json`). Resolved on
  PATH, then as `~/.cargo/bin/gt`; override with `gtCommand`.
- `gt-version-history` — optional; only needed for the version listings and
  comparisons. **Nothing provides it yet.** These features need a tool that
  constructs the version history of a branch's patch — each amend and restack
  of its single commit, with the interdiffs between them — and answers
  `<branch> --json` and the compare calls in the shape `src/versionHistory.ts`
  reads. Until one exists, a branch's patch list reports the command as not
  found. Resolved on PATH, then as `scripts/gt-version-history` under the
  workspace repo; override with `versionHistoryCommand`.
- Claude Code — optional; only needed to offer conversation titles as worktree
  names. Which conversations are running in a worktree comes from
  `sessions/*.json` under `CLAUDE_CONFIG_DIR`, falling back to `~/.claude`, and
  what each is called from `projects/*/*/custom-title.json` beside it. A session
  counts only while the process that recorded it is still running.

## Install

```bash
./install.sh
```

Compiles the extension, builds `core/` with `cargo build --release` and copies
it to `bin/wt-core`, packages, and installs into the local VS Code server, then
reload the window. Where there is no server it installs into desktop VS Code
instead, through `code` on PATH or the CLI inside
`/Applications/Visual Studio Code.app`. In a devcontainer the extension does not survive a container
rebuild (it lives under `~/.vscode-server`, which is not on a persisted
volume), so re-run the script after rebuilding.

For development: `npm run watch` and the **Run Extension** launch config in
`.vscode/launch.json`.

## Tests

```bash
npm test          # both tiers
npm run test:unit # Vitest, no VS Code
npm run test:e2e  # a real VS Code, driven headlessly
```

Both tiers build their own repositories — a main worktree on `main`, a
`feature` worktree one commit ahead, and a worktree named `review` — from
`test/fixtures/repo.ts`. Every run gets a fresh one under the system temp
directory and removes it afterwards. Nothing runs against the repository you
are working in.

### Unit tier (`test/unit`)

Vitest over the modules that hold the git plumbing and the stores, exercised
against real repositories rather than mocked git output: worktree listing,
changed files, patch ids, line-count buckets, and the comment, viewed, and
stack-name stores. A global setup builds `core/` (debug) first, and
`coreParity.test.ts` puts a worktree through renames, deletions, staged and
unstaged edits, mode changes, binary and untracked files and checks the core's
answer against the `git` CLI's. `vscode` only exists inside the extension host, so `vitest.config.mts`
resolves it to `test/stubs/vscode.ts`, which covers the log channel and
settings — all these modules ask of it. The suite runs in about half a second,
which is what makes it the tier to iterate in.

### End-to-end tier (`test/e2e`)

`@vscode/test-electron` downloads VS Code, opens the fixture repository in it,
and loads the extension from source. The suite runs inside the extension host
with the real API, and drives the extension the way a user does — through
commands. It covers activation, the contributed commands, and the export path
end to end, from the tree provider's worktree enumeration through the comment
store to the clipboard.

Prerequisites, beyond what the extension itself needs:

```bash
sudo apt-get install -y xvfb xauth libgtk-3-0 libnss3 libasound2
```

The runner starts its own `Xvfb` when `DISPLAY` is unset, and points VS Code
at short temporary directories for its user data — its IPC socket lives there,
and unix socket paths cap out at 107 characters, which a path under this
project exceeds. `WT_KEEP_FIXTURE=1` leaves the fixture repositories in place
and prints where they are.

**What this tier cannot do.** VS Code refuses to open modal dialogs while
tests are running and rejects the call instead. Every flow that confirms first
— the checkouts and the review reset — can therefore be driven up to its
confirmation and no further. Those tests assert that the confirmation is
asked, that it names the right branches, and that nothing moved; the git work
behind it is covered by the unit tier. Stubbing the dialog from the test file
does not help: the suite gets its own instance of the `vscode` module, so an
assignment there is invisible to the extension.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `worktreeReview.fallbackBase` | `origin/main` | Diff base when the branch is in no stack in `.git/gh-stack`. |
| `worktreeReview.useStackParent` | `true` | Resolve each worktree's base from its parent in `.git/gh-stack`. |
| `worktreeReview.includeUncommitted` | `true` | Review the working tree rather than committed changes only. Toggled from the view title bar. |
| `worktreeReview.hideViewed` | `false` | Keep files marked viewed out of the list. Toggled from the view title bar; the marks are unaffected. |
| `worktreeReview.showFileDecorations` | `false` | Let VS Code draw problem badges and git status colours on file rows. See [File decorations](#file-decorations). |
| `worktreeReview.layout` | `tree` | Changed files as a nested tree or a flat list. |
| `worktreeReview.showPullRequests` | `true` | Show the Stack section (PR data requires `gh`). |
| `worktreeReview.hideAgentWorktreesOnTheirOwnBranch` | `true` | Leave out an agent session's worktree while it is still on the branch named after it. See [Which worktrees are listed](#which-worktrees-are-listed). |
| `worktreeReview.reviewWorktreeName` | `review` | Directory name of the worktree branches can be checked out into for review, and the name of the branch it resets to. See [The review worktree](#the-review-worktree). |
| `worktreeReview.versionHistoryCommand` | `gt-version-history` | Command for version listings/compares; bare names resolve on PATH, then `scripts/` in the workspace repo. |
| `worktreeReview.stateDirectory` | empty | Where review state is kept: empty for each worktree's git directory, or a path relative to each worktree. See [Files written](#files-written). |
| `worktreeReview.gtCommand` | `gt` | Command for stack branches' line counts; a bare name resolves on PATH, then `~/.cargo/bin/`. |
| `worktreeReview.pruneIntervalHours` | `6` | How often to archive comments from deleted branches; `0` disables the timer. |
| `worktreeReview.previewColumnWidth` | `900` | How wide the review preview sets its text, in pixels; `0` runs the full width of the tab. |

## The core

The extension's git reads — worktrees, changed files and their patches, line
counts, merge bases, file contents at a ref, attributes, status — are answered
by `wt-core`, a Rust binary in `core/` built on
[gix](https://github.com/GitoxideLabs/gitoxide). The extension starts it once
and keeps it running, sending one line of JSON per request over stdin and
reading answers back by id; requests run concurrently. That replaces the one
`git` process per question the extension used to start, which is where most
of a refresh's time went, and keeps the object database mapped between
refreshes.

A worktree's uncommitted state is diffed the same way as a commit: the core
builds a tree from HEAD, the index's changes and the files on disk (run
through the repository's clean filters, as `git diff` reads them), writing it
only to an in-memory overlay of the object database, then diffs the two trees
with git's rename defaults. It writes the `-U0` patch text git would, and the
extension hashes that into patch ids exactly as before.

Two places can differ from git, both harmlessly:

- In a large rewrite where several minimal diffs exist, gix can line hunks up
  differently from git. The counts are the same; the file's patch id is not, so
  a tick on such a file clears once after upgrading.
- Abbreviated blob ids can be a character shorter than the ones git wrote with
  `--numstat --patch`. A viewed tick compares base blobs by prefix, so marks
  written before the core took over still match.

The binary is found as `WT_CORE_BIN`, or else the newest of `bin/wt-core` and
the release and debug builds under `core/target/`. Checkouts, branch creation
and fetches still run `git`, whose safety checks around moving a worktree are
the point; PR data still comes from `gh`.

## Timing

The "Worktree Stack Reviewer" output channel reports how long each user-visible wait
took — building the root list, fetching PRs from `gh`, listing a worktree's
changed files, listing a branch's versions, and running a version compare.

Every external process and every core request that takes 250ms or more is
reported too. Core requests read `<ms> core <method> <args>`; for processes:

```
   958ms git ls-files --others --exclude-standard (wait 16ms, run 942ms, 12 ours, load 4.0)
   302ms git rev-parse --quiet --verify refs/heads/main (wait 302ms, run 0ms, 1 ours, load 0.4)
```

`wait` is the gap before the process started, `run` is the command's own work,
`ours` is how many of this extension's child processes were running at the same
time, and `load` is the machine's one-minute load average.

Together they separate causes that a total on its own cannot. A high `wait`
means the extension host was too busy to start the process. A high `run` with a
high `ours` means the extension's own fan-out is competing for the disk — the
same command is much faster run alone. A high `run` with a high `load` but low
`ours` means something else on the machine is competing. High `run` with both
low is a command that is simply expensive.

That difference matters most on a repository whose git directory lives on a
Docker bind mount from the host, where concurrent git processes slow each other
down far more than they would on a container-native disk.

Setting the channel's log level to Trace (the gear in the Output panel) reports
every process this way rather than only the slow ones.

## Files written

All in each worktree's **state directory**. By default that is `wt-review/`
inside the worktree's own git directory — `.git/wt-review/` for the main
checkout, `.git/worktrees/<name>/wt-review/` for a linked one — where git never
sees it, so nothing has to be ignored and nothing can be committed by
accident. The `stateDirectory` setting moves it to a path relative to each
worktree instead (which then needs ignoring). `stacks.json` and
`worktree-names.json` describe the repository rather than one worktree, so
they are written only in the main worktree's.

| File | Purpose |
| --- | --- |
| `comments.json` | Review threads for branches reviewed in this worktree. |
| `stacks.json` | Stack names and their pinned branch membership (main worktree only). |
| `worktree-names.json` | The name given to each worktree (main worktree only). |
| `viewed.json` | Which files have been marked viewed, and at which patch ids. |
| `comments.archive.json` | Threads whose branch no longer exists locally. |
| `resolutions.json` | Inbox the extension watches for agent-written resolutions and notes; consumed and deleted on pickup. |
| `resolutions.rejected.json` | Inbox entries the extension could not apply, each with a reason. |
