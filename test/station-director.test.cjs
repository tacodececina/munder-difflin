const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { StationDirector } = loadTs('src/renderer/src/scene/office/stationDirector.ts');
function rig(spots = [{kind:'terminal',stand:{x:3,y:3},facing:'up'}]) {
  let now = 1000, serial = 0;
  const timers = new Map(), calls = [];
  const director = new StationDirector({ spots, now: () => now,
    schedule: (fn, ms) => { timers.set(++serial,{fn,at:now+ms}); return serial; },
    clear: id => timers.delete(id), eligible: () => true,
    show: (id,e) => calls.push(['show',id,e.toolPhase,e.provenance]),
    hide: id => calls.push(['hide',id]),
    visit: (id,spot,arrived,failed) => { calls.push(['visit',id,spot]); return true; },
    cancel: id => calls.push(['cancel',id]),
  });
  function advance(ms) { now += ms; for (const [id,t] of [...timers]) if(t.at<=now){timers.delete(id);t.fn();} }
  function event(patch={}) { director.observe({event:'PreToolUse',agentId:'a',tool:'Bash',provenance:'hook',receivedAt:now,sessionId:'s',invocationId:'i',toolPhase:'requested',...patch}); }
  return {director,calls,timers,event,advance};
}
test('short tool displays a request immediately but never walks after completion',()=>{
 const r=rig();r.event();assert.deepEqual(r.calls[0],['show','a','requested','hook']);
 r.advance(200);r.event({event:'PostToolUse',toolPhase:'completed'});r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);r.director.dispose();assert.equal(r.timers.size,0);
});
test('sustained correlated request visits once, then real denial cancels immediately',()=>{
 const r=rig();r.event();r.advance(1500);assert.equal(r.calls.filter(x=>x[0]==='visit').length,1);
 assert.equal(r.director.owns('a'),true);r.event({toolPhase:'denied'});
 assert.equal(r.calls.filter(x=>x[0]==='cancel').length,1);
});
test('missing IDs, parser and proxy observations never move',()=>{
 for(const patch of [{invocationId:undefined},{sessionId:undefined},{provenance:'parser'},{provenance:'proxy'}]){
 const r=rig();r.event(patch);r.advance(1500);assert.equal(r.calls.some(x=>x[0]==='visit'),false);r.director.dispose();}
});
test('parser cannot overwrite authoritative evidence even after completion',()=>{
 const r=rig();r.event();r.event({toolPhase:'completed'});const n=r.calls.length;
 r.event({provenance:'parser',tool:'Read'});assert.equal(r.calls.length,n);
});
test('overlapping calls and unrelated completions do not resurrect a visit',()=>{
 const r=rig();r.event();r.event({invocationId:'j'});r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);
 r.event({invocationId:'i',toolPhase:'completed'});r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);
});
test('completion before request tombstones invocation; old session cannot return',()=>{
 const r=rig();r.event({toolPhase:'completed'});r.event();r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);
 r.event({sessionId:'new',invocationId:'j'});r.event({sessionId:'s',invocationId:'old'});r.advance(1500);
 assert.equal(r.calls.filter(x=>x[0]==='visit').length,1);
});
test('duplicate request cannot postpone its observation expiry',()=>{
 const r=rig();r.event();r.advance(10000);r.event();r.advance(6000);
 assert.equal(r.director.owns('a'),false);
});
test('blocked, disconnect, disable and late callbacks leave no activity resources',()=>{
 for(const stop of [r=>r.director.block('a'),r=>r.director.disconnect('a'),r=>r.director.dispose()]){
 const r=rig();r.event();stop(r);r.advance(30000);assert.equal(r.calls.some(x=>x[0]==='visit'),false);assert.equal(r.timers.size,0);}
});
test('legacy theme without stations remains at its desk',()=>{
 const r=rig(undefined); // explicitly use an empty station list below
 r.director.dispose();const empty=rig([]);empty.event();empty.advance(1500);
 assert.equal(empty.calls.some(x=>x[0]==='visit'),false);
});
test('an uncorrelated request prevents a later correlated request from travelling',()=>{
 const r=rig();r.event({invocationId:undefined});r.event({invocationId:'known'});r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);
});
test('retired session cannot replay after disconnect/reconnect; a new session works',()=>{
 const r=rig();r.event();r.director.disconnect('a');r.director.reconnect('a');r.event();r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);
 r.event({sessionId:'new',invocationId:'new'});r.advance(1500);
 assert.equal(r.calls.filter(x=>x[0]==='visit').length,1);
});
test('parser status refresh cannot unblock a constrained breaker',()=>{
 const r=rig();r.director.setBreaker('a',true);r.director.unblock('a');r.event();r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);
 r.director.setBreaker('a',false);r.event();r.advance(1500);
 assert.equal(r.calls.filter(x=>x[0]==='visit').length,1);
});
test('late cancelled timers cannot cancel or move a newer observation',()=>{
 const r=rig();r.event();const callbacks=[...r.timers.values()].map(t=>t.fn);
 r.event({sessionId:'new',invocationId:'j'});for(const fn of callbacks)fn();
 assert.equal(r.director.owns('a'),true);r.advance(1500);
 assert.equal(r.calls.filter(x=>x[0]==='visit').length,1);
});
test('bounded per-session history does not prevent a new session',()=>{
 const r=rig();for(let i=0;i<300;i++)r.event({invocationId:String(i),toolPhase:'completed'});
 r.event({sessionId:'new',invocationId:'new'});r.advance(1500);
 assert.equal(r.calls.filter(x=>x[0]==='visit').length,1);
});
test('stale SessionStart cannot reopen a disconnected agent',()=>{
 const r=rig();r.event();r.director.disconnect('a');r.advance(19000);
 r.event({event:'SessionStart',sessionId:'unseen',receivedAt:1000});
 r.event({sessionId:'unseen',invocationId:'late'});r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);
});
test('unrelated completions cannot grow the bounded history forever',()=>{
 const r=rig();r.event();for(let i=0;i<1000;i++)r.event({invocationId:'other'+i,toolPhase:'completed'});
 assert.ok(r.director.agents.get('a').closed.size<=256);
});
test('SessionEnd retires that session and rejects late new request IDs',()=>{
 const r=rig();r.event();r.event({event:'SessionEnd'});r.event({invocationId:'late'});r.advance(1500);
 assert.equal(r.calls.some(x=>x[0]==='visit'),false);
});
