const API = '';
let token = null, me = null, socket = null;
let currentRoom = null, currentRoomLabel = null, currentPeerId = null; // peerId used for DM calls
let contacts = [], groups = [];
let selectedMembers = new Set();
let authMode = 'login';

// ---- WebRTC state ----
let pc = null, localStream = null, activeCallPeerId = null, pendingCall = null;
let cachedIceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; // fallback until /api/ice-servers loads

async function loadIceServers(){
  try{
    const res = await authedFetch('/api/ice-servers');
    const data = await res.json();
    if(data.iceServers && data.iceServers.length) cachedIceServers = data.iceServers;
  }catch(e){
    console.warn('Could not load ICE server config, using STUN-only fallback', e);
  }
}

function colorFor(name){
  const colors = ['#6C5CE7','#00B894','#E17055','#0984E3','#D63031','#00CEC9','#FD79A8','#FDCB6E'];
  let h=0; for(const c of (name||'?')) h=c.charCodeAt(0)+((h<<5)-h);
  return colors[Math.abs(h)%colors.length];
}
function initials(name){ return (name||'?').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
function escapeHtml(str){ const d=document.createElement('div'); d.textContent=str||''; return d.innerHTML; }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); }

// ---------------- Auth ----------------
function setAuthMode(mode){
  authMode = mode;
  document.getElementById('tab-login').classList.toggle('active', mode==='login');
  document.getElementById('tab-register').classList.toggle('active', mode==='register');
  document.getElementById('register-fields').style.display = mode==='register' ? '
