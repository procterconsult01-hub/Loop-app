require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { Server } = require('socket.io');
const { pool, init } = require('./db');
const { saveFile, localUploadsDir } = require('./storage');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const PORT = process.env.PORT || 3001;

if (JWT_SECRET === 'change-this-secret-before-deploying') {
  console.warn('WARNING: JWT_SECRET is not set — using an insecure default. Set it in your environment before real use.');
}

// Railway (and most hosts) sit behind a proxy — this makes req.ip reflect the
// real client IP instead of the proxy's, which the rate limiters below need.
app.set('trust proxy', 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json({ limit: '1mb' })); // caps request body size against abuse

// Slows down brute-force attempts against login/register specifically.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});
// A gentler general limit across the rest of the API.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

app.use('/uploads', express.static(localUploadsDir)); // only used when R2 isn't configured
app.use(express.static(__dirname)); // flat repo — frontend files sit alongside server.js

// ---------- File uploads (media) ----------
// Kept in memory, then handed to storage.js which sends to R2 if configured
// or writes to local disk otherwise.
const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm',
  'application/pdf'
];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB cap
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('That file type is not allowed'));
  }
});

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
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'name, phone, and password are required' });
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 60) {
      return res.status(400).json({ error: 'Name must be between 1 and 60 characters' });
    }
    if (password.length < 6 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with that phone number already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id: uuid(), name: name.trim(), phone, passwordHash, createdAt: Date.now() };
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

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password are required' });
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
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
    return res.status(400).json({ error: 'Group name must be between 1 and 80 characters' });
  }
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'memberIds[] is required' });
  }
  const allMembers = Array.from(new Set([req.user.id, ...memberIds]));
  const group = { id: uuid(), name: name.trim(), memberIds: allMembers, createdAt: Date.now() };
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
app.post('/api/upload', authMiddleware, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const url = await saveFile(req.file);
      res.json({ url, type: req.file.mimetype });
    } catch (e) {
      console.error('Upload failed', e);
      res.status(500).json({ error: 'Upload failed' });
    }
  });
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

// ---------- ICE server config (STUN + TURN) for WebRTC calls ----------
// Frontend fetches this instead of hardcoding servers, so TURN credentials
// live only in environment variables, never in client-side code.
app.get('/api/ice-servers', authMiddleware, (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.json({ iceServers });
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
    if (text && (typeof text !== 'string' || text.length > 2000)) return; // basic abuse guard
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
