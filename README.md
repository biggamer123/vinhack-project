# Blast Radius - Stages 1–3

A VS Code extension that shows, inline, how far a change to any function reaches -
and how dangerous that reach is. Everything through Stage 3 is **deterministic**:
tree-sitter parsing, lcov parsing, `git log`, set arithmetic. No AI calls anywhere.

## Stage 1 - call graph + inline badges

- Bundled `tree-sitter-javascript.wasm` grammar loaded on activation from [parsers/](parsers/).
- Scans `**/*.js`, excluding `node_modules`, `dist`, `build`, `out`, `.git`, `coverage`, `.next`, `vendor`.
- Extracts **named** functions: declarations, function/arrow expressions assigned to a
  name, object pairs, class methods and class fields. Anonymous callbacks are skipped.
- Graph keyed `"<file path>:<function name>"` (with `#<line>` on same-file name
  collisions), each node carrying `callers`/`callees` sets.
- Every `call_expression` is recorded (callee name, line, **argument count** - already
  stored for Stage 4's signature-mismatch detector) and resolved into edges.
- On save: re-parses only that file and rebuilds edges from the stored call-site table,
  so cross-file _incoming_ edges survive a single-file edit. Deletions are watched too.

**Callee resolution:** `foo()` and `a.b.foo()` both resolve on the bare name `foo` -
same-file match first, then any match in the graph (lowest id, so runs are stable).
Unresolved names (built-ins, library imports, dynamic dispatch) are dropped. Known
limitation: common names collide, so in a large repo generic methods like `push`/`get`
accumulate inflated fan-in. Import-aware resolution is a later refinement.

## Stage 2 - risk scoring

Four measured signals per function:

| signal     | source                                                         |
| ---------- | -------------------------------------------------------------- |
| fan-in     | the graph                                                      |
| coverage   | `coverage/lcov.info` DA records over the function's line range |
| churn      | commits touching that line range in the last 90 days           |
| bus factor | distinct author emails touching that line range, ever          |

Churn and bus factor come from **one** `git log -L <start>,<end>:<file>` call per
function (git follows the range backwards through edits), run in the background with
bounded concurrency, cached, and invalidated per file on save.

If no `lcov.info` exists, coverage falls back to a **proxy**: does the function's name
appear in a file under `test/`, `tests/`, `__tests__/` or `spec/`? The UI always labels
this as a proxy - it is never shown as a percentage, and never conflated with real data.

The formula lives in one commented function, [src/score.ts](src/score.ts):

```
score = fanIn*2 + (100 - coveragePct)/10 + churnCount - (busFactor > 1 ? 2 : 0)
```

Unknown coverage counts as 50%. Tiers: `<15` low, `15–30` medium, `30–50` high, `50+`
critical. The CodeLens shows `risk 50 · 18 callers · 0% covered · 4 changes/90d · bus
factor 1`; the hover spells the same thing out in plain language, including the
arithmetic.

## Stage 3 - the graph webview

Command **Blast Radius: Show Full Graph** (or click any CodeLens - the graph opens
focused on that function, and zooms to it).

- D3 force-directed layout, node radius scaled by fan-in, arrows for caller → callee.
- Node fill = risk tier, using Pokémon type colours: Grass `#78C850` low, Electric
  `#F8D030` medium, Fire `#EE8130` high, Fighting/Dark `#7C538C` critical.
- Pokédex/Game Boy chrome: Press Start 2P, cream `#F2E8CF` canvas, red `#DC0A2D`,
  blue `#3B4CCA`, yellow `#FFCB05`, hard `4px 4px 0 #000` pixel borders, Game Boy green
  HUD, CRT scanline overlay over the canvas.
- Side panel is a dex entry: function name as the "species", tier as a type badge,
  stat bars for callers / calls-out / coverage / churn / bus factor, the score
  arithmetic, a proxy-coverage warning when relevant, the caller and callee lists, and
  **OPEN IN EDITOR** which jumps the editor to the function.
- Selecting a node dims everything outside its blast radius. Tier chips, a name/path
  search, HIDE ORPHANS, FREEZE and RESET VIEW are in the toolbar.
- Node positions are preserved across data updates, so saving a file does not re-scatter
  the layout.

The page is [media/graph.html](media/graph.html) - inline `<style>` and `<script>`, D3
from cdnjs, no build step. It lives in its own file rather than a TypeScript template
literal purely so the D3 code's `${}` does not need escaping.

## Setup (first time, after cloning)

Needs **Node 18+**, **git**, and **VS Code 1.85+**.

```bash
git clone https://github.com/Advik-Gupta/blast-radius.git
cd blast-radius
npm run setup          # install deps, compile, restore the demo repo's git history
```

`npm run setup:demo` is the part worth knowing about: `demo/` is a repo-within-a-repo
whose 32 commits by 3 authors are what make churn and bus factor real. A parent clone
cannot carry a nested `.git`, so that history ships as `demo-history.bundle` and is
unpacked into `demo/.git` by that script. Skip it and the demo still runs, but every
function reports churn 0 and bus factor 0.

Then either press **F5** in VS Code to run it from source, or install it properly:

```bash
npm run package        # builds blast-radius-0.1.0.vsix
code --install-extension blast-radius-0.1.0.vsix
```

If `code` is not on your PATH: in VS Code run **Shell Command: Install 'code' command in
PATH** from the palette, or install the `.vsix` through the Extensions panel's `···`
menu → *Install from VSIX…*. On macOS the CLI also lives at
`/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`.

Installing does not affect already-open windows — **quit and reopen VS Code** afterwards.

Check it worked without opening the editor at all:

```bash
npm run check:risk     # expect: critical 1, high 1, medium 6, low 52
npm run preview        # opens the graph in a browser
```

## Features view

Write commit messages as `type: title` and the **FEATURES** tab shows the codebase
as features instead of commits:

```
feature: get users from db
bug fix: users list crashes on empty page
refactor(users): split the repository layer
```

- **Types:** `feature`/`feat`, `bug fix`/`fix`/`bugfix`, `hotfix`, `refactor`,
  `perf`, `security`, `test`, `docs`, `style`, `chore`. Case-insensitive. `type!:`
  marks a breaking change.
- **Grouping:** commits with the same title join one feature. Add a `(scope)` to
  group different titles under one name - `feature(posts): url slugs` and
  `feature(posts): save posts` both land in **posts**.
- **Each feature shows** who worked on it (and how much), the files its commits
  changed, every commit, and the **functions** it touched. Functions come from the
  per-function `git log -L` history, so a function is listed only if that feature's
  commits changed its lines - not merely because it shares a file.
- **BY PERSON** flips it: pick someone, see the features they worked on.
- **SHOW IN GRAPH** highlights a feature's functions on the call graph.
- Untagged commits are counted, not hidden, so you can see how much of the history
  follows the convention.

**Blast Radius: Write Tagged Commit Message** (also the tag button in the Source
Control title bar) walks you through type, title and optional scope, then fills the
commit message box. It never commits.

**Related tests.** The dex entry lists the test cases that mention the selected function
(an `it(...)`/`test(...)` block naming it) and opens them on click. They are found whether
or not an lcov report exists. Matching is by name, so a very generic function name can
pick up unrelated tests.

**Browser snapshots are served from localhost.** Open in Browser serves the page on a
random `127.0.0.1` port that stays up while you use it - reloading works - and closes
after 30 idle minutes, keeping at most five snapshots live. If a browser cannot be
opened automatically, the URL is offered to copy instead.

## Backups and the command log

For dire situations. Turn it on once per repository from the **BACKUPS** tab (or
**Blast Radius: Enable Backups**); it is never switched on silently.

**What it does**

- Snapshots the whole working tree - committed, staged, unstaged and new files that
  are not gitignored - onto a local branch, **`blastradiusbackups`**, every 10 minutes
  (`blastradius.backups.intervalMinutes`) and after every commit.
- Snapshots are written with git plumbing into a throwaway index. They never touch
  HEAD, your staging area or any file you are working on. A snapshot identical to the
  last one (same files, same HEAD) is skipped.
- Installs two hooks. Hooks that were already there are kept and still run first;
  turning backups off puts them back exactly as they were. Backups themselves are
  kept when you turn it off.

**Never pushed**

A `pre-push` hook guards every remote. A normal `git push` never includes the branch,
so the hook stays silent. If a push would include it - `git push --all`, `--mirror`,
naming it, or pushing it under another name - the hook refuses that push, pushes every
*other* ref itself (forced ones stay forced, non-forced rewrites are still rejected)
and prints what it did. Git then reports the original push as failed; that refers only
to the withheld branch.

Limits worth knowing: `git push --no-verify` skips all hooks, including this one. If
the repository sets `core.hooksPath` (husky and similar), the hooks live in a folder
that is usually committed, so Blast Radius does not write there and the BACKUPS tab
shows a warning with the two lines to add yourself.

**Getting back**

Pick a backup and copy a command:

1. **Preview** - `git diff --stat <backup>`; changes nothing.
2. **Restore** - puts every file from the backup back.
3. **Exact restore** - also removes files created after the backup (gitignored files
   are never touched).

Restore and exact restore first take a **pre-restore** backup and refuse to continue if
they cannot, so a restore can always be undone the same way. None of them move your
branch or rewrite history: the files come back, HEAD stays put, and you commit when you
are happy.

**The COMMANDS tab**

A newest-first timeline built from the reflog (every command that moved HEAD: commit,
reset, rebase, amend, checkout, merge, pull) and from git commands typed into VS Code
terminals, with exit codes. Destructive and history-rewriting commands are flagged, and
each links to the backup taken just before it. Commit entries link to their feature, and
features list the backups taken during their work.

Git does not record every command, so commands typed outside VS Code that do not move
HEAD - `git clean`, for instance - cannot appear.

## Context for LLMs

**LLM MD** turns what Blast Radius knows into Markdown you can hand an assistant
before it touches the code. Everything in it is measured - graph edges, git history,
risk scores and the source itself - never summarised or guessed.

**For a function** (the LLM MD button in the dex entry, or the toolbar): risk
metadata, callers and callees with locations, how far a change can reach through the
call graph, the features it belongs to, recent history, and its source code. The page
shows a quick version instantly; the extension then fills in the source.

**For a feature** (LLM MD in a feature's detail): its commits in the authors' own
words, who to ask, the files and functions it touched ranked by risk, the calls between
those functions, **what outside the feature calls into it** - the code an assistant
would otherwise break without knowing - what it depends on, its risks, the source of
every function, and the full history.

- **SAVE .MD** writes to `.blastradius/llm/features/` or `.blastradius/llm/functions/`
  and opens the file.
- **EXPORT ALL AS MD** in the FEATURES toolbar (or **Blast Radius: Export Feature Docs
  for LLMs**) writes one file per feature plus a linked `FEATURES.md` index.
- Source is capped at 150 lines per function and 2,000 per document so a document stays
  usable in a prompt; anything cut says exactly where the rest lives.
- Browser snapshots carry the feature documents with them, with **DOWNLOAD .MD** in
  place of save.

Commit `.blastradius/llm/` if you want teammates and agents to share the same context,
or add it to `.gitignore` if you would rather regenerate it locally. Documents reflect the
code at the moment they were generated - regenerate after significant changes.

## Run it

```bash
npm install && npm run compile
```

Press **F5** → **"Run Extension (demo repo)"**. A second window opens on [demo/](demo/).

Commands: _Show Full Graph_, **Open Graph in Browser**, _Re-index Workspace_, _Show Graph
Stats_, _Reload Coverage (lcov)_.

**Open Graph in Browser** (also the blue button in the panel's toolbar) writes a
self-contained snapshot to a temp file and opens it in your default browser - the same
page, full screen, for when the docked panel is too cramped. It is a snapshot: the
extension cannot push updates into a browser tab, so OPEN IN EDITOR is hidden there and
the header carries the capture time. Re-run the command after a re-index to refresh it. Settings: `blastradius.enableCodeLens`, `blastradius.maxGitFunctions` (default
800 - caps how many functions get a `git log -L` call on big repos).

## The demo repo

[demo/](demo/) is a small blog engine - 60 functions, 247 call sites, 12 source files -
with its **own git history** (24 commits, 3 authors, dated across the churn window) and a
real `coverage/lcov.info`. It is built so every tier appears for real, not by fiat:

| function                          | why                                                                   |
| --------------------------------- | --------------------------------------------------------------------- |
| `trace` (telemetry.js)            | 18 callers, 0% covered, 4 recent commits, bus factor 1 → **critical** |
| `recordChange` (audit.js)         | 11 callers, 0% covered, 3 commits → **high**                          |
| `ok`, `getPost`, `tokenize`       | moderate fan-in, no/low coverage → **medium**                         |
| `slugify`, `hasTitle`, `wrapFeed` | fully covered, stable, low fan-in → **low**                           |

## Checking it without the dev host

```bash
npm run check          # graph only: function/call-site counts, most-called functions
npm run check:risk     # full pipeline: score, tier, fan-in, coverage, churn, bus factor
npm run check:webview  # loads media/graph.html in jsdom and drives the interactions
npm run preview        # bakes real data into the page and opens it in a browser
```

All four accept a path, e.g. `node scripts/check-risk.js ~/some-repo`.

Verified: hand-checked fixture counts (including cross-file edges and the incremental
save path); 14 headless webview interaction checks; churn/bus-factor cross-checked
against `git log` on the demo repo; stress-tested on the TypeScript compiler sources
(27,747 functions, 125,985 call sites, ~3.4s). Unparseable files are logged and skipped.

## Not built yet

Stage 4 (diff-aware blast radius, signature-mismatch and stale-test detectors) and
Stage 5 (test generation, suggested reviewer, companion panel).
