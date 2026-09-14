const test=require('node:test');
const assert=require('node:assert/strict');
const loadTs=require('./load-ts.cjs');
const {startStationActivity}=loadTs('src/renderer/src/scene/office/stationActivity.ts');
test('flag off never even resolves resource dependencies',()=>{
 let calls=0;
 for(let i=0;i<100;i++)assert.equal(startStationActivity(false,()=>{calls++;throw Error('allocated');}),null);
 assert.equal(calls,0);
});
test('hooks work without terminal parser or view; disable cleans subscriptions, timers, and late replies',()=>{
 let hook,parser,exit,subscribed=0,unsubscribed=0,moved=0,shown=0,now=1000;
 const timers=new Map();let serial=0;
 const subscribe=(set)=>cb=>{set(cb);subscribed++;return()=>unsubscribed++;};
 const session=startStationActivity(true,()=>({
  map:{width:8,height:8,isWalkable:(x,y)=>x>=0&&x<8&&y>=0&&y<8},
  onHook:subscribe(cb=>hook=cb),onParser:subscribe(cb=>parser=cb),
  onExit:(_id,cb)=>subscribe(x=>exit=x)(cb),
  director:{spots:[{kind:'terminal',stand:{x:3,y:3},facing:'up'}],now:()=>now,
   schedule:(fn,ms)=>{timers.set(++serial,{fn,ms});return serial;},clear:id=>timers.delete(id),
   eligible:()=>true,show:()=>shown++,hide:()=>{},visit:()=>{moved++;return true;},cancel:()=>{}}
 }));
 session.connections.bind('a','pty-a');assert.equal(subscribed,3);
 const e={event:'PreToolUse',agentId:'a',tool:'Bash',receivedAt:now,provenance:'hook',toolPhase:'requested',sessionId:'s',invocationId:'i'};
 hook(e);assert.equal(shown,1);now+=1500;
 const [timerId,timer]=[...timers].find(([id,t])=>t.ms===1200);timers.delete(timerId);timer.fn();assert.equal(moved,1);
 session.dispose();assert.equal(timers.size,0);assert.equal(unsubscribed,3);
 hook({...e,receivedAt:now,invocationId:'late'});parser({...e,provenance:'parser'});exit();
 assert.equal(shown,1);assert.equal(timers.size,0);session.dispose();assert.equal(unsubscribed,3);
});
