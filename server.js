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

const PORT = process.env.PORT || 2567;       // hosts set PORT automatically
const WORLD_SEED = 424242;                    // the whole realm grows from this — keep it fixed forever
const TICK_MS = 1000 / 15;                    // 15 snapshots per second

// a tiny health page so you can open the server URL in a browser and see it's alive
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hearthwood server is running. Players online: ' + clients.size);
});

const wss = new WebSocketServer({ server });
const clients = new Map();   // ws -> player
const plots = {};            // gid -> { name, tier, ownerId }  (house ownership)
let nextId = 1;

function send(ws, obj){ if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } }
function broadcastPlots(){ const out = { t:'plots', map:plots }; for (const ws2 of clients.keys()) send(ws2, out); }
function wsById(id){ for (const [ws, p] of clients) { if (p.id === id) return ws; } return null; }

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
    } else if (m.t === 'look') {
      if (m.look) player.look = m.look;
    } else if (m.t === 'state') {
      player.x = m.x; player.y = m.y;
      player.dir = m.dir || 'down';
      player.zone = m.zone || player.zone;
      player.moving = !!m.moving;
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
      player.chat = ('' + m.text).slice(0, 80);
      player.chatUntil = Date.now() + 5000;
      // WORLD CHAT: relay to every connected player, in any zone
      const out = { t:'say', name:player.name, color:player.color, zone:player.zone, text:player.chat };
      for (const ws2 of clients.keys()) send(ws2, out);
    }
  });

  ws.on('close', () => {
    // final cloud save on disconnect (best effort)
    const tws = wsById(player.tradeWith); if (tws) send(tws, { t:'trade_cancel', reason:'The other player left' });
    const tp = tws && clients.get(tws); if (tp) tp.tradeWith = null;
    clients.delete(ws);
  });
  ws.on('error', () => clients.delete(ws));
});

// broadcast a per-zone snapshot to everyone, 15x/sec
setInterval(() => {
  const now = Date.now();
  const byZone = {};
  for (const p of clients.values()) (byZone[p.zone] = byZone[p.zone] || []).push(p);

  for (const [ws, p] of clients) {
    const peers = byZone[p.zone] || [];
    const list = [];
    for (const q of peers) {
      if (q.id === p.id) continue;
      list.push({ id:q.id, name:q.name, color:q.color, look:q.look,
                  x:Math.round(q.x), y:Math.round(q.y), dir:q.dir, moving:q.moving,
                  chat: q.chatUntil > now ? q.chat : null });
    }
    send(ws, { t:'players', zone:p.zone, here: peers.length, online: clients.size, list });
  }
}, TICK_MS);

server.listen(PORT, () => console.log('Hearthwood server listening on port ' + PORT));
