import assert from 'node:assert/strict';
import { mockImport } from './mock-import.mjs';
import { eventOffsetAt, playbackEventFrom, playbackEvents } from '../../web/playback-effects.js';

class Target extends EventTarget {
  value = 0; checked = false; hidden = true;
  matches() { return false; }
}
let seconds = 0, scheduler;
const calls = [];
const audio = Object.assign(new Target(), { paused:true, currentTime:3, playbackRate:1, duration:12,
  play() { this.paused=false; this.dispatchEvent(new Event('play')); return Promise.resolve(); },
  pause() { this.paused=true; this.dispatchEvent(new Event('pause')); },
});
const lane = { id:'guitar', volume:1, notes:[
  {pitch:60,start:1,end:5,bend:'full'}, {pitch:64,start:1,end:6},
  {pitch:67,start:0,end:1}, {pitch:69,start:2,end:8,fx:{palmMute:true}},
  {pitch:72,start:7,end:8},
], _synth:{ volume:{value:0}, onsetSec:0 } };
const S = { state:{ duration:12,stems:[],lanes:[lane] }, voicingRevision:0,
  scoreTime:3,scorePlaying:false,toneReady:true,detectRegion:null };
const win = new Target(), noop = () => {};
const saved = Object.fromEntries(['window','document','Tone','performance','requestAnimationFrame','setInterval','clearInterval','CustomEvent'].map(key=>[key,globalThis[key]]));
try {
  const tone = {getContext:()=>({currentTime:seconds,rawContext:{outputLatency:0}})};
  Object.assign(globalThis,{window:win,document:{hidden:false},Tone:tone,
    performance:{now:()=>seconds*1000},requestAnimationFrame:noop,
    setInterval(fn) {scheduler=fn;return 1;},clearInterval:noop,
    CustomEvent:class extends Event {constructor(type,options){super(type);this.detail=options.detail;}},
  });
  win.Tone=tone;
  const dom=Object.fromEntries(['editorEl','metroOn','playBtn','scroll','seek','speedSel','timeEl'].map(key=>[key,new Target()]));
  const playback=await mockImport(new URL('../../web/playback.js',import.meta.url),{
    './dom.js':{...dom,audio,$:()=>null},'./store.js':{S},'./repaint.js':{draw:noop,drawNow:noop},
    './grid.js':{gridSegments:()=>[],gridAt:()=>({bpm:120})},
    './lanes.js':{editLanes:()=>[lane],releaseLaneSynth:noop,applyLaneVolume:noop},
    './volume.js':{busLevel:()=>1},
    './viewport-motion.js':{viewportFollowing:()=>false,stopViewportMotion:noop},
    './playback-effects.js':{playbackEventFrom,playbackEvents,
      playSampleEvent(synth,event,when,heard,rate){calls.push({event,when,heard,rate});}},
  },{'./constants.js':true,'./util.js':true,'./region-loop.js':true,'./keymap.js':true});
  playback.init_playback();
  await playback.playTransport(); scheduler();
  assert.deepEqual(calls.map(c=>c.event.pitch),[60,64],'start inside a chord resumes every sounding member only');
  assert.deepEqual(calls.map(c=>c.event.duration),[2,3],'only the remaining duration is played');
  assert.equal(eventOffsetAt(calls[0].event,0),eventOffsetAt(playbackEvents(lane.notes).find(e=>e.pitch===60),2),'bend resumes at the current pitch');
  seconds+=.05; scheduler();
  assert.equal(calls.length,2,'ordinary scheduler ticks do not reattack sustained notes');
  playback.seekPlayback(4); scheduler();
  assert.deepEqual(calls.slice(-2).map(c=>c.event.duration),[1,2],'seeking while playing resumes the remaining tails');
  playback.pauseTransport(); calls.length=0;
  await playback.playTransport(); scheduler();
  assert.equal(calls.length,2,'pause/resume inside a chord does not leave it silent');
  playback.pauseTransport(); calls.length=0;
  audio.playbackRate=.5; playback.seekPlayback(3);
  await playback.playTransport(); scheduler();
  assert.equal(calls[0].rate,.5,'remaining song duration still follows playback speed');
  playback.pauseTransport(); calls.length=0;

  audio.playbackRate=1; S.detectRegion={t0:3,t1:3.2}; playback.seekPlayback(3);
  await playback.playTransport(); scheduler();
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>Math.abs(c.event.duration-.2)<1e-9),'loop end caps notes that began before the loop');
  seconds+=.25; scheduler();
  assert.equal(calls.length,4,'a loop beginning mid-note restarts its sustains on each pass');
  playback.pauseTransport(); calls.length=0;

  // Exercise the media clock as well as the score-only clock.
  S.detectRegion=null; S.state.stems=[{id:'master'}]; S.mediaNode={};
  audio.currentTime=3; await playback.playTransport();
  audio.currentTime=3.01; seconds+=.01; scheduler();
  assert.deepEqual(calls.map(c=>c.event.pitch),[60,64],'audio-backed start also resumes held notes');
  playback.seekPlayback(4); audio.currentTime=4.01; seconds+=.01; scheduler();
  assert.equal(calls.length,4,'audio-backed seek resumes the chord again');
  assert.ok(calls.slice(-2).every(c=>c.event.start>=4 && c.event.duration<=2));
} finally {Object.assign(globalThis,saved);}
console.log('Start, seek, pause/resume, speed and mid-note loops: OK');
