# Blast Radius - UI design guide

The rules behind every screen in the extension's webview (`media/graph.html`). Follow them when
you add a tab, a card or a button, so the whole panel keeps looking like one device.

## 1. The idea: a Pokédex for your code

The panel is styled as a handheld Pokédex from the Game Boy era:

- a red device body (`--dex-red`)
- cream screens where the content sits
- a yellow control strip for the toolbars
- Game Boy green for status readouts
- a pixel font, black outlines and hard shadows everywhere

Every function is a "creature". Its risk tier is a Pokémon type, and the side panel is its
Dex entry.

Two principles sit on top of the look:

1. **Show structure, not prose.** Views draw what is in the code, git history or Docker files,
   and show the real lines. Never rewrite a file into plain-language paragraphs. The only
   generated text allowed is short labels, check names and commands.
2. **Every number explains itself.** A score is always shown next to the bars and the formula
   that produced it.

## 2. Colour

### Palette tokens

Use the CSS variables and never introduce a new hex for a role these already cover.

| Token | Hex | Used for |
| --- | --- | --- |
| `--dex-red` | `#DC0A2D` | Device body, header, table headers, window title bars, "hot" highlights |
| `--cream` | `#F2E8CF` | Screens: canvases, cards, buttons, inputs |
| `--yellow` | `#FFCB05` | Toolbars, hover rows, flags, scrollbar thumbs |
| `--gb-green` | `#9BBC0F` | Status readouts (HUD, summaries, "backups on") |
| `--blue` | `#3B4CCA` | Selected state, primary bars, links, SHAs |
| `--ink` | `#17140f` | Body text; also the background of code blocks |
| `--muted` | `#6b6355` | Secondary text: paths, meta lines, captions |
| `#000` | | Every outline and every shadow |
| `#fffdf6` | | Paper: list backgrounds, inner cards, form fields |

### Risk tiers (Pokémon types)

Tier colours come from `TIER_COLORS` in `src/score.ts`, and the webview mirrors them in
`TIER_COLOR`. Change both together.

| Tier | Type | Hex | Text on it |
| --- | --- | --- | --- |
| low | Grass | `#78C850` | ink |
| medium | Electric | `#F8D030` | ink |
| high | Fire | `#EE8130` | ink |
| critical | Dark | `#7C538C` | white |
| unused | Ghost | `#705898` | white |

Unused functions have a **negative** score and always use the Ghost colour with the
"UNUSED - NOTHING CALLS IT" wording. Keep them visually separate from the four risk tiers.

### Other semantic maps

Keep these maps the single source of truth for their meaning:

- **Commit types** (`TYPE_COLOR`):

  | Type | Hex |
  | --- | --- |
  | feature | `#78C850` |
  | bug fix | `#EE8130` |
  | hotfix | `#DC0A2D` |
  | refactor | `#3B4CCA` |
  | performance | `#F8D030` |
  | security | `#7C538C` |
  | test | `#9BBC0F` |
  | docs | `#c9bfa6` |
  | style | `#f4a6c0` |
  | chore | `#b8b0a0` |

- **Command risk** (`RISK_STYLE`):

  | Risk | Hex |
  | --- | --- |
  | destructive | `#DC0A2D` |
  | rewrites history | `#7C538C` |
  | remote | `#3B4CCA` |
  | moves HEAD | `#6b6355` |
  | safe | `#78C850` |

- **Backup triggers** (`TRIGGER_COLOR`):

  | Trigger | Hex |
  | --- | --- |
  | interval | `#3B4CCA` |
  | commit | `#78C850` |
  | manual | `#FFCB05` |
  | pre-restore | `#EE8130` |

- **Authors** (`AUTHOR_COLORS`): assigned in order of first appearance and stable for the
  session. One person gets one colour; identities are merged in `src/identity.ts`.
- **Docker services** (`KIND_COLOR`): the technology's own brand colour, for example Postgres
  `#336791` and Redis `#D82C20`.

Colour is never the only signal. Every tier, type or risk colour appears with a text label
(`FIRE / HIGH`, `DESTRUCTIVE`, `FEATURE 4`).

## 3. Type

- **Font:** `'Press Start 2P', ui-monospace, monospace`, loaded from Google Fonts (the CSP
  allows only `fonts.googleapis.com` and `fonts.gstatic.com`).
- **Sizes.** The pixel font is large for its point size, so keep to this scale:

  | Size | Use |
  | --- | --- |
  | 13px | The function name in a Dex entry |
  | 12px | App title (`h1`) |
  | 10px | Body default, tooltip heading, focused lineage chip |
  | 9px | Tabs, card titles, section headings |
  | 8px | Almost everything else: buttons, chips, rows, bars, flags |
  | 7-7.5px | Meta lines, tags, commit rows, field rows |
  | 6.5px | Only the tiniest labels (source paths on table cards, crate tags) |

- **Line height** is generous (1.7-2.0), because the pixel font is dense.
- **Labels are UPPERCASE**, like Game Boy menus: `HIDE ORPHANS`, `CALLS OUT`, `VIEW LINEAGE`.
  Function names, file paths, emails and commit subjects keep their real case.
- **Code, commands and file contents** use `ui-monospace, Menlo, monospace` at 11px, never the
  pixel font, so they stay readable and copyable.
- Long names truncate with an ellipsis in rows and chips, and wrap (`word-break`) in headings
  and paths.

## 4. Shape and depth

Everything is square, outlined and casts a hard shadow. There is no blur and no gradient
lighting.

- **No border radius.** The exceptions are "real objects": lamps and the lens (circles),
  window lights and barrels.
- **Borders are black and solid:**

  | Width | Use |
  | --- | --- |
  | 2px | Controls: buttons, inputs, chips, bars, swatches |
  | 3px | Cards, tabs, tooltips, table cards |
  | 4px | Structural dividers: header bottom, toolbar bottom, rails, modal window |

  Dashed black borders mean "grouping or annotation": formula dividers, schema groups, loose
  services.
- **Shadows are solid black, offset down-right, with no blur:**

  | Offset | Use |
  | --- | --- |
  | 2px 2px | Badges, small buttons |
  | 3px 3px | Buttons, chips, inputs |
  | 4px 4px | Cards and HUDs |
  | 5-6px | Floating things: tooltip, focused chip, ship |
  | 10px 10px, 60% black | Modal windows only |

- **Pressed state:** buttons move into their shadow on `:active`
  (`transform: translate(2px, 2px); box-shadow: 1px 1px 0 #000`).
- **Coloured left edge:** cards that belong to a category (features, backups, timeline entries)
  use `border-left-width: 9-10px` in the category colour.
- **Texture:** the graph canvas has faint scanlines, and the Docker ship and crates have plank
  stripes. Texture is decoration only; never put information in it.

## 5. Layout

```
┌ header (red): lens + lamps, title, sub-line ─────────────────────────┐
│ tab strip: cream tab = active, grey tab = inactive                   │
├ toolbar (yellow): search, filter chips, buttons ─────────────────────┤
│ view (cream screen)                          │ right rail (red, 330px)│
│  canvas / sheet / list                       │  cards stacked, 10px   │
│  HUD (green) bottom-left                     │                        │
└───────────────────────────────────────────────┴───────────────────────┘
```

- **One view per tab.** Each tab owns a `.view`, shown with `.on`. Tabs wrap onto a second line
  instead of scrolling.
- **Two-pane views** (features, backups, devops) use a fixed-width list on one side (250-470px)
  and a flexible detail pane, separated by a 4px black rule.
- **Spacing** is 6-12px between controls and 10-14px padding inside panes. Keep to multiples
  close to these; the look depends on tightness.
- **Scrollbars** are yellow thumbs with a black outline, 10px wide.
- **Modals** (lineage) look like a small browser window:
  - red title bar with three lights, a tab and square buttons
  - dark backdrop at 55%
  - maximum size `min(1000px, 96vw)` × `92vh`

## 6. Components

Reuse these classes before inventing new ones.

| Component | Class | Rules |
| --- | --- | --- |
| Button | `.btn` | Cream, 2px border, 3px shadow, 8px text. `.on` = blue with white text. `.wide` = full width. |
| Search field | `input.search` | Same frame as a button, placeholder `#8a8271`. |
| Filter chip | `.tierchip`, `.typechip` | Filled with its category colour. Clicking toggles it; off = 30-35% opacity, never hidden. |
| Card | `.card`, `.fsection`, `.llm-card` | Cream or paper background, 3px border, 4px shadow. `.cardhead` is a muted 8px caption. |
| List row | `.row`, `tbody tr` | Hover = yellow, selected = blue with white text. Always clickable. |
| Stat bar | `.statrow` + `.bar` | Grid of label, bar and value (92px / 1fr / 44px). The bar fill uses the colour of the thing measured. The value is always printed. |
| Badge / pill / tag | `.badge`, `.pill`, `.typetag`, `.trig`, `.riskbadge` | Uppercase, 2px border, filled with its semantic colour. |
| Flag | `.flag` | Yellow callout for caveats ("NO lcov.info FOUND", "BUS FACTOR 1"). Green variant for a positive note, purple for unused. |
| Warning | `.warnbox` | Fire-orange; only for things that can lose work. |
| Formula | `.formula` | Under a dashed divider: the exact arithmetic with real numbers. |
| HUD | `.hud`, `.dbhud` | Green readout pinned in a canvas corner: counts and what is on screen. |
| Code | `pre.code`, `.cmdbox` | Ink background, pale green text, line numbers in olive. Show the file's own lines. |
| Tooltip | `.tip` | 268px cream card, 5px shadow; short bars plus up to three action buttons. |
| Empty state | `.empty` | Muted text saying what is missing **and** how to get it (a command or a click). |

## 7. Graph marks

- **Nodes:** circles with a 2px black stroke, filled with the tier colour. The selected node
  has a 4px stroke.
- **Edges:** muted at 45% opacity. Edges on the selected path turn red (`.link.hot`) at 2.4px.
  Arrows point from caller to callee.
- **Labels:** 6.5px with a cream halo (`paint-order: stroke`) so they read over edges.
- **Focus:** everything outside the current focus drops to `.dim` (12% opacity) rather than
  disappearing, so context is kept.
- **Orphans** (no edges) are laid out apart from the connected graph and never overlap it.
  "HIDE ORPHANS" removes them from view.

## 8. Interaction rules

- **Clicking a function anywhere opens its definition beside the panel**, in the other editor
  column: from the graph, the list, lineage chips or the index table.
  - The editor opens as a preview and does not steal focus.
  - `OPEN IN EDITOR` does move focus.
  - In a browser snapshot there is no editor, so the entry shows a `SOURCE` card instead.
- **Selection is shared.** Selecting in one place (rail, table, graph) highlights the same item
  everywhere.
- **Filters dim or fade; they never silently drop data.** Counts in the HUD always say
  `SHOWING n / total`.
- **Sortable tables** show `▼` on the sorted column.
- **Expandable rows** (git history) put their detail in a paper-coloured row with a red left
  rule.
- **Destructive actions** (restoring a backup) show the exact commands first, with a
  `.warnbox`, and always take a safety backup before running.
- **Draggable things** (table cards, crates, palette items) use `cursor: grab` / `grabbing`,
  and have a "space out" or "fit view" button to recover from a mess.

## 9. Writing on screen

- **Labels:** short and uppercase. **Sentences:** plain and sentence case.
- **Say the fact, then the consequence:** `BUS FACTOR 1 - one person has ever touched these
  lines.`
- **Name uncertainty honestly:** a proxy is called a proxy (`PROXY: NAMED`), unknown is
  `NO DATA` or `?`, never a guessed number.
- **Use the same words everywhere.** The CodeLens, hover, Dex entry, LLM markdown and README
  all say "callers", "coverage", "churn 90d", "bus factor" and "unused".

## 10. Technical constraints

- **One file.** The webview is a single page, `media/graph.html`. Scripts need the nonce and
  may load only from `cdnjs.cloudflare.com` (D3).
- **Browser snapshots.** "Open in browser" snapshots render the same page with
  `standalone: true`, so every view must work without the extension host. Hide host-only
  buttons instead of letting them fail.
- **Safe data.** Escape all repository text with `esc()` before inserting it into HTML. Data
  embedded in snapshots goes through `jsonForScript`.
- **Checks.** When you add UI, add a check to `scripts/check-webview.js`, which drives the page
  in jsdom. Run `npm run preview` to see it in a real browser.
- **Theme.** The design is intentionally fixed and does not follow the VS Code theme. It always
  paints its own background and colours.

## 11. Known exceptions

- The legacy schema host (`.schema-host`) still uses a dark slate gradient. New schema UI
  should use the cream table-card viewer (`.dbwrap`, `.tablecard`) instead.
- Critical (Dark) and security/rewrite share `#7C538C`. They never appear in the same
  component, so this is accepted, but do not add a third meaning to that colour.
