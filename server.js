/**
 * EduCall — Servidor con Sistema de Permisos
 * ===========================================
 * Stack: Node.js + Express + Socket.io + PeerJS Server
 *
 * INSTALACIÓN:
 *   npm install express socket.io peer cors
 *
 * EJECUCIÓN:
 *   node server.js
 *
 * Abre en el navegador: http://localhost:3000
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const cors       = require('cors');
const path       = require('path');

const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── PEERJS ────────────────────────────────────────────────────────────────
const peerServer = ExpressPeerServer(server, { debug: true, path: '/', allow_discovery: true });
app.use('/peerjs', peerServer);
peerServer.on('connection',  c => console.log(`[PeerJS] Conectado: ${c.getId()}`));
peerServer.on('disconnect',  c => console.log(`[PeerJS] Desconectado: ${c.getId()}`));

// ─── SOCKET.IO ─────────────────────────────────────────────────────────────
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

/**
 * rooms[roomId] = {
 *   participants: {
 *     [socketId]: {
 *       socketId, peerId, userName, userRole,
 *       micOn, camOn, handRaised, isSharingScreen,
 *       micPermission:    'none' | 'requested' | 'granted' | 'denied',
 *       screenPermission: 'none' | 'requested' | 'granted' | 'denied',
 *       joinedAt
 *     }
 *   },
 *   messages: [],
 *   startTime: number,
 *   teacherSocketId: string|null
 * }
 */
const rooms = {};

function isTeacher(roomId, socketId) {
  const p = rooms[roomId]?.participants[socketId];
  return p?.userRole === 'Profesor';
}

io.on('connection', (socket) => {
  console.log(`[Socket.io] Conectado: ${socket.id}`);

  // ── Unirse a sala ────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, peerId, userName, userRole }) => {
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = { participants: {}, messages: [], startTime: Date.now(), teacherSocketId: null };
    }
    const room = rooms[roomId];
    if (userRole === 'Profesor' && !room.teacherSocketId) room.teacherSocketId = socket.id;

    room.participants[socket.id] = {
      socketId: socket.id, peerId, userName, userRole,
      micOn: userRole === 'Profesor',
      camOn: true,
      handRaised: false,
      isSharingScreen: false,
      micPermission:    userRole === 'Profesor' ? 'granted' : 'none',
      screenPermission: userRole === 'Profesor' ? 'granted' : 'none',
      joinedAt: Date.now(),
    };

    console.log(`[Room ${roomId}] ${userName} (${userRole}) entró`);

    socket.to(roomId).emit('user-joined', { socketId: socket.id, peerId, userName, userRole });
    socket.emit('existing-participants', Object.values(room.participants).filter(p => p.socketId !== socket.id));
    socket.emit('permissions-update', {
      micPermission:    room.participants[socket.id].micPermission,
      screenPermission: room.participants[socket.id].screenPermission,
      hasTeacher: !!room.teacherSocketId,
    });
    if (room.messages.length) socket.emit('chat-history', room.messages.slice(-50));
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  // ── SOLICITUDES DE PERMISO (Estudiante → Profesor) ───────────────────────
  socket.on('request-mic-permission', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.participants[socket.id];
    if (!p || p.userRole !== 'Estudiante') return;
    if (p.micPermission === 'granted') return;

    p.micPermission = 'requested';
    const tId = room.teacherSocketId;
    if (!tId) { socket.emit('no-teacher-online'); return; }

    console.log(`[Permiso MIC] ${p.userName} solicita al profesor`);
    io.to(tId).emit('permission-request', {
      type: 'mic', requesterSocketId: socket.id, requesterName: p.userName, roomId,
    });
    socket.emit('permission-request-sent', { type: 'mic' });
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  socket.on('request-screen-permission', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.participants[socket.id];
    if (!p || p.userRole !== 'Estudiante') return;
    if (p.screenPermission === 'granted') return;

    p.screenPermission = 'requested';
    const tId = room.teacherSocketId;
    if (!tId) { socket.emit('no-teacher-online'); return; }

    console.log(`[Permiso PANTALLA] ${p.userName} solicita al profesor`);
    io.to(tId).emit('permission-request', {
      type: 'screen', requesterSocketId: socket.id, requesterName: p.userName, roomId,
    });
    socket.emit('permission-request-sent', { type: 'screen' });
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  // ── RESPUESTA DEL PROFESOR a solicitudes ─────────────────────────────────
  socket.on('respond-permission', ({ roomId, targetSocketId, type, approved }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId];
    const target = room?.participants[targetSocketId];
    if (!target) return;

    const state = approved ? 'granted' : 'denied';
    if (type === 'mic')    target.micPermission    = state;
    if (type === 'screen') target.screenPermission = state;

    const label = type === 'mic' ? 'micrófono' : 'compartir pantalla';
    console.log(`[Permiso] Profesor ${approved?'APROBÓ':'DENEGÓ'} ${type} a ${target.userName}`);

    io.to(targetSocketId).emit('permission-response', {
      type, approved,
      message: approved
        ? `✅ El profesor autorizó tu ${label}`
        : `❌ El profesor denegó tu ${label}`,
    });
    if (type === 'mic' && approved) {
      io.to(roomId).emit('student-mic-enabled', { socketId: targetSocketId, userName: target.userName });
    }
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  // ── REVOCAR permiso ───────────────────────────────────────────────────────
  socket.on('revoke-permission', ({ roomId, targetSocketId, type }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId];
    const target = room?.participants[targetSocketId];
    if (!target) return;

    if (type === 'mic')    { target.micPermission    = 'none'; target.micOn = false; }
    if (type === 'screen') { target.screenPermission = 'none'; target.isSharingScreen = false; }

    io.to(targetSocketId).emit('permission-revoked', { type });
    io.to(roomId).emit('participants-update', Object.values(room.participants));
    console.log(`[Permiso] Profesor revocó ${type} a ${target.userName}`);
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    const full = {
      id: `${Date.now()}_${socket.id}`, senderSocketId: socket.id,
      senderName: p.userName, senderRole: p.userRole,
      text: message.text, timestamp: Date.now(),
    };
    room.messages.push(full);
    io.to(roomId).emit('chat-message', full);
  });

  // ── Controles media ───────────────────────────────────────────────────────
  socket.on('toggle-mic', ({ roomId, micOn }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    if (p.userRole === 'Estudiante' && micOn && p.micPermission !== 'granted') {
      socket.emit('permission-denied-action', { type: 'mic' }); return;
    }
    p.micOn = micOn;
    socket.to(roomId).emit('participant-mic-changed', { socketId: socket.id, micOn });
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  socket.on('toggle-cam', ({ roomId, camOn }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    p.camOn = camOn;
    socket.to(roomId).emit('participant-cam-changed', { socketId: socket.id, camOn });
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  socket.on('screen-share-start', ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    if (p.userRole === 'Estudiante' && p.screenPermission !== 'granted') {
      socket.emit('permission-denied-action', { type: 'screen' }); return;
    }
    p.isSharingScreen = true;
    io.to(roomId).emit('screen-share-started', { socketId: socket.id, userName: p.userName, peerId: p.peerId });
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  socket.on('screen-share-stop', ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    p.isSharingScreen = false;
    io.to(roomId).emit('screen-share-stopped', { socketId: socket.id });
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  socket.on('raise-hand', ({ roomId, raised }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p) return;
    p.handRaised = raised;
    io.to(roomId).emit('hand-raised', { socketId: socket.id, userName: p.userName, raised });
    io.to(roomId).emit('participants-update', Object.values(room.participants));
  });

  socket.on('reaction', ({ roomId, emoji }) => {
    const name = rooms[roomId]?.participants[socket.id]?.userName || '';
    socket.to(roomId).emit('reaction', { emoji, userName: name });
  });

  socket.on('whiteboard-draw',  ({ roomId, drawData }) => socket.to(roomId).emit('whiteboard-draw', drawData));
  socket.on('whiteboard-clear', ({ roomId }) => socket.to(roomId).emit('whiteboard-clear'));

  // ── Moderación ────────────────────────────────────────────────────────────
  socket.on('mute-participant', ({ roomId, targetSocketId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId]; if (!room) return;
    const t = room.participants[targetSocketId]; if (!t) return;
    t.micOn = false; t.micPermission = 'none';
    io.to(targetSocketId).emit('force-mute');
    io.to(roomId).emit('participants-update', Object.values(room.participants));
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
        if (room.teacherSocketId) {
          io.to(room.teacherSocketId).emit('teacher-role-transferred');
        }
      }
      socket.to(roomId).emit('user-left', { socketId: socket.id, userName });
      io.to(roomId).emit('participants-update', Object.values(room.participants));
      if (Object.keys(room.participants).length === 0) { delete rooms[roomId]; }
    }
  });

  socket.on('disconnect', () => console.log(`[Socket.io] Desconectado: ${socket.id}`));
});

// ─── API REST ──────────────────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => res.json(
  Object.entries(rooms).map(([id, r]) => ({
    roomId: id, participants: Object.keys(r.participants).length, startTime: r.startTime,
  }))
));
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.json({ exists: false });
  res.json({
    exists: true, hasTeacher: !!room.teacherSocketId,
    participants: Object.keys(room.participants).length,
    participantList: Object.values(room.participants).map(p => ({ userName: p.userName, userRole: p.userRole })),
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║  🎓  EduCall — Servidor con Sistema de Permisos    ║');
  console.log(`║  📡  http://localhost:${PORT}                        ║`);
  console.log('║  🔒  Mic y pantalla requieren aprobación docente   ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');
});
