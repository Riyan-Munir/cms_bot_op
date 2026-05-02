// server.js
require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const logger  = require('./src/utils/logger');

const { initWhatsApp, isWhatsAppReady, getLatestQR, getLatestQRString, isQRPending, qrEventEmitter, listGroups } = require('./src/whatsapp/whatsappClient');
const { startScheduler, stopScheduler, triggerManualCheck } = require('./src/scheduler/scheduler');
const { refreshSession, closeBrowser }                      = require('./src/scraper/cmsScraper');
const { getAllRecords, updateRecord, deleteRecord }          = require('./src/utils/notificationStore');

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ── SSE QR events ─────────────────────────────────────────────────────────────
app.get('/qr/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

  if      (isWhatsAppReady())   send('ready', null);
  else if (getLatestQR())       send('qr', getLatestQR());
  else if (getLatestQRString()) send('qr_raw', getLatestQRString());
  else                          send('waiting', null);

  const onQR   = d  => send('qr', d);
  const onRaw  = r  => send('qr_raw', r);
  const onRdy  = () => { send('ready', null); cleanup(); };
  const onDisc = () => send('waiting', null);

  qrEventEmitter.on('qr', onQR); qrEventEmitter.on('qr_raw', onRaw);
  qrEventEmitter.on('ready', onRdy); qrEventEmitter.on('disconnected', onDisc);

  function cleanup() {
    qrEventEmitter.off('qr', onQR); qrEventEmitter.off('qr_raw', onRaw);
    qrEventEmitter.off('ready', onRdy); qrEventEmitter.off('disconnected', onDisc);
  }
  req.on('close', cleanup);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => clearInterval(ping));
});

// ── QR page ───────────────────────────────────────────────────────────────────
app.get('/qr', (_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><title>WhatsApp Login</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#161616;border-radius:20px;padding:32px;display:flex;flex-direction:column;align-items:center;gap:20px;box-shadow:0 0 40px rgba(37,211,102,.1);max-width:380px;width:100%}
h1{font-size:18px;color:#25D366;text-align:center}
.qr-wrap{background:#fff;border-radius:12px;padding:10px;border:3px solid #25D366;width:264px;height:264px;display:flex;align-items:center;justify-content:center;position:relative}
#qr-img{width:244px;height:244px;display:none}
#qr-canvas{display:none;align-items:center;justify-content:center}
#loading{display:flex;flex-direction:column;align-items:center;gap:10px;position:absolute}
.dots{display:flex;gap:6px}.dot{width:8px;height:8px;border-radius:50%;background:#25D366;animation:p 1.2s ease-in-out infinite}
.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
@keyframes p{0%,100%{opacity:.15;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
.steps{width:100%;display:flex;flex-direction:column;gap:8px}
.step{background:#1f1f1f;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;font-size:12px;color:#ccc}
.num{background:#25D366;color:#000;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:11px;flex-shrink:0}
#status{font-size:12px;color:#888;text-align:center}#timer{font-size:11px;color:#555;text-align:center;display:none}
.badge{background:#25D366;color:#000;padding:8px 24px;border-radius:999px;font-weight:bold;font-size:16px;display:none}
</style></head><body><div class="card">
<h1 id="title">📱 Scan to Connect WhatsApp</h1>
<div class="badge" id="badge">✓ WhatsApp Connected</div>
<div class="qr-wrap" id="wrap">
  <div id="loading"><div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div><p style="color:#888;font-size:12px" id="lt">Starting...</p></div>
  <img id="qr-img"/><div id="qr-canvas"></div>
</div>
<div class="steps" id="steps">
  <div class="step"><div class="num">1</div>Open WhatsApp on your phone</div>
  <div class="step"><div class="num">2</div>Tap ⋮ → Linked Devices</div>
  <div class="step"><div class="num">3</div>Tap Link a Device → scan here</div>
</div>
<p id="status">Connecting...</p><p id="timer"></p>
</div><script>
const img=document.getElementById('qr-img'),cv=document.getElementById('qr-canvas'),
ld=document.getElementById('loading'),lt=document.getElementById('lt'),
st=document.getElementById('status'),ti=document.getElementById('timer'),
badge=document.getElementById('badge'),wrap=document.getElementById('wrap'),
steps=document.getElementById('steps'),title=document.getElementById('title');
let exp=null;
function showQR(src){ld.style.display='none';cv.style.display='none';img.src=src;img.style.display='block';st.textContent='QR ready — scan now';ti.style.display='block';startTimer(60);}
function showRaw(raw){ld.style.display='none';img.style.display='none';cv.innerHTML='';try{new QRCode(cv,{text:raw,width:244,height:244});cv.style.display='flex';}catch(e){st.textContent='QR error — refresh';}st.textContent='QR ready — scan now';ti.style.display='block';startTimer(60);}
function showReady(){wrap.style.display='none';steps.style.display='none';badge.style.display='block';title.textContent='✅ WhatsApp Connected';st.textContent='Bot running.';ti.style.display='none';if(exp)clearInterval(exp);}
function showWait(){ld.style.display='flex';lt.textContent='Waiting for QR...';img.style.display='none';cv.style.display='none';st.textContent='QR will appear shortly...';}
function startTimer(s){if(exp)clearInterval(exp);let r=s;ti.textContent='Expires in '+r+'s';exp=setInterval(()=>{r--;ti.textContent=r>0?'Expires in '+r+'s':'Waiting for new QR...';if(r<=0)clearInterval(exp);},1000);}
(function connect(){const es=new EventSource('/qr/events');es.onmessage=e=>{const{type,data}=JSON.parse(e.data);if(type==='qr')showQR(data);else if(type==='qr_raw')showRaw(data);else if(type==='ready')showReady();else showWait();};es.onerror=()=>{st.textContent='Reconnecting...';es.close();setTimeout(connect,3000);};})();
</script></body></html>`);
});

// ── Notifications page ────────────────────────────────────────────────────────
app.get('/notifications', (_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><title>Notifications</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#e0e0e0;font-family:Arial,sans-serif;padding:24px;min-height:100vh}
h1{color:#25D366;font-size:20px;margin-bottom:6px}
.sub{color:#555;font-size:12px;margin-bottom:20px}
.toolbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
.search{background:#1a1a1a;border:1px solid #333;color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;width:220px;outline:none}
.search:focus{border-color:#25D366}
.btn{padding:7px 14px;border-radius:8px;border:none;cursor:pointer;font-size:12px;font-weight:bold}
.btn-green{background:#25D366;color:#000}.btn-red{background:#c0392b;color:#fff}
.btn-gray{background:#2a2a2a;color:#aaa;border:1px solid #333}
.btn:hover{opacity:.85}
#count{color:#555;font-size:12px;margin-left:auto}
.table-wrap{overflow-x:auto;border-radius:12px;border:1px solid #1e1e1e}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#161616;color:#777;padding:10px 12px;text-align:left;border-bottom:1px solid #222;white-space:nowrap}
tr:nth-child(even){background:#0e0e0e}
tr:hover{background:#161616}
td{padding:9px 12px;border-bottom:1px solid #1a1a1a;vertical-align:middle;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flag{display:inline-block;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:bold}
.yes{background:#1a3a1a;color:#25D366}.no{background:#2a1a1a;color:#c0392b}
.ext{background:#1a2a3a;color:#3498db}
.course{color:#25D366;font-weight:bold}
.deadline{color:#f39c12}
.actions{display:flex;gap:6px;white-space:nowrap}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:100;align-items:center;justify-content:center}
.overlay.open{display:flex}
.modal{background:#161616;border-radius:16px;padding:28px;width:100%;max-width:480px;border:1px solid #2a2a2a;display:flex;flex-direction:column;gap:14px}
.modal h2{color:#25D366;font-size:16px}
.field{display:flex;flex-direction:column;gap:5px}
label{font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.5px}
input[type=text],input[type=number]{background:#0e0e0e;border:1px solid #333;color:#fff;padding:8px 10px;border-radius:8px;font-size:13px;outline:none;width:100%}
input:focus{border-color:#25D366}
.checkrow{display:flex;gap:16px;flex-wrap:wrap}
.checkitem{display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;cursor:pointer}
.checkitem input{width:14px;height:14px;accent-color:#25D366}
.modal-btns{display:flex;gap:10px;justify-content:flex-end;margin-top:4px}
.toast{position:fixed;bottom:24px;right:24px;background:#25D366;color:#000;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:bold;opacity:0;transition:opacity .3s;pointer-events:none;z-index:200}
.toast.show{opacity:1}
</style></head><body>
<h1>📋 Notification Records</h1>
<p class="sub">View, edit or delete assignment notification records from notifications.json</p>
<div class="toolbar">
  <input class="search" id="search" placeholder="Search course or assignment..." oninput="render()">
  <button class="btn btn-gray" onclick="load()">↺ Refresh</button>
  <span id="count"></span>
</div>
<div class="table-wrap">
<table><thead><tr>
  <th>Course</th><th>Assignment</th><th>Deadline</th>
  <th>48hr</th><th>6hr</th><th>Ext</th><th>Extension?</th><th>Actions</th>
</tr></thead><tbody id="tbody"></tbody></table>
</div>
<div class="overlay" id="overlay">
  <div class="modal">
    <h2>✏️ Edit Record</h2>
    <input type="hidden" id="edit-key">
    <div class="field"><label>Course</label><input type="text" id="edit-course" readonly style="opacity:.5"></div>
    <div class="field"><label>Assignment</label><input type="text" id="edit-title" readonly style="opacity:.5"></div>
    <div class="field"><label>Deadline (display)</label><input type="text" id="edit-deadline"></div>
    <div class="field"><label>Deadline Timestamp (ms)</label><input type="number" id="edit-ms"></div>
    <div class="field"><label>Flags</label>
      <div class="checkrow">
        <label class="checkitem"><input type="checkbox" id="edit-48"> 48hr sent</label>
        <label class="checkitem"><input type="checkbox" id="edit-6"> 6hr sent</label>
        <label class="checkitem"><input type="checkbox" id="edit-ext"> Extension notified</label>
        <label class="checkitem"><input type="checkbox" id="edit-isext"> Is Extension</label>
      </div>
    </div>
    <div class="modal-btns">
      <button class="btn btn-gray" onclick="closeModal()">Cancel</button>
      <button class="btn btn-green" onclick="saveEdit()">Save</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
let data={};
async function load(){try{const r=await fetch('/notifications/data');data=await r.json();render();}catch(e){toast('Failed to load: '+e.message,true);}}
function render(){
  const q=document.getElementById('search').value.toLowerCase();
  const tbody=document.getElementById('tbody');
  const entries=Object.entries(data).filter(([k,v])=>!q||v.courseName?.toLowerCase().includes(q)||v.title?.toLowerCase().includes(q));
  document.getElementById('count').textContent=entries.length+' record(s)';
  if(!entries.length){tbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#444;padding:24px">No records found</td></tr>';return;}
  tbody.innerHTML=entries.map(([k,v])=>{
    const dl=v.deadlineDisplay||v.deadline||'—';
    const ts=v.deadlineMs?new Date(v.deadlineMs).toLocaleString():'—';
    const past=v.deadlineMs&&v.deadlineMs<Date.now();
    return \`<tr>
      <td class="course" title="\${esc(v.courseName)}">\${esc(v.courseName)}</td>
      <td title="\${esc(v.title)}">\${esc(v.title)}</td>
      <td class="deadline" title="\${ts}">\${esc(dl)}\${past?' <span style="color:#c0392b">(expired)</span>':''}</td>
      <td><span class="flag \${v.alert48hrSent?'yes':'no'}">\${v.alert48hrSent?'✓':'✗'}</span></td>
      <td><span class="flag \${v.alert6hrSent?'yes':'no'}">\${v.alert6hrSent?'✓':'✗'}</span></td>
      <td><span class="flag \${v.extensionNotified?'yes':'no'}">\${v.extensionNotified?'✓':'✗'}</span></td>
      <td><span class="flag \${v.isExtension?'ext':'no'}">\${v.isExtension?'Extended':'No'}</span></td>
      <td><div class="actions">
        <button class="btn btn-gray" onclick='openEdit(\${JSON.stringify(k)})'>Edit</button>
        <button class="btn btn-red" onclick='del(\${JSON.stringify(k)})'>Delete</button>
      </div></td>
    </tr>\`;
  }).join('');
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function openEdit(k){
  const v=data[k]; if(!v) return;
  document.getElementById('edit-key').value=k;
  document.getElementById('edit-course').value=v.courseName||'';
  document.getElementById('edit-title').value=v.title||'';
  document.getElementById('edit-deadline').value=v.deadlineDisplay||v.deadline||'';
  document.getElementById('edit-ms').value=v.deadlineMs||'';
  document.getElementById('edit-48').checked=!!v.alert48hrSent;
  document.getElementById('edit-6').checked=!!v.alert6hrSent;
  document.getElementById('edit-ext').checked=!!v.extensionNotified;
  document.getElementById('edit-isext').checked=!!v.isExtension;
  document.getElementById('overlay').classList.add('open');
}
function closeModal(){document.getElementById('overlay').classList.remove('open');}
async function saveEdit(){
  const k=document.getElementById('edit-key').value;
  const payload={deadlineDisplay:document.getElementById('edit-deadline').value,deadlineMs:parseInt(document.getElementById('edit-ms').value)||null,alert48hrSent:document.getElementById('edit-48').checked,alert6hrSent:document.getElementById('edit-6').checked,extensionNotified:document.getElementById('edit-ext').checked,isExtension:document.getElementById('edit-isext').checked};
  try{const r=await fetch('/notifications/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k,data:payload})});const j=await r.json();if(j.ok){data[k]={...data[k],...payload};render();closeModal();toast('Saved!');}else toast('Save failed: '+j.error,true);}
  catch(e){toast('Error: '+e.message,true);}
}
async function del(k){
  const v=data[k];
  if(!confirm('Delete "'+v?.title+'" from '+v?.courseName+'?')) return;
  try{const r=await fetch('/notifications/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})});const j=await r.json();if(j.ok){delete data[k];render();toast('Deleted.');}else toast('Delete failed: '+j.error,true);}
  catch(e){toast('Error: '+e.message,true);}
}
function toast(msg,err=false){const t=document.getElementById('toast');t.textContent=msg;t.style.background=err?'#c0392b':'#25D366';t.style.color=err?'#fff':'#000';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
document.getElementById('overlay').addEventListener('click',e=>{if(e.target===e.currentTarget)closeModal();});
load();
</script></body></html>`);
});

// ── Notifications API ─────────────────────────────────────────────────────────
app.get('/notifications/data', (_, res) => res.json(getAllRecords()));

app.post('/notifications/update', (req, res) => {
  const { key, data } = req.body;
  if (!key || !data) return res.json({ ok: false, error: 'Missing key or data' });
  res.json(updateRecord(key, data) ? { ok: true } : { ok: false, error: 'Record not found' });
});

app.post('/notifications/delete', (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ ok: false, error: 'Missing key' });
  res.json(deleteRecord(key) ? { ok: true } : { ok: false, error: 'Record not found' });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', whatsappReady: isWhatsAppReady(), qrPending: isQRPending(), uptime: Math.floor(process.uptime()) }));

app.get('/groups', async (_, res) => {
  if (!isWhatsAppReady()) return res.status(503).json({ error: 'WhatsApp not ready. Visit /qr.' });
  try { res.json({ groups: await listGroups() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/assignments', (_, res) => {
  const r = getAllRecords();
  res.json({ count: Object.keys(r).length, records: r });
});

app.post('/check', (_, res) => {
  res.json({ message: 'Manual check triggered.' });
  triggerManualCheck().catch(e => logger.error(`Manual check: ${e.message}`));
});

app.post('/refresh-session', (_, res) => {
  res.json({ message: 'Session refresh triggered.' });
  refreshSession().catch(e => logger.error(`Manual refresh: ${e.message}`));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  logger.info('Shutting down...');
  stopScheduler();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── WhatsApp — init with auto-reconnect on disconnect ─────────────────────────
// Listens to the disconnected event and re-initialises automatically.
// This keeps the bot alive for months without manual intervention.
async function startWhatsApp(attempt = 1) {
  try {
    logger.info(`WhatsApp init attempt #${attempt}...`);
    await initWhatsApp();
    // On disconnect, reinit after a short delay
    qrEventEmitter.once('disconnected', () => {
      logger.warn('WhatsApp disconnected — will reinitialise in 10s...');
      setTimeout(() => startWhatsApp(1), 10000);
    });
  } catch (err) {
    logger.error(`WhatsApp init failed: ${err.message}`);
    const delay = Math.min(30000 * attempt, 120000);
    logger.info(`Retrying in ${delay / 1000}s...`);
    setTimeout(() => startWhatsApp(attempt + 1), delay);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const url = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`;
  logger.info('═══════════════════════════════════════');
  logger.info('   Bahria CMS Assignment Bot Started   ');
  logger.info('═══════════════════════════════════════');
  logger.info(`QR Page:       ${url}/qr`);
  logger.info(`Notifications: ${url}/notifications`);
  logger.info(`Health:        ${url}/health`);
  logger.info(`Groups:        ${url}/groups`);
  logger.info('───────────────────────────────────────');
  startScheduler();
  startWhatsApp();
});
