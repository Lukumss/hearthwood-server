// ============================================================
//  economy.js — Phase 2: SERVER-AUTHORITATIVE economy engine.
//  Faithful port of the client's item/loot/XP/reward rules
//  (js/data.js, js/skilling.js, js/game.js) so the SERVER owns
//  progression: gold, XP, levels, skills, inventory, equip, bank.
//  The client becomes a renderer that requests actions; the server
//  validates + mutates this state and pushes it back.
//
//  Loaded ONLY when PHASE2 is enabled. Pure data + functions; the
//  wiring into server.js is gated so live is unaffected until ready.
// ============================================================
'use strict';

// ---------- rarities ----------
const RARITY = {
  common:    { mult:1.00, weight:60 },
  uncommon:  { mult:1.30, weight:26 },
  rare:      { mult:1.75, weight:10 },
  epic:      { mult:2.40, weight:3.4 },
  legendary: { mult:3.40, weight:0.6 },
};
const RARITY_ORDER = ['common','uncommon','rare','epic','legendary'];
const PREFIX = {
  common:   ['Worn','Plain','Rusty','Simple','Chipped'],
  uncommon: ['Sturdy','Keen','Polished','Hunter\u2019s','Trusty'],
  rare:     ['Gleaming','Fierce','Runed','Frostbitten','Knight\u2019s'],
  epic:     ['Ancient','Vicious','Stormforged','Enchanted','Dread'],
  legendary:['Mythic','Godslayer\u2019s','Eternal','Worldbreaker','Celestial'],
};
const ITEM_BASES = {
  dagger: { kind:'weapon', icon:'dagger', name:'Dagger',     power:5,  range:22, speed:1.9, atype:'melee'  },
  sword:  { kind:'weapon', icon:'sword',  name:'Sword',      power:8,  range:24, speed:1.25,atype:'melee'  },
  axe:    { kind:'weapon', icon:'axe',    name:'Battleaxe',  power:13, range:26, speed:0.85,atype:'melee'  },
  bow:    { kind:'weapon', icon:'bow',    name:'Bow',        power:7,  range:120,speed:1.1, atype:'ranged' },
  staff:  { kind:'weapon', icon:'staff',  name:'Staff',      power:9,  range:130,speed:0.95,atype:'magic'  },
  armor_leather:{ kind:'armor', icon:'armor_leather', name:'Leather Vest', power:3 },
  armor_plate:  { kind:'armor', icon:'armor_plate',   name:'Plate Mail',   power:6 },
  helm:   { kind:'helm', icon:'helm', name:'Helm', power:2 },
  helm_leathercowl: { kind:'helm', icon:'helm', name:'Leather Cowl', power:2, art:'cowl' },
  helm_iron:        { kind:'helm', icon:'ic_ironhelm', name:'Iron Great Helm', power:4, art:'iron' },
  helm_executioner: { kind:'helm', icon:'ic_exehelm', name:'Executioner Helm', power:5, art:'executioner' },
  ring:   { kind:'ring', icon:'ring', name:'Ring', power:4 },
};
const COSMETICS = {
  santa:{ name:'Santa Hat', icon:'cos_santa', hatType:'santa', rarity:'legendary' },
  party:{ name:'Party Hat', icon:'cos_party', hatType:'party', rarity:'legendary' },
  crown:{ name:'Golden Crown', icon:'cos_crown', hatType:'crown', rarity:'legendary' },
  jester:{ name:'Jester Cap', icon:'cos_jester', hatType:'jester', rarity:'epic' },
  flower:{ name:'Flower Crown', icon:'cos_flower', hatType:'flower', rarity:'epic' },
  pharaoh:{ name:'Pharaoh\u2019s Mask', icon:'cos_pharaoh', hatType:'pharaoh', rarity:'legendary' },
  dragon:{ name:'Dragon Horns', icon:'cos_dragon', hatType:'dragon', rarity:'legendary' },
  flame:{ name:'Crown of Flames', icon:'cos_flame', hatType:'flame', rarity:'legendary' },
};
const CONSUMABLES = {
  potion_minor:{ kind:'potion', icon:'potion_red', name:'Minor Health Potion', heal:35, value:12, rarity:'common', desc:'Restores 35 HP.' },
  potion_major:{ kind:'potion', icon:'potion_red', name:'Greater Health Potion', heal:80, value:30, rarity:'uncommon', desc:'Restores 80 HP.' },
  ore:{ kind:'material', icon:'ore', name:'Iron Ore', value:8, rarity:'common', desc:'Used at the forge to upgrade weapons.' },
  gem:{ kind:'material', icon:'gem', name:'Star Gem', value:40, rarity:'rare', desc:'A precious gem. Powers legendary upgrades.' },
};
// per-enemy reward data (gold range / xp / drop flags) — ported from ENEMY_TYPES
const ENEMY = {
  rat:{gold:[1,4],xp:6,dropChance:0.28}, slime:{gold:[2,6],xp:9,dropChance:0.34},
  fairy:{gold:[3,7],xp:11,dropChance:0.4}, goblin:{gold:[4,12],xp:16,dropChance:0.46},
  skeleton:{gold:[6,16],xp:22,dropChance:0.5}, mercenary:{gold:[10,24],xp:34,dropChance:0.58},
  wizard:{gold:[12,28],xp:38,dropChance:0.62}, stag:{gold:[6,14],xp:28,dropChance:0,mount:'stag'},
  chieftain:{gold:[80,150],xp:200,dropChance:1,elite:true,cosmeticDrop:true},
  cryptlord:{gold:[220,360],xp:600,dropChance:1,boss:true},
  cactus:{gold:[12,24],xp:60,dropChance:0.5}, scorpion:{gold:[14,30],xp:70,dropChance:0.55},
  dragon:{gold:[600,900],xp:1400,dropChance:1,boss:true,cosmeticDrop:true},
  mummyking:{gold:[400,600],xp:900,dropChance:1,boss:true,cosmeticDrop:true},
  minidragon:{gold:[18,36],xp:95,dropChance:0.55}, flameknight:{gold:[22,44],xp:130,dropChance:0.62},
  blackknight:{gold:[1000,1500],xp:2600,dropChance:1,boss:true,cosmeticDrop:true},
  magmalord:{gold:[700,1100],xp:1800,dropChance:1,boss:true,cosmeticDrop:true},
  treant:{gold:[120,200],xp:340,dropChance:1,boss:true}, wraith:{gold:[260,400],xp:680,dropChance:1,boss:true},
  ember_warden:{gold:[300,500],xp:1400,dropChance:1,boss:true},
  graveweaver:{gold:[400,650],xp:1800,dropChance:1,boss:true},
  stonebreaker:{gold:[600,900],xp:2400,dropChance:1,boss:true},
};
// per-zone loot config — ported from ZONES (dropTier + lootBases)
const ZONE_LOOT = {
  forest:{tier:0,bases:['dagger','sword','bow','armor_leather','helm','helm_iron','ring']},
  snow:{tier:1,bases:['sword','axe','bow','staff','armor_plate','helm','helm_iron','helm_executioner','ring']},
  desert:{tier:2,bases:['sword','axe','bow','staff','armor_plate','helm','helm_iron','helm_executioner','ring']},
  desert_tomb:{tier:2,bases:['sword','axe','staff','armor_plate','helm','helm_executioner','ring']},
  volcano:{tier:3,bases:['sword','axe','bow','staff','armor_plate','helm','helm_executioner','ring']},
  volcano_forge:{tier:3,bases:['sword','axe','staff','armor_plate','helm','helm_executioner','ring']},
  crypt:{tier:1,bases:['sword','axe','staff','armor_plate','helm','helm_iron','ring']},
  shadewell:{tier:2,bases:['sword','axe','bow','staff','armor_plate','helm','helm_iron','helm_executioner','ring']},
};

// ---------- server-side unique ids (won't collide with client temp ids) ----------
let _uid = 1;
function uid(){ return 'S' + Date.now().toString(36) + (_uid++).toString(36); }
const num = (v)=>{ v=Number(v); return isFinite(v)?v:0; };
const ri  = (a,b)=> a + Math.floor(Math.random()*(b-a+1));

// ---------- item generation (ports of data.js) ----------
function pickRarity(luck, floor){
  const weights = RARITY_ORDER.map((r,i)=>{ let w=RARITY[r].weight; if(luck) w*=(1+i*0.18*luck); if(floor && i<floor) w*=0.15; return w; });
  let total=weights.reduce((a,b)=>a+b,0), roll=Math.random()*total;
  for(let i=0;i<RARITY_ORDER.length;i++){ roll-=weights[i]; if(roll<=0) return RARITY_ORDER[i]; }
  return 'common';
}
function makeGear(baseKey, rarity, tier){
  const base=ITEM_BASES[baseKey], rar=RARITY[rarity];
  const variance=0.85+Math.random()*0.3, tierMult=1+(tier||0)*0.35;
  const power=Math.max(1, Math.round(base.power*rar.mult*tierMult*variance));
  const pre=PREFIX[rarity][Math.floor(Math.random()*PREFIX[rarity].length)];
  const item={ id:uid(), base:baseKey, kind:base.kind, slot:base.kind,
    icon:(['dagger','sword','axe','bow','staff'].indexOf(baseKey)>=0 ? base.icon+'_'+rarity : base.icon),
    name:pre+' '+base.name, rarity, power, plus:0, value:Math.round(power*3*rar.mult) };
  if(base.kind==='weapon'){ item.damage=power; item.range=base.range; item.speed=base.speed*(0.95+Math.random()*0.15); item.atype=base.atype; }
  else if(base.kind==='armor'||base.kind==='helm') item.defense=power;
  else if(base.kind==='ring') item.bonusDmg=power;
  if(base.art) item.art=base.art;
  return item;
}
function cloneConsumable(key){ const c=CONSUMABLES[key]; return c ? Object.assign({ id:uid() }, c) : null; }
// ---- pets (forest barrel kittens) — server rolls + delivers to inventory ----
const PET_NAMES = { marmalade:'Marmalade Kitten', smoke:'Smoke Kitten', inkwell:'Inkwell Kitten', snowpaw:'Snowpaw Kitten', patches:'Patches Kitten' };
const PET_KEYS = Object.keys(PET_NAMES);
function makePetItem(key){
  const name = PET_NAMES[key] || PET_NAMES.marmalade;
  return { id:uid(), kind:'pet', slot:'pet', petKey:key, name, icon:'pet:'+key, rarity:'epic',
    value:0, cosmetic:true, desc:'A loyal kitten. Equip it and it follows you, fetching nearby loot.' };
}
// search a barrel: one kitten per barrel (server tracks which are searched so it
// can't be farmed by repeat clicks). Delivers the kitten to authoritative inventory.
function grantBarrel(econ, bkey){
  if(!econ.searchedBarrels || typeof econ.searchedBarrels!=='object') econ.searchedBarrels={};
  if(bkey && econ.searchedBarrels[bkey]) return { ok:false, err:'already searched' };
  if(bkey) econ.searchedBarrels[bkey]=true;
  const key = PET_KEYS[Math.floor(Math.random()*PET_KEYS.length)];
  const item = makePetItem(key);
  econ.inventory.push(item);
  if(!Array.isArray(econ.petsOwned)) econ.petsOwned=[];
  if(!econ.petsOwned.includes(key)) econ.petsOwned.push(key);
  return { ok:true, key, name:item.name };
}

// ---- gathering / crafting / tools (server-built so they can't mint gear) ----
const TOOL_NAMES = { axe:'Woodcutting Axe', pickaxe:'Pickaxe', rod:'Fishing Rod' };
function makeToolItem(tool){
  return { id:uid(), kind:'tool', tool, icon: tool==='axe'?'axe':tool==='pickaxe'?'pickaxe':'rod',
    name:TOOL_NAMES[tool]||'Tool', value:5, rarity:'common', desc:'A gathering tool. Click a resource node to use it.' };
}
// the client gathered a SAFE low-value item (log/ore/raw fish). The server builds
// it from a constrained spec — it can only ever be a material/fishraw, never gear.
function giveSafe(econ, spec){
  spec = spec || {}; const t = String(spec.type||'');
  const nm = String(spec.name||'Item').slice(0,40);
  const val = Math.max(1, Math.min(60, Math.round(num(spec.value))||4));
  let item;
  if(t==='material') item = { id:uid(), kind:'material', icon:String(spec.icon||'ore').slice(0,12), name:nm, value:val, rarity:'common', color:spec.color, desc:'A gathered material.' };
  else if(t==='fishraw') item = { id:uid(), kind:'fishraw', icon:'fish', name:nm, value:val, rarity:'common',
    heal:Math.max(0,Math.min(300,Math.round(num(spec.heal)))), cookReq:Math.max(1,Math.round(num(spec.cookReq))||1),
    cookXp:Math.max(0,Math.round(num(spec.cookXp))), fishName:String(spec.fishName||'Fish').slice(0,30), desc:'Cook at a range to make it edible.' };
  else return { ok:false, err:'bad type' };
  econ.inventory.push(item);
  return { ok:true, item };
}
// ---------- one-time QUEST reward items (server-minted so they persist + can be wielded) ----------
// giveSafe forbids gear on purpose; this is the ONLY sanctioned gear grant, gated give-once
// per character so it can't be farmed. Used by the intro quest "The Understudy".
const QUEST_ITEMS = {
  hero_blade: ()=>{ const it=makeGear('sword','common',0); it.name='The Hero\u2019s Blade'; it.questId='hero_blade';
    it.desc='Left to an understudy by a hero the songs forgot.'; return it; },
  // Pip the Welcomer's one-time starter bundle (each gated give-once via questId)
  welcome_party:   ()=>({ id:'wc_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6), kind:'cosmetic', slot:'cosmetic', name:'Party Hat', icon:'cos_party', hatType:'party', rarity:'legendary', cosmetic:true, value:500, questId:'welcome_party' }),
  welcome_cowl:    ()=>{ const it=makeGear('helm_leathercowl','common',0); it.questId='welcome_cowl'; return it; },
  welcome_leather: ()=>{ const it=makeGear('armor_leather','common',0); it.questId='welcome_leather'; return it; },
  welcome_plate:   ()=>{ const it=makeGear('armor_plate','common',0); it.questId='welcome_plate'; return it; },
  welcome_staff:   ()=>{ const it=makeGear('staff','common',0); it.questId='welcome_staff'; return it; },
  welcome_sword:   ()=>{ const it=makeGear('sword','common',0); it.questId='welcome_sword'; return it; },
  welcome_bow:     ()=>{ const it=makeGear('bow','common',0); it.questId='welcome_bow'; return it; },
};
function _ownsQuestItem(econ, qid){
  const has=(arr)=>Array.isArray(arr)&&arr.some(it=>it&&it.questId===qid);
  if(has(econ.inventory)||has(econ.bank)) return true;
  const eq=econ.equip||{}; for(const s in eq){ if(eq[s]&&eq[s].questId===qid) return true; }
  return false;
}
function giveQuestItem(econ, key){
  const make = QUEST_ITEMS[String(key||'')];
  if(!make) return { ok:false, err:'unknown quest item' };
  if(_ownsQuestItem(econ, key)) return { ok:true, already:true };   // idempotent: already granted
  const item = make();
  econ.inventory.push(item);
  return { ok:true, item };
}
// cook a raw fish the player actually owns: consume it, produce cooked or burnt.
function doCook(econ, rawId){
  const i = econ.inventory.findIndex(it=>it && it.id===rawId && it.kind==='fishraw');
  if(i<0) return { ok:false, err:'no raw fish' };
  const raw = econ.inventory[i]; econ.inventory.splice(i,1);
  if(Math.random() < 0.95){
    econ.inventory.push({ id:uid(), kind:'food', icon:'fishck', name:String(raw.fishName||'Fish').slice(0,30),
      value:Math.max(3,Math.round(num(raw.heal)/3)), rarity:'common', heal:num(raw.heal), fishName:raw.fishName, desc:'Eat to heal.' });
    return { ok:true, burnt:false, name:raw.fishName };
  }
  econ.inventory.push({ id:uid(), kind:'junk', icon:'fishburn', name:'Burnt Fish', value:0, rarity:'common', desc:'Oops. Inedible.' });
  return { ok:true, burnt:true, name:raw.fishName };
}
function doBuyTool(econ, tool){
  if(!TOOL_NAMES[tool]) return { ok:false, err:'bad tool' };
  const price = 12;
  if(num(econ.gold) < price) return { ok:false, err:'not enough gold' };
  if(econ.inventory.some(it=>it&&it.kind==='tool'&&it.tool===tool)) return { ok:false, err:'already own' };
  econ.gold -= price; econ.inventory.push(makeToolItem(tool));
  return { ok:true, name:TOOL_NAMES[tool] };
}
function doStarterKit(econ){
  if(econ.gotStarterKit) return { ok:false, err:'already taken' };
  econ.gotStarterKit = true;
  for(const t of ['axe','pickaxe','rod']) if(!econ.inventory.some(it=>it&&it.kind==='tool'&&it.tool===t)) econ.inventory.push(makeToolItem(t));
  return { ok:true };
}
function randomCosmetic(){ const ks=Object.keys(COSMETICS); const k=ks[Math.floor(Math.random()*ks.length)]; return Object.assign({ id:uid(), kind:'cosmetic', slot:'cosmetic', value:500, cosmetic:true }, COSMETICS[k]); }
function rollEnemyLoot(enemyType, zone){
  const et=ENEMY[enemyType]; if(!et) return null;
  if(Math.random() > et.dropChance && !et.boss) return null;
  const z=ZONE_LOOT[zone] || ZONE_LOOT.forest;
  const baseKey=z.bases[Math.floor(Math.random()*z.bases.length)];
  return makeGear(baseKey, pickRarity(et.boss?2.2:1, et.boss?2:0), z.tier||0);
}
// effective sell value (port of client sellValue): gear/cosmetic priced by
// rarity + enchant level; materials/consumables keep their listed value.
const RARITY_SELL = { common:25, uncommon:75, rare:125, epic:175, legendary:225 };
function sellValue(item){
  if(!item) return 1;
  if(['weapon','armor','helm','ring','cosmetic'].includes(item.kind))
    return (RARITY_SELL[item.rarity]||25) + num(item.plus)*25;
  return num(item.value)||1;
}
// forge upgrade cost (port of upgradeCost)
function upgradeCost(item){
  const lvl=num(item.plus);
  return { gold: Math.round(40*Math.pow(1.6,lvl)+num(item.power)*4), ore: 1+lvl, gem: lvl>=4?1:0 };
}

// ---------- skill / level curves (ports of skilling.js + game.js) ----------
const MAX_SKILL = 99;
function skillNeed(lvl){ return Math.round(83 * Math.pow(1.104, lvl-1)); }
function skillLvl(p, id){ const s=p.skills&&p.skills[id]; return (s&&num(s.lvl))||(id==='hitpoints'?10:1); }
function weaponDamage(item){ if(!item) return 0; return Math.round(num(item.damage)*(1+num(item.plus)*0.22)); }
function effectiveDamage(p){
  const eq=p.equip||{}; let d=num(p.baseDmg)+weaponDamage(eq.weapon);
  if(eq.ring) d+=num(eq.ring.bonusDmg);
  if(p.unlocked && p.unlocked.power) d*=1.2;
  const atype=(eq.weapon&&eq.weapon.atype)||'melee';
  if(atype==='ranged') d*=1+(skillLvl(p,'ranging')-1)*0.022;
  else if(atype==='magic') d*=1+(((skillLvl(p,'goodmagic')+skillLvl(p,'evilmagic'))/2)-1)*0.018;
  else d*=1+(skillLvl(p,'strength')-1)*0.022;
  return Math.max(1, Math.round(d));
}
function rollHitDamage(p){
  const base=effectiveDamage(p);
  const crit=Math.random() < (0.12 + ((p.unlocked&&p.unlocked.precision)?0.12:0));
  let dmg=base*(0.85+Math.random()*0.3); if(crit) dmg*=1.9;
  return { dmg:Math.max(1,Math.round(dmg)), crit };
}
function addSkillXp(p, id, amt){
  if(!p.skills) p.skills={};
  if(!p.skills[id]) p.skills[id]={ lvl:(id==='hitpoints'?10:1), xp:0 };
  amt=Math.max(0,Math.round(num(amt))); if(!amt) return;
  const sk=p.skills[id]; sk.xp+=amt;
  while(sk.lvl<MAX_SKILL && sk.xp>=skillNeed(sk.lvl)){ sk.xp-=skillNeed(sk.lvl); sk.lvl++; if(id==='hitpoints'){ p.maxHp=num(p.maxHp)+8; p.hp=p.maxHp; } }
  if(sk.lvl>=MAX_SKILL) sk.xp=0;
}
function awardCombatXp(p, style, dmg){
  const x=Math.max(1,Math.round(dmg*0.45));
  addSkillXp(p,'hitpoints',Math.max(1,Math.round(x*0.45)));
  if(style==='ranged') addSkillXp(p,'ranging',x);
  else if(style==='magic') addSkillXp(p,'goodmagic',x);
  else { addSkillXp(p,'weaponry',Math.round(x*0.6)); addSkillXp(p,'strength',Math.round(x*0.6)); }
}
function gainXp(p, n){
  p.xp=num(p.xp)+num(n); if(!p.xpNext) p.xpNext=60;
  while(p.xp>=p.xpNext){ p.xp-=p.xpNext; p.level=num(p.level)+1; p.xpNext=Math.round(p.xpNext*1.45+20);
    p.maxHp=num(p.maxHp)+18; p.baseDmg=num(p.baseDmg)+2; p.hp=p.maxHp; p.skillPoints=num(p.skillPoints)+1; }
}

// ---------- authoritative state container ----------
// CRITICAL SPLIT (fixes the level-up wipe):
//  • OWNED_FIELDS = the dupe-risk ECONOMY the server overwrites + persists
//    authoritatively (pushed in pstate, written to disk). These are the only
//    fields the server sends back to the client, so it can never wipe anything
//    else the client changes.
//  • STATE_FIELDS = the broader set the server KEEPS A COPY of (needed for the
//    damage formula), seeded at login + refreshed from each cloudsave, but NOT
//    pushed back or overwritten. Self-progression (levels, skills, mounts, pet
//    keys, kills) lives here and stays CLIENT-authored — so it is never reset.
const OWNED_FIELDS = ['gold','inventory','equip','bank'];
const STATE_FIELDS = ['level','xp','xpNext','hp','maxHp','baseDmg','gold','skillPoints',
  'inventory','equip','bank','mounts','activeMount','petsOwned','searchedBarrels',
  'skills','unlocked','bossKills','zoneKills','totalKills','gotStarterKit'];
// Build the server's canonical econ object from a (client) save's player blob.
// Used ONCE at login to seed authoritative state from the existing save.
function fromSave(p){
  p = p || {};
  const econ = {};
  for(const f of STATE_FIELDS) econ[f] = p[f];
  // sane defaults / repairs
  econ.level = Math.max(1, Math.round(num(econ.level)||1));
  econ.xp = Math.max(0, num(econ.xp));
  econ.xpNext = Math.max(1, num(econ.xpNext)||60);
  econ.maxHp = Math.max(1, Math.round(num(econ.maxHp)||100));
  econ.hp = Math.max(0, Math.min(econ.maxHp, Math.round(num(econ.hp)||econ.maxHp)));
  econ.baseDmg = Math.max(0, num(econ.baseDmg)||10);
  econ.gold = Math.max(0, Math.round(num(econ.gold)));
  econ.skillPoints = Math.max(0, Math.round(num(econ.skillPoints)));
  econ.totalKills = Math.max(0, Math.round(num(econ.totalKills)));
  econ.inventory = Array.isArray(econ.inventory)?econ.inventory:[];
  econ.bank = Array.isArray(econ.bank)?econ.bank:[];
  econ.mounts = Array.isArray(econ.mounts)?econ.mounts:[];
  econ.petsOwned = Array.isArray(econ.petsOwned)?econ.petsOwned:[];
  econ.equip = (econ.equip&&typeof econ.equip==='object')?econ.equip:{};
  econ.skills = (econ.skills&&typeof econ.skills==='object')?econ.skills:{};
  econ.unlocked = (econ.unlocked&&typeof econ.unlocked==='object')?econ.unlocked:{};
  econ.bossKills = (econ.bossKills&&typeof econ.bossKills==='object')?econ.bossKills:{};
  econ.zoneKills = (econ.zoneKills&&typeof econ.zoneKills==='object')?econ.zoneKills:{};
  // repair skills: ensure {lvl,xp} with valid lvl (the m0065 corruption guard)
  for(const id in econ.skills){ const s=econ.skills[id]; if(s&&typeof s==='object'){
    if(!(num(s.lvl)>0)) s.lvl = (id==='hitpoints'?10:1); s.xp=Math.max(0,num(s.xp)); } }
  return econ;
}
// Merge the server's owned fields back over a client save before persisting,
// so the disk copy reflects authoritative ECONOMY while keeping the client's
// self-progression (levels/skills/mounts/kills) and position/appearance intact.
function mergeIntoSave(clientSave, econ){
  const save = (clientSave && typeof clientSave==='object') ? clientSave : { v:1, p:{} };
  if(!save.p || typeof save.p!=='object') save.p = {};
  for(const f of OWNED_FIELDS) save.p[f] = econ[f];
  return save;
}
// Refresh the server's COPY of client-owned, damage-relevant fields from a
// fresh cloudsave, so server-side damage stays accurate as the player levels
// skills client-side. Never touches OWNED_FIELDS (those stay authoritative).
function refreshState(econ, p){
  if(!p || typeof p!=='object') return;
  if('baseDmg' in p) econ.baseDmg = num(p.baseDmg);
  if('level' in p)   econ.level   = num(p.level);
  if('maxHp' in p)   econ.maxHp   = num(p.maxHp);
  if(p.skills   && typeof p.skills==='object')   econ.skills   = p.skills;
  if(p.unlocked && typeof p.unlocked==='object') econ.unlocked = p.unlocked;
}

// ---------- the one authoritative mutation we wire first: a kill ----------
// Grants gold + XP + (maybe) loot for killing `enemyType` in `zone`, mutating
// econ in place. Returns a summary the client renders (floats, toasts, drops).
// ---------- kill rewards: ECONOMY ONLY ----------
// The server grants only the dupe-risk rewards: GOLD and ITEMS (loot/cosmetics/
// boss drops) straight into the authoritative inventory. XP, levels, skill XP,
// mount taming and kill-counts are SELF-progression and are handled by the
// client (they can't be duplicated), so the server never touches them here —
// that's what stops the level-up wipe.
function grantKill(econ, enemyType, zone){
  const et = ENEMY[enemyType] || { gold:[1,3], dropChance:0.3 };
  const out = { gold:0, items:[], boss:!!et.boss };
  // gold (instant, added to econ)
  const gold = ri(et.gold[0], et.gold[1]); econ.gold = num(econ.gold)+gold; out.gold = gold;
  // items are ROLLED but NOT added to inventory — the caller places them as
  // ground drops (picked up by walking over them). Keeps the loot-on-floor feel.
  const loot = rollEnemyLoot(enemyType, zone);
  if(loot){ out.items.push(loot); }
  if(et.elite || et.cosmeticDrop){ out.items.push(randomCosmetic());
    const extra=rollEnemyLoot(enemyType,zone); if(extra) out.items.push(extra); }
  else if(Math.random()<0.012){ out.items.push(randomCosmetic()); }   // any enemy: rare ~1.2% cosmetic
  if(et.boss){
    out.items.push(cloneConsumable('gem'), cloneConsumable('potion_major'));
    const extra=rollEnemyLoot(enemyType,zone); if(extra) out.items.push(extra); }
  return out;
}

// ---------- authoritative economy actions ----------
// Each takes the server's econ state + the item id/key the client requested,
// validates against server state, mutates in place, returns {ok, ...}. The
// client NEVER changes gold/inventory itself — it asks; the server decides.
function _findInv(econ, id){ return econ.inventory.findIndex(it=>it && it.id===id); }
function _countMat(econ, name){ return econ.inventory.filter(it=>it&&it.kind==='material'&&it.name===name).length; }
function _spendMat(econ, name, n){ for(let k=0;k<n;k++){ const i=econ.inventory.findIndex(it=>it&&it.kind==='material'&&it.name===name); if(i>=0) econ.inventory.splice(i,1); } }
function _unequipRefs(econ, item){ if(econ.equip) for(const s in econ.equip){ if(econ.equip[s] && econ.equip[s].id===item.id) econ.equip[s]=null; } }

function doSell(econ, id){
  const i=_findInv(econ,id); if(i<0) return { ok:false, err:'no such item' };
  const item=econ.inventory[i]; const v=sellValue(item);
  econ.inventory.splice(i,1); _unequipRefs(econ,item); econ.gold=num(econ.gold)+v;
  return { ok:true, gold:v, name:item.name };
}
function doSellMany(econ, ids){
  if(!Array.isArray(ids)||!ids.length) return { ok:false, err:'nothing' };
  const idSet=new Set(ids); let total=0, n=0;
  for(const it of econ.inventory){ if(it && idSet.has(it.id)){ total+=sellValue(it); n++; } }
  if(!n) return { ok:false, err:'nothing owned' };
  econ.inventory=econ.inventory.filter(it=>!(it&&idSet.has(it.id)));
  if(econ.equip) for(const s in econ.equip){ if(econ.equip[s]&&idSet.has(econ.equip[s].id)) econ.equip[s]=null; }
  econ.gold=num(econ.gold)+total;
  return { ok:true, gold:total, count:n };
}
// find an item by id in the bag OR in any equipped slot (so the forge/enchanter
// can act on equipped gear too, not just the bag)
function _findItemAnywhere(econ, id){
  const i=_findInv(econ,id); if(i>=0) return econ.inventory[i];
  if(econ.equip){ for(const s in econ.equip){ if(econ.equip[s] && econ.equip[s].id===id) return econ.equip[s]; } }
  return null;
}
function doUpgrade(econ, id){
  const item=_findItemAnywhere(econ,id); if(!item) return { ok:false, err:'no item' };
  if(item.kind!=='weapon') return { ok:false, err:'not a weapon' };
  const c=upgradeCost(item);
  if(num(econ.gold)<c.gold) return { ok:false, err:'not enough gold' };
  if(_countMat(econ,'Iron Ore')<c.ore) return { ok:false, err:'need ore' };
  if(c.gem && _countMat(econ,'Star Gem')<c.gem) return { ok:false, err:'need gem' };
  econ.gold-=c.gold; _spendMat(econ,'Iron Ore',c.ore); if(c.gem) _spendMat(econ,'Star Gem',c.gem);
  item.plus=num(item.plus)+1; item.name=item.name.replace(/ \+\d+$/,'')+' +'+item.plus;
  return { ok:true, plus:item.plus, name:item.name };
}
// Sela the Enchanter: gamble 100g for a 10% chance at +1 glow (bag OR equipped).
// Server-authoritative so the enchant persists and the gold is actually spent.
function doEnchant(econ, id){
  const item=_findItemAnywhere(econ,id); if(!item) return { ok:false, err:'no item' };
  if(!(item.kind==='weapon'||item.kind==='armor'||item.kind==='helm'||item.kind==='ring')) return { ok:false, err:'not enchantable' };
  if(num(item.plus)>=10) return { ok:false, err:'maxed' };
  if(num(econ.gold)<100) return { ok:false, err:'not enough gold' };
  econ.gold-=100;
  const success = Math.random()<0.10;
  if(success) item.plus=num(item.plus)+1;
  return { ok:true, success, plus:num(item.plus), name:item.name };
}
function doBuyConsumable(econ, key){
  const proto=CONSUMABLES[key]; if(!proto) return { ok:false, err:'no such item' };
  if(num(econ.gold)<proto.value) return { ok:false, err:'not enough gold' };
  econ.gold-=proto.value; const it=cloneConsumable(key); econ.inventory.push(it);
  return { ok:true, item:it, name:proto.name };
}
function doEquip(econ, id){
  const i=_findInv(econ,id); if(i<0) return { ok:false, err:'no item' };
  const item=econ.inventory[i]; const slot=item.slot; if(!slot) return { ok:false, err:'not equippable' };
  const prev=econ.equip[slot]||null;
  econ.equip[slot]=item; econ.inventory.splice(i,1);
  if(prev) econ.inventory.push(prev);
  return { ok:true, slot };
}
function doUnequip(econ, slot){
  const item=econ.equip&&econ.equip[slot]; if(!item) return { ok:false, err:'empty slot' };
  econ.equip[slot]=null; econ.inventory.push(item);
  return { ok:true, slot };
}
function doUse(econ, id){
  const i=_findInv(econ,id); if(i<0) return { ok:false, err:'no item' };
  const item=econ.inventory[i]; const heal=num(item.heal);
  if(!heal) return { ok:false, err:'not consumable' };
  econ.inventory.splice(i,1);
  econ.hp=Math.min(num(econ.maxHp), num(econ.hp)+heal);
  return { ok:true, heal, hp:econ.hp };
}
function doDrop(econ, id){
  const i=_findInv(econ,id); if(i<0) return { ok:false, err:'no item' };
  const item=econ.inventory[i]; econ.inventory.splice(i,1); _unequipRefs(econ,item);
  return { ok:true, item };
}
// ---- bank (server-owned: inventory <-> bank moves must be validated too,
// because the server now owns both arrays; client-side moves would be reverted) ----
function doDeposit(econ, id){
  const i=_findInv(econ,id); if(i<0) return { ok:false, err:'no item' };
  if(!Array.isArray(econ.bank)) econ.bank=[];
  const item=econ.inventory[i]; econ.inventory.splice(i,1); _unequipRefs(econ,item); econ.bank.push(item);
  return { ok:true, name:item.name };
}
function doWithdraw(econ, id){
  if(!Array.isArray(econ.bank)) econ.bank=[];
  const i=econ.bank.findIndex(it=>it&&it.id===id); if(i<0) return { ok:false, err:'no item' };
  const item=econ.bank[i]; econ.bank.splice(i,1); econ.inventory.push(item);
  return { ok:true, name:item.name };
}
function doDepositAll(econ){
  if(!Array.isArray(econ.bank)) econ.bank=[];
  const keep=econ.inventory.filter(it=>it&&it.kind==='potion');
  const move=econ.inventory.filter(it=>it&&it.kind!=='potion');
  for(const it of move){ _unequipRefs(econ,it); econ.bank.push(it); }
  econ.inventory=keep;
  return { ok:true, count:move.length };
}

// ---- trade escrow (Phase 4): the server validates BOTH offers against the
// authoritative inventories and performs an atomic swap. Items must really be
// owned (in econ.inventory, not equipped); gold must really be held. An offer
// is { ids:[itemId...], gold:Number }. Nothing mutates unless BOTH sides pass.
function resolveOfferItems(econ, offer){
  // best-effort: real item objects for the ids the player claims to offer
  // (used to SHOW the other player an authoritative preview)
  const ids=(offer&&offer.ids)||[];
  return ids.map(id=>econ.inventory.find(x=>x&&x.id===id)).filter(Boolean);
}
function _validateOffer(econ, offer){
  const gold=Math.max(0, Math.round(num(offer&&offer.gold)));
  if(gold>num(econ.gold)) return { ok:false, err:'not enough gold' };
  const ids=(offer&&offer.ids)||[];
  if(!Array.isArray(ids)) return { ok:false, err:'bad offer' };
  if(ids.length>12) return { ok:false, err:'too many items' };
  const items=[]; const seen=new Set();
  for(const id of ids){
    if(seen.has(id)) return { ok:false, err:'duplicate item' };
    seen.add(id);
    const it=econ.inventory.find(x=>x&&x.id===id);
    if(!it) return { ok:false, err:'item not owned' };
    if(it.kind==='tool') return { ok:false, err:'cannot trade tools' };
    items.push(it);
  }
  return { ok:true, items, gold };
}
function executeTrade(econA, offerA, econB, offerB){
  const a=_validateOffer(econA, offerA); if(!a.ok) return { ok:false, who:'A', err:a.err };
  const b=_validateOffer(econB, offerB); if(!b.ok) return { ok:false, who:'B', err:b.err };
  // remove offered items from each giver (atomic — both already validated)
  for(const it of a.items){ const i=econA.inventory.indexOf(it); if(i>=0) econA.inventory.splice(i,1); _unequipRefs(econA,it); }
  for(const it of b.items){ const i=econB.inventory.indexOf(it); if(i>=0) econB.inventory.splice(i,1); _unequipRefs(econB,it); }
  // transfer gold
  econA.gold=num(econA.gold)-a.gold+b.gold;
  econB.gold=num(econB.gold)-b.gold+a.gold;
  // deliver items to receivers with fresh server ids
  for(const it of a.items){ const c=Object.assign({}, it); c.id=uid(); econB.inventory.push(c); }
  for(const it of b.items){ const c=Object.assign({}, it); c.id=uid(); econA.inventory.push(c); }
  return { ok:true, aGave:a.items.length, bGave:b.items.length, aGold:a.gold, bGold:b.gold };
}
// server-owned gear-shop stock (port of genShopStock) so buys are validated
const SHOP_BASES = { sword:['dagger','sword','axe'], mage:['staff','staff','ring'], armor:['armor_leather','armor_plate','helm','helm_leathercowl','ring'] };
function genShopStock(kind, level){
  const bases=SHOP_BASES[kind]||['sword']; const lvl=Math.max(1,num(level)||1); const tier=Math.floor((lvl-1)/3);
  const stock=[];
  if(kind==='armor'){ const cowl=makeGear('helm_leathercowl','common',0); cowl.price=Math.round(cowl.value*2.4); stock.push(cowl); }
  const n=(kind==='armor')?5:6;
  for(let i=0;i<n;i++){ const base=bases[Math.floor(Math.random()*bases.length)]; const it=makeGear(base, pickRarity(0.4+lvl*0.05,0), tier); it.price=Math.round(it.value*2.4); stock.push(it); }
  stock.sort((a,b)=>a.price-b.price); return stock;
}
function doBuyGear(econ, stock, id){
  if(!Array.isArray(stock)) return { ok:false, err:'no stock' };
  const idx=stock.findIndex(it=>it&&it.id===id); if(idx<0) return { ok:false, err:'sold out' };
  const it=stock[idx]; if(num(econ.gold)<num(it.price)) return { ok:false, err:'not enough gold' };
  econ.gold-=it.price; stock.splice(idx,1);
  const bought=Object.assign({}, it); delete bought.price; econ.inventory.push(bought);
  return { ok:true, item:bought, name:bought.name };
}

module.exports = {
  OWNED_FIELDS, STATE_FIELDS, fromSave, mergeIntoSave, refreshState, grantKill,
  rollEnemyLoot, makeGear, cloneConsumable, randomCosmetic, sellValue, upgradeCost,
  effectiveDamage, rollHitDamage, weaponDamage, skillLvl,
  addSkillXp, awardCombatXp, gainXp, skillNeed, ri, uid,
  ENEMY, ZONE_LOOT, CONSUMABLES,
  // authoritative economy actions (each returns {ok, err?, ...info}; mutates econ)
  doSell, doSellMany, doUpgrade, doEnchant, doBuyConsumable, doEquip, doUnequip, doUse, doDrop,
  doDeposit, doWithdraw, doDepositAll,
  resolveOfferItems, executeTrade, grantBarrel,
  giveSafe, doCook, doBuyTool, doStarterKit,
  giveQuestItem,
  genShopStock, doBuyGear,
};
