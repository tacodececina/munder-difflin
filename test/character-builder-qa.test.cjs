'use strict';

// Combinatorial QA pass for the custom-character builder (Phase 3: personalized
// avatars). portraitArt.ts's drawing primitives are a parametric space (skin ×
// hair style/args × clothing × colors × face features); the builder UI lets a
// user reach ANY point in that space, not just the 15 hand-picked combinations
// the fixed cast used before. This file mechanically hammers that space with
// real recipes — systematic edge cases plus a large seeded-random sweep — and
// asserts the drawing engine never throws and never produces an empty/corrupt
// buffer. It does NOT eyeball whether any given combination looks good; that is
// explicitly a follow-up visual pass (see the phase report).
//
// portraitArt.ts has zero runtime imports (its only import is `import type`,
// erased by transpilation) except for the browser `document`/canvas APIs used
// inside paintPortrait(FromRecipe) — so it loads standalone here via load-ts.cjs,
// with a minimal fake canvas/2D-context shim standing in for the DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  PORTRAIT_W, PORTRAIT_H, SCENE_W, SCENE_H,
  paintPortrait, paintPortraitFromRecipe,
  sceneFrameBufs, sceneFrameBufsFromRecipe,
  hashRecipe,
  SKIN_KEYS, HAIR_STYLES, CLOTH_KINDS, BROW_OPTIONS, MOUTH_OPTIONS, FACIAL_OPTIONS,
  ACCESSORY_OPTIONS, ACCESSORY_DEFAULT_COLOR, GLASSES_OPTIONS,
  quarterFrameBufsFromRecipe, recipeForFixedCharacter
} = loadTs('src/renderer/src/scene/office/portraitArt.ts');

// ─── minimal fake DOM: just enough canvas/2D-context surface for blitPortrait ─
//
// blitPortrait (portraitArt.ts) composes onto an OFFSCREEN "stage" canvas it
// creates itself via document.createElement, then drawImage()s that stage onto
// the ctx the caller passed in. So the actual pixel data lands on the STAGE's
// context's putImageData call, not on the caller's ctx (whose drawImage/
// clearRect this shim no-ops) — `lastStagePut` captures whichever fake context
// (stage or caller-supplied) most recently received image data, which in this
// code path is always the stage.
let lastStagePut = null;
function makeFakeCtx() {
  return {
    imageSmoothingEnabled: true,
    clearRect() {},
    drawImage() {},
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img) { lastStagePut = img; }
  };
}

global.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected document.createElement(${tag})`);
    const ctx = makeFakeCtx();
    return {
      width: 0, height: 0,
      getContext(kind) { return kind === '2d' ? ctx : null; }
    };
  }
};

// ─── seeded PRNG (mulberry32) — deterministic across runs/CI ─────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xc0ffee);
const randInt = (min, max) => min + Math.floor(rng() * (max - min + 1));
const randChoice = (arr) => arr[Math.floor(rng() * arr.length)];
const randBool = (p = 0.5) => rng() < p;
const randRGB = () => [randInt(0, 255), randInt(0, 255), randInt(0, 255)];

function randomHairArgs(style) {
  if (style === 'styleShort') return { part: randChoice(['L', 'R']), recede: randBool(0.4) ? 1 : 0 };
  if (style === 'styleBald') return { recede: randBool(0.4) ? 1 : 0 };
  if (style === 'styleFrame') return { length: randInt(10, 26), vol: randInt(1, 3) };
  if (style === 'styleMessy') return { length: randInt(5, 22) };
  return undefined;
}

function randomRecipe() {
  const hair = randChoice(HAIR_STYLES);
  return {
    skin: randChoice(SKIN_KEYS),
    hairc: randRGB(),
    hair,
    hairargs: randomHairArgs(hair),
    cloth: randChoice(CLOTH_KINDS),
    c1: randRGB(),
    c2: randBool() ? randRGB() : undefined,
    tie: randBool() ? randRGB() : undefined,
    pants: randBool(0.35) ? randRGB() : undefined,
    brow: randChoice(BROW_OPTIONS),
    mouth: randChoice(MOUTH_OPTIONS),
    blush: randBool(0.4),
    facial: randBool(0.35) ? randChoice(FACIAL_OPTIONS) : undefined,
    glasses: randBool(0.35) ? randChoice(GLASSES_OPTIONS) : undefined,
    lashes: randBool(0.4),
    heavy: randBool(0.3),
    accessory: randBool(0.35) ? randChoice(ACCESSORY_OPTIONS) : undefined,
    accessoryColor: randBool(0.5) ? randRGB() : undefined
  };
}

// ─── buffer sanity checks (no throw is the headline; these catch a silently
// corrupt/blank render, which a bare try/catch would miss) ───────────────────
function assertHealthyBuf(buf, w, h, label) {
  assert.ok(buf instanceof Uint8ClampedArray, `${label}: not a Uint8ClampedArray`);
  assert.equal(buf.length, w * h * 4, `${label}: wrong buffer length`);
  let drawn = 0;
  for (let i = 3; i < buf.length; i += 4) {
    const a = buf[i];
    assert.ok(a >= 0 && a <= 255, `${label}: alpha out of range at pixel ${(i - 3) / 4}`);
    if (a > 0) drawn++;
  }
  const total = w * h;
  assert.ok(drawn > total * 0.15,
    `${label}: suspiciously blank — only ${drawn}/${total} pixels drawn`);
}

function checkRecipeRendersCleanly(recipe, label) {
  // Scene buffers (front ×3 phases + back ×3 phases) — pure buffer math, no DOM.
  const { front, back } = sceneFrameBufsFromRecipe(recipe);
  assert.equal(front.length, 3, `${label}: expected 3 front phases`);
  assert.equal(back.length, 3, `${label}: expected 3 back phases`);
  for (const [i, buf] of front.entries()) assertHealthyBuf(buf, SCENE_W, SCENE_H, `${label} front[${i}]`);
  for (const [i, buf] of back.entries()) assertHealthyBuf(buf, SCENE_W, SCENE_H, `${label} back[${i}]`);

  // Portrait bust — exercises compose()/outlinePass() + the canvas blit path
  // through the fake DOM shim above.
  lastStagePut = null;
  const ctx = makeFakeCtx();
  paintPortraitFromRecipe(ctx, recipe, 2);
  assert.ok(lastStagePut, `${label}: no portrait image was composed`);
  assertHealthyBuf(lastStagePut.data, PORTRAIT_W, PORTRAIT_H, `${label} portrait`);
}

// ─── the 15 fixed characters still render (regression guard for the refactor
// that made paintPortrait/sceneFrameBufs share their cache + compose() calls
// with the new *FromRecipe functions — see portraitArt.ts) ───────────────────
const FIXED_CAST = [
  'michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley',
  'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'
];

test('all 15 fixed cast members still render without throwing', () => {
  for (const name of FIXED_CAST) {
    const { front, back } = sceneFrameBufs(name);
    for (const [i, buf] of front.entries()) assertHealthyBuf(buf, SCENE_W, SCENE_H, `${name} front[${i}]`);
    for (const [i, buf] of back.entries()) assertHealthyBuf(buf, SCENE_W, SCENE_H, `${name} back[${i}]`);
    lastStagePut = null;
    const ctx = makeFakeCtx();
    paintPortrait(ctx, name, 2);
    assert.ok(lastStagePut, `${name}: no portrait image was composed`);
    assertHealthyBuf(lastStagePut.data, PORTRAIT_W, PORTRAIT_H, `${name} portrait`);
  }
});

// ─── cache correctness: identical-content recipes (different object/array
// instances — exactly what a live builder preview re-creates every keystroke)
// must hit the SAME cached buffers; a content change must produce a fresh one ─
test('hashRecipe cache: identical content hits, different content misses', () => {
  const a = { skin: 'light', hairc: [10, 20, 30], hair: 'styleShort', hairargs: { part: 'L', recede: 0 }, cloth: 'polo', c1: [1, 2, 3], brow: 'flat', mouth: 'smile' };
  const b = { skin: 'light', hairc: [10, 20, 30], hair: 'styleShort', hairargs: { part: 'L', recede: 0 }, cloth: 'polo', c1: [1, 2, 3], brow: 'flat', mouth: 'smile' };
  assert.notEqual(a, b, 'test setup: a and b must be different object instances');
  assert.equal(hashRecipe(a), hashRecipe(b), 'structurally identical recipes must hash the same');

  const framesA = sceneFrameBufsFromRecipe(a);
  const framesB = sceneFrameBufsFromRecipe(b);
  assert.equal(framesA.front[0], framesB.front[0], 'identical recipes must share the cached buffer (reference equality)');

  const c = { ...a, blush: true };
  assert.notEqual(hashRecipe(a), hashRecipe(c), 'a content change must change the hash');
  const framesC = sceneFrameBufsFromRecipe(c);
  assert.notEqual(framesA.front[0], framesC.front[0], 'a changed recipe must NOT reuse the old cached buffer');
});

// ─── explicit "suspect" combinations named in the phase brief ────────────────
const HEAVY_SUSPECTS = [
  { label: 'heavy + suit', recipe: { skin: 'light', hairc: [80, 60, 40], hair: 'styleShort', cloth: 'suit', c1: [60, 60, 70], tie: [150, 40, 40], heavy: true } },
  { label: 'heavy + blouse', recipe: { skin: 'tan', hairc: [40, 30, 20], hair: 'styleCurly', cloth: 'blouse', c1: [200, 150, 180], heavy: true, lashes: true } },
  { label: 'heavy + cardigan', recipe: { skin: 'dark', hairc: [20, 15, 10], hair: 'styleBun', cloth: 'cardigan', c1: [150, 150, 170], c2: [230, 230, 220], heavy: true } },
  { label: 'heavy + polo', recipe: { skin: 'light', hairc: [58, 44, 30], hair: 'styleBald', cloth: 'polo', c1: [110, 140, 180], heavy: true } },
  { label: 'heavy + sweater + glasses + facial', recipe: { skin: 'brown', hairc: [60, 50, 40], hair: 'styleRecede', cloth: 'sweater', c1: [150, 150, 120], heavy: true, glasses: 'round', facial: 'mustache' } }
];

const LASHES_FACIAL_SUSPECTS = FACIAL_OPTIONS.map((facial) => ({
  label: `lashes + facial:${facial}`,
  recipe: { skin: 'light', hairc: [100, 70, 40], hair: 'styleFrame', hairargs: { length: 18, vol: 1 }, cloth: 'blouse', c1: [200, 160, 190], lashes: true, facial }
}));

const LONG_HAIR_HIGH_COLLAR_SUSPECTS = [
  { label: 'styleFrame long+full vol + cardigan', recipe: { skin: 'light', hairc: [120, 76, 42], hair: 'styleFrame', hairargs: { length: 24, vol: 3 }, cloth: 'cardigan', c1: [150, 146, 170], c2: [235, 233, 226] } },
  { label: 'styleFrame long + dressshirt + tie', recipe: { skin: 'light', hairc: [90, 60, 40], hair: 'styleFrame', hairargs: { length: 22, vol: 2 }, cloth: 'dressshirt', c1: [180, 190, 210], tie: [120, 60, 60] } },
  { label: 'styleMessy long + polo', recipe: { skin: 'tan', hairc: [154, 82, 46], hair: 'styleMessy', hairargs: { length: 20 }, cloth: 'polo', c1: [176, 86, 74] } },
  // Beyond any real recipe's usage — bounds-safety stress (set() already
  // no-ops out-of-canvas writes; this confirms that holds under real extremes).
  { label: 'styleFrame EXTREME length/vol', recipe: { skin: 'light', hairc: [90, 60, 40], hair: 'styleFrame', hairargs: { length: 40, vol: 8 }, cloth: 'suit', c1: [60, 60, 70], tie: [150, 40, 40] } },
  { label: 'styleMessy EXTREME length', recipe: { skin: 'light', hairc: [90, 60, 40], hair: 'styleMessy', hairargs: { length: 40 }, cloth: 'sweater', c1: [150, 150, 120] } }
];

const MISC_SUSPECTS = [
  { label: 'styleBald + recede + stubble', recipe: { skin: 'light', hairc: [170, 166, 156], hair: 'styleBald', hairargs: { recede: 1 }, cloth: 'dressshirt', c1: [126, 130, 96], facial: 'stubble' } },
  { label: 'glasses + heavy + lashes + blush', recipe: { skin: 'light', hairc: [196, 162, 110], hair: 'styleCurly', cloth: 'blouse', c1: [202, 160, 192], glasses: 'sun', heavy: true, lashes: true, blush: true } },
  { label: 'styleShort recede + part R', recipe: { skin: 'light', hairc: [64, 48, 28], hair: 'styleShort', hairargs: { part: 'R', recede: 1 }, cloth: 'dressshirt', c1: [184, 155, 62], tie: [120, 82, 46] } },
  { label: 'every optional color set at once', recipe: { skin: 'dark', hairc: [50, 40, 30], hair: 'styleSpiky', cloth: 'suit', c1: [70, 70, 90], c2: [90, 90, 110], tie: [180, 60, 60], pants: [30, 30, 40], glasses: 'square', facial: 'goatee', blush: true, lashes: true, heavy: true } },
  { label: 'no optional fields at all (minimal recipe)', recipe: { skin: 'light', hairc: [90, 60, 40], hair: 'styleFloppy', cloth: 'sweater', c1: [150, 150, 150] } }
];

// ─── accessory (phase 9 second-wave avatar accessories) suspect combinations:
// cap over long/bald hair (does the overlay conflict with hair silhouettes?),
// headphones + glasses (both compete for the temple/ear area), earrings +
// lashes + blush (crowded face), and every optional field set together.
const ACCESSORY_SUSPECTS = [
  { label: 'cap + styleFrame long hair', recipe: { skin: 'light', hairc: [120, 76, 42], hair: 'styleFrame', hairargs: { length: 22, vol: 2 }, cloth: 'cardigan', c1: [150, 146, 170], accessory: 'cap' } },
  { label: 'cap + styleBald', recipe: { skin: 'light', hairc: [170, 166, 156], hair: 'styleBald', cloth: 'dressshirt', c1: [126, 130, 96], accessory: 'cap' } },
  { label: 'headphones + glasses', recipe: { skin: 'light', hairc: [64, 48, 28], hair: 'styleShort', cloth: 'dressshirt', c1: [184, 155, 62], glasses: 'round', accessory: 'headphones' } },
  { label: 'headphones + styleMessy long', recipe: { skin: 'tan', hairc: [154, 82, 46], hair: 'styleMessy', hairargs: { length: 20 }, cloth: 'polo', c1: [176, 86, 74], accessory: 'headphones' } },
  { label: 'earrings + lashes + blush', recipe: { skin: 'tan', hairc: [24, 18, 22], hair: 'styleFrame', hairargs: { length: 20, vol: 1 }, cloth: 'blouse', c1: [212, 90, 158], lashes: true, blush: true, accessory: 'earrings' } },
  { label: 'accessory + heavy + custom accessoryColor', recipe: { skin: 'dark', hairc: [60, 54, 48], hair: 'styleRecede', cloth: 'dressshirt', c1: [150, 120, 86], heavy: true, accessory: 'headphones', accessoryColor: [200, 60, 60] } },
  { label: 'every optional field set at once (incl. accessory)', recipe: { skin: 'dark', hairc: [50, 40, 30], hair: 'styleSpiky', cloth: 'suit', c1: [70, 70, 90], c2: [90, 90, 110], tie: [180, 60, 60], pants: [30, 30, 40], glasses: 'sun', facial: 'goatee', blush: true, lashes: true, heavy: true, accessory: 'cap', accessoryColor: [10, 200, 10] } }
];

const NAMED_SUSPECTS = [
  ...HEAVY_SUSPECTS, ...LASHES_FACIAL_SUSPECTS, ...LONG_HAIR_HIGH_COLLAR_SUSPECTS, ...MISC_SUSPECTS,
  ...ACCESSORY_SUSPECTS
];

test(`explicit suspect combinations render cleanly (${NAMED_SUSPECTS.length} cases)`, () => {
  for (const { label, recipe } of NAMED_SUSPECTS) {
    assert.doesNotThrow(() => checkRecipeRendersCleanly(recipe, label), `${label} threw`);
  }
});

// ─── systematic cross of the two biggest fragility axes named in the brief:
// every hair style × heavy, and every clothing cut × heavy ────────────────────
test('every hair style renders under heavy=true and heavy=false', () => {
  for (const hair of HAIR_STYLES) {
    for (const heavy of [false, true]) {
      const recipe = {
        skin: 'light', hairc: [90, 60, 40], hair, hairargs: randomHairArgs(hair),
        cloth: 'dressshirt', c1: [172, 196, 224], tie: [120, 130, 150], heavy
      };
      assert.doesNotThrow(() => checkRecipeRendersCleanly(recipe, `hair=${hair} heavy=${heavy}`));
    }
  }
});

test('every clothing cut renders under heavy=true and heavy=false', () => {
  for (const cloth of CLOTH_KINDS) {
    for (const heavy of [false, true]) {
      const recipe = {
        skin: 'tan', hairc: [40, 30, 20], hair: 'styleShort', hairargs: { part: 'L' },
        cloth, c1: [150, 100, 90], c2: [200, 180, 170], tie: [90, 70, 60], heavy
      };
      assert.doesNotThrow(() => checkRecipeRendersCleanly(recipe, `cloth=${cloth} heavy=${heavy}`));
    }
  }
});

test('every skin tone renders', () => {
  for (const skin of SKIN_KEYS) {
    const recipe = { skin, hairc: [90, 60, 40], hair: 'styleFloppy', cloth: 'dressshirt', c1: [172, 196, 224] };
    assert.doesNotThrow(() => checkRecipeRendersCleanly(recipe, `skin=${skin}`));
  }
});

// ─── accessory axis (phase 9): every kind must render cleanly crossed with
// heavy=true/false and every hair style, both with the default color and an
// explicit accessoryColor override, front AND back (checkRecipeRendersCleanly
// already exercises both directions via sceneFrameBufsFromRecipe). ───────────
test('ACCESSORY_DEFAULT_COLOR has an entry for every ACCESSORY_OPTIONS kind', () => {
  for (const kind of ACCESSORY_OPTIONS) {
    const c = ACCESSORY_DEFAULT_COLOR[kind];
    assert.ok(Array.isArray(c) && c.length === 3, `missing/invalid default color for accessory "${kind}"`);
  }
});

test('every accessory kind renders under heavy=true and heavy=false', () => {
  for (const accessory of ACCESSORY_OPTIONS) {
    for (const heavy of [false, true]) {
      const recipe = {
        skin: 'light', hairc: [90, 60, 40], hair: 'styleFloppy',
        cloth: 'dressshirt', c1: [172, 196, 224], tie: [120, 130, 150], heavy, accessory
      };
      assert.doesNotThrow(() => checkRecipeRendersCleanly(recipe, `accessory=${accessory} heavy=${heavy}`));
    }
  }
});

test('every accessory kind renders across every hair style', () => {
  for (const accessory of ACCESSORY_OPTIONS) {
    for (const hair of HAIR_STYLES) {
      const recipe = {
        skin: 'tan', hairc: [90, 60, 40], hair, hairargs: randomHairArgs(hair),
        cloth: 'polo', c1: [176, 86, 74], accessory
      };
      assert.doesNotThrow(() => checkRecipeRendersCleanly(recipe, `accessory=${accessory} hair=${hair}`));
    }
  }
});

test('every accessory kind renders with an explicit accessoryColor override', () => {
  for (const accessory of ACCESSORY_OPTIONS) {
    const recipe = {
      skin: 'brown', hairc: [40, 30, 20], hair: 'styleCurly',
      cloth: 'sweater', c1: [150, 150, 120], accessory, accessoryColor: [220, 30, 140]
    };
    assert.doesNotThrow(() => checkRecipeRendersCleanly(recipe, `accessory=${accessory} custom color`));
  }
});

test('no accessory field (undefined) leaves rendering equivalent to omitting it entirely', () => {
  // Guards the "byte-identical for the 15 fixed recipes" requirement: a recipe
  // that never mentions `accessory` and one that explicitly sets it to
  // undefined must hash and render identically (both skip the overlay).
  const withoutField = { skin: 'light', hairc: [92, 60, 34], hair: 'styleFloppy', cloth: 'dressshirt', c1: [172, 196, 224], tie: [120, 130, 150] };
  const withUndefined = { ...withoutField, accessory: undefined };
  assert.equal(hashRecipe(withoutField), hashRecipe(withUndefined));
  const a = sceneFrameBufsFromRecipe(withoutField);
  const b = sceneFrameBufsFromRecipe(withUndefined);
  assert.equal(a.front[0], b.front[0], 'identical recipes (with vs. without an explicit undefined accessory) must share the cached buffer');
});

// ─── accessories on the TURNED poses ─────────────────────────────────────────
// The ¾ prototype in portraitArt.ts first shipped its accessories by replaying
// the FRONT overlay on the turned figure. That overlay is anchored on the front
// head box (ears at x=3 and x=14) and on the canvas centre line, neither of
// which the ¾ pose has, so parts of it landed outside the silhouette and the
// outline pass drew a border around the mistake. These lock in the re-anchored
// ¾ overlays — cheap, because the whole thing is deterministic buffer math.
const ACCESSORY_RGBA = (buf, x, y) => {
  const i = (y * SCENE_W + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]].join(',');
};

test('turned poses render every accessory cleanly, on every fixed cast member', () => {
  for (const name of FIXED_CAST) {
    for (const facing of ['quarter', 'quarterBody']) {
      for (const acc of ACCESSORY_OPTIONS) {
        const recipe = { ...recipeForFixedCharacter(name), accessory: acc };
        const frames = quarterFrameBufsFromRecipe(recipe, facing);
        assert.equal(frames.length, 3, `${name}/${facing}/${acc}: expected 3 walk phases`);
        for (const [i, buf] of frames.entries()) {
          assertHealthyBuf(buf, SCENE_W, SCENE_H, `${name} ${facing} ${acc}[${i}]`);
        }
      }
    }
  }
});

test('no accessory paints ink detached from the turned figure it is worn on', () => {
  // The failure this catches: an overlay anchored on the wrong geometry drops a
  // pixel into empty space beside the sprite, where outlinePass faithfully
  // draws a border around it and it reads as a chip of dirt. "Attached" = the
  // added ink reaches the plain figure's ink through orthogonal steps.
  const ink = (buf, x, y) =>
    x >= 0 && y >= 0 && x < SCENE_W && y < SCENE_H && buf[(y * SCENE_W + x) * 4 + 3] !== 0;
  for (const name of FIXED_CAST) {
    for (const facing of ['quarter', 'quarterBody']) {
      const plain = quarterFrameBufsFromRecipe(recipeForFixedCharacter(name), facing)[0];
      for (const acc of ACCESSORY_OPTIONS) {
        const worn = quarterFrameBufsFromRecipe({ ...recipeForFixedCharacter(name), accessory: acc }, facing)[0];
        const added = [];
        for (let y = 0; y < SCENE_H; y++) {
          for (let x = 0; x < SCENE_W; x++) if (!ink(plain, x, y) && ink(worn, x, y)) added.push([x, y]);
        }
        const key = (x, y) => y * SCENE_W + x;
        const pending = new Set(added.map(([x, y]) => key(x, y)));
        const stack = [];
        for (const [x, y] of added) {
          const touchesBody = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ink(plain, x + dx, y + dy));
          if (touchesBody) { pending.delete(key(x, y)); stack.push([x, y]); }
        }
        while (stack.length) {
          const [x, y] = stack.pop();
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (pending.delete(key(x + dx, y + dy))) stack.push([x + dx, y + dy]);
          }
        }
        assert.equal(pending.size, 0,
          `${name}/${facing}/${acc}: ${pending.size} accessory pixel(s) float detached from the figure`);
      }
    }
  }
});

test('¾ earrings hang one stud off the one ear a turned head shows', () => {
  // The concrete bug: the front pair's second stud landed at x=14,y=12, one
  // column past where QUARTER_SKULL's row 12 ends — outside the head.
  for (const name of FIXED_CAST) {
    const plain = quarterFrameBufsFromRecipe(recipeForFixedCharacter(name), 'quarter')[0];
    const worn = quarterFrameBufsFromRecipe({ ...recipeForFixedCharacter(name), accessory: 'earrings' }, 'quarter')[0];
    assert.equal(ACCESSORY_RGBA(worn, 14, 12), ACCESSORY_RGBA(plain, 14, 12),
      `${name}: earrings must not touch x=14,y=12 — that is past the ¾ skull's edge`);
    assert.notEqual(ACCESSORY_RGBA(worn, 4, 12), ACCESSORY_RGBA(plain, 4, 12),
      `${name}: the ¾ stud belongs under the one visible ear, at x=4,y=12`);
  }
});

test("'quarterBody' keeps the FRONT head verbatim, accessories included", () => {
  // That is the entire point of the facing: turn the body, risk nothing of the
  // identity the hair mass carries. Rows 0-16 are head-only (the ¾ torso starts
  // at row 18 and the front head owns the neck at row 17), so they must match
  // the plain front pose pixel for pixel, with or without headwear.
  for (const name of FIXED_CAST) {
    for (const acc of [undefined, 'cap', 'headphones', 'earrings']) {
      const recipe = { ...recipeForFixedCharacter(name), accessory: acc };
      const front = sceneFrameBufsFromRecipe(recipe).front[0];
      const body = quarterFrameBufsFromRecipe(recipe, 'quarterBody')[0];
      for (let y = 0; y <= 16; y++) {
        for (let x = 0; x < SCENE_W; x++) {
          assert.equal(ACCESSORY_RGBA(body, x, y), ACCESSORY_RGBA(front, x, y),
            `${name}/${acc ?? 'no accessory'}: head pixel (${x},${y}) drifted from the front pose`);
        }
      }
    }
  }
});

test('¾ body accessories follow the torso when `heavy` widens it', () => {
  // The lanyard and the watch hang on the torso, and drawQuarterTorso moves its
  // centre-front seam and its near-arm column for a heavy build. A fixed-column
  // overlay would sit a column inside a heavy figure's sleeve.
  const base = { ...recipeForFixedCharacter('michael'), accessory: 'watch' };
  const slimWatch = quarterFrameBufsFromRecipe({ ...base, heavy: false }, 'quarter')[0];
  const wideWatch = quarterFrameBufsFromRecipe({ ...base, heavy: true }, 'quarter')[0];
  const plainWide = quarterFrameBufsFromRecipe({ ...recipeForFixedCharacter('michael'), heavy: true }, 'quarter')[0];
  assert.notEqual(ACCESSORY_RGBA(slimWatch, 4, 23), ACCESSORY_RGBA(
    quarterFrameBufsFromRecipe({ ...recipeForFixedCharacter('michael'), heavy: false }, 'quarter')[0], 4, 23),
    'slim build: the watch belongs on the near arm at x=4');
  assert.notEqual(ACCESSORY_RGBA(wideWatch, 3, 23), ACCESSORY_RGBA(plainWide, 3, 23),
    'heavy build: the watch must move out to the wider near-arm column x=3');
});

// ─── the turned-pose cache ───────────────────────────────────────────────────
test("quarterFrameBufsFromRecipe hands 'front'/'back' straight to the scene cache", () => {
  // Facing covers all four directions, so the untuned two are reachable here.
  // They must not be composed a second time under a second key — same buffer
  // objects, or the two caches drift and the same figure is stored twice.
  const recipe = recipeForFixedCharacter('toby');
  const scene = sceneFrameBufsFromRecipe(recipe);
  assert.deepEqual(quarterFrameBufsFromRecipe(recipe, 'front'), scene.front);
  assert.equal(quarterFrameBufsFromRecipe(recipe, 'front')[0], scene.front[0]);
  assert.equal(quarterFrameBufsFromRecipe(recipe, 'back')[2], scene.back[2]);
});

test('the ¾ cache is bounded — a long recipe sweep does not grow it forever', () => {
  // Three 2.3 KB frames live behind every key, and the turned pose exists to be
  // swept (preview sheets, look proposals). Evicting is observable: the very
  // first recipe of a sweep longer than the bound has to be composed again, so
  // it comes back as a different buffer object with identical contents.
  const seed = { ...recipeForFixedCharacter('creed'), c1: [0, 0, 0] };
  const first = quarterFrameBufsFromRecipe(seed, 'quarter')[0];
  for (let i = 1; i <= 200; i++) {
    quarterFrameBufsFromRecipe({ ...recipeForFixedCharacter('creed'), c1: [i, i, i] }, 'quarter');
  }
  const again = quarterFrameBufsFromRecipe(seed, 'quarter')[0];
  assert.notEqual(again, first, 'the cache never evicted: 200 distinct recipes all stayed resident');
  assert.deepEqual(Array.from(again), Array.from(first), 're-composing must be deterministic');
});

// ─── the big seeded-random sweep ──────────────────────────────────────────────
const RANDOM_SWEEP_SIZE = 200;

test(`${RANDOM_SWEEP_SIZE} random recipes across the full parametric space render without throwing or producing an empty/corrupt buffer`, () => {
  let checked = 0;
  for (let i = 0; i < RANDOM_SWEEP_SIZE; i++) {
    const recipe = randomRecipe();
    assert.doesNotThrow(
      () => checkRecipeRendersCleanly(recipe, `random#${i} ${JSON.stringify(recipe)}`),
      `random recipe #${i} crashed or produced a bad buffer: ${JSON.stringify(recipe)}`
    );
    checked++;
  }
  assert.equal(checked, RANDOM_SWEEP_SIZE);
});
