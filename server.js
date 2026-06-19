// ============================================================
//  Hearthwood multiplayer server  (plain Node.js + ws)
//  ----------------------------------------------------------
//  • Holds the shared WORLD_SEED so every player builds the
//    identical world locally.
//  • "Rooms = zones": you only receive players in YOUR zone.
//  • Broadcasts a snapshot of each room 15 times a second.
//  • Relays chat. ~10 players is trivial for this.
//
//  Run it:   npm install   then   npm start
//  Deploy:   see MULTIPLAYER-SETUP.md
// ============================================================

const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// ---- durable player saves (Render Persistent Disk) ----
// Render mounts your disk at the path you set; default to /data, fall back to a
// local folder for testing so the server still runs anywhere.
let SAVE_DIR = process.env.SAVE_DIR || '/data';
try { fs.mkdirSync(SAVE_DIR, { recursive: true }); fs.accessSync(SAVE_DIR, fs.constants.W_OK); }
catch (e) { SAVE_DIR = path.join(__dirname, 'hearthwood-saves'); try { fs.mkdirSync(SAVE_DIR, { recursive: true }); } catch (e2) {} }
console.log('Saves stored in: ' + SAVE_DIR);
function acctKey(name){ return String(name||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,24); }
function acctPath(name){ return path.join(SAVE_DIR, acctKey(name) + '.json'); }
function readAcct(name){ try { return JSON.parse(fs.readFileSync(acctPath(name), 'utf8')); } catch (e) { return null; } }
function writeAcct(name, obj){ try { fs.writeFileSync(acctPath(name), JSON.stringify(obj)); return true; } catch (e) { return false; } }

// ---- global shared lists (bug reports + wish list), visible to everyone ----
function listsPath(){ return path.join(SAVE_DIR, '_lists.json'); }
function readLists(){ try { return JSON.parse(fs.readFileSync(listsPath(), 'utf8')); } catch (e) { return { bugs:[], wishes:[] }; } }
function writeLists(o){ try { fs.writeFileSync(listsPath(), JSON.stringify(o)); } catch (e) {} }
let LISTS = readLists(); if(!LISTS.bugs) LISTS.bugs=[]; if(!LISTS.wishes) LISTS.wishes=[];
function listsMsg(){ return { t:'lists', bugs:LISTS.bugs, wishes:LISTS.wishes }; }

const PORT = process.env.PORT || 2567;       // hosts set PORT automatically
const WORLD_SEED = 424242;                    // the whole realm grows from this — keep it fixed forever
const TICK_MS = 1000 / 15;                    // 15 snapshots per second

// a tiny health page so you can open the server URL in a browser and see it's alive
const SERVER_VERSION = 'REVERTED-ORIGINAL-2026-06-20';   // bump on every deploy to confirm Render updated
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hearthwood server [' + SERVER_VERSION + '] is running. Players online: ' + clients.size);
});

const wss = new WebSocketServer({ server });
const clients = new Map();   // ws -> player
const plots = {};            // gid -> { name, tier, ownerId }  (house ownership)
let nextId = 1;

function send(ws, obj){ if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } }
function broadcastPlots(){ const out = { t:'plots', map:plots }; for (const ws2 of clients.keys()) send(ws2, out); }
function wsById(id){ for (const [ws, p] of clients) { if (p.id === id) return ws; } return null; }
// ---- per-zone host election (one player simulates each zone's monsters) ----
const zoneHost = {};   // zone -> player id
function assignHost(zone){
  if (!zone) return;
  const inZone = [...clients.values()].filter(p => p.zone === zone);
  if (inZone.length === 0) { delete zoneHost[zone]; return; }
  const cur = zoneHost[zone];
  // prefer an ACTIVE (foregrounded) player as host; only fall back to inactive if all are
  const active = inZone.filter(p => !p.inactive);
  const pool = active.length ? active : inZone;
  if (!cur || !pool.some(p => p.id === cur)) zoneHost[zone] = pool[0].id;  // (re)elect from the eligible pool
  const hid = zoneHost[zone];
  for (const [ws2, q] of clients) if (q.zone === zone) send(ws2, { t:'host', zone, host: q.id === hid });
}
// ============================================================
//  SERVER-AUTHORITATIVE MOB SIMULATION
//  The server owns every zone's monsters. Clients upload the
//  (seed-deterministic) collision grid + spawn data once per
//  zone, then become pure renderers. No host, no alt-tab freeze.
// ============================================================
const TILE = 16;
const zoneMaps = {};   // zone -> { w,h,solid:Uint8Array, spawns, maxMobs, level, bossSpawn, campSpawns, playerSpawn, etypes }
const zoneMobs = {};   // zone -> [ mob ]
const zoneSpawnCd = {};
let _mid = 1;
function srnd(a,b){ return a + Math.random()*(b-a); }
function sri(a,b){ return Math.floor(a + Math.random()*(b-a+1)); }
function sdist(ax,ay,bx,by){ return Math.hypot(ax-bx, ay-by); }
function mapSolidPx(map,x,y){ const tx=Math.floor(x/TILE), ty=Math.floor(y/TILE); if(tx<0||ty<0||tx>=map.w||ty>=map.h) return true; return !!map.solid[ty*map.w+tx]; }
function mapBoxSolid(map,cx,cy,hw,hh){ return mapSolidPx(map,cx-hw,cy-hh)||mapSolidPx(map,cx+hw,cy-hh)||mapSolidPx(map,cx-hw,cy+hh)||mapSolidPx(map,cx+hw,cy+hh)||mapSolidPx(map,cx,cy+hh)||mapSolidPx(map,cx,cy-hh); }

// store a client-provided map for a zone (first valid upload wins; identical for all via the seed)
function ingestZoneMap(zone, d){
  if(zoneMaps[zone]) return;
  if(!d || !d.w || !d.h || !d.solid || !d.etypes) return;
  const solid = Uint8Array.from(d.solid);
  zoneMaps[zone] = { w:d.w, h:d.h, solid, spawns:d.spawns||[], maxMobs:d.maxMobs||0, level:d.level||1,
                     bossSpawn:d.bossSpawn||null, campSpawns:d.campSpawns||[], playerSpawn:d.playerSpawn||{x:d.w*TILE/2,y:d.h*TILE/2}, etypes:d.etypes,
                     bossSpawns:d.bossSpawns||null, partyScale:Math.max(1,Math.min(4, d.partyScale||1)), dungeon:!!d.dungeon };
  zoneMobs[zone] = [];
  if(d.bossSpawns && d.bossSpawns.length){
    // dungeon: spawn each room boss, HP/damage scaled by party size
    for(const b of d.bossSpawns){ const mob=spawnMob(zone, b.type, b.x, b.y, true, zoneMaps[zone].partyScale); if(mob){ mob.bossAI=b.bossAI||mob.bossAI; mob.room=b.room; } }
  } else if((d.maxMobs||0) > 0){
    // boss + camp guards + an initial population
    if(d.bossSpawn) spawnMob(zone, d.bossSpawn.type, d.bossSpawn.x, d.bossSpawn.y, true);
    for(const c of (d.campSpawns||[])) spawnMob(zone, c.type||'mercenary', c.x, c.y, false);
    const initial = Math.min(Math.round(d.maxMobs*0.55), d.maxMobs);
    for(let i=0;i<initial;i++) spawnRandomMobAt(zone);
  }
}
function spawnMob(zone, type, x, y, isBoss, bossScale){
  const map=zoneMaps[zone]; if(!map) return null;
  const t=map.etypes[type]; if(!t) return null;
  const lvl=map.level||1;
  const bs=isBoss?(bossScale||1):1;
  const scaleHp = (isBoss? 1 : (1+(lvl-1)*0.6)) * bs;
  const scaleDmg = (isBoss? (1+(bs-1)*0.25) : (1+(lvl-1)*0.4));
  const baseHp = isBoss ? (t.hp*4) : t.hp;   // dungeon bosses are beefy (~1000 HP solo class)
  const mob={ id:'m'+(_mid++), type, x, y, homeX:x, homeY:y,
    hp:Math.round(baseHp*scaleHp), maxHp:Math.round(baseHp*scaleHp), dmg:Math.round(t.dmg*scaleDmg),
    speed:t.speed, speedBase:t.speed, range:t.range, atkspd:t.atkspd, aggro:t.aggro, xp:t.xp, gold:t.gold,
    scale:t.scale, boss:!!isBoss, atype:t.atype||'melee', flee:!!t.flee, mount:t.mount||null, elite:!!t.elite,
    dir:'down', state:'idle', atkCd:srnd(0,1), wanderT:0, vx:0, vy:0, stun:0, slow:0, lastHitBy:null,
    castCd: isBoss? srnd(4,6):0, bossAI:t.bossAI||null };
  zoneMobs[zone].push(mob);
  return mob;
}
function spawnRandomMobAt(zone){
  const map=zoneMaps[zone]; if(!map || !map.spawns.length) return;
  if((zoneMobs[zone]||[]).filter(m=>!m.boss).length >= map.maxMobs) return;
  // a walkable spot away from all players
  for(let tries=0; tries<14; tries++){
    const tx=sri(3,map.w-4), ty=sri(3,map.h-4);
    if(map.solid[ty*map.w+tx]) continue;
    const x=tx*TILE+8, y=ty*TILE+8;
    let near=false; for(const p of clients.values()){ if(p.zone===zone && sdist(p.x,p.y,x,y)<150){ near=true; break; } }
    if(near) continue;
    let total=0; for(const s of map.spawns) total+=s.w; let roll=Math.random()*total, type=map.spawns[0].type;
    for(const s of map.spawns){ roll-=s.w; if(roll<=0){ type=s.type; break; } }
    spawnMob(zone, type, x, y, false); return;
  }
}
function stepMobToward(map, o, tx, ty, speed, dt, hw, hh){
  let base=Math.atan2(ty-o.y, tx-o.x);
  if(o._detourT>0){ o._detourT-=dt; base+=o._detour*0.9; }
  for(const off of [0,0.5,-0.5,1.0,-1.0,1.6,-1.6,2.2,-2.2,2.8,-2.8]){
    const a=base+off, nx=o.x+Math.cos(a)*speed*dt, ny=o.y+Math.sin(a)*speed*dt;
    let moved=false;
    if(!mapBoxSolid(map,nx,o.y,hw,hh)){ o.x=nx; moved=true; }
    if(!mapBoxSolid(map,o.x,ny,hw,hh)){ o.y=ny; moved=true; }
    if(moved){ o._stuckT=0; return true; }
  }
  if(o._detourT<=0){ o._detour=(Math.random()<0.5?1:-1); o._detourT=0.7; }
  return false;
}
// players present in a zone (targets)
function zonePlayers(zone){ const a=[]; for(const p of clients.values()) if(p.zone===zone && !p.dead) a.push(p); return a; }
function nearestPlayer(zone, x, y){ let best=null,bd=1e9; for(const p of zonePlayers(zone)){ const d=sdist(x,y,p.x,p.y); if(d<bd){bd=d;best=p;} } return best?{p:best,d:bd}:null; }
// apply mob damage to a backgrounded player's server-side HP mirror; kill + announce if it drops
function damageAwayPlayer(zone, p, dmg){
  const real = Math.max(1, Math.round(dmg - (p.def||0)*0.6));
  p.hp = (p.hp==null? (p.maxHp||100) : p.hp) - real;
  if(p.hp <= 0 && !p.dead){
    p.dead = true; p.deadAt = Date.now();
    for(const [ws2,q] of clients) if(q.zone===zone) send(ws2, { t:'pdead', id:p.id, name:p.name });
  }
}

// one simulation step for a zone (called from the tick)
function simZone(zone, dt){
  const map=zoneMaps[zone]; const mobs=zoneMobs[zone]; if(!map||!mobs) return;
  const leash = 520;   // ~one screen in world px
  for(let i=mobs.length-1;i>=0;i--){
    const e=mobs[i];
    e.atkCd=Math.max(0,e.atkCd-dt);
    e.stun=Math.max(0,e.stun-dt); e.slow=Math.max(0,e.slow-dt);
    e.speed=e.speedBase*(e.slow>0?0.45:1);
    if(e.stun>0) continue;
    const near=nearestPlayer(zone, e.x, e.y);
    const tgt=near?near.p:null, d=near?near.d:1e9;
    const distHome=sdist(e.x,e.y,e.homeX,e.homeY);
    // boss AOE telegraph (server-driven; broadcast so all see + can be hit)
    if(e.boss && e.bossAI){ e.castCd-=dt; if(e.castCd<=0 && tgt){ e.castCd= e.bossAI==='dragon'?7:3; runServerBossAI(zone,e,tgt); } }
    if(e.flee){
      if(tgt && d<170){ const ang=Math.atan2(e.y-tgt.y,e.x-tgt.x)+srnd(-0.4,0.4); stepMobToward(map,e,e.x+Math.cos(ang)*60,e.y+Math.sin(ang)*60,e.speed,dt,4,3); e.dir=Math.cos(ang)<0?'left':'right'; }
      else { e.wanderT-=dt; if(e.wanderT<=0){ e.wanderT=srnd(1,2.5); e.vx=srnd(-1,1); e.vy=srnd(-1,1); } stepMobToward(map,e,e.x+e.vx*40,e.y+e.vy*40,e.speed*0.4,dt,4,3); }
      continue;
    }
    if(!e.boss && distHome>leash){ e.state='return'; }
    if(e.state==='return'){ if(distHome<30){ e.state='idle'; } else { stepMobToward(map,e,e.homeX,e.homeY,e.speed,dt,5,4); continue; } }
    if(tgt && (d<e.aggro || e.boss)) e.state='chase';
    else if(d>e.aggro*1.6) e.state='idle';
    if(e.state==='chase' && tgt){
      if(d>e.range*0.85){ stepMobToward(map,e,tgt.x,tgt.y,e.speed,dt,4,3); e.dir = Math.abs(tgt.x-e.x)>Math.abs(tgt.y-e.y)?(tgt.x<e.x?'left':'right'):(tgt.y<e.y?'up':'down'); }
      else if(e.atkCd<=0){ e.atkCd=1/e.atkspd; e.swing=0.2;
        // active players apply damage on their own client; AWAY players take it server-side so they can die
        const tws=wsById(tgt.id);
        if(tgt.inactive){ damageAwayPlayer(zone, tgt, e.dmg); }
        else if(tws) send(tws, { t:'ehit', dmg:e.dmg, kind:e.atype });
      }
    } else {
      e.wanderT-=dt; if(e.wanderT<=0){ e.wanderT=srnd(1.5,3.5); e.vx=srnd(-1,1); e.vy=srnd(-1,1); }
      if(distHome>70){ e.vx=(e.homeX-e.x); e.vy=(e.homeY-e.y); const l=Math.hypot(e.vx,e.vy)||1; e.vx/=l; e.vy/=l; }
      stepMobToward(map,e,e.x+e.vx*40,e.y+e.vy*40,e.speed*0.4,dt,5,4);
    }
  }
  // respawn over time
  zoneSpawnCd[zone]=(zoneSpawnCd[zone]||0)-dt;
  if(zoneSpawnCd[zone]<=0){ zoneSpawnCd[zone]=srnd(2.5,4.5); spawnRandomMobAt(zone); }
}
function runServerBossAI(zone,e,tgt){
  // each boss has signature, telegraphed mechanics; clients render the cause/effect
  const players=zonePlayers(zone);
  const out={ t:'saoe', zone, kind:e.bossAI, x:Math.round(tgt.x), y:Math.round(tgt.y), bx:Math.round(e.x), by:Math.round(e.y), spots:[] };
  if(e.bossAI==='lava'){
    // lava geysers erupt under several players after a 1.6s tell
    e.castCd=srnd(4,6);
    const spots=[{x:Math.round(tgt.x),y:Math.round(tgt.y)}];
    for(let i=0;i<Math.min(3,players.length);i++){ const p=players[(i+1)%players.length]; spots.push({x:Math.round(p.x+srnd(-30,30)),y:Math.round(p.y+srnd(-30,30))}); }
    for(let i=0;i<2;i++) spots.push({x:Math.round(e.x+srnd(-90,90)),y:Math.round(e.y+srnd(-70,70))});
    out.spots=spots; out.delay=1.6; out.r=46; out.dmg=Math.round(e.dmg*1.4);
  } else if(e.bossAI==='void'){
    // expanding void rifts centred on each player
    e.castCd=srnd(4.5,6.5);
    out.spots=players.map(p=>({x:Math.round(p.x),y:Math.round(p.y)}));
    out.delay=1.8; out.r=64; out.dmg=Math.round(e.dmg*1.3);
  } else if(e.bossAI==='quake'){
    // ground slam → fissures crack outward from the boss toward the target
    e.castCd=srnd(5,7);
    const ang=Math.atan2(tgt.y-e.y, tgt.x-e.x);
    const spots=[]; for(let i=1;i<=5;i++){ const d=i*42; spots.push({x:Math.round(e.x+Math.cos(ang)*d),y:Math.round(e.y+Math.sin(ang)*d)}); }
    out.spots=spots; out.delay=1.4; out.r=40; out.dmg=Math.round(e.dmg*1.6); out.slam=1;
  } else if(e.bossAI==='knight'){
    e.kphase=(e.kphase||0)+1;
    if(e.kphase%2===1){
      // ground slam → expanding shockwave ring
      e.castCd=srnd(5,6.5); e.swing=0.4;
      out.kind='shockwave'; out.delay=0.9; out.maxR=200; out.expand=1.1; out.dmg=Math.round(e.dmg*1.3);
    } else {
      // flaming sword plunge → lava geysers erupt under the party
      e.castCd=srnd(5,6.5); e.swing=0.4;
      out.kind='lava';
      const spots=[{x:Math.round(tgt.x),y:Math.round(tgt.y)}];
      for(let i=0;i<Math.min(3,players.length);i++){ const p=players[(i+1)%players.length]; spots.push({x:Math.round(p.x+srnd(-26,26)),y:Math.round(p.y+srnd(-26,26))}); }
      out.spots=spots; out.delay=1.5; out.r=46; out.dmg=Math.round(e.dmg*1.3);
    }
  }
  for(const [ws2,q] of clients) if(q.zone===zone) send(ws2,out);
}
// apply a player's hit to a server mob; handle death + rewards broadcast
function applyHitToMob(zone, id, dmg, crit, byId){
  const mobs=zoneMobs[zone]; if(!mobs) return;
  const e=mobs.find(m=>m.id===id); if(!e) return;
  e.hp-=dmg; e.lastHitBy=byId; e.state='chase'; e.hurt=0.12;
  if(e.hp<=0){
    const idx=mobs.indexOf(e); if(idx>=0) mobs.splice(idx,1);
    const out={ t:'mdead', zone, id:e.id, by:e.lastHitBy, boss:!!e.boss, type:e.type, xp:e.xp|0, x:Math.round(e.x), y:Math.round(e.y) };
    for(const [ws2,q] of clients) if(q.zone===zone) send(ws2,out);
  }
}
// compact mob snapshot for clients
function mobSnapshot(zone){
  const mobs=zoneMobs[zone]||[]; const list=[];
  for(const e of mobs){ list.push({ id:e.id, t:e.type, x:Math.round(e.x), y:Math.round(e.y), hp:Math.round(e.hp), mh:e.maxHp, dir:e.dir, b:e.boss?1:0, sc:e.scale, st:e.state, at:e.atype, sw:e.swing>0?1:0, hu:e.hurt>0?1:0 }); e.swing=Math.max(0,(e.swing||0)-0.08); e.hurt=Math.max(0,(e.hurt||0)-0.08); }
  return list;
}

// build a friend list with live online status for a player
function sendFriendList(ws, player){
  const acct = readAcct(player.account) || {};
  const friends = (acct.friends || []).map(fkey => {
    let online = false, name = fkey;
    for (const q of clients.values()) { if (q.account === fkey) { online = true; name = q.name; break; } }
    if (!online) { const fa = readAcct(fkey); if (fa) name = fa.name || fkey; }
    return { key:fkey, name, online };
  });
  send(ws, { t:'social_list', friends });
}

// ============================================================
//  PARTIES (up to 4) + shared Need/Greed loot rolls
// ============================================================
const parties = {};   // pid -> { id, leader, members:[playerId] }
const lootRolls = {}; // rollId -> { item, members:[id], choices:{}, rolls:{}, zone, t }
let _pid = 1, _rid = 1;
function partyOf(p){ return p && p.party && parties[p.party] ? parties[p.party] : null; }
function partyBroadcast(pid){
  const party = parties[pid]; if(!party) return;
  const roster = party.members.map(mid => { for(const q of clients.values()) if(q.id===mid) return { id:mid, name:q.name, color:q.color, leader:mid===party.leader }; return null; }).filter(Boolean);
  for(const mid of party.members){ const ws2 = wsById(mid); if(ws2) send(ws2, { t:'party_state', members:roster }); }
}
function leaveParty(p){
  const party = partyOf(p); if(!party) return;
  party.members = party.members.filter(id => id !== p.id);
  p.party = null;
  if(party.members.length <= 1){ for(const mid of party.members){ const q=[...clients.values()].find(c=>c.id===mid); if(q){ q.party=null; const ws2=wsById(mid); if(ws2) send(ws2,{t:'party_state',members:[]}); } } delete parties[party.id]; }
  else { if(party.leader===p.id) party.leader=party.members[0]; partyBroadcast(party.id); }
  const ws=wsById(p.id); if(ws) send(ws,{t:'party_state',members:[]});
}
function resolveLootRoll(rollId){
  const r = lootRolls[rollId]; if(!r || r.done) return; r.done = true;
  // who needs / greeds (anyone who didn't answer counts as pass)
  const need = r.members.filter(id => r.choices[id]==='need');
  const greed = r.members.filter(id => r.choices[id]==='greed');
  const pool = need.length ? need : greed;
  const rolls = [];
  let winner = null, best = -1;
  for(const id of pool){ const roll = 1 + Math.floor(Math.random()*100); rolls.push({ id, roll, choice: need.length?'need':'greed' }); if(roll > best){ best = roll; winner = id; } }
  const nameOf = id => { for(const q of clients.values()) if(q.id===id) return q.name; return '?'; };
  const out = { t:'loot_award', rollId, item:r.item, winnerId:winner, winnerName: winner?nameOf(winner):null,
                rolls: rolls.map(x=>({ name:nameOf(x.id), roll:x.roll, choice:x.choice })) };
  for(const mid of r.members){ const ws2 = wsById(mid); if(ws2) send(ws2, out); }
  delete lootRolls[rollId];
}

wss.on('connection', (ws) => {
  const id = 'u' + (nextId++);
  const player = { id, name:'Adventurer', color:'#7fd0ff', look:null,
                   x:0, y:0, dir:'down', zone:'town', moving:false, chat:null, chatUntil:0 };
  clients.set(ws, player);

  // hand the new client its id + the shared world seed + current plot ownership
  send(ws, { t:'welcome', id, seed: WORLD_SEED, plots });

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (m.t === 'checkname') {
      // unique-name check (case-insensitive) against everyone currently connected
      const want = ('' + (m.name || '')).trim().toLowerCase();
      let taken = false;
      for (const q of clients.values()) { if (q !== player && (q.name || '').toLowerCase() === want) { taken = true; break; } }
      send(ws, { t:'nameres', name:m.name, ok: !taken && want.length > 0 });
    } else if (m.t === 'login') {
      // name + 4-digit PIN. New name -> create account. Existing -> PIN must match.
      const key = acctKey(m.name); const pin = String(m.pin||'').slice(0,8);
      if (!key || pin.length < 3) { send(ws, { t:'login_fail', reason:'Enter a name and a 4-digit PIN' }); return; }
      const acct = readAcct(key);
      // one live session per character: refuse if that account is already connected
      for (const q of clients.values()) { if (q !== player && q.account === key) { send(ws, { t:'login_fail', reason:'That hero is already logged in elsewhere' }); return; } }
      if (acct) {
        if (acct.pin !== pin) { send(ws, { t:'login_fail', reason:'Wrong PIN for that hero' }); return; }
        player.account = key; player.name = acct.name || m.name;
        send(ws, { t:'login_ok', save: acct.save || null, isNew: !acct.save, name: player.name });
      } else {
        player.account = key; player.name = ('' + (m.name||'Hero')).slice(0,16);
        writeAcct(key, { name: player.name, pin, save: null, created: Date.now() });
        send(ws, { t:'login_ok', save: null, isNew: true, name: player.name });
      }
    } else if (m.t === 'cloudsave') {
      if (player.account && m.save) {
        const acct = readAcct(player.account) || { name: player.name, pin: '0000' };
        acct.save = m.save; acct.name = player.name; acct.updated = Date.now();
        writeAcct(player.account, acct);
      }
    } else if (m.t === 'join') {
      player.name   = ('' + (m.name || 'Adventurer')).slice(0, 16);
      player.color  = m.color  || player.color;
      player.zone   = m.zone   || player.zone;
      if (m.look) player.look = m.look;
      assignHost(player.zone);
      send(ws, listsMsg());
    } else if (m.t === 'list_get') {
      send(ws, listsMsg());
    } else if (m.t === 'list_add') {
      const kind = m.kind==='wish' ? 'wishes' : 'bugs'; const arr = LISTS[kind];
      const e = (m.entry && typeof m.entry==='object') ? m.entry : {};
      const o = { id:'L'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
        by:(''+(player.name||'Anon')).slice(0,16), ts:Date.now(), wip:false, done:false };
      if(kind==='bugs'){ o.what=(''+(e.what||'')).slice(0,140); o.occur=(''+(e.occur||'')).slice(0,220); if(!o.what && !o.occur) return; }
      else { o.title=(''+(e.title||'')).slice(0,90); o.body=(''+(e.body||'')).slice(0,1000); if(!o.title && !o.body) return; }
      arr.unshift(o); if(arr.length>300) arr.length=300; writeLists(LISTS);
      for (const ws2 of clients.keys()) send(ws2, listsMsg());
    } else if (m.t === 'list_toggle') {
      const kind = m.kind==='wish' ? 'wishes' : 'bugs'; const it=(LISTS[kind]||[]).find(x=>x.id===m.id);
      if(it){ if(m.field==='wip'){ it.wip=!it.wip; if(it.wip) it.done=false; } else { it.done=!it.done; if(it.done) it.wip=false; } writeLists(LISTS); for (const ws2 of clients.keys()) send(ws2, listsMsg()); }
    } else if (m.t === 'list_del') {
      const kind = m.kind==='wish' ? 'wishes' : 'bugs'; LISTS[kind]=(LISTS[kind]||[]).filter(x=>x.id!==m.id); writeLists(LISTS);
      for (const ws2 of clients.keys()) send(ws2, listsMsg());
    } else if (m.t === 'look') {
      if (m.look) player.look = m.look;
    } else if (m.t === 'state') {
      const oldZone = player.zone;
      player.x = m.x; player.y = m.y;
      player.dir = m.dir || 'down';
      player.zone = m.zone || player.zone;
      player.moving = !!m.moving;
      player.sw = m.sw?1:0;
      if (m.hp != null) player.hp = m.hp;
      if (m.maxHp != null) player.maxHp = m.maxHp;
      if (m.def != null) player.def = m.def;
      if (player.zone !== oldZone) { assignHost(oldZone); assignHost(player.zone); }
    } else if (m.t === 'active') {
      // foreground/background signal — a backgrounded host yields the zone to an active player
      const was = player.inactive;
      player.inactive = !m.active;
      // returning from away after dying there → tell the client to run its death/respawn
      if (m.active && player.dead) { player.dead = false; const ws2 = wsById(player.id); if (ws2) send(ws2, { t:'youdied' }); }
      if (was !== player.inactive) assignHost(player.zone);
    } else if (m.t === 'zonemap') {
      // a client uploads the seed-deterministic collision grid + spawn data for a zone
      ingestZoneMap(m.zone, m);
    } else if (m.t === 'hit') {
      // a player damaged a server-owned mob → apply authoritatively
      applyHitToMob(player.zone, m.id, m.dmg|0, !!m.crit, player.id);
    } else if (m.t === 'fx') {
      // visual-only effect/projectile/slash — relay to everyone else in the zone
      const out = Object.assign({}, m);
      for (const [ws2, q] of clients) if (q !== player && q.zone === player.zone) send(ws2, out);
    } else if (m.t === 'party_invite') {
      const tws = wsById(m.to), tp = tws && clients.get(tws);
      const party = partyOf(player);
      if (tp && (!party || party.members.length < 4)) send(tws, { t:'party_invite', from:player.id, name:player.name });
    } else if (m.t === 'party_accept') {
      const iws = wsById(m.from), inviter = iws && clients.get(iws);
      if (!inviter) return;
      let party = partyOf(inviter);
      if (!party) { const pid = 'pty'+(_pid++); party = parties[pid] = { id:pid, leader:inviter.id, members:[inviter.id] }; inviter.party = pid; }
      if (party.members.length >= 4) { send(ws, { t:'party_full' }); return; }
      if (!party.members.includes(player.id)) { leaveParty(player); party.members.push(player.id); player.party = party.id; }
      partyBroadcast(party.id);
    } else if (m.t === 'party_leave') {
      leaveParty(player);
    } else if (m.t === 'dungeon_start') {
      // party leader instigates a dungeon run → ready-check to every member
      const party = partyOf(player);
      if (party && party.leader === player.id) {
        party.ready = {}; party.dungeon = m.zone;
        for (const mid of party.members){ const ws2 = wsById(mid); if (ws2) send(ws2, { t:'dungeon_check', zone:m.zone, leader:player.name }); }
      } else if (!party) { send(ws, { t:'dungeon_go', zone:m.zone }); }   // solo → straight in
    } else if (m.t === 'dungeon_ready') {
      const party = partyOf(player);
      if (party && party.ready){ party.ready[player.id] = true;
        // tell everyone who's ready so far
        for (const mid of party.members){ const ws2 = wsById(mid); if (ws2) send(ws2, { t:'dungeon_readystate', ready:party.members.filter(id=>party.ready[id]).length, total:party.members.length }); }
        if (party.members.every(id => party.ready[id])){ for (const mid of party.members){ const ws2 = wsById(mid); if (ws2) send(ws2, { t:'dungeon_go', zone:party.dungeon }); } party.ready = {}; }
      }
    } else if (m.t === 'loot_start') {
      // killer offers a dropped item to the party for a Need/Greed roll
      const party = partyOf(player);
      if (!party || party.members.length < 2 || !m.item) { send(ws, { t:'loot_solo', item:m.item }); return; }
      const rollId = 'r'+(_rid++);
      lootRolls[rollId] = { item:m.item, members:party.members.slice(), choices:{}, done:false };
      const out = { t:'loot_roll', rollId, item:m.item, from:player.name };
      for (const mid of party.members){ const ws2 = wsById(mid); if (ws2) send(ws2, out); }
      setTimeout(()=>resolveLootRoll(rollId), 12000);   // auto-resolve if someone stalls
    } else if (m.t === 'loot_choice') {
      const r = lootRolls[m.rollId];
      if (r && !r.done && r.members.includes(player.id)) {
        r.choices[player.id] = (m.choice==='need'||m.choice==='greed') ? m.choice : 'pass';
        if (r.members.every(id => r.choices[id] != null)) resolveLootRoll(m.rollId);
      }
    } else if (m.t === 'claim') {
      // claim/upgrade a house plot. One home per player: free any other plot they hold.
      const gid = '' + m.gid, tier = '' + (m.tier || 'basic');
      const cur = plots[gid];
      if (cur && cur.ownerId !== player.id) { send(ws, { t:'plots', map:plots }); return; } // taken — resync
      for (const g in plots) { if (plots[g].ownerId === player.id && g !== gid) delete plots[g]; }
      plots[gid] = { name: player.name, tier, ownerId: player.id };
      broadcastPlots();
    } else if (m.t === 'trade_req') {
      const tws = wsById(m.to); if (tws) send(tws, { t:'trade_req', from:player.id, name:player.name });
    } else if (m.t === 'trade_accept') {
      const tws = wsById(m.to), tp = tws && clients.get(tws);
      if (tp) { player.tradeWith = tp.id; tp.tradeWith = player.id;
        player.tradeOffer = { items:[], gold:0 }; tp.tradeOffer = { items:[], gold:0 }; player.tradeOK = false; tp.tradeOK = false;
        send(ws,  { t:'trade_start', other:{ id:tp.id, name:tp.name } });
        send(tws, { t:'trade_start', other:{ id:player.id, name:player.name } }); }
    } else if (m.t === 'trade_offer') {
      player.tradeOffer = { items:(m.items||[]).slice(0,12), gold:Math.max(0, m.gold|0) }; player.tradeOK = false;
      const tws = wsById(player.tradeWith), tp = tws && clients.get(tws);
      if (tp) { tp.tradeOK = false; send(tws, { t:'trade_other', items:player.tradeOffer.items, gold:player.tradeOffer.gold }); send(ws, { t:'trade_otherconfirm', confirmed:false }); }
    } else if (m.t === 'trade_confirm') {
      player.tradeOK = !!m.confirmed;
      const tws = wsById(player.tradeWith), tp = tws && clients.get(tws);
      if (tp) { send(tws, { t:'trade_otherconfirm', confirmed:player.tradeOK });
        if (player.tradeOK && tp.tradeOK) {
          send(ws,  { t:'trade_done', get:tp.tradeOffer, give:player.tradeOffer });
          send(tws, { t:'trade_done', get:player.tradeOffer, give:tp.tradeOffer });
          player.tradeWith = null; tp.tradeWith = null;
        } }
    } else if (m.t === 'trade_cancel') {
      const tws = wsById(player.tradeWith), tp = tws && clients.get(tws);
      if (tws) send(tws, { t:'trade_cancel', reason:player.name + ' cancelled the trade' });
      if (tp) tp.tradeWith = null; player.tradeWith = null;
    } else if (m.t === 'chat') {
      const text = ('' + m.text).slice(0, 120);
      const ch = m.ch || 'world';
      if (ch === 'world' || ch === 'area' || ch === 'local') { player.chat = text.slice(0,80); player.chatUntil = Date.now() + 5000; }
      const out = { t:'say', ch, name:player.name, color:player.color, zone:player.zone, text };
      if (ch === 'area') {
        // AREA: only players in the same zone
        for (const [ws2, q] of clients) if (q.zone === player.zone) send(ws2, out);
      } else if (ch === 'guild') {
        // GUILD: same guild tag (guild system TBD — for now, only members of a shared tag)
        const g = player.guild || null;
        for (const [ws2, q] of clients) if (g && q.guild === g) send(ws2, out);
        if (!g) send(ws, { t:'say', ch:'guild', name:'System', color:'#caa46a', text:'You are not in a guild yet.' });
      } else {
        // WORLD: everyone
        for (const ws2 of clients.keys()) send(ws2, out);
      }
    } else if (m.t === 'social_add') {
      const fkey = acctKey(m.name);
      if (!player.account) { send(ws, { t:'social_err', reason:'Log in with a hero to add friends' }); return; }
      if (!fkey || fkey === player.account) { send(ws, { t:'social_err', reason:'Enter a valid hero name' }); return; }
      const target = readAcct(fkey);
      if (!target) { send(ws, { t:'social_err', reason:'No hero named "' + m.name + '" exists' }); return; }
      const acct = readAcct(player.account) || {};
      acct.friends = acct.friends || [];
      if (!acct.friends.includes(fkey)) { acct.friends.push(fkey); writeAcct(player.account, acct); }
      sendFriendList(ws, player);
    } else if (m.t === 'social_remove') {
      const fkey = acctKey(m.name);
      const acct = readAcct(player.account) || {};
      acct.friends = (acct.friends || []).filter(f => f !== fkey);
      writeAcct(player.account, acct);
      sendFriendList(ws, player);
    } else if (m.t === 'social_list') {
      sendFriendList(ws, player);
    } else if (m.t === 'dm') {
      const fkey = acctKey(m.to);
      const text = ('' + m.text).slice(0, 200);
      // find an online client on that account
      let tws = null, tname = m.to;
      for (const [ws2, q] of clients) { if (q.account === fkey) { tws = ws2; tname = q.name; break; } }
      const stamp = { t:'dm', from:player.name, fromKey:player.account, to:tname, toKey:fkey, text, ts:Date.now() };
      send(ws, stamp);                       // echo to sender
      if (tws && tws !== ws) send(tws, stamp); // deliver to recipient
      else if (!tws) send(ws, { t:'dm_offline', to:m.to });
    }
  });

  ws.on('close', () => {
    // final cloud save on disconnect (best effort)
    const tws = wsById(player.tradeWith); if (tws) send(tws, { t:'trade_cancel', reason:'The other player left' });
    const tp = tws && clients.get(tws); if (tp) tp.tradeWith = null;
    const z = player.zone;
    leaveParty(player);
    clients.delete(ws);
    assignHost(z);   // hand the zone's monsters to someone else
  });
  ws.on('error', () => clients.delete(ws));
});

// broadcast a per-zone snapshot to everyone, 15x/sec; the server also SIMULATES mobs
let _lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.2, (now - _lastTick)/1000) || TICK_MS/1000; _lastTick = now;
  const byZone = {};
  for (const p of clients.values()) (byZone[p.zone] = byZone[p.zone] || []).push(p);

  // run the authoritative mob simulation for every occupied zone
  for (const zone in byZone) {
    if (zoneMaps[zone]) simZone(zone, dt);
    else {
      // no map yet — ask one occupant to upload the seed-deterministic grid
      const asker = byZone[zone][0];
      if (asker && !asker._askedMap) { asker._askedMap = true; const ws = wsById(asker.id); if (ws) send(ws, { t:'needmap', zone }); }
    }
  }

  for (const [ws, p] of clients) {
    const peers = byZone[p.zone] || [];
    const list = [];
    for (const q of peers) {
      if (q.id === p.id) continue;
      list.push({ id:q.id, name:q.name, color:q.color, look:q.look,
                  x:Math.round(q.x), y:Math.round(q.y), dir:q.dir, moving:q.moving, sw:q.sw?1:0, dead:q.dead?1:0,
                  chat: q.chatUntil > now ? q.chat : null });
    }
    send(ws, { t:'players', zone:p.zone, here: peers.length, online: clients.size, list });
    if (zoneMaps[p.zone]) send(ws, { t:'mobs', zone:p.zone, list: mobSnapshot(p.zone) });
  }

  // free mobs/maps for zones nobody is in (so they re-seed fresh next time)
  for (const zone in zoneMobs) { if (!byZone[zone]) { delete zoneMobs[zone]; delete zoneMaps[zone]; for (const p of clients.values()) p._askedMap = false; } }
}, TICK_MS);

server.listen(PORT, () => console.log('Hearthwood server listening on port ' + PORT));
