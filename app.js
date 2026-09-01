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
  document.getElementById('register-fields').style.display = mode==='register' ? 'block' : 'none';
  document.getElementById('auth-submit').textContent = mode==='login' ? 'Log in' : 'Sign up';
  document.getElementById('auth-error').textContent = '';
}

async function submitAuth(){
  const phone = document.getElementById('auth-phone').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';

  const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
  const body = authMode === 'login'
    ? { phone, password }
    : { name: document.getElementById('reg-name').value.trim(), phone, password };

  try{
    const res = await fetch(API + endpoint, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    const data = await res.json();
    if(!res.ok){ errEl.textContent = data.error || 'Something went wrong'; return; }
    token = data.token; me = data.user;
    enterApp();
  }catch(e){
    errEl.textContent = 'Could not reach the server. Is it running?';
  }
}

function enterApp(){
  document.getElementById('view-auth').classList.remove('active');
  document.getElementById('view-main').classList.add('active');
  document.getElementById('me-label').textContent = me.name;
  initSocket();
  loadContacts();
  loadGroups();
  loadIceServers();
}

// ---------------- Socket ----------------
function initSocket(){
  socket = io({ auth: { token } });

  socket.on('message:new', (msg) => {
    if(msg.roomId === currentRoom) appendMessage(msg);
  });

  socket.on('presence:update', ({ userId, online }) => {
    const row = document.querySelector(`.list-row[data-userid="${userId}"] .avatar`);
    if(row) row.classList.toggle('online', online);
  });

  socket.on('call:incoming', ({ fromUserId, fromName, roomId, callType }) => {
    pendingCall = { fromUserId, fromName, roomId, callType };
    document.getElementById('incoming-avatar').style.background = colorFor(fromName);
    document.getElementById('incoming-avatar').textContent = initials(fromName);
    document.getElementById('incoming-name').textContent = fromName;
    document.getElementById('incoming-type').textContent = (callType==='video'?'Video call':'Voice call') + '…';
    document.getElementById('incoming-call-overlay').classList.add('active');
  });

  socket.on('call:offer', async ({ fromUserId, sdp, callType }) => {
    activeCallPeerId = fromUserId;
    await setupPeerConnection(callType, false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call:answer', { toUserId: fromUserId, sdp: answer });
  });

  socket.on('call:answer', async ({ sdp }) => {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    document.getElementById('active-call-status').textContent = 'Connected';
  });

  socket.on('call:ice-candidate', async ({ candidate }) => {
    if(pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  socket.on('call:end', () => teardownCall());
  socket.on('call:reject', () => { teardownCall(); alert('Call declined'); });
  socket.on('call:unavailable', () => { teardownCall(); alert('That person is offline right now'); });
}

// ---------------- Contacts / Groups ----------------
async function authedFetch(url, opts={}){
  opts.headers = Object.assign({}, opts.headers, { 'Authorization': 'Bearer ' + token });
  return fetch(API + url, opts);
}

async function loadContacts(){
  const res = await authedFetch('/api/contacts');
  contacts = await res.json();
  renderContacts();
  renderMemberPicker();
}

async function loadGroups(){
  const res = await authedFetch('/api/groups');
  groups = await res.json();
  renderGroups();
}

function renderContacts(){
  const el = document.getElementById('contact-list');
  el.innerHTML = contacts.map(c => `
    <div class="list-row" data-userid="${c.id}" onclick='openDM(${JSON.stringify(c).replace(/'/g,"&apos;")})'>
      <div class="avatar" style="background:${colorFor(c.name)}">${initials(c.name)}</div>
      <div>
        <div class="list-name">${escapeHtml(c.name)}</div>
        <div class="list-sub">${escapeHtml(c.phone)}</div>
      </div>
    </div>
  `).join('') || '<div style="padding:10px 18px;color:var(--text-faint);font-size:12.5px;">No other users yet — register a second account to test.</div>';
}

function renderGroups(){
  const el = document.getElementById('group-list');
  el.innerHTML = groups.map(g => `
    <div class="list-row" onclick='openGroup(${JSON.stringify(g).replace(/'/g,"&apos;")})'>
      <div class="avatar" style="background:${colorFor(g.name)}">${initials(g.name)}</div>
      <div>
        <div class="list-name">${escapeHtml(g.name)}</div>
        <div class="list-sub">${g.memberIds.length} members</div>
      </div>
    </div>
  `).join('') || '<div style="padding:10px 18px;color:var(--text-faint);font-size:12.5px;">No groups yet.</div>';
}

function renderMemberPicker(){
  const el = document.getElementById('group-member-picker');
  el.innerHTML = contacts.map(c => `
    <div class="member-chip" data-id="${c.id}" onclick="toggleMember('${c.id}', this)">${escapeHtml(c.name)}</div>
  `).join('');
}
function toggleMember(id, el){
  if(selectedMembers.has(id)){ selectedMembers.delete(id); el.classList.remove('selected'); }
  else { selectedMembers.add(id); el.classList.add('selected'); }
}
async function createGroup(){
  const name = document.getElementById('group-name').value.trim();
  if(!name || selectedMembers.size===0){ alert('Enter a group name and pick at least one member'); return; }
  const res = await authedFetch('/api/groups', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name, memberIds: Array.from(selectedMembers) })
  });
  if(res.ok){
    document.getElementById('group-name').value = '';
    selectedMembers.clear();
    renderMemberPicker();
    loadGroups();
  }
}

// ---------------- Chat ----------------
async function openDM(contact){
  const res = await authedFetch(`/api/rooms/dm/${contact.id}`);
  const { roomId } = await res.json();
  currentPeerId = contact.id;
  enterRoom(roomId, contact.name, 'Direct message');
}
function openGroup(group){
  currentPeerId = null; // groups don't support 1:1 calls in this MVP
  enterRoom('group:' + group.id, group.name, group.memberIds.length + ' members');
}

async function enterRoom(roomId, label, sub){
  if(currentRoom) socket.emit('room:leave', currentRoom);
  currentRoom = roomId;
  currentRoomLabel = label;
  socket.emit('room:join', roomId);

  document.getElementById('chat-empty').style.display = 'none';
  document.getElementById('chat-active').style.display = 'flex';
  document.getElementById('room-avatar').style.background = colorFor(label);
  document.getElementById('room-avatar').textContent = initials(label);
  document.getElementById('room-name').textContent = label;
  document.getElementById('room-status').textContent = sub;

  const res = await authedFetch('/api/messages/' + encodeURIComponent(roomId));
  const history = await res.json();
  document.getElementById('messages').innerHTML = '';
  history.forEach(appendMessage);
}

function appendMessage(msg){
  const box = document.getElementById('messages');
  const mine = msg.senderId === me.id;
  const cls = mine ? 'out' : 'in';
  const senderLabel = mine ? '' : `<div class="msg-sender">${escapeHtml(msg.senderName)}</div>`;

  let mediaHtml = '';
  if(msg.mediaUrl){
    if((msg.mediaType||'').startsWith('image/')) mediaHtml = `<img src="${msg.mediaUrl}">`;
    else if((msg.mediaType||'').startsWith('video/')) mediaHtml = `<video src="${msg.mediaUrl}" controls></video>`;
    else if((msg.mediaType||'').startsWith('audio/')) mediaHtml = `<audio src="${msg.mediaUrl}" controls></audio>`;
    else mediaHtml = `<a href="${msg.mediaUrl}" target="_blank" style="color:inherit;">📎 Attachment</a>`;
  }
  const textHtml = msg.text ? `<div>${escapeHtml(msg.text)}</div>` : '';

  const row = document.createElement('div');
  row.className = 'msg-row ' + cls;
  row.innerHTML = `${senderLabel}<div class="bubble">${mediaHtml}${textHtml}<div class="bubble-time">${fmtTime(msg.createdAt)}</div></div>`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function sendMessage(){
  const input = document.getElementById('text-input');
  const text = input.value.trim();
  if(!text || !currentRoom) return;
  socket.emit('message:send', { roomId: currentRoom, text });
  input.value = '';
}

async function handleFileSelect(event){
  const file = event.target.files[0];
  if(!file || !currentRoom) return;
  const formData = new FormData();
  formData.append('file', file);
  const res = await authedFetch('/api/upload', { method:'POST', body: formData });
  const data = await res.json();
  if(res.ok){
    socket.emit('message:send', { roomId: currentRoom, mediaUrl: data.url, mediaType: data.type });
  }
  event.target.value = '';
}

// ---------------- WebRTC calls ----------------
async function setupPeerConnection(callType, isCaller){
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true, video: callType === 'video'
  });
  document.getElementById('local-video').srcObject = localStream;
  document.getElementById('local-video').style.display = callType === 'video' ? 'block' : 'none';

  pc = new RTCPeerConnection({ iceServers: cachedIceServers });
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    document.getElementById('remote-video').srcObject = event.streams[0];
  };
  pc.onicecandidate = (event) => {
    if(event.candidate && activeCallPeerId){
      socket.emit('call:ice-candidate', { toUserId: activeCallPeerId, candidate: event.candidate });
    }
  };
  pc.onconnectionstatechange = () => {
    if(pc.connectionState === 'connected') document.getElementById('active-call-status').textContent = 'Connected';
    if(['disconnected','failed','closed'].includes(pc.connectionState)) teardownCall();
  };

  document.getElementById('active-call-overlay').classList.add('active');
  document.getElementById('active-call-name').textContent = currentRoomLabel || 'Call';
}

async function startCall(callType){
  if(!currentPeerId){ alert('Voice/video calling works for direct messages in this build (not group calls yet).'); return; }
  activeCallPeerId = currentPeerId;
  socket.emit('call:invite', { toUserId: currentPeerId, roomId: currentRoom, callType });
  document.getElementById('active-call-status').textContent = 'Calling…';
  await setupPeerConnection(callType, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call:offer', { toUserId: currentPeerId, sdp: offer, roomId: currentRoom, callType });
}

async function acceptCall(){
  document.getElementById('incoming-call-overlay').classList.remove('active');
  activeCallPeerId = pendingCall.fromUserId;
  currentRoomLabel = pendingCall.fromName;
  // setupPeerConnection happens once the offer arrives via socket 'call:offer' listener,
  // which fires right after the caller sends it — this just readies local media/UI.
  await setupPeerConnection(pendingCall.callType, false);
  pendingCall = null;
}

function rejectCall(){
  if(pendingCall) socket.emit('call:reject', { toUserId: pendingCall.fromUserId });
  document.getElementById('incoming-call-overlay').classList.remove('active');
  pendingCall = null;
}

function endCall(){
  if(activeCallPeerId) socket.emit('call:end', { toUserId: activeCallPeerId });
  teardownCall();
}

function teardownCall(){
  if(pc){ pc.close(); pc = null; }
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream = null; }
  document.getElementById('active-call-overlay').classList.remove('active');
  document.getElementById('active-call-status').textContent = 'Connecting…';
  activeCallPeerId = null;
}

function toggleMute(){
  if(!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  document.getElementById('mute-btn').classList.toggle('active-toggle', !track.enabled);
}
function toggleCamera(){
  if(!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if(!track) return;
  track.enabled = !track.enabled;
  document.getElementById('cam-btn').classList.toggle('active-toggle', !track.enabled);
}
