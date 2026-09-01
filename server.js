require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { Server } = require('socket.io');
const { pool, init } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
const fs = require('fs');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(__dirname)); // flat repo — frontend files sit alongside server.js

// ---------- File uploads (media) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB cap

// ---------- Auth helpers ----------
function signToken(user) {
  return jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: '30d' });
}
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
function roomIdForDM(userIdA, userIdB) {
  return 'dm:' + [userIdA, userIdB].sort().join(':');
}

// ---------- Auth routes ----------
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'name, phone, and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with that phone number already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id: uuid(), name, phone, passwordHash, createdAt: Date.now() };
    await pool.query(
      'INSERT INTO users (id, name, phone, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)',
      [user.id, user.name, user.phone, user.passwordHash, user.createdAt]
    );

    const token = signToken(user);
    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid phone number or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid phone number or password' });

    const token = signToken({ id: user.id, name: user.name });
    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT id, name, phone FROM users WHERE id = $1', [req.user.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
});

// ---------- Directory / contacts ----------
app.get('/api/contacts', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT id, name, phone FROM users WHERE id != $1 ORDER BY name', [req.user.id]);
  res.json(result.rows);
});

// ---------- Groups ----------
app.post('/api/groups', authMiddleware, async (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'name and memberIds[] are required' });
  }
  const allMembers = Array.from(new Set([req.user.id, ...memberIds]));
  const group = { id: uuid(), name, memberIds: allMembers, createdAt: Date.now() };
  await pool.query(
    'INSERT INTO groups (id, name, member_ids, created_at) VALUES ($1,$2,$3::jsonb,$4)',
    [group.id, group.name, JSON.stringify(group.memberIds), group.createdAt]
  );
  res.json(group);
});

app.get('/api/groups', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, member_ids, created_at FROM groups WHERE member_ids @> $1::jsonb`,
    [JSON.stringify([req.user.id])]
  );
  const groups = result.rows.map(g => ({
    id: g.id, name: g.name, memberIds: g.member_ids, createdAt: Number(g.created_at)
  }));
  res.json(groups);
});

// ---------- Media upload ----------
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}`, type: req.file.mimetype });
});

// ---------- Message history ----------
app.get('/api/messages/:roomId', authMiddleware, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM messages WHERE room_id = $1 ORDER BY created_at ASC',
    [req.params.roomId]
  );
  const msgs = result.rows.map(m => ({
    id: m.id, roomId: m.room_id, senderId: m.sender_id, senderName: m.sender_name,
    text: m.text, mediaUrl: m.media_url, mediaType: m.media_type, createdAt: Number(m.created_at)
  }));
  res.json(msgs);
});

app.get('/api/rooms/dm/:otherUserId', authMiddleware, (req, res) => {
  res.json({ roomId: roomIdForDM(req.user.id, req.params.otherUserId) });
});

// ---------- Socket.io: auth + presence ----------
const onlineUsers = new Map(); // userId -> socketId

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Missing auth token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('Invalid or expired token'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  io.emit('presence:update', { userId, online: true });

  socket.on('room:join', (roomId) => socket.join(roomId));
  socket.on('room:leave', (roomId) => socket.leave(roomId));

  socket.on('message:send', async ({ roomId, text, mediaUrl, mediaType }) => {
    if (!roomId || (!text && !mediaUrl)) return;
    const message = {
      id: uuid(), roomId, senderId: userId, senderName: socket.user.name,
      text: text || null, mediaUrl: mediaUrl || null, mediaType: mediaType || null,
      createdAt: Date.now()
    };
    try {
      await pool.query(
        `INSERT INTO messages (id, room_id, sender_id, sender_name, text, media_url, media_type, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [message.id, message.roomId, message.senderId, message.senderName, message.text, message.mediaUrl, message.mediaType, message.createdAt]
      );
      io.to(roomId).emit('message:new', message);
    } catch (e) {
      console.error('Failed to save message', e);
    }
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('typing', { roomId, userId, name: socket.user.name, isTyping });
  });

  // ---------- WebRTC signaling (voice/video calls) ----------
  socket.on('call:invite', ({ toUserId, roomId, callType }) => {
    const targetSocket = onlineUsers.get(toUserId);
    if (!targetSocket) { socket.emit('call:unavailable', { toUserId }); return; }
    io.to(targetSocket).emit('call:incoming', { fromUserId: userId, fromName: socket.user.name, roomId, callType });
  });
  socket.on('call:offer', ({ toUserId, sdp, roomId, callType }) => {
    const targetSocket = onlineUsers.get(toUserId);
    if (targetSocket) io.to(targetSocket).emit('call:offer', { fromUserId: userId, sdp, roomId, callType });
  });
  socket.on('call:answer', ({ toUserId, sdp }) => {
    const targetSocket = onlineUsers.get(toUserId);
    if (targetSocket) io.to(targetSocket).emit('call:answer', { fromUserId: userId, sdp });
  });
  socket.on('call:ice-candidate', ({ toUserId, candidate }) => {
    const targetSocket = onlineUsers.get(toUserId);
    if (targetSocket) io.to(targetSocket).emit('call:ice-candidate', { fromUserId: userId, candidate });
  });
  socket.on('call:end', ({ toUserId }) => {
    const targetSocket = onlineUsers.get(toUserId);
    if (targetSocket) io.to(targetSocket).emit('call:end', { fromUserId: userId });
  });
  socket.on('call:reject', ({ toUserId }) => {
    const targetSocket = onlineUsers.get(toUserId);
    if (targetSocket) io.to(targetSocket).emit('call:reject', { fromUserId: userId });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('presence:update', { userId, online: false });
  });
});

init()
  .then(() => {
    server.listen(PORT, () => console.log(`Loop server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
