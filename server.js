/**
 * EduCall — Servidor Completo v4
 * ================================
 * - PeerJS integrado en el mismo servidor (soluciona el problema de video)
 * - Salas con contraseña
 * - Grabación de clases
 * - Sistema de permisos mic/pantalla
 * - Soporte para múltiples estudiantes
 *
 * INSTALACIÓN:
 *   npm install
 *
 * EJECUCIÓN LOCAL:
 *   node server.js
 */

const express          = require('express');
const http             = require('http');
const { Server }       = require('socket.io');
const { ExpressPeerServer } = require('peer');
const cors             = require('cors');
const path             = require('path');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── PEERJS en el mismo servidor ──────────────────────────────────────────────
const peerServer = ExpressPeerServer(server, {
  debug: false,
  path: '/',
  allow_discovery: true,
  proxied: true,              // ← importante para Render (proxy)
});
app.use('/peerjs', peerServer);

peerServer.on('connection',  c => console.log(`[Peer] + ${c.getId()}`));
peerServer.on('disconnect',  c => console.log(`[Peer] - ${c.getId()}`));

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket', 'polling'],
});

/**
 * rooms[roomId] = {
 *   password: string|null,
 *   teacherSocketId: string|null,
 *   participants: { [socketId]: Participant },
 *   messages: Message[],
 *   startTime: number,
 *   recording: boolean,
 * }
 */
const rooms = {};

function isTeacher(roomId, socketId) {
  return rooms[roomId]?.participants[socketId]?.userRole === 'Profesor';
}

function safeParticipants(roomId) {
  return Object.values(rooms[roomId]?.participants || {});
}

io.on('connection', socket => {

  // ── Verificar contraseña antes de unirse ──────────────────────────────────
  socket.on('check-password', ({ roomId, password }) => {
    const room = rooms[roomId];
    if (!room) {
      // sala nueva — cualquier contraseña es válida (la define el primer usuario)
      socket.emit('password-ok');
      return;
    }
    if (!room.password || room.password === password) {
      socket.emit('password-ok');
    } else {
      socket.emit('password-wrong');
    }
  });

  // ── Unirse a sala ──────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, peerId, userName, userRole, password }) => {

    // Verificar contraseña
    if (rooms[roomId]?.password && rooms[roomId].password !== password) {
      socket.emit('kicked', { reason: 'Contraseña incorrecta' });
      return;
    }

    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = {
        password: password || null,
        teacherSocketId: null,
        participants: {},
        messages: [],
        startTime: Date.now(),
        recording: false,
      };
    }

    const room = rooms[roomId];
    if (userRole === 'Profesor' && !room.teacherSocketId) {
      room.teacherSocketId = socket.id;
    }

    room.participants[socket.id] = {
      socketId: socket.id,
      peerId,
      userName,
      userRole,
      micOn:    userRole === 'Profesor',
      camOn:    true,
      handRaised:      false,
      isSharingScreen: false,
      micPermission:    userRole === 'Profesor' ? 'granted' : 'none',
      screenPermission: userRole === 'Profesor' ? 'granted' : 'none',
      joinedAt: Date.now(),
    };

    console.log(`[Room ${roomId}] ${userName} (${userRole}) entró | Total: ${Object.keys(room.participants).length}`);

    // Notificar a los demás
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id, peerId, userName, userRole,
    });

    // Enviar participantes existentes al nuevo
    const existing = safeParticipants(roomId).filter(p => p.socketId !== socket.id);
    socket.emit('existing-participants', existing);

    // Enviar estado de permisos
    socket.emit('permissions-update', {
      micPermission:    room.participants[socket.id].micPermission,
      screenPermission: room.participants[socket.id].screenPermission,
      hasTeacher:       !!room.teacherSocketId,
      roomRecording:    room.recording,
    });

    // Historial de chat
    if (room.messages.length) socket.emit('chat-history', room.messages.slice(-50));

    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  // ── PERMISOS ──────────────────────────────────────────────────────────────

  socket.on('request-mic-permission', ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p || p.userRole !== 'Estudiante') return;
    p.micPermission = 'requested';
    const tId = room.teacherSocketId;
    if (!tId) { socket.emit('no-teacher-online'); return; }
    io.to(tId).emit('permission-request', { type:'mic', requesterSocketId: socket.id, requesterName: p.userName, roomId });
    socket.emit('permission-request-sent', { type:'mic' });
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  socket.on('request-screen-permission', ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p || p.userRole !== 'Estudiante') return;
    p.screenPermission = 'requested';
    const tId = room.teacherSocketId;
    if (!tId) { socket.emit('no-teacher-online'); return; }
    io.to(tId).emit('permission-request', { type:'screen', requesterSocketId: socket.id, requesterName: p.userName, roomId });
    socket.emit('permission-request-sent', { type:'screen' });
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  socket.on('respond-permission', ({ roomId, targetSocketId, type, approved }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId]; if (!room) return;
    const target = room.participants[targetSocketId]; if (!target) return;
    const state = approved ? 'granted' : 'denied';
    if (type === 'mic')    target.micPermission    = state;
    if (type === 'screen') target.screenPermission = state;
    const label = type === 'mic' ? 'micrófono' : 'pantalla';
    io.to(targetSocketId).emit('permission-response', {
      type, approved,
      message: approved ? `✅ El profesor autorizó tu ${label}` : `❌ El profesor denegó tu ${label}`,
    });
    if (type === 'mic' && approved) {
      io.to(roomId).emit('student-mic-enabled', { socketId: targetSocketId, userName: target.userName });
    }
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  socket.on('revoke-permission', ({ roomId, targetSocketId, type }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId]; if (!room) return;
    const target = room.participants[targetSocketId]; if (!target) return;
    if (type === 'mic')    { target.micPermission    = 'none'; target.micOn = false; }
    if (type === 'screen') { target.screenPermission = 'none'; target.isSharingScreen = false; }
    io.to(targetSocketId).emit('permission-revoked', { type });
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  // ── Media ─────────────────────────────────────────────────────────────────
  socket.on('toggle-mic', ({ roomId, micOn }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    if (p.userRole === 'Estudiante' && micOn && p.micPermission !== 'granted') {
      socket.emit('permission-denied-action', { type:'mic' }); return;
    }
    p.micOn = micOn;
    socket.to(roomId).emit('participant-mic-changed', { socketId: socket.id, micOn });
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  socket.on('toggle-cam', ({ roomId, camOn }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    p.camOn = camOn;
    socket.to(roomId).emit('participant-cam-changed', { socketId: socket.id, camOn });
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  socket.on('screen-share-start', ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    if (p.userRole === 'Estudiante' && p.screenPermission !== 'granted') {
      socket.emit('permission-denied-action', { type:'screen' }); return;
    }
    p.isSharingScreen = true;
    io.to(roomId).emit('screen-share-started', { socketId: socket.id, userName: p.userName, peerId: p.peerId });
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  socket.on('screen-share-stop', ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    p.isSharingScreen = false;
    io.to(roomId).emit('screen-share-stopped', { socketId: socket.id });
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  socket.on('raise-hand', ({ roomId, raised }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    p.handRaised = raised;
    io.to(roomId).emit('hand-raised', { socketId: socket.id, userName: p.userName, raised });
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  // ── GRABACIÓN ─────────────────────────────────────────────────────────────
  socket.on('start-recording', ({ roomId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId]; if (!room) return;
    room.recording = true;
    io.to(roomId).emit('recording-started', { startedBy: room.participants[socket.id]?.userName });
    console.log(`[Room ${roomId}] Grabación iniciada`);
  });

  socket.on('stop-recording', ({ roomId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId]; if (!room) return;
    room.recording = false;
    io.to(roomId).emit('recording-stopped');
    console.log(`[Room ${roomId}] Grabación detenida`);
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    const full = {
      id: `${Date.now()}_${socket.id}`,
      senderSocketId: socket.id,
      senderName: p.userName,
      senderRole: p.userRole,
      text: message.text,
      timestamp: Date.now(),
    };
    room.messages.push(full);
    if (room.messages.length > 200) room.messages.shift();
    io.to(roomId).emit('chat-message', full);
  });

  // ── Reacciones y pizarra ───────────────────────────────────────────────────
  socket.on('reaction', ({ roomId, emoji }) => {
    const name = rooms[roomId]?.participants[socket.id]?.userName || '';
    socket.to(roomId).emit('reaction', { emoji, userName: name });
  });

  socket.on('whiteboard-draw',  ({ roomId, drawData }) => socket.to(roomId).emit('whiteboard-draw', drawData));
  socket.on('whiteboard-clear', ({ roomId }) => socket.to(roomId).emit('whiteboard-clear'));
  socket.on('whiteboard-text',  ({ roomId, textData }) => socket.to(roomId).emit('whiteboard-text', textData));

  // ── Moderación ────────────────────────────────────────────────────────────
  socket.on('mute-participant', ({ roomId, targetSocketId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId]; if (!room) return;
    const t = room.participants[targetSocketId]; if (!t) return;
    t.micOn = false; t.micPermission = 'none';
    io.to(targetSocketId).emit('force-mute');
    io.to(roomId).emit('participants-update', safeParticipants(roomId));
  });

  socket.on('kick-participant', ({ roomId, targetSocketId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    io.to(targetSocketId).emit('force-kick');
  });

  // ── Desconexión ───────────────────────────────────────────────────────────
  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      const room = rooms[roomId]; if (!room) continue;
      const p = room.participants[socket.id]; if (!p) continue;
      const { userName } = p;
      delete room.participants[socket.id];
      if (room.teacherSocketId === socket.id) {
        const newT = Object.values(room.participants).find(x => x.userRole === 'Profesor');
        room.teacherSocketId = newT?.socketId || null;
      }
      socket.to(roomId).emit('user-left', { socketId: socket.id, userName });
      io.to(roomId).emit('participants-update', safeParticipants(roomId));
      if (Object.keys(room.participants).length === 0) {
        delete rooms[roomId];
        console.log(`[Room ${roomId}] Eliminada (vacía)`);
      }
    }
  });

  socket.on('disconnect', () => console.log(`[Socket] Desconectado: ${socket.id}`));
});

// ─── API REST ──────────────────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  res.json(Object.entries(rooms).map(([id, r]) => ({
    roomId: id,
    participants: Object.keys(r.participants).length,
    hasPassword: !!r.password,
    recording: r.recording,
    startTime: r.startTime,
  })));
});

app.get('/api/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.json({ exists: false });
  res.json({
    exists: true,
    hasPassword: !!room.password,
    hasTeacher: !!room.teacherSocketId,
    participants: Object.keys(room.participants).length,
    recording: room.recording,
  });
});

// ─── UptimeRobot ping endpoint ─────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── Inicio ────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  🎓  EduCall v4 — Servidor Completo                   ║
║  📡  Puerto: ${PORT}                                      ║
║  🔗  PeerJS: /peerjs                                  ║
║  🔒  Contraseñas: activadas                           ║
║  🎬  Grabación: activada                              ║
║  🏓  Ping UptimeRobot: /ping                          ║
╚══════════════════════════════════════════════════════╝
  `);
});
