#!/usr/bin/env python3
"""Offline rasterizer for office.tmj — mirrors TiledMapRenderer so we can
visually verify the map without launching Electron. Usage:
    python3 render_map.py [map.tmj] [out.png] [--labels]
"""
import base64, json, sys, os, subprocess
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(__file__)
ASSETS = os.path.abspath(os.path.join(HERE, '..', '..', 'src', 'renderer', 'src', 'assets'))

FLIP_H = 0x80000000
FLIP_V = 0x40000000
FLIP_D = 0x20000000
GID_MASK = 0x1FFFFFFF

# firstgid -> (image path, columns, tilew, tileh)
TILESETS = [
    (1,    'tilesets/office-tileset.png',        16, 16, 16),
    (513,  'tilesets/a5-office-floors-walls.png',16, 16, 16),
    (1025, 'tilesets/interiors.png',             16, 16, 16),
]
TILE_LAYERS = ['floor', 'walls', 'furniture-below', 'furniture-above']
SCALE = 3

def load_sheets(m=None, mappath=None):
    if m and any(p.get('name') == 'proceduralAtlas' and p.get('value') == 'tech-office'
                 for p in m.get('properties', [])):
        # The TS module is the source of truth for both the browser and PNG.
        # Fail loudly if Node/art generation fails; never substitute old art.
        result = subprocess.run(
            ['node', os.path.join(HERE, 'export-tech-preview.cjs'), os.path.abspath(mappath)],
            check=True, capture_output=True, text=True)
        atlas = json.loads(result.stdout)
        img = Image.frombytes('RGBA', (atlas['width'], atlas['height']), base64.b64decode(atlas['rgba']))
        return [(1, img, atlas['columns'], 16, 16)], atlas['monitorOffsets'], atlas['monitorGids']
    out = []
    for firstgid, path, cols, tw, th in TILESETS:
        img = Image.open(os.path.join(ASSETS, path)).convert('RGBA')
        out.append((firstgid, img, cols, tw, th))
    return out, {}, {}

def resolve(gid, sheets):
    for firstgid, img, cols, tw, th in reversed(sheets):
        if gid >= firstgid:
            local = gid - firstgid
            sx = (local % cols) * tw
            sy = (local // cols) * th
            return img.crop((sx, sy, sx+tw, sy+th)), tw, th
    return None, 16, 16

def render(mappath, outpath, labels=False):
    m = json.load(open(mappath))
    W, H, TS = m['width'], m['height'], m['tilewidth']
    sheets, monitor_offsets, monitor_gids = load_sheets(m, mappath)
    tech = m.get('tilesets', [{}])[0].get('image') == 'procedural:tech-office'
    canvas = Image.new('RGBA', (W*TS, H*TS), (22, 29, 36, 255) if tech else (20, 18, 30, 255))
    layers = {l['name']: l for l in m['layers']}
    for name in TILE_LAYERS:
        l = layers.get(name)
        if not l or 'data' not in l:
            continue
        data = l['data']
        for y in range(H):
            for x in range(W):
                raw = data[y*W + x]
                if raw == 0:
                    continue
                fh = bool(raw & FLIP_H); fv = bool(raw & FLIP_V); fd = bool(raw & FLIP_D)
                gid = raw & GID_MASK
                if name == 'furniture-above':
                    gid = monitor_gids.get(f'{x},{y}', gid)
                tile, tw, th = resolve(gid, sheets)
                if tile is None:
                    continue
                if fd:
                    tile = tile.transpose(Image.TRANSPOSE)
                if fh:
                    tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
                if fv:
                    tile = tile.transpose(Image.FLIP_TOP_BOTTOM)
                display_y = y + (monitor_offsets.get(f'{x},{y}', 0) if name == 'furniture-above' else 0)
                canvas.alpha_composite(tile, (x*TS, display_y*TS))

    canvas = canvas.resize((W*TS*SCALE, H*TS*SCALE), Image.NEAREST)
    draw = ImageDraw.Draw(canvas)

    # collision overlay (faint red) + grid
    col = layers.get('collision')
    if col and 'data' in col and labels:
        for y in range(H):
            for x in range(W):
                if col['data'][y*W+x] & GID_MASK:
                    draw.rectangle([x*TS*SCALE, y*TS*SCALE, (x+1)*TS*SCALE-1, (y+1)*TS*SCALE-1],
                                   outline=(255,0,0,60))

    if labels:
        try:
            font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 11)
        except Exception:
            font = ImageFont.load_default()
        for l in m['layers']:
            if l['type'] != 'objectgroup':
                continue
            isspawn = l['name'] == 'spawn-points'
            for o in l['objects']:
                px = int(o['x']/TS)*TS*SCALE
                py = int(o['y']/TS)*TS*SCALE
                color = (0,255,180) if isspawn else (255,200,0)
                draw.rectangle([px+2, py+2, px+TS*SCALE-2, py+TS*SCALE-2], outline=color, width=2)
                draw.text((px+3, py+3), o.get('name','?'), fill=color, font=font)

    canvas.convert('RGB').save(outpath)
    print('wrote', outpath, canvas.size)

if __name__ == '__main__':
    mp = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ASSETS, 'maps/office.tmj')
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'preview.png')
    render(mp, out, labels='--labels' in sys.argv)
