'use strict';
const loadTs = require('../../test/load-ts.cjs');
const { buildWalkable, parseSpawnPoints, parseZones } = loadTs('src/renderer/src/scene/office/tiledCollision.ts');
const { readDeskVisualOffsets, monitorVisualOffsets } = loadTs('src/renderer/src/scene/office/deskVisuals.ts');
const { TECH_ATLAS_META, TECH_PIECES, techGid } = loadTs('src/renderer/src/scene/office/techOfficeArt.ts');
const { OFFICE_BINDINGS: B, OFFICE_SEATS, OFFICE_CAFE } = loadTs('src/renderer/src/scene/office/officeLayout.ts');

function validateOfficeMap(map) {
  const errors = [], check = (ok, msg) => { if (!ok) errors.push(msg); };
  const fail = () => { if (errors.length) throw new Error(errors.join('\n')); };
  const names = ['floor', 'walls', 'furniture-below', 'furniture-above', 'collision', 'spawn-points', 'zones'];
  // #7: check final serialized layers, not just in-memory aliases.
  check(Array.isArray(map.layers), '#7 missing layers'); fail();
  check(map.layers.length === names.length && names.every(n => map.layers.filter(l => l.name === n).length === 1), '#7 exact layer names (one of each) required');
  check(map.orientation === 'orthogonal' && map.tilewidth === 16 && map.tileheight === 16, 'office requires a 16px orthogonal map');
  check(Number.isInteger(map.width) && Number.isInteger(map.height) && map.width > 0 && map.height > 0, 'invalid dimensions');
  fail();
  const W = map.width, H = map.height, index = (x, y) => y * W + x;
  const inb = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H;
  const L = Object.fromEntries(map.layers.map(l => [l.name, l]));
  for (const name of names.slice(0, 5)) {
    const l = L[name];
    check(l.type === 'tilelayer' && l.width === W && l.height === H && l.data?.length === W * H, `#7 invalid tile layer ${name}`);
  }
  for (const name of names.slice(5)) check(L[name].type === 'objectgroup' && Array.isArray(L[name].objects), `#7 invalid object layer ${name}`);
  check(map.tilesets?.length === 1 && Object.entries(TECH_ATLAS_META).every(([k, v]) => map.tilesets[0][k] === v), 'atlas metadata differs from runtime');
  fail();
  const painted = new Set([0, 365, 366, 381, 382]);
  for (const p of Object.values(TECH_PIECES)) for (let i = 0; i < p.w * p.h; i++) painted.add(p.gid + i);
  for (const name of names.slice(0, 5)) for (const gid of L[name].data) {
    if (!Number.isInteger(gid) || !(name === 'collision' ? gid === 0 || gid === 1 : painted.has(gid))) {
      check(false, `unpainted or invalid gid ${gid} in ${name}`); break;
    }
  }
  const objects = L['spawn-points'].objects;
  check(new Set(objects.map(o => o.name)).size === objects.length, 'duplicate spawn name');
  for (const o of objects) check(o.x % 16 === 0 && o.y % 16 === 0 && inb(o.x / 16, o.y / 16), `invalid spawn ${o.name}`);
  fail();
  const spawns = parseSpawnPoints(map), walk = buildWalkable(map);
  const free = (x, y) => inb(x, y) && walk.isWalkable(x, y);
  const at = (name, x, y) => inb(x, y) ? L[name].data[index(x, y)] : undefined;
  const neighbors = t => [[t.x, t.y - 1], [t.x, t.y + 1], [t.x - 1, t.y], [t.x + 1, t.y]];
  const offsets = readDeskVisualOffsets(map);
  for (const o of objects) for (const p of o.properties ?? []) if (p.name === 'monitorOffsetY') {
    check(p.type === 'int' && p.value === 3, `invalid monitor offset ${o.name}`);
  }
  for (const expected of [...OFFICE_SEATS, ...OFFICE_CAFE]) {
    const s = spawns.get(expected.name);
    check(s && s.x === expected.x && s.y === expected.y, `theme binding missing or moved: ${expected.name}`);
  }
  // #1 / #2 / #3. Check all four monitor cells, not only 365.
  for (const name of B.primarySeatNames) {
    const s = spawns.get(name); if (!s) continue;
    for (const [gid, dx, dy] of [[365, 0, -2], [366, 1, -2], [381, 0, -1], [382, 1, -1]])
      check(at('furniture-above', s.x + dx, s.y + dy) === gid, `#1 ${name}: incomplete monitor block (${gid})`);
    check(at('furniture-above', s.x - 1, s.y - 1) === 0, `#2 ${name}: shelf slot occupied`);
    check(neighbors(s).some(([x, y]) => !free(x, y)), `#3 ${name}: no blocked facing neighbor`);
    const offset = offsets.get(`${s.x},${s.y}`) ?? 0;
    const expected = OFFICE_SEATS.find(o => o.name === name)?.monitorOffsetY ?? 0;
    check(offset === expected, `${name}: missing visual offset for facing island`);
    check(offset ? free(s.x, s.y - 1) && !free(s.x, s.y + 1) : !free(s.x, s.y - 1), `#3 ${name}: avatar faces away from its surface`);
    check(inb(s.x + 1, s.y - 1 + offset) && !free(s.x - 1, s.y - 1 + offset), `${name}: displaced shelf has no desk surface`);
  }
  // #4 / #6. Café seats and stands never receive prefix overrides.
  const cafe = B.cafeSeatNames.map(n => [n, spawns.get(n)]).filter(([, t]) => t);
  for (const [name, a] of cafe) {
    check(cafe.filter(([n, b]) => n !== name && a.x === b.x && Math.abs(a.y - b.y) === 2).length === 1, `#4 ${name}: requires one partner in its column exactly 2 tiles away`);
    check(neighbors(a).some(([x, y]) => !free(x, y)), `#3 ${name}: no table to face`);
    const partner = cafe.find(([n, b]) => n !== name && a.x === b.x && Math.abs(a.y - b.y) === 2)?.[1];
    if (partner) check(partner.y > a.y ? free(a.x, a.y - 1) && !free(a.x, a.y + 1) : !free(a.x, a.y - 1), `#3 ${name}: faces away from cafe partner`);
  }
  for (const [name, s] of spawns) if (name.startsWith('cafe-')) check(at('collision', s.x, s.y) === 0, `#6 ${name}: collision must be explicitly empty`);
  const entry = spawns.get('entrance');
  check(entry && free(entry.x, entry.y), '#5 missing or invalid entrance'); fail();
  // Shared engine walkability, including the exact prefix overrides.
  const visited = new Set([`${entry.x},${entry.y}`]), queue = [entry];
  for (let i = 0; i < queue.length; i++) for (const [x, y] of neighbors(queue[i])) {
    const k = `${x},${y}`;
    if (free(x, y) && !visited.has(k)) { visited.add(k); queue.push({ x, y }); }
  }
  const reached = t => t && visited.has(`${t.x},${t.y}`);
  const ring = queue.filter(t => Math.max(Math.abs(t.x - entry.x), Math.abs(t.y - entry.y)) <= 6 && (t.x !== entry.x || t.y !== entry.y));
  check(ring.length >= 16, '#5 entrance needs at least 16 reachable waiting tiles within Chebyshev 6');
  for (const [name, s] of spawns) check(reached(s), `unreachable spawn ${name}`);
  for (const name of ['trayStand', 'machineStand', 'sinkStand']) check(reached(B.coffee[name]), `unreachable coffee.${name}`);
  for (const name of ['trayTile', 'sinkTile']) check(!free(B.coffee[name].x, B.coffee[name].y), `coffee.${name} must sit on furniture`);
  for (const name of ['boardPinStand', 'boardTakeStand', 'boardArchiveStand']) check(reached(B.anchors[name]), `unreachable anchors.${name}`);
  for (const name of ['boards', 'askBoard']) check(at('walls', B.anchors[name].x, B.anchors[name].y) === techGid('wall', 0, 2), `${name} must hang on a wall base`);
  for (const e of B.errandSpots) {
    check(reached(e.stand), `unreachable errand ${e.kind} at ${e.stand.x},${e.stand.y}`);
    check(Math.abs(e.stand.x - e.fx.x) + Math.abs(e.stand.y - e.fx.y) <= 2, `errand ${e.kind} detached from prop`);
  }
  // #8: enumerate required names to detect missing/misspelled zones too.
  const zones = parseZones(map);
  check(zones.size === L.zones.objects.length, '#8 duplicate zone name');
  for (const name of ['wing-engineering', 'wing-warroom', 'wing-meeting', 'wing-deploy', 'wing-break', 'boardroom']) {
    const z = zones.get(name);
    check(!!z, `#8 missing zone ${name}`);
    if (z) check(z.width > 0 && z.height > 0 && inb(z.x, z.y) && inb(z.x + z.width - 1, z.y + z.height - 1)
      && queue.some(t => t.x >= z.x && t.x < z.x + z.width && t.y >= z.y && t.y < z.y + z.height), `#8 invalid or unreachable zone ${name}`);
  }
  const dest = new Set();
  for (const [k, dy] of monitorVisualOffsets(map)) {
    const [x, y] = k.split(',').map(Number), target = `${x},${y + dy}`;
    check(inb(x, y + dy) && at('furniture-above', x, y + dy) === 0 && !dest.has(target), `monitor display collision at ${target}`);
    dest.add(target);
  }
  fail();
  return { seats: B.primarySeatNames.length, reachable: queue.length, waiting: ring.length };
}
module.exports = { validateOfficeMap };
