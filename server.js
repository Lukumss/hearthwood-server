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
// Phase 1: server-authoritative DAMAGE maths. Loaded defensively so a
// missing/broken rules.js can NEVER crash boot or block login.
let rules = null;
try { rules = require('./rules'); console.log('rules.js loaded — server-authoritative damage ACTIVE'); }
catch (e) { console.error('rules.js not loaded — damage falls back to clamped client value:', e.message); }

// Phase 2: server-authoritative ECONOMY (gold/XP/inventory/shops). Activated
// ONLY by an explicit PHASE2=1 env var — so live can never turn it on by
// accident. You set PHASE2=1 in the STAGING service's Environment tab.
const PHASE2 = (process.env.PHASE2 === '1');
let economy = null;
if (PHASE2) {
  try { economy = require('./economy'); console.log('economy.js loaded — PHASE2 server-authoritative economy ACTIVE'); }
  catch (e) { console.error('PHASE2 set but economy.js failed to load — economy stays client-side:', e.message); }
}
// build the authoritative player-state message the client renders. The server now
// owns ALL progression, so it pushes the COMPLETE state (every STATE_FIELD) — the
// client treats this as truth and never mutates these fields itself.
function pstateMsg(player){ const p = {}; for (const f of economy.STATE_FIELDS) p[f] = player.econ[f]; return { t:'pstate', p }; }
function pushState(ws, player){ if (economy && player.econ) send(ws, pstateMsg(player)); }
// persist a PHASE2 player's authoritative econ into their account save on disk
function saveEcon(player){
  if (!economy || !player.econ || !player.account) return;
  const acct = readAcct(player.account) || { name: player.name, pin: '0000' };
  acct.save = economy.mergeIntoSave(acct.save || player.save || { v:1, p:{} }, player.econ);
  acct.name = player.name; acct.updated = Date.now();
  writeAcct(player.account, acct);
  player.save = acct.save;
}

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
const SERVER_VERSION = 'LIVE-2026-06-20';   // bump on every deploy to confirm Render updated
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hearthwood server [' + SERVER_VERSION + '] is running. Players online: ' + clients.size);
});

const wss = new WebSocketServer({ server });
const clients = new Map();   // ws -> player

// ============================================================
//  ORIGIN LOCK (anti-clone guest list).
//  A browser tells us which website a connection comes from via the
//  Origin header (can't be spoofed by an ordinary web page). We only
//  accept our own site(s); a cloned client hosted elsewhere is hung
//  up on. Connections with NO origin (your own dev tools, native
//  clients) are allowed so we never lock ourselves out. Every reject
//  is logged, never crashes anything.
//  Add domains to ALLOWED_ORIGINS as needed (e.g. a custom domain).
// ============================================================
const ALLOWED_ORIGINS = [
  'remarkable-dolphin-6fd98b.netlify.app',   // live site
  'symphonious-marshmallow-3e0cad.netlify.app', // staging test client
  'localhost',                               // local dev
  '127.0.0.1',                               // local dev
];
// STAGING servers (this branch) also accept any *.netlify.app drop-deploy so
// the throwaway test client connects no matter what URL Netlify assigns.
// Detected via RENDER_SERVICE_NAME containing "staging" (set automatically by
// Render) or the STAGING env var. The LIVE service stays strictly locked.
const IS_STAGING = /staging/i.test(process.env.RENDER_SERVICE_NAME || '') || process.env.STAGING === '1';
function originAllowed(origin){
  if(!origin) return true;                   // no-origin (dev tools / native) — allow
  try {
    const host = new URL(origin).hostname;
    if(IS_STAGING && host.endsWith('.netlify.app')) return true;   // staging: any netlify deploy
    return ALLOWED_ORIGINS.some(a => host === a || host.endsWith('.' + a));
  } catch(e){ return true; }                 // unparseable — don't risk locking out
}
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
const zoneAskCd = {};   // zone -> seconds until we re-ask an occupant to upload its map
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
function serverPlayerDef(p){
  if(p && p.econ && p.econ.equip){ let d=0; const eq=p.econ.equip;
    if(eq.armor) d+=Number(eq.armor.defense)||0; if(eq.helm) d+=Number(eq.helm.defense)||0;
    return d; }
  return Number(p&&p.def)||0;
}
// AUTHORITATIVE damage to a player's server HP (active OR backgrounded). This is what
// closes godmode: the server owns HP, applies the hit, pushes the result, and the
// client renders it instead of deciding its own health.
function serverHurtPlayer(zone, p, dmg, kind){
  if(!p || p.dead) return;
  const real = Math.max(1, Math.round(Number(dmg||0) - serverPlayerDef(p)*0.6));
  const maxHp = (p.econ ? Number(p.econ.maxHp)||100 : Number(p.maxHp)||100);
  let hp = (p.econ ? (p.econ.hp==null?maxHp:Number(p.econ.hp)) : (p.hp==null?maxHp:Number(p.hp)));
  hp = Math.max(0, hp - real);
  if(p.econ) p.econ.hp = hp;
  p.hp = hp;
  const ws = wsById(p.id);
  if(ws){ send(ws, { t:'ehit', dmg:Math.round(Number(dmg||0)), kind:kind||'melee' });
          send(ws, { t:'hp', hp:Math.round(hp), maxHp:Math.round(maxHp) }); }
  if(hp<=0 && !p.dead){
    p.dead=true; p.deadAt=Date.now();
    if(p.econ){ p.econ.gold = Math.floor(Number(p.econ.gold||0)*0.85); }   // server applies the death gold penalty (was client-side)
    for(const [ws2,q] of clients) if(q.zone===zone) send(ws2, { t:'pdead', id:p.id, name:p.name });
    if(ws){ send(ws, { t:'youdied' }); pushState(ws, p); saveEcon(p); }
  }
}
// kept as an alias for existing callers (backgrounded-player damage)
function damageAwayPlayer(zone, p, dmg){ serverHurtPlayer(zone, p, dmg, 'melee'); }

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
    const peaceful = (zone==='forest' && !e.boss);   // gentle starting area
    if(!e.boss && distHome>leash){ e.state='return'; }
    if(e.state==='return'){ if(distHome<30){ e.state='idle'; if(peaceful) e.lastHitBy=null; } else { stepMobToward(map,e,e.homeX,e.homeY,e.speed,dt,5,4); continue; } }
    // Forest roamers DON'T aggro on sight (so a new player isn't mobbed) but FIGHT BACK once attacked;
    // they calm down again after leashing home (lastHitBy cleared above). The zone boss always fights.
    const provoked = peaceful && !!e.lastHitBy;
    if((!peaceful || provoked) && tgt && (d<e.aggro || e.boss)) e.state='chase';
    else if((peaceful && !provoked) || d>e.aggro*1.6) e.state='idle';
    if(e.state==='chase' && tgt){
      if(d>e.range*0.85){ stepMobToward(map,e,tgt.x,tgt.y,e.speed,dt,4,3); e.dir = Math.abs(tgt.x-e.x)>Math.abs(tgt.y-e.y)?(tgt.x<e.x?'left':'right'):(tgt.y<e.y?'up':'down'); }
      else if(e.atkCd<=0){ e.atkCd=1/e.atkspd; e.swing=0.2;
        serverHurtPlayer(zone, tgt, e.dmg, e.atype);   // SERVER owns HP for everyone now (active + away)
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
  // AUTHORITATIVE AOE damage: after the telegraph delay, the SERVER applies the hit to
  // players standing in the marked spots (client telegraphs are visual-only now).
  if(out.dmg){
    const _dmg=out.dmg, _r=(out.r||46)+12, _spots=(out.spots||[]).slice(), _ring=(out.kind==='shockwave'), _bx=e.x, _by=e.y, _maxR=out.maxR||0;
    setTimeout(()=>{ try{
      for(const p of zonePlayers(zone)){
        let hitp=false;
        if(_ring){ if(sdist(p.x,p.y,_bx,_by) <= _maxR+16) hitp=true; }
        else { for(const s of _spots){ if(sdist(p.x,p.y,s.x,s.y) <= _r){ hitp=true; break; } } }
        if(hitp) serverHurtPlayer(zone, p, _dmg, 'aoe');
      }
    }catch(_e){} }, Math.max(200,(out.delay||1.4)*1000));
  }
  for(const [ws2,q] of clients) if(q.zone===zone) send(ws2,out);
}
// apply a player's hit to a server mob; handle death + rewards broadcast.
// Phase 1: the SERVER rolls the damage from the player's own loadout — the
// client's claimed dmg is ignored when we can compute it (only a clamped
// fallback if rules.js or the loadout is unavailable). Signature unchanged
// callers: we pass the player object so we know their gear/skills.
function applyHitToMob(player, id, clientDmg){
  const zone = player.zone; const mobs=zoneMobs[zone]; if(!mobs) return;
  const e=mobs.find(m=>m.id===id); if(!e) return;
  // Phase 6: ATTACK-CADENCE GATE. The client limits attacks to 1/weaponSpeed
  // seconds apart; the server enforces the same so a scripted client can't
  // machine-gun hits. We allow generous leeway (55%) so latency/jitter never
  // blocks legit play, but anything firing >~1.8x the weapon's rate is dropped.
  const loadout = (economy && player.econ) ? player.econ : (player.save && player.save.p);
  const wpn = loadout && loadout.equip && loadout.equip.weapon;
  const atkSpeed = (wpn && Number(wpn.speed)) || 1.4;            // attacks/sec
  const minGap = (1 / atkSpeed) * 0.55 * 1000;                   // ms floor between hits ON THE SAME mob
  const now = Date.now();
  // Per-MOB cadence: a player can hit many different mobs at once (AoE skills),
  // but can't hammer a SINGLE mob faster than the weapon allows. (A per-player
  // gate broke AoE — every target was hit in the same instant and all but the
  // first hit got dropped.)
  if(!e.hitAt) e.hitAt = {};
  if ((now - (e.hitAt[player.id] || 0)) < minGap) return;
  e.hitAt[player.id] = now;
  let dmg, crit=false;
  // Phase 2: damage rolls from the AUTHORITATIVE econ loadout (server-owned),
  // not the client-authored save — closes the "cloud-save a fake weapon" hole.
  if(rules && loadout){
    const r = rules.rollHitDamage(loadout); dmg = r.dmg; crit = r.crit;
  } else {
    dmg = Math.max(1, Math.min(500, clientDmg|0));   // fail-safe clamp
  }
  e.hp-=dmg; e.lastHitBy=player.id; e.state='chase'; e.hurt=0.12;
  if(e.hp<=0){
    const idx=mobs.indexOf(e); if(idx>=0) mobs.splice(idx,1);
    const out={ t:'mdead', zone, id:e.id, by:e.lastHitBy, boss:!!e.boss, type:e.type, xp:e.xp|0, x:Math.round(e.x), y:Math.round(e.y) };
    for(const [ws2,q] of clients) if(q.zone===zone) send(ws2,out);
    // Phase 2 (full authority): the SERVER grants the ECONOMY reward (gold + items)
    // AND all PROGRESSION (XP, level, combat skill XP, kill counts, mount tame) and
    // pushes the COMPLETE authoritative state. The client no longer mutates any of it.
    if(economy && player.econ){
      const style = (player.econ.equip && player.econ.equip.weapon && player.econ.equip.weapon.atype) || 'melee';
      const reward = economy.grantKill(player.econ, e.type, zone, style);
      // Phase 2: items become GROUND DROPS (walk over to grab). If the killer is
      // in a party, GEAR instead goes to a shared Need/Greed roll.
      const party = partyOf(player);
      const present = party
        ? party.members.filter(id => { for(const q of clients.values()) if(q.id===id) return q.zone===zone; return false; })
        : [player.id];
      const owners = (present.length >= 2) ? present.slice() : [player.id];
      // ALL loot drops on the ground so it's always visible. Picking up GEAR in a
      // party triggers the Need/Greed roll (handled in econ_pickup); solo and
      // non-gear are grabbed instantly.
      for(const it of reward.items){
        const ang = Math.random()*Math.PI*2, r = 8 + Math.random()*14;
        addDrop(zone, it, e.x + Math.cos(ang)*r, e.y + Math.sin(ang)*r, owners);
      }
      // notable-drop FLEX: announce epic/legendary GEAR to EVERYONE on the server
      // (zone-wide would miss instanced dungeons — a legendary should be server-wide)
      const _RANK={common:0,uncommon:1,rare:2,epic:3,legendary:4};
      let top=null; for(const it of reward.items){ if(it && ['weapon','armor','helm','ring','cosmetic'].includes(it.kind) && (!top || _RANK[it.rarity]>_RANK[top.rarity])) top=it; }
      if(top && _RANK[top.rarity]>=3){
        const flex={ t:'lootflex', name:player.name, item:top.name, rarity:top.rarity, cosmetic:top.kind==='cosmetic' };
        for(const ws2 of clients.keys()) send(ws2, flex);
      }
      const kws = wsById(player.id);
      if(kws){ send(kws, { t:'reward', x:Math.round(e.x), y:Math.round(e.y), boss:!!e.boss, gold:reward.gold, xp:reward.xp, levelUp:!!reward.levelUp, level:reward.level, tamed:reward.tamed||null, topRarity:(top?top.rarity:null) });
        pushState(kws, player); }
    }
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
// Phase 2: server-authoritative GROUND DROPS so loot is visible on the floor and
// picked up by walking over it (the original feel) while staying dupe-proof.
const zoneDrops = {}; // zone -> [ { id, item, x, y, t, owners:[playerId,...] } ]
let _did = 1;
// owners = who may see/grab this drop (the killer, or the whole party). Strangers
// never see it — loot stays personal, exactly like the original local drops.
function addDrop(zone, item, x, y, owners){
  if(!item) return null;
  if(!zoneDrops[zone]) zoneDrops[zone] = [];
  const d = { id:'d'+(_did++), item, x:Math.round(x), y:Math.round(y), t:Date.now(), owners:owners||[] };
  zoneDrops[zone].push(d);
  return d;
}
// only the drops THIS player owns (their kills / their party's shared loot)
function dropsSnapshot(zone, playerId){
  return (zoneDrops[zone]||[]).filter(d => d.owners.indexOf(playerId) >= 0)
    .map(d=>({ id:d.id, item:d.item, x:d.x, y:d.y, manual:!!d.manual }));
}
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
  const rolls = []; let best=-1, winner=null;
  for(const id of pool){ const roll = 1 + Math.floor(Math.random()*100); rolls.push({ id, roll, choice: need.length?'need':'greed' }); if(roll > best){ best = roll; winner = id; } }
  const nameOf = id => { for(const q of clients.values()) if(q.id===id) return q.name; return '?'; };
  // Phase 2: deliver the won item to the WINNER's authoritative inventory server-side
  // (a client-side add would be wiped). Flag applied so the client doesn't double-add.
  let applied = false;
  if(economy && winner){
    const wws = wsById(winner), wp = wws && clients.get(wws);
    if(wp && wp.econ){ const it = Object.assign({}, r.item); it.id = economy.uid();
      wp.econ.inventory.push(it); saveEcon(wp); pushState(wws, wp); applied = true; }
  }
  const out = { t:'loot_award', rollId, item:r.item, winnerId:winner, winnerName: winner?nameOf(winner):null, applied,
                rolls: rolls.map(x=>({ name:nameOf(x.id), roll:x.roll, choice:x.choice })) };
  for(const mid of r.members){ const ws2 = wsById(mid); if(ws2) send(ws2, out); }
  delete lootRolls[rollId];
}
// Phase 2: start a party Need/Greed roll among the given members (already
// filtered to those present in the kill's zone). Returns true if a roll started.
function startLootRoll(killer, item, members){
  members = (members && members.length ? members : (partyOf(killer)||{members:[]}).members) || [];
  if(members.length < 2) return false;
  const rollId = 'r'+(_rid++);
  lootRolls[rollId] = { item, members: members.slice(), choices:{}, done:false };
  const out = { t:'loot_roll', rollId, item, from:killer.name };
  for(const mid of members){ const ws2 = wsById(mid); if(ws2) send(ws2, out); }
  setTimeout(()=>resolveLootRoll(rollId), 12000);
  return true;
}

wss.on('connection', (ws, req) => {
  // origin lock: refuse cloned clients hosted on other domains
  const origin = req && req.headers && req.headers.origin;
  if(!originAllowed(origin)){
    console.warn('[origin-lock] refused connection from:', origin);
    try { ws.close(4003, 'origin not allowed'); } catch(e){}
    return;
  }
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
        player.save = acct.save || null;   // Phase 1: keep loadout ref for server-side damage (NOT mutated)
        send(ws, { t:'login_ok', save: acct.save || null, isNew: !acct.save, name: player.name });
        // Phase 2: seed authoritative econ from the existing save, then push it
        if (economy) { player.econ = economy.fromSave(acct.save && acct.save.p); pushState(ws, player); }
      } else {
        player.account = key; player.name = ('' + (m.name||'Hero')).slice(0,16);
        writeAcct(key, { name: player.name, pin, save: null, created: Date.now() });
        send(ws, { t:'login_ok', save: null, isNew: true, name: player.name });
        if (economy) { player.econ = economy.fromSave(null); pushState(ws, player); }
      }
    } else if (m.t === 'cloudsave') {
      if (player.account && m.save) {
        player.save = m.save;   // Phase 1: refresh loadout ref (gear/skills)
        const acct = readAcct(player.account) || { name: player.name, pin: '0000' };
        if (economy && player.econ) {
          // Phase 2: server owns progression. Take the client's non-owned fields
          // (position, appearance, settings) but OVERRIDE owned fields with our
          // authoritative econ — the client cannot author gold/items/equip/bank.
          economy.refreshState(player.econ, m.save.p);   // keep server's damage inputs (skills/baseDmg) current
          acct.save = economy.mergeIntoSave(m.save, player.econ);
        } else {
          acct.save = m.save;   // Phase 1 path: stored UNCHANGED
        }
        acct.name = player.name; acct.updated = Date.now();
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
      // HP is server-authoritative now — do NOT trust client-reported hp (godmode fix).
      // Keep the server mirror in sync from econ; def is computed from owned gear.
      if (player.econ){ player.hp = Number(player.econ.hp); player.maxHp = Number(player.econ.maxHp); }
      else if (m.maxHp != null) player.maxHp = m.maxHp;
      if (player.zone !== oldZone) { assignHost(oldZone); assignHost(player.zone); }
    } else if (m.t === 'active') {
      // foreground/background signal — a backgrounded host yields the zone to an active player
      const was = player.inactive;
      player.inactive = !m.active;
      // returning from away after dying there → tell the client to run its death/respawn
      if (m.active && player.dead) { player.dead = false; const ws2 = wsById(player.id); if (ws2) send(ws2, { t:'youdied' }); }
      if (was !== player.inactive) assignHost(player.zone);
    } else if (m.t === 'respawn') {
      // client finished its death timer — SERVER restores full HP authoritatively
      if (economy && player.econ) {
        player.dead = false; player.econ.hp = Number(player.econ.maxHp)||100; player.hp = player.econ.hp;
        const rws = wsById(player.id); if (rws) pushState(rws, player); saveEcon(player);
      }
    } else if (m.t === 'zonemap') {
      // a client uploads the seed-deterministic collision grid + spawn data for a zone
      ingestZoneMap(m.zone, m);
    } else if (m.t === 'hit') {
      // a player damaged a server-owned mob → SERVER rolls the real damage
      // (m.dmg is only a clamped fallback if the server can't compute it)
      applyHitToMob(player, m.id, m.dmg|0);
    } else if (m.t && m.t.indexOf('econ_') === 0) {
      // Phase 2: server-authoritative economy actions. Each validates against
      // the server's owned state, mutates it, persists, and pushes pstate back.
      if (!economy || !player.econ) return;
      const E = economy, ec = player.econ; let r = { ok:false, err:'unknown' };
      if (m.t === 'econ_sell')           r = E.doSell(ec, m.id);
      else if (m.t === 'econ_sellmany')  r = E.doSellMany(ec, m.ids);
      else if (m.t === 'econ_upgrade')   r = E.doUpgrade(ec, m.id);
      else if (m.t === 'econ_enchant')   r = E.doEnchant(ec, m.id);
      else if (m.t === 'econ_buy')       r = E.doBuyConsumable(ec, m.key);
      else if (m.t === 'econ_equip')     r = E.doEquip(ec, m.id);
      else if (m.t === 'econ_unequip')   r = E.doUnequip(ec, m.slot);
      else if (m.t === 'econ_use')       r = E.doUse(ec, m.id);
      else if (m.t === 'econ_drop') {
        r = E.doDrop(ec, m.id);
        // a DELIBERATE drop becomes a MANUAL ground drop (must be clicked to pick back up),
        // unlike kill-loot which auto-grabs. Owned by the dropper only.
        if (r.ok && r.item) { const dd = addDrop(player.zone, r.item, Math.round(player.x), Math.round(player.y), [player.id]); if (dd) dd.manual = true; }
      }
      else if (m.t === 'econ_deposit')   r = E.doDeposit(ec, m.id);
      else if (m.t === 'econ_withdraw')  r = E.doWithdraw(ec, m.id);
      else if (m.t === 'econ_depositall')r = E.doDepositAll(ec);
      else if (m.t === 'econ_barrel')    r = E.grantBarrel(ec, m.bkey);
      else if (m.t === 'econ_give')      r = E.giveSafe(ec, m.spec);
      else if (m.t === 'econ_givequestitem') r = E.giveQuestItem(ec, m.key);
      else if (m.t === 'econ_cook')      r = E.doCook(ec, m.id);
      else if (m.t === 'econ_buytool')   r = E.doBuyTool(ec, m.tool);
      else if (m.t === 'econ_starterkit')r = E.doStarterKit(ec);
      else if (m.t === 'econ_gather')    r = E.doGather(ec, m.kind, m.tier);
      else if (m.t === 'econ_unlock')    r = E.doUnlock(ec, m.key);
      else if (m.t === 'econ_pickup') {
        // pick up a server ground drop the player is standing on
        const arr = zoneDrops[player.zone] || [];
        const di = arr.findIndex(d => d.id === m.dropId);
        if (di < 0) r = { ok:false, err:'gone' };
        else {
          const d = arr[di];
          if (d.owners.indexOf(player.id) < 0) r = { ok:false, err:'not yours' };
          else if (Math.hypot((player.x||0)-d.x, (player.y||0)-d.y) > 110) r = { ok:false, err:'too far' };
          else {
            // party GEAR pickup → trigger a Need/Greed roll among present owners
            // instead of an instant grab. Solo / non-gear = instant.
            const isGear = ['weapon','armor','helm','ring'].indexOf(d.item.kind) >= 0;
            const presentOwners = d.owners.filter(id => { for(const q of clients.values()) if(q.id===id) return q.zone===player.zone; return false; });
            if (isGear && presentOwners.length >= 2) {
              arr.splice(di,1);
              startLootRoll(player, d.item, presentOwners);
              r = { ok:true, rolled:true };
            } else {
              arr.splice(di,1); const it = Object.assign({}, d.item); it.id = E.uid(); ec.inventory.push(it); r = { ok:true, item:it, dropId:d.id };
            }
          }
        }
      }
      else if (m.t === 'econ_shop') {
        // (re)generate this player's gear-shop stock for a vendor kind
        player.shopStock = player.shopStock || {};
        if (!player.shopStock[m.kind] || m.refresh) player.shopStock[m.kind] = E.genShopStock(m.kind, ec.level);
        send(ws, { t:'shopstock', kind:m.kind, stock:player.shopStock[m.kind] });
        return;
      }
      else if (m.t === 'econ_sync') {
        // re-push authoritative state on demand (used to verify the client cannot
        // fabricate progression — any local tamper is overwritten by this)
        pushState(ws, player); return;
      }
      else if (m.t === 'econ_buygear') {
        const stock = (player.shopStock && player.shopStock[m.kind]) || null;
        r = E.doBuyGear(ec, stock, m.id);
        if (r.ok) send(ws, { t:'shopstock', kind:m.kind, stock:player.shopStock[m.kind] });
      }
      send(ws, { t:'econ_ack', action:m.t, ok:!!r.ok, err:r.err, info:r });
      if (r.ok) { pushState(ws, player); saveEcon(player); }
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
      // Phase 4: when economy is authoritative, store only the offered item IDS
      // (validated against real inventory at completion) — never client item objects.
      if (economy && player.econ) {
        const ids = (m.items||[]).map(it=>it && it.id).filter(Boolean).slice(0,12);
        player.tradeOffer = { ids, gold: Math.max(0, m.gold|0) }; player.tradeOK = false;
        const tws = wsById(player.tradeWith), tp = tws && clients.get(tws);
        if (tp) { tp.tradeOK = false;
          // show the partner the AUTHORITATIVE items for those ids (can't be faked)
          const items = economy.resolveOfferItems(player.econ, player.tradeOffer);
          send(tws, { t:'trade_other', items, gold:player.tradeOffer.gold });
          send(ws,  { t:'trade_otherconfirm', confirmed:false }); }
      } else {
        player.tradeOffer = { items:(m.items||[]).slice(0,12), gold:Math.max(0, m.gold|0) }; player.tradeOK = false;
        const tws = wsById(player.tradeWith), tp = tws && clients.get(tws);
        if (tp) { tp.tradeOK = false; send(tws, { t:'trade_other', items:player.tradeOffer.items, gold:player.tradeOffer.gold }); send(ws, { t:'trade_otherconfirm', confirmed:false }); }
      }
    } else if (m.t === 'trade_confirm') {
      player.tradeOK = !!m.confirmed;
      const tws = wsById(player.tradeWith), tp = tws && clients.get(tws);
      if (tp) { send(tws, { t:'trade_otherconfirm', confirmed:player.tradeOK });
        if (player.tradeOK && tp.tradeOK) {
          if (economy && player.econ && tp.econ) {
            // Phase 4: SERVER performs the atomic swap against both real inventories.
            const res = economy.executeTrade(player.econ, player.tradeOffer, tp.econ, tp.tradeOffer);
            if (res.ok) {
              saveEcon(player); saveEcon(tp);
              pushState(ws, player); pushState(tws, tp);
              send(ws,  { t:'trade_done', applied:true });
              send(tws, { t:'trade_done', applied:true });
            } else {
              // an offer was invalid (item sold/dropped mid-trade) → abort, nothing moved
              send(ws,  { t:'trade_cancel', reason:'Trade failed — an item was no longer available' });
              send(tws, { t:'trade_cancel', reason:'Trade failed — an item was no longer available' });
            }
            player.tradeOK = false; tp.tradeOK = false;
          } else {
            send(ws,  { t:'trade_done', get:tp.tradeOffer, give:player.tradeOffer });
            send(tws, { t:'trade_done', get:player.tradeOffer, give:tp.tradeOffer });
          }
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
    if (economy && player.econ) { try { saveEcon(player); } catch(e){} }   // Phase 2: persist authoritative econ
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
      // no map yet — ask an occupant to upload it, and RE-ASK every few seconds
      // (per ZONE, not per player) until the map actually arrives. The old
      // per-player flag got stuck after the first zone, leaving every other
      // zone (and dungeons) map-less and therefore empty of enemies.
      zoneAskCd[zone] = (zoneAskCd[zone] || 0) - dt;
      if (zoneAskCd[zone] <= 0) {
        zoneAskCd[zone] = 3;
        const asker = byZone[zone][0];
        const aws = asker && wsById(asker.id); if (aws) send(aws, { t:'needmap', zone });
      }
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
    send(ws, { t:'drops', zone:p.zone, list: dropsSnapshot(p.zone, p.id) });
  }
  // expire old ground drops (2 min) so the floor doesn't fill forever
  for (const zone in zoneDrops) {
    const arr = zoneDrops[zone];
    for (let i=arr.length-1;i>=0;i--) if (now - arr[i].t > 120000) arr.splice(i,1);
    if (!arr.length) delete zoneDrops[zone];
  }

  // free mobs/maps for zones nobody is in (so they re-seed fresh next time)
  for (const zone in zoneMobs) { if (!byZone[zone]) { delete zoneMobs[zone]; delete zoneMaps[zone]; delete zoneAskCd[zone]; } }
}, TICK_MS);

server.listen(PORT, () => console.log('Hearthwood server listening on port ' + PORT));

// ============================================================
//  PHASE 0 — rolling save backups (safety net).
//  Every 6h, copy all account .json files into a timestamped
//  folder under <SAVE_DIR>/_backups, keeping the newest 8 (=2 days).
//  Entirely additive + wrapped in try/catch: a backup failure can
//  NEVER affect login, saves, or the game loop. Restore from the
//  Render Shell with:
//     cp /data/_backups/<timestamp>/*.json /data/
// ============================================================
const BACKUP_DIR = path.join(SAVE_DIR, '_backups');
const BACKUP_KEEP = 8;
const BACKUP_EVERY_MS = 6 * 60 * 60 * 1000;   // 6 hours
function runBackup(){
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const dest = path.join(BACKUP_DIR, stamp);
    fs.mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const f of fs.readdirSync(SAVE_DIR)) {
      if (!f.endsWith('.json')) continue;                 // accounts + _lists.json
      try { fs.copyFileSync(path.join(SAVE_DIR, f), path.join(dest, f)); n++; } catch (e) {}
    }
    // prune: keep only the newest BACKUP_KEEP backup folders
    const folders = fs.readdirSync(BACKUP_DIR)
      .filter(d => { try { return fs.statSync(path.join(BACKUP_DIR, d)).isDirectory(); } catch(e){ return false; } })
      .sort();                                            // ISO timestamps sort chronologically
    while (folders.length > BACKUP_KEEP) {
      const old = folders.shift();
      try { fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true }); } catch (e) {}
    }
    console.log('[backup] wrote ' + n + ' files -> _backups/' + stamp);
  } catch (e) {
    console.error('[backup] failed (non-fatal):', e.message);
  }
}
setTimeout(runBackup, 60 * 1000);                          // first backup 1 min after boot
setInterval(runBackup, BACKUP_EVERY_MS);                   // then every 6 hours
