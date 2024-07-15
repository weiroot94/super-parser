import spEventsMgr from '../src/util/sp_events_manager.js';

function c1() {
  console.log('an event occurred!');
}

function c2() {
  console.log('yet another event occurred!');
}

spEventsMgr.on(spEventsMgr.event_manifest_parsed, c1); // Register for eventOne
spEventsMgr.on('eventOne', c2); // Register for eventOne

spEventsMgr.emit(spEventsMgr.event_manifest_parsed);