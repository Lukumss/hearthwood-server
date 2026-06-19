// ============================================================
//  rules.js — server-side game maths (Phase 1: DAMAGE ONLY).
//  Faithful port of the client's damage formula (js/game.js
//  pDamage + combat mults, js/skilling.js skill levels) so the
//  SERVER decides how hard a hit lands — a tampered client can no
//  longer set its own damage / one-shot bosses.
//  Pure functions. Adding more rules (loot/xp) comes in later phases.
// ============================================================
'use strict';

const num = (v)=>{ v=Number(v); return isFinite(v)?v:0; };

// weapon damage incl. forge "+" upgrades — port of weaponDamage()
function weaponDamage(item){
  if(!item) return 0;
  return Math.round(num(item.damage) * (1 + num(item.plus)*0.22));
}
// a skill's level from a save (defaults: hitpoints 10, else 1)
function skillLvl(p, id){
  const s = p && p.skills && p.skills[id];
  if(s && isFinite(num(s.lvl)) && num(s.lvl) > 0) return num(s.lvl);
  return (id==='hitpoints') ? 10 : 1;
}
// effective (pre-variance, pre-crit) damage — port of pDamage()
function effectiveDamage(p){
  const eq = (p && p.equip) || {};
  let d = num(p.baseDmg) + weaponDamage(eq.weapon);
  if(eq.ring) d += num(eq.ring.bonusDmg);
  if(p.unlocked && p.unlocked.power) d *= 1.2;                 // "power" upgrade
  const atype = (eq.weapon && eq.weapon.atype) || 'melee';     // style scaling
  if(atype==='ranged')      d *= 1 + (skillLvl(p,'ranging')-1)*0.022;
  else if(atype==='magic')  d *= 1 + (((skillLvl(p,'goodmagic')+skillLvl(p,'evilmagic'))/2)-1)*0.018;
  else                      d *= 1 + (skillLvl(p,'strength')-1)*0.022;
  return Math.max(1, Math.round(d));
}
// the actual server-rolled per-swing damage (variance + crit) — authoritative
function rollHitDamage(p){
  const base = effectiveDamage(p);
  const crit = Math.random() < (0.12 + ((p && p.unlocked && p.unlocked.precision) ? 0.12 : 0));
  let dmg = base * (0.85 + Math.random()*0.3);
  if(crit) dmg *= 1.9;
  return { dmg: Math.max(1, Math.round(dmg)), crit };
}
// absolute ceiling a single legit hit could reach (safety clamp for fallbacks)
function maxHit(p){
  return Math.max(50, Math.ceil(effectiveDamage(p) * 1.15 * 1.9 * 1.5));
}

module.exports = { weaponDamage, skillLvl, effectiveDamage, rollHitDamage, maxHit };
