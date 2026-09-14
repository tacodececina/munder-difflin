# Authoring a custom office theme

## Built-in office: procedural tech floor (2026-09-13)

The built-in `office` now uses a dedicated 48×36 composition and one generated
atlas. The custom PNG bundle format below is unchanged. The other four map
files and `tools/mapgen/office-legacy-handpainted.tmj` are untouched.

- `scene/office/techOfficeArt.ts` draws entire furniture silhouettes into RGBA
  buffers, then slices them into 16px cells. It imports `setPx`, `shades`, and
  `mix` from `tileArt.ts`, using `TILE_PALETTES['office-tech']`. The old `office`
  palette remains available to the isometric prototype.
- `scene/office/officeLayout.ts` supplies seats, coffee destinations, errands,
  anchors and zones to both the map generator and `OFFICE_THEME`.
- `tools/gen-tech-office.cjs` places named furniture groups: a facing island,
  shared bench, L desks, standing desks, staggered operations consoles,
  briefing table, rack bay and café. Each seat adds only the required monitor
  block, not a repeated furniture pod.
- `tools/mapgen/validate-tech-office.cjs` checks all eight engine contracts
  before the generator writes anything. It also checks complete monitor
  blocks, atlas references, reachable destinations and visual overlap.

The two north-side island seats retain **365/366/381/382** at their original
logical positions `(seat.x, seat.y−2)`. Their spawn objects carry an integer
`monitorOffsetY: 3`: `deskVisuals.ts` translates the displayed block south and
selects separately drawn rear casing tiles, preserving the NW light direction.
`TiledMapRenderer`, `DeskScreen`, cup, shelf and task-note placement use that
same offset. The rear cup goes on the free surface to the right of the casing.
The north neighbor remains walkable and the south neighbor blocked, so the
existing facing logic turns the avatar toward its desk. Unannotated maps use
their original placement and monitor tiles.

Reproduce and inspect:

```sh
node tools/gen-tech-office.cjs --check
node tools/gen-tech-office.cjs
python tools/mapgen/render_map.py src/renderer/src/assets/maps/office.tmj tools/mapgen/office-tech-preview.png
```

The Python rasterizer calls `export-tech-preview.cjs` to obtain the **same RGBA
atlas and monitor offsets as Pixi**. It does not reimplement the artwork. Add
`--labels` for collision/spawn/zone annotations. These are static map previews:
agents, live clocks, interactive task boards, cups and other runtime overlays
are not included. The large screen's diagram/uptime and the whiteboard are
decorative content, not connections to live infrastructure metrics.

[Final static preview](../tools/mapgen/office-tech-preview.png) ·
[Collision and spawn overlay](../tools/mapgen/office-tech-validation.png)

Verification in this workspace: typecheck passes; 116 tests pass across tile
art, collision, theme bundles, the new office tests, projections/isometric art
and renderer sandbox security. Generator/validator coverage: 96.89% lines,
96.88% branches, 100% functions. This is coverage of those two CJS modules,
not a claim of 96% coverage of the whole application. Artwork has deterministic
buffer, palette, opacity and pixel-exact atlas reassembly tests; Pixi is also
instantiated to verify OFF/ON rear monitor frames and positions.

The standard test runner cannot spawn workers here (`spawn EPERM`); the same
tests run with Node 24's `--test-isolation=none`. `npm run build` is also blocked
at esbuild process creation, before bundling. Full Electron validation remains
pending. There is no lint script/config in the repository; JS/Python syntax
checks and `git diff --check` passed. No dependencies were added.

```sh
npm run typecheck
npm run build
node --test --test-isolation=none --experimental-test-coverage --test-coverage-include=tools/gen-tech-office.cjs --test-coverage-include=tools/mapgen/validate-tech-office.cjs --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 test/tech-office.test.cjs test/tile-art.test.cjs test/tiled-collision.test.cjs test/theme-bundle-validator.test.cjs test/iso-tile-art.test.cjs test/office-projection.test.cjs test/renderer-sandbox.test.cjs
```

The pixel office's map, seating, coffee economy and props are all data —
a `ThemeConfig` (see
[`src/renderer/src/scene/office/themeRegistry.ts`](../src/renderer/src/scene/office/themeRegistry.ts)) —
rather than anything hard-coded into the renderer. Settings → Office Theme →
**Import theme…** lets you point the app at a folder on disk containing your
own map and it will validate and load it, no rebuild required.

This is infrastructure for *your own* re-skins, and it's also how the built-in
TV-show themes got made. Friends, Brooklyn Nine-Nine and Silicon Valley
(`built: true` in the theme picker) each got their own `.tmj` floor plan but
still *reuse the office tileset's gids* — Pam's license-clean art for each show
hasn't landed, so their desks/walls/props are visually the office's, just
re-anchored to a new layout. Game of Thrones and Hogwarts (`built: false`) are
a step further behind: they don't even have their own map yet, because unlike
those three, no stone/castle/torch tile exists in *any* loaded atlas to build
one from — see ["Game of Thrones and Hogwarts — what a real bundle
needs"](#game-of-thrones-and-hogwarts--what-a-real-bundle-needs) below for
exactly what's missing. A custom bundle is how you build an equivalent of any
of this yourself today, art included.

## Bundle format

A theme bundle is a **folder**:

```
my-theme/
  theme.json     ← the manifest (required)
  map.tmj        ← Tiled JSON, referenced by theme.json's "mapFile"
  tileset.png    ← one PNG per tileset entry in theme.json
  extra.png
```

`theme.json` may inline the map instead of referencing a file, by setting
`mapRaw` (the Tiled JSON as a string) instead of `mapFile` — useful for a
single-file bundle, though a separate `.tmj` is easier to edit in Tiled itself.

### `theme.json`

```jsonc
{
  "schemaVersion": 1,
  "label": "My Custom Office",          // shown in the theme picker
  "mapFile": "map.tmj",                 // or: "mapRaw": "{...tiled json as a string...}"

  "tilesets": [
    // "embedded": true means "use the .tmj's OWN tileset metadata for this
    // entry's firstgid/dimensions" — still needs "file" for the actual PNG.
    // Use this for the tileset your map editor treats as tileset #1.
    { "file": "tileset.png", "embedded": true },

    // A second (or later) atlas painted at higher gids needs its full
    // metadata spelled out — firstgid MUST NOT overlap the previous
    // tileset's gid range (firstgid_2 >= firstgid_1 + tilecount_1).
    {
      "file": "extra.png",
      "firstgid": 513,
      "image": "extra",
      "imagewidth": 256, "imageheight": 512,
      "tilewidth": 16, "tileheight": 16,
      "columns": 16, "tilecount": 512
    }
  ],

  // Desk-claim order. Seat 0 (first entry) is the "god"/CEO desk.
  // EVERY name here must exist as an object in the map's "spawn-points"
  // object layer (see below) — the importer checks this and tells you
  // exactly which name is missing.
  "primarySeatNames": ["desk-ceo", "pc-1", "pc-2", "pc-3"],

  // Paired café table seats, in order. Same existence rule as above.
  "cafeSeatNames": ["cafe-seat-1", "cafe-seat-2"],

  // Standing spots at the coffee machine / vending machine.
  "cafeStands": [
    ["cafe-stand-coffee", "coffee"],
    ["cafe-stand-vending", "vending"]
  ],

  // Fixed tiles for the coffee economy: sideboard (mug rack) → machine →
  // sink → back to the sideboard. trayStand/machineStand/sinkStand are
  // WHERE a character stands, so they must be walkable tiles (not on a
  // desk/wall/furniture tile marked blocked in the collision layer).
  // trayTile/sinkTile are just where the mug art is drawn and are not
  // required to be walkable (they're typically the counter itself).
  "coffee": {
    "trayTile":     { "x": 5, "y": 4 },
    "trayStand":    { "x": 5, "y": 5 },
    "machineStand": { "x": 6, "y": 5 },
    "sinkTile":     { "x": 7, "y": 4 },
    "sinkStand":    { "x": 7, "y": 5 },
    "maxCups": 4
  },

  // Wall props, each on a tile of YOUR map. Three are clickable (calendar →
  // Triggers tab, boards → Tasks tab, clock → Closing Time, askBoard →
  // Ask Me tab); worldClock (live CN/MX time) and coffeeSteam are decoration.
  // These are drawn ON TOP of a tile, not stand points — none of them is
  // required to be walkable.
  //
  // Only "calendar", "boards" and "clock" are REQUIRED. Everything below them
  // was added after bundles started shipping, so a manifest that omits one
  // still imports — the validator fills it in (worldClock → clock's tile,
  // askBoard → boards' tile, coffeeSteam → 3 rows above coffee.machineStand,
  // the three board stands → boards + (2,1)/(3,1)/(6,1), which is where
  // office.tmj puts them). Those defaults keep an old bundle loading; they
  // are not good placements on your map. Author all nine.
  "anchors": {
    "calendar":    { "x": 1, "y": 1 },
    "boards":      { "x": 1, "y": 3 },
    "clock":       { "x": 8, "y": 1 },
    // A second, non-interactive wall clock. Give it its own stretch of wall,
    // clear of "clock" and "calendar", or the two props overlap.
    "worldClock":  { "x": 6, "y": 1 },
    // The ASK ME pinboard. Drawn like "boards" (30px wide, centered on the
    // tile's wall run), so give it a wall, not open floor.
    "askBoard":    { "x": 4, "y": 3 },
    // The coffee machine's TOP tile — brewing steam puffs upward out of it.
    // NOT where a character stands: that is coffee.machineStand. In every
    // built-in theme's counter this sits 3 rows above machineStand.
    "coffeeSteam": { "x": 6, "y": 2 },

    // The three floor tiles an agent walks to in order to WORK the boards:
    // pin a new card, take one off, file a finished one on the archive table.
    // Unlike every other anchor these are walk destinations, so all three
    // MUST be walkable tiles standing in front of "boards" — an agent that
    // cannot reach one never arrives and the card silently never moves. The
    // validator does not check them (it cannot fail an old bundle over tiles
    // it never chose), so this one is on you.
    "boardPinStand":     { "x": 3, "y": 4 },
    "boardTakeStand":    { "x": 4, "y": 4 },
    "boardArchiveStand": { "x": 7, "y": 4 }
  },

  // Idle errands (plant watering, smoking break, window gazing, the water
  // dispenser, ...). "stand" must be a walkable tile; "fx" is where the
  // ambient animation (droplet, smoke, wind streak, ...) plays and is not
  // checked for walkability. "kind" must be one of: water, window,
  // dispenser, fridge, shelf, bin, smoke. "facing": up/down/left/right.
  // "godOnly": true restricts an errand to the CEO/god agent.
  "errandSpots": [
    { "kind": "water", "stand": { "x": 3, "y": 3 }, "facing": "down", "fx": { "x": 3, "y": 4 }, "duration": 4.5 }
  ],

  // Desk-monitor overlay gids. "offTopLeftGid" is the top-left tile of the
  // OFF monitor block as painted on the map; "onGids" are the matching ON
  // tiles as [gid, dx, dy] relative to that block's top-left, overlaid while
  // the desk's agent is seated. Every gid must fall inside the combined gid
  // range of the "tilesets" array above.
  "monitor": {
    "offTopLeftGid": 365,
    "onGids": [[367, 0, 0], [368, 1, 0], [383, 0, 1], [384, 1, 1]]
  },

  // Hex colors ("#rrggbb" or "rrggbb", case-insensitive).
  "palette": {
    "background": "#1a1320",
    "noteColors": { "todo": "#f2df8a", "doing": "#9ecbf0", "blocked": "#f0a3a3", "done": "#a8e0b0" }
  }
}
```

There is **no `cast` field**. A custom theme always uses the app's built-in
15-person roster plus any characters made with the in-app character builder
(Settings → agent picker → "+ create character") — exactly like the
placeholder Brooklyn Nine-Nine theme reuses the office cast today. Authoring
a whole new likeness set is out of scope for a theme bundle; swap the *map*,
keep the *people*.

### The map (`.tmj`) — what layers the engine looks for

The engine (`TiledMapRenderer`) looks for these layers **by exact name**.
None are strictly required to exist (a missing tile layer just renders
nothing there; a missing `collision` layer means everything is walkable), but
`spawn-points` is required in practice — every seat name in `theme.json` has
to resolve to something in it.

| Layer name          | Type          | Purpose                                                              |
|----------------------|---------------|-----------------------------------------------------------------------|
| `floor`              | tile layer    | Ground tiles, drawn first.                                            |
| `walls`              | tile layer    | Wall tiles, drawn above `floor`.                                      |
| `furniture-below`    | tile layer    | Furniture drawn below characters (rugs, floor props).                 |
| `furniture-above`    | tile layer    | Furniture drawn above characters (tall shelves, plants).               |
| `collision`          | tile layer    | Any non-empty tile here is **blocked**. Empty/absent = walkable.       |
| `spawn-points`       | object layer  | Named points — objects' `x`/`y` (pixels) become a tile coordinate.    |
| `zones`              | object layer  | Named rectangles (not currently used by any bundle-validated field).  |

Spawn-point names starting with `desk-`, `pc-`, `warroom-` or `entrance` are
automatically forced walkable even if the collision layer marks that tile
blocked (the desk/chair art usually IS the "wall" there) — you don't need to
carve a hole in your collision layer under a desk.

## What gets validated, and the exact error you'll see

Clicking **Import theme…** never renders anything unvalidated. In order:

1. **`theme.json` parses and has every required key**, correctly shaped
   (e.g. `"palette.background": "#1a1320"` must actually be a hex color).
   *Example error:* `theme.json is missing a non-empty "label" (the display name shown in the theme picker).`

2. **Every named seat exists** as an object in the map's `spawn-points`
   layer — checked for `primarySeatNames`, `cafeSeatNames`, and the seat name
   half of each `cafeStands` pair.
   *Example error:* `Seat 'pc-3' (from "primarySeatNames") does not exist as a spawn point in the map.`

3. **Coffee/errand stand tiles are walkable** against the `collision` layer
   (reusing the exact same walkability rule the renderer itself uses — see
   `tiledCollision.ts` — not a re-implementation that could quietly diverge).
   *Example error:* `coffee.machineStand tile (6, 20) is not walkable — it is blocked in the map's collision layer.`

4. **Tileset metadata is internally coherent** — no `firstgid` overlapping a
   previous tileset's gid range, `columns × tilewidth` must equal the
   declared `imagewidth`, and the rows implied by `tilecount ÷ columns` must
   fit the declared `imageheight`. The `monitor` gids are checked against the
   combined gid range too.
   *Example error:* `tilesets[1] ("extra.png") columns (16) x tilewidth (16) = 256, but imagewidth is 100.`

Every failure is reported as a full list (fix everything, re-import once) —
not "stop at the first problem."

## A minimal example that passes validation

[`test/fixtures/theme-bundle-valid/`](../test/fixtures/theme-bundle-valid/)
is a real, minimal bundle (10×8 tiles, a walled border, one desk row and one
café row) that passes every check above — the same fixture the validator's
own test suite (`test/theme-bundle-validator.test.cjs`) runs against. It has
no real tileset PNG (the single tile it references is never actually drawn
in the test), so copy it as a starting skeleton and drop in your own art +
a real Tiled-authored map rather than importing it as-is.

## Game of Thrones and Hogwarts — what a real bundle needs

`got` and `hogwarts` are registered `ThemeId`s
([`themeRegistry.ts`](../src/renderer/src/scene/office/themeRegistry.ts) exports
`GOT_THEME` / `HOGWARTS_THEME`), and the theme picker lists both cards, but
both stay `built: false` — on purpose, not by omission. Their `ThemeConfig`s
are explicit *placeholders*: every field except `id` and `palette` is copied
byte-for-byte from `OFFICE_THEME`, so picking either from the switcher renders
the ordinary office floor rather than crashing or showing a blank scene. That
is a functional stand-in, not a Red Keep or a Great Hall. This section is the
brief a future artist (human or an AI session with real image-generation
capability) needs to actually finish them, without having to read the engine
source first.

### Why these two are harder than Friends/B99/Silicon Valley

Those three built themes each got a bespoke `.tmj` (new floor plan, new desk
layout) while still painting it with the *existing* `office-tileset.png` /
`a5-office-floors-walls.png` / `interiors.png` gids — an office desk stamp
reads as "an office desk" whether it sits in a bullpen, a hacker hostel, or a
sitcom apartment. That trick doesn't work here: a stone throne room or a
castle great hall painted with beige cubicle-carpet and monitor-desk tiles
reads as *wrong*, not as a stylistic choice — which is exactly the confusing,
bug-looking result this project has been careful to avoid. Genuinely new tile
art is required before either theme can flip to `built: true`.

### What to draw (new tileset PNG(s), 16×16 tiles, matching `office-tileset.png`'s grid convention)

**Game of Thrones — the Red Keep throne room:**
- Stone floor + stone wall tiles (plain, and a couple of variants/cracks for visual rhythm)
- Arrow-slit windows (replaces the office's glass-pane window tiles)
- Wall torches / braziers (animated flicker is a nice-to-have, not required — the engine's errand "fx" system, see below, already knows how to play a looping animation at a tile without touching this atlas)
- The Iron Throne (a large, multi-tile prop for the `desk-ceo` seat, the same way the office renders a CEO desk)
- A long council table + benches (replaces the `pc-*` desk row)
- House banners / sigils as wall decoration (furniture-above layer)
- A hearth, an ale barrel, a root-cellar door, a weapon rack, an ash bucket (see the errand-prop table below)

**Hogwarts — the Great Hall / a common room:**
- Castle stone floor + wall tiles, with tall gothic windows
- Floating candles (furniture-above, drawn over the tables — a nice callback to the actual scene)
- The House tables (replaces the `pc-*` desk row) and a raised staff table (`desk-ceo`)
- Portraits (wall decoration, furniture-above)
- A fireplace, a pumpkin-juice urn, a potions cabinet, a bookshelf, a parchment-scrap bin (see below)

Follow the existing tileset conventions documented above (`tilewidth`/
`tileheight`: 16, `columns × tilewidth == imagewidth`, etc.) — a new atlas
here is authored exactly like a custom bundle's non-embedded tileset entry
(see `theme.json`'s `"tilesets"` array above), just wired into
`GOT_THEME.tilesets` / `HOGWARTS_THEME.tilesets` directly instead of going
through the bundle importer.

### The map: author a real `.tmj` in Tiled, same layer contract as any other theme

Use the same layer names and rules already documented above (`floor`,
`walls`, `furniture-below`, `furniture-above`, `collision`, `spawn-points`,
`zones`). `office.tmj` is 34×22 tiles — not a hard requirement, but a
reasonable size to start from. The `spawn-points` object layer needs, at
minimum, one name per seat GOT_THEME/HOGWARTS_THEME will actually use; the
simplest path is to keep reusing `OFFICE_THEME`'s own seat names
(`desk-ceo`, `pc-1`..`pc-6`, the various `desk-<role>` names, `cafe-seat-1..4`,
`cafe-stand-coffee`, `cafe-stand-vending`, etc. — see `OFFICE_THEME` in
`themeRegistry.ts` for the exact list) so the rest of `GOT_THEME` /
`HOGWARTS_THEME` (`primarySeatNames`, `cafeSeatNames`, `coffee`, `anchors`,
`errandSpots`) barely needs to change — only the coordinates move to match
the new floor plan, and `tilesets`/`palette` swap to the new art. Renaming
seats (e.g. `desk-ceo` → a more thematic name) is fine too, it just means
updating every reference to that name across the theme's own config.

### `ErrandKind` → thematic prop mapping

The engine's idle-errand system is show-agnostic: each `ErrandSpot` names one
of a fixed set of `ErrandKind`s (`water`, `window`, `dispenser`, `fridge`,
`shelf`, `bin`, `smoke`), a `stand` tile (must be walkable), and an `fx` tile
(where the ambient animation plays — droplet, wind streak, steam, etc. — not
required to be walkable). None of that logic needs to change; only which
*prop art* sits at each `stand`/`fx` tile pair does. Suggested reskins:

| `ErrandKind` | Office prop            | Game of Thrones                          | Hogwarts                                   |
|--------------|-------------------------|-------------------------------------------|---------------------------------------------|
| `water`      | potted plant             | godswood sapling in a stone urn           | greenhouse plant / potted Mandrake          |
| `window`     | office window            | arrow-slit overlooking Blackwater Bay     | tall arched window with floating candles    |
| `dispenser`  | water cooler             | ale barrel with a tap                     | pumpkin-juice urn                           |
| `fridge`     | break-room fridge        | root cellar / stone larder chest          | potions cabinet                             |
| `shelf`      | supply shelf             | weapon rack / maester's scroll shelf      | bookshelf                                   |
| `bin`        | garbage bin              | ash bucket by the hearth                  | parchment-scrap bin by the fireplace        |
| `smoke`      | cigar at the window (god-only) | a goblet of Dornish wine on the balcony (king only) | a headmaster's pipe by the fireplace (headmaster only) |

`godOnly` errands (currently `water` at the CEO's plant + `smoke`) stay
restricted to the god/CEO agent in both reskins — the Iron Throne / staff
table seat is the natural place to anchor them, same as `desk-ceo`'s office
corner today.

### Palette

Both placeholders already commit to a palette so the picker's swatch and the
in-scene mood agree once real art lands:

- `GOT_THEME.palette.background` = `0x2a1216` (dark stone-red, echoes the
  picker's `#6a2630` swatch)
- `HOGWARTS_THEME.palette.background` = `0x241d3a` (dark castle-purple, echoes
  the picker's `#39305a` swatch)

A real art pass is free to retune these once actual stone/castle tiles exist
and it's clear what reads well against them — they're a placeholder starting
point, not a locked-in constraint.

### Flipping the switch

Once a theme has its own map + tileset(s): replace the placeholder body of
`GOT_THEME` / `HOGWARTS_THEME` in `themeRegistry.ts` (new `mapRaw`,
`tilesets`, and the layout-bound fields re-anchored to the new map's
coordinates — follow `SILICONVALLEY_THEME` or `FRIENDS_THEME` above as the
template for a bespoke-map, reused-cast theme), then flip its `built` flag to
`true` in `OfficeThemePicker.tsx`'s `THEME_META`. Until both of those land,
leave `built: false` — that flag is the app's one honest signal to a user
about to switch (with the game's destructive re-seat warning) that they're
about to see the office, not the show.

## Out of scope for this pass

- Per-tile gid validation against every painted tile (only tileset
  *metadata* coherence is checked — a single wildly-out-of-range gid buried
  deep in a `floor` layer's data array will still render as a missing tile
  rather than fail import).
- `.zip` bundles — a plain folder is the supported format. Unzip first.
- A visual round-trip / thumbnail preview before import.
- Custom casts (see above — a bundle re-skins the map, not the roster).
