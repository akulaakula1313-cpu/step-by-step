const assert=require('node:assert/strict');
const Module=require('module'); const orig=Module._load;
Module._load=function(req,p,m){
 if(req==='express'){const e=()=>({use(){},get(){}});e.static=()=>()=>{};return e;}
 if(req==='socket.io') return {Server:class{}};
 return orig(req,p,m);
};
const g=require('./server.js');
g.setIO({to(){return {emit(){}}}});
function room(n){return {id:'R'+n+'_'+Math.random(),maxPlayers:n,players:Array.from({length:n},(_,i)=>({id:'P'+i,isBot:false,name:'P'+i})),state:null,rematchVotes:new Set(),rematchTimer:null,botLoopTimeout:null};}
function cards(r){let s=r.state;return [...Object.values(s.hands).flat(),...s.deck,...(s.discard||[]),...s.table.flatMap(x=>[x.attack,x.defense].filter(Boolean))]}
function inv(r){let s=r.state,c=cards(r);assert.equal(c.length,36);assert.equal(new Set(c.map(x=>x.id)).size,36);for(const x of c){assert(g.SUITS.includes(x.suit));assert(g.RANKS.some(y=>y.rank===x.rank&&y.value===x.value));}
 if(s.table.length){assert(s.table.length<=s.attackLimit,'table over attackLimit'); for(const p of s.table){if(p.defense) assert(g.canBeat(p.attack,p.defense,s.trumpSuit));}}
 if(!s.isGameOver && s.deck.length>0 && s.table.length===0){for(const p of s.playersInfo) assert((s.hands[p.id]||[]).length >= 6,'active hand below refill target');}
}
function legalRandom(r){let s=r.state,n=s.playersInfo.length;
 if(s.isGameOver)return false;
 if(s.pendingTake){const p=s.playersInfo[s.currentThrowerIdx],h=s.hands[p.id]||[],ranks=g.getTableRanks(s.table);const m=h.filter(c=>ranks.has(c.rank)); if(m.length && s.table.length<s.attackLimit && Math.random()<.65)return g.handlePlayCard(r,p.id,m[Math.floor(Math.random()*m.length)].id); return g.handlePass(r,p.id);}
 const d=s.playersInfo[s.defenderIdx]; const un=s.table.find(x=>!x.defense);
 if(un){const h=s.hands[d.id]||[],v=h.filter(c=>g.canBeat(un.attack,c,s.trumpSuit)); if(v.length&&Math.random()<.75)return g.handlePlayCard(r,d.id,v[Math.floor(Math.random()*v.length)].id); return g.handleTake(r,d.id);}
 if(!s.table.length){const a=s.playersInfo[s.attackerIdx],h=s.hands[a.id]||[]; assert(h.length>0); return g.handlePlayCard(r,a.id,h[Math.floor(Math.random()*h.length)].id);}
 const t=s.playersInfo[s.currentThrowerIdx],h=s.hands[t.id]||[],ranks=g.getTableRanks(s.table),m=h.filter(c=>ranks.has(c.rank));
 if(m.length && s.table.length<s.attackLimit && Math.random()<.7)return g.handlePlayCard(r,t.id,m[Math.floor(Math.random()*m.length)].id);
 return g.handlePass(r,t.id);
}
let total=0;
for(const n of [2,3,4]) for(let run=0;run<100;run++){
 const r=room(n);g.initGameState(r);inv(r);let steps=0;
 while(!r.state.isGameOver&&steps<20000){const ok=legalRandom(r);assert(ok,'random legal action failed');inv(r);steps++;}
 if(r.rematchTimer)clearInterval(r.rematchTimer);
 if(!r.state.isGameOver){console.error('STALL', {n,run,steps,deck:r.state.deck.length,table:r.state.table.length,pending:r.state.pendingTake,a:r.state.attackerIdx,d:r.state.defenderIdx,t:r.state.currentThrowerIdx,hands:Object.fromEntries(Object.entries(r.state.hands).map(([k,v])=>[k,v.length])),tablePairs:r.state.table.map(x=>({a:x.attack.id+':'+x.attack.rank+x.attack.suit,d:x.defense&&x.defense.id+':'+x.defense.rank+x.defense.suit})),tableRanks:g.getTableRanks(r.state.table),attackLimit:r.state.attackLimit}); process.exit(2);}  assert(steps<20000); total++;
}
console.log('OVERALL RANDOM GAME TESTS PASSED:',total,'games');
