import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelModal } from './PixelModal';
import { PixelButton } from './PixelButton';
import { PixelTabs } from './PixelTabs';
import { PixelCheckbox } from './PixelCheckbox';
import {
  type Recipe, type RGB, type Brow, type Mouth, type Facial, type Cloth, type HairStyle, type HairArgs,
  type AccessoryKind, type GlassesKind,
  SKIN_KEYS, BROW_OPTIONS, MOUTH_OPTIONS, FACIAL_OPTIONS, CLOTH_KINDS, HAIR_STYLES,
  ACCESSORY_OPTIONS, ACCESSORY_DEFAULT_COLOR, GLASSES_OPTIONS,
  PORTRAIT_W, PORTRAIT_H, SCENE_W, SCENE_H,
  paintPortraitFromRecipe, sceneFrameBufsFromRecipe
} from '@/scene/office/portraitArt';
import { saveCustomCharacter, type CustomCharacter } from '@/scene/office/customCast';

export interface CharacterBuilderModalProps {
  onClose: () => void;
  onCreate: (character: CustomCharacter) => void;
  /** Hex fallback for the in-scene glow color (see OfficeFloor.tsx) — seeded
   *  from the wizard's own "Color" step. This builder has no color tab of its
   *  own; an agent's accent is picked separately, one step over. */
  defaultAccentHex: string;
}

type Tab = 'face' | 'hair' | 'clothing' | 'accessory';

// ─── small color helpers (UI-only glue — the drawing engine only knows RGB
// tuples; native <input type="color"> only knows hex) ──────────────────────
function toHex([r, g, b]: RGB): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function fromHex(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function pickOne<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomRGB(): RGB {
  return [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)];
}

// A safe, reasonable starting point — structurally identical to Jim's recipe
// (a known-good combination) rather than an arbitrary blank slate.
const INITIAL: Recipe = {
  skin: 'light', hairc: [92, 60, 34], hair: 'styleFloppy',
  cloth: 'dressshirt', c1: [172, 196, 224], tie: [120, 130, 150],
  brow: 'flat', mouth: 'smile'
};

const tileStyle = (selected: boolean): CSSProperties => ({
  padding: 4,
  background: selected ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
  boxShadow: selected ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
  cursor: 'pointer',
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
  border: 'none'
});

/** A single grid thumbnail: paints a sample Recipe via paintPortraitFromRecipe
 *  rather than any hand-drawn icon, per the "expose the existing parametric
 *  space" scope of this phase. */
function RecipeThumb({
  recipe, scale = 2, selected, onClick, label, title
}: {
  recipe: Recipe; scale?: number; selected: boolean; onClick: () => void; label?: string; title?: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paintPortraitFromRecipe(ctx, recipe, scale);
  }, [recipe, scale]);
  const w = Math.round(PORTRAIT_W * scale), h = Math.round(PORTRAIT_H * scale);
  return (
    <button type="button" onClick={onClick} title={title} style={{ ...tileStyle(selected), width: w + 8 }}>
      <canvas ref={ref} width={w} height={h} style={{ width: w, height: h, imageRendering: 'pixelated' }} />
      {label && (
        <span style={{ fontSize: 10, color: 'var(--cth-ink-700)', textAlign: 'center', lineHeight: '12px' }}>
          {label}
        </span>
      )}
    </button>
  );
}

const fieldLabel: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-700)', textTransform: 'uppercase', display: 'block', marginBottom: 4
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <span style={fieldLabel}>{label}</span>
      {children}
    </div>
  );
}

const colorSwatchStyle: CSSProperties = {
  width: 32, height: 24, padding: 0, border: 'none', cursor: 'pointer',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'none'
};

/**
 * "Create character" builder: every control here maps directly to a Recipe
 * field portraitArt.ts already knows how to draw — this UI does not invent
 * any new hair/clothing/accessory content, it only exposes the existing
 * parametric space (see phase report). Saves into the localStorage-backed
 * custom-character registry (customCast.ts) on submit.
 */
export function CharacterBuilderModal({ onClose, onCreate, defaultAccentHex }: CharacterBuilderModalProps) {
  const { t: tr } = useTranslation();
  const [tab, setTab] = useState<Tab>('face');
  const [displayName, setDisplayName] = useState('');

  const [skin, setSkin] = useState<string>('light');
  const [brow, setBrow] = useState<Brow>('flat');
  const [mouth, setMouth] = useState<Mouth>('smile');
  const [blush, setBlush] = useState(false);
  const [lashes, setLashes] = useState(false);
  const [useGlasses, setUseGlasses] = useState(false);
  const [glasses, setGlasses] = useState<GlassesKind>('round');
  const [useFacial, setUseFacial] = useState(false);
  const [facial, setFacial] = useState<Facial>('mustache');
  const [heavy, setHeavy] = useState(false);

  const [hair, setHair] = useState<HairStyle>('styleFloppy');
  const [hairc, setHairc] = useState<RGB>([92, 60, 34]);
  const [part, setPart] = useState<'L' | 'R'>('L');
  const [recede, setRecede] = useState(false);
  const [length, setLength] = useState(17);
  const [vol, setVol] = useState(1);

  const [cloth, setCloth] = useState<Cloth>('dressshirt');
  const [c1, setC1] = useState<RGB>([172, 196, 224]);
  const [useC2, setUseC2] = useState(false);
  const [c2, setC2] = useState<RGB>([244, 242, 238]);
  const [useTie, setUseTie] = useState(true);
  const [tie, setTie] = useState<RGB>([120, 130, 150]);
  const [usePants, setUsePants] = useState(false);
  const [pants, setPants] = useState<RGB>([54, 56, 70]);

  const [useAccessory, setUseAccessory] = useState(false);
  const [accessory, setAccessory] = useState<AccessoryKind>('cap');
  const [accessoryColor, setAccessoryColor] = useState<RGB>(ACCESSORY_DEFAULT_COLOR.cap);

  const hairArgsFor = (style: HairStyle): HairArgs | undefined => {
    if (style === 'styleShort') return { part, recede: recede ? 1 : 0 };
    if (style === 'styleBald') return { recede: recede ? 1 : 0 };
    if (style === 'styleFrame') return { length, vol };
    if (style === 'styleMessy') return { length };
    return undefined;
  };

  const recipe: Recipe = useMemo(() => ({
    skin, hairc, hair, hairargs: hairArgsFor(hair),
    cloth, c1,
    c2: useC2 ? c2 : undefined,
    tie: useTie ? tie : undefined,
    pants: usePants ? pants : undefined,
    brow, mouth, blush, lashes, heavy,
    glasses: useGlasses ? glasses : undefined,
    facial: useFacial ? facial : undefined,
    accessory: useAccessory ? accessory : undefined,
    accessoryColor: useAccessory ? accessoryColor : undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    skin, hairc, hair, part, recede, length, vol,
    cloth, c1, useC2, c2, useTie, tie, usePants, pants,
    brow, mouth, blush, lashes, useGlasses, glasses, heavy, useFacial, facial,
    useAccessory, accessory, accessoryColor
  ]);

  // Live portrait preview — paintPortraitFromRecipe is synchronous and cheap,
  // so every recipe change repaints immediately (same canvas+useEffect pattern
  // SpritePortrait already uses for the fixed roster).
  const portraitRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = portraitRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paintPortraitFromRecipe(ctx, recipe, 6);
  }, [recipe]);

  // Walking preview — HONEST CAVEAT (see phase report): this is a flat 2D
  // canvas cycling the 3 walk-phase buffers with setInterval, not a real Pixi
  // sprite in a live scene. Mounting a full Pixi Application inside an HTML
  // modal was judged more risk/effort than this phase's payoff; the frames
  // themselves are the exact same buffers the real office floor will use.
  const walkRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = walkRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { front } = sceneFrameBufsFromRecipe(recipe);
    const scale = 4;
    let phase = 0;
    const stage = document.createElement('canvas');
    stage.width = SCENE_W; stage.height = SCENE_H;
    const sctx = stage.getContext('2d');
    const draw = () => {
      if (!sctx) return;
      const img = sctx.createImageData(SCENE_W, SCENE_H);
      img.data.set(front[phase]);
      sctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(stage, 0, 0, SCENE_W, SCENE_H, 0, 0, SCENE_W * scale, SCENE_H * scale);
      phase = (phase + 1) % front.length;
    };
    draw();
    const id = setInterval(draw, 380);
    return () => clearInterval(id);
  }, [recipe]);

  const randomize = () => {
    setSkin(pickOne(SKIN_KEYS));
    setHair(pickOne(HAIR_STYLES));
    setHairc(randomRGB());
    setPart(pickOne(['L', 'R'] as const));
    setRecede(Math.random() < 0.35);
    setLength(15 + Math.floor(Math.random() * 10));
    setVol(1 + Math.floor(Math.random() * 3));
    setCloth(pickOne(CLOTH_KINDS));
    setC1(randomRGB());
    const c2On = Math.random() < 0.5; setUseC2(c2On); if (c2On) setC2(randomRGB());
    const tieOn = Math.random() < 0.5; setUseTie(tieOn); if (tieOn) setTie(randomRGB());
    const pantsOn = Math.random() < 0.4; setUsePants(pantsOn); if (pantsOn) setPants(randomRGB());
    setBrow(pickOne(BROW_OPTIONS));
    setMouth(pickOne(MOUTH_OPTIONS));
    setBlush(Math.random() < 0.4);
    setLashes(Math.random() < 0.4);
    const glassesOn = Math.random() < 0.35;
    setUseGlasses(glassesOn);
    if (glassesOn) setGlasses(pickOne(GLASSES_OPTIONS));
    const facialOn = Math.random() < 0.3; setUseFacial(facialOn); if (facialOn) setFacial(pickOne(FACIAL_OPTIONS));
    setHeavy(Math.random() < 0.3);
    const accessoryOn = Math.random() < 0.3;
    setUseAccessory(accessoryOn);
    if (accessoryOn) {
      const a = pickOne(ACCESSORY_OPTIONS);
      setAccessory(a);
      setAccessoryColor(ACCESSORY_DEFAULT_COLOR[a]);
    }
  };

  const save = () => {
    const saved = saveCustomCharacter(displayName.trim() || tr('characterBuilder.fallbackName'), defaultAccentHex, recipe);
    onCreate(saved);
  };

  const hairStyleLabel = (s: HairStyle) => tr(`characterBuilder.hairStyleNames.${s}`);
  const clothLabel = (c: Cloth) => tr(`characterBuilder.clothNames.${c}`);
  const skinLabel = (s: string) => tr(`characterBuilder.skinNames.${s}`, s);
  const browLabel = (b: Brow) => tr(`characterBuilder.browOptions.${b}`);
  const mouthLabel = (m: Mouth) => tr(`characterBuilder.mouthOptions.${m}`);
  const facialLabel = (f: Facial) => tr(`characterBuilder.facialOptions.${f}`);
  const accessoryLabel = (a: AccessoryKind) => tr(`characterBuilder.accessoryOptions.${a}`);
  const glassesLabel = (g: GlassesKind) => tr(`characterBuilder.glassesOptions.${g}`);

  return (
    <PixelModal onClose={onClose} title={tr('characterBuilder.title')} width={760} noPadding>
      <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '86vh' }}>
        <div style={{ padding: '12px 16px 0' }}>
          <Field label={tr('characterBuilder.nameLabel')}>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={tr('characterBuilder.namePlaceholder')}
              style={{
                width: '100%', padding: '6px 8px 4px', background: 'var(--cth-paper-100)',
                border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 16, color: 'var(--cth-ink-900)', outline: 'none'
              }}
            />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 16, padding: '0 16px 12px', overflow: 'hidden', flex: 1, minHeight: 0 }}>
          {/* LEFT — live previews */}
          <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <span style={fieldLabel}>{tr('characterBuilder.portraitPreview')}</span>
              <div style={{
                width: PORTRAIT_W * 6, height: PORTRAIT_H * 6,
                background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <canvas
                  ref={portraitRef}
                  width={PORTRAIT_W * 6}
                  height={PORTRAIT_H * 6}
                  style={{ width: PORTRAIT_W * 6, height: PORTRAIT_H * 6, imageRendering: 'pixelated' }}
                />
              </div>
            </div>
            <div>
              <span style={fieldLabel}>{tr('characterBuilder.walkPreview')}</span>
              <div style={{
                width: SCENE_W * 4, height: SCENE_H * 4,
                background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <canvas
                  ref={walkRef}
                  width={SCENE_W * 4}
                  height={SCENE_H * 4}
                  style={{ width: SCENE_W * 4, height: SCENE_H * 4, imageRendering: 'pixelated' }}
                />
              </div>
            </div>
            <PixelButton variant="secondary" size="sm" onClick={randomize} fullWidth>
              {tr('characterBuilder.randomize')}
            </PixelButton>
          </div>

          {/* RIGHT — tabbed controls */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <PixelTabs
              variant="strip"
              current={tab}
              onChange={(k) => setTab(k as Tab)}
              items={[
                { key: 'face', label: tr('characterBuilder.tabs.face') },
                { key: 'hair', label: tr('characterBuilder.tabs.hair') },
                { key: 'clothing', label: tr('characterBuilder.tabs.clothing') },
                { key: 'accessory', label: tr('characterBuilder.tabs.accessory') }
              ]}
            />
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 4px 0 0' }}>
              {tab === 'face' && (
                <>
                  <Field label={tr('characterBuilder.skin')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {SKIN_KEYS.map((s) => (
                        <RecipeThumb
                          key={s}
                          recipe={{ ...recipe, skin: s }}
                          selected={skin === s}
                          onClick={() => setSkin(s)}
                          label={skinLabel(s)}
                        />
                      ))}
                    </div>
                  </Field>
                  <Field label={tr('characterBuilder.browLabel')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {BROW_OPTIONS.map((b) => (
                        <RecipeThumb
                          key={b}
                          recipe={{ ...recipe, brow: b }}
                          selected={brow === b}
                          onClick={() => setBrow(b)}
                          label={browLabel(b)}
                        />
                      ))}
                    </div>
                  </Field>
                  <Field label={tr('characterBuilder.mouthLabel')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {MOUTH_OPTIONS.map((m) => (
                        <RecipeThumb
                          key={m}
                          recipe={{ ...recipe, mouth: m }}
                          selected={mouth === m}
                          onClick={() => setMouth(m)}
                          label={mouthLabel(m)}
                        />
                      ))}
                    </div>
                  </Field>
                  <Field label={tr('characterBuilder.facialHair')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <RecipeThumb
                        recipe={{ ...recipe, facial: undefined }}
                        selected={!useFacial}
                        onClick={() => setUseFacial(false)}
                        label={tr('characterBuilder.facialNone')}
                      />
                      {FACIAL_OPTIONS.map((f) => (
                        <RecipeThumb
                          key={f}
                          recipe={{ ...recipe, facial: f }}
                          selected={useFacial && facial === f}
                          onClick={() => { setUseFacial(true); setFacial(f); }}
                          label={facialLabel(f)}
                        />
                      ))}
                    </div>
                  </Field>
                  <Field label={tr('characterBuilder.glasses')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <RecipeThumb
                        recipe={{ ...recipe, glasses: undefined }}
                        selected={!useGlasses}
                        onClick={() => setUseGlasses(false)}
                        label={tr('characterBuilder.glassesNone')}
                      />
                      {GLASSES_OPTIONS.map((g) => (
                        <RecipeThumb
                          key={g}
                          recipe={{ ...recipe, glasses: g }}
                          selected={useGlasses && glasses === g}
                          onClick={() => { setUseGlasses(true); setGlasses(g); }}
                          label={glassesLabel(g)}
                        />
                      ))}
                    </div>
                  </Field>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <PixelCheckbox checked={blush} onChange={setBlush} label={tr('characterBuilder.blush')} />
                    <PixelCheckbox checked={lashes} onChange={setLashes} label={tr('characterBuilder.lashes')} />
                    <PixelCheckbox checked={heavy} onChange={setHeavy} label={tr('characterBuilder.heavy')} />
                  </div>
                </>
              )}

              {tab === 'hair' && (
                <>
                  <Field label={tr('characterBuilder.hairStyle')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {HAIR_STYLES.map((s) => (
                        <RecipeThumb
                          key={s}
                          recipe={{ ...recipe, hair: s, hairargs: undefined }}
                          selected={hair === s}
                          onClick={() => setHair(s)}
                          label={hairStyleLabel(s)}
                        />
                      ))}
                    </div>
                  </Field>
                  <Field label={tr('characterBuilder.hairColor')}>
                    <input type="color" value={toHex(hairc)} onChange={(e) => setHairc(fromHex(e.target.value))} style={colorSwatchStyle} />
                  </Field>
                  {hair === 'styleShort' && (
                    <>
                      <Field label={tr('characterBuilder.hairPart')}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <PixelButton variant={part === 'L' ? 'primary' : 'secondary'} size="sm" onClick={() => setPart('L')}>
                            {tr('characterBuilder.hairPartLeft')}
                          </PixelButton>
                          <PixelButton variant={part === 'R' ? 'primary' : 'secondary'} size="sm" onClick={() => setPart('R')}>
                            {tr('characterBuilder.hairPartRight')}
                          </PixelButton>
                        </div>
                      </Field>
                      <PixelCheckbox checked={recede} onChange={setRecede} label={tr('characterBuilder.hairRecede')} />
                    </>
                  )}
                  {hair === 'styleBald' && (
                    <PixelCheckbox checked={recede} onChange={setRecede} label={tr('characterBuilder.hairRecede')} />
                  )}
                  {(hair === 'styleFrame' || hair === 'styleMessy') && (
                    <Field label={tr('characterBuilder.hairLength')}>
                      <input
                        type="range" min={6} max={26} value={length}
                        onChange={(e) => setLength(Number(e.target.value))}
                        style={{ width: '100%' }}
                      />
                    </Field>
                  )}
                  {hair === 'styleFrame' && (
                    <Field label={tr('characterBuilder.hairVolume')}>
                      <input
                        type="range" min={1} max={3} value={vol}
                        onChange={(e) => setVol(Number(e.target.value))}
                        style={{ width: '100%' }}
                      />
                    </Field>
                  )}
                </>
              )}

              {tab === 'clothing' && (
                <>
                  <Field label={tr('characterBuilder.clothCut')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {CLOTH_KINDS.map((c) => (
                        <RecipeThumb
                          key={c}
                          recipe={{ ...recipe, cloth: c }}
                          selected={cloth === c}
                          onClick={() => setCloth(c)}
                          label={clothLabel(c)}
                        />
                      ))}
                    </div>
                  </Field>
                  <Field label={tr('characterBuilder.primaryColor')}>
                    <input type="color" value={toHex(c1)} onChange={(e) => setC1(fromHex(e.target.value))} style={colorSwatchStyle} />
                  </Field>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                    <PixelCheckbox checked={useC2} onChange={setUseC2} label={tr('characterBuilder.useSecondaryColor')} />
                    {useC2 && (
                      <input type="color" value={toHex(c2)} onChange={(e) => setC2(fromHex(e.target.value))} style={colorSwatchStyle} />
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                    <PixelCheckbox checked={useTie} onChange={setUseTie} label={tr('characterBuilder.wearTie')} />
                    {useTie && (
                      <input type="color" value={toHex(tie)} onChange={(e) => setTie(fromHex(e.target.value))} style={colorSwatchStyle} />
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <PixelCheckbox checked={usePants} onChange={setUsePants} label={tr('characterBuilder.overridePants')} />
                    {usePants && (
                      <input type="color" value={toHex(pants)} onChange={(e) => setPants(fromHex(e.target.value))} style={colorSwatchStyle} />
                    )}
                  </div>
                </>
              )}

              {tab === 'accessory' && (
                <>
                  <Field label={tr('characterBuilder.accessory')}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <RecipeThumb
                        recipe={{ ...recipe, accessory: undefined, accessoryColor: undefined }}
                        selected={!useAccessory}
                        onClick={() => setUseAccessory(false)}
                        label={tr('characterBuilder.accessoryNone')}
                      />
                      {ACCESSORY_OPTIONS.map((a) => (
                        <RecipeThumb
                          key={a}
                          recipe={{ ...recipe, accessory: a, accessoryColor: useAccessory && accessory === a ? accessoryColor : ACCESSORY_DEFAULT_COLOR[a] }}
                          selected={useAccessory && accessory === a}
                          onClick={() => { setUseAccessory(true); setAccessory(a); setAccessoryColor(ACCESSORY_DEFAULT_COLOR[a]); }}
                          label={accessoryLabel(a)}
                        />
                      ))}
                    </div>
                  </Field>
                  {useAccessory && (
                    <Field label={tr('characterBuilder.accessoryColor')}>
                      <input type="color" value={toHex(accessoryColor)} onChange={(e) => setAccessoryColor(fromHex(e.target.value))} style={colorSwatchStyle} />
                    </Field>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '10px 16px',
          boxShadow: 'inset 0 1px 0 var(--cth-ink-100)'
        }}>
          <PixelButton variant="ghost" size="md" onClick={onClose}>{tr('common.cancel')}</PixelButton>
          <PixelButton variant="primary" size="md" onClick={save}>{tr('characterBuilder.save')}</PixelButton>
        </div>
      </div>
    </PixelModal>
  );
}
