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
