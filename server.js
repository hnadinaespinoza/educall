/**
 * EduCall v5 — Servidor Definitivo
 * Soluciona: video entre dispositivos, pizarra, contraseñas, grabación
 */
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const cors       = require('cors');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── PEERJS ────────────────────────────────────────────────────────
const peerServer = ExpressPeerServer(server, {
  debug: false,
  path: '/',
  proxied: true,
  allow_discovery: true,
});
app.use('/peerjs', peerServer);
peerServer.on('connection', c => console.log('[Peer] +', c.getId()));
peerServer.on('disconnect', c => console.log('[Peer] -', c.getId()));

// ─── SOCKET.IO ─────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

const rooms = {};

function isTeacher(roomId, socketId) {
  return rooms[roomId]?.participants[socketId]?.userRole === 'Profesor';
}
function getParticipants(roomId) {
  return Object.values(rooms[roomId]?.participants || {});
}

io.on('connection', socket => {

  // Verificar contraseña
  socket.on('check-password', ({ roomId, password }) => {
    const room = rooms[roomId];
    if (!room || !room.password || room.password === password) {
      socket.emit('password-ok');
    } else {
      socket.emit('password-wrong');
    }
  });

  // Unirse
  socket.on('join-room', ({ roomId, peerId, userName, userRole, password }) => {
    if (rooms[roomId]?.password && rooms[roomId].password !== password) {
      socket.emit('kicked', { reason: 'Contraseña incorrecta' }); return;
    }
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = { password: password||null, teacherSocketId: null, participants: {}, messages: [], startTime: Date.now(), recording: false };
    }
    const room = rooms[roomId];
    if (userRole === 'Profesor' && !room.teacherSocketId) room.teacherSocketId = socket.id;

    room.participants[socket.id] = {
      socketId: socket.id, peerId, userName, userRole,
      micOn: userRole === 'Profesor', camOn: true,
      handRaised: false, isSharingScreen: false,
      micPermission:    userRole === 'Profesor' ? 'granted' : 'none',
      screenPermission: userRole === 'Profesor' ? 'granted' : 'none',
      joinedAt: Date.now(),
    };

    console.log(`[Room ${roomId}] ${userName} entró | peers: ${getParticipants(roomId).length}`);

    // Notificar a otros
    socket.to(roomId).emit('user-joined', { socketId: socket.id, peerId, userName, userRole });

    // Enviar lista existente al nuevo
    const existing = getParticipants(roomId).filter(p => p.socketId !== socket.id);
    socket.emit('existing-participants', existing);

    // Estado de permisos
    socket.emit('permissions-update', {
      micPermission:    room.participants[socket.id].micPermission,
      screenPermission: room.participants[socket.id].screenPermission,
      hasTeacher: !!room.teacherSocketId,
      roomRecording: room.recording,
    });

    if (room.messages.length) socket.emit('chat-history', room.messages.slice(-50));
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  // Permisos
  socket.on('request-mic-permission', ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p || p.userRole !== 'Estudiante') return;
    p.micPermission = 'requested';
    const tId = room.teacherSocketId;
    if (!tId) { socket.emit('no-teacher-online'); return; }
    io.to(tId).emit('permission-request', { type:'mic', requesterSocketId: socket.id, requesterName: p.userName, roomId });
    socket.emit('permission-request-sent', { type:'mic' });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  socket.on('request-screen-permission', ({ roomId }) => {
    const room = rooms[roomId]; if (!room) return;
    const p = room.participants[socket.id]; if (!p || p.userRole !== 'Estudiante') return;
    p.screenPermission = 'requested';
    const tId = room.teacherSocketId;
    if (!tId) { socket.emit('no-teacher-online'); return; }
    io.to(tId).emit('permission-request', { type:'screen', requesterSocketId: socket.id, requesterName: p.userName, roomId });
    socket.emit('permission-request-sent', { type:'screen' });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  socket.on('respond-permission', ({ roomId, targetSocketId, type, approved }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const room = rooms[roomId]; const target = room?.participants[targetSocketId]; if (!target) return;
    if (type === 'mic')    target.micPermission    = approved ? 'granted' : 'denied';
    if (type === 'screen') target.screenPermission = approved ? 'granted' : 'denied';
    io.to(targetSocketId).emit('permission-response', {
      type, approved,
      message: approved ? `✅ El profesor autorizó tu ${type === 'mic' ? 'micrófono' : 'pantalla'}` : `❌ El profesor denegó tu ${type === 'mic' ? 'micrófono' : 'pantalla'}`,
    });
    if (type === 'mic' && approved) io.to(roomId).emit('student-mic-enabled', { socketId: targetSocketId, userName: target.userName });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  socket.on('revoke-permission', ({ roomId, targetSocketId, type }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const target = rooms[roomId]?.participants[targetSocketId]; if (!target) return;
    if (type === 'mic')    { target.micPermission    = 'none'; target.micOn = false; }
    if (type === 'screen') { target.screenPermission = 'none'; target.isSharingScreen = false; }
    io.to(targetSocketId).emit('permission-revoked', { type });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  // Media
  socket.on('toggle-mic', ({ roomId, micOn }) => {
    const room = rooms[roomId]; const p = room?.participants[socket.id]; if (!p) return;
    if (p.userRole === 'Estudiante' && micOn && p.micPermission !== 'granted') { socket.emit('permission-denied-action', { type:'mic' }); return; }
    p.micOn = micOn;
    socket.to(roomId).emit('participant-mic-changed', { socketId: socket.id, micOn });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  socket.on('toggle-cam', ({ roomId, camOn }) => {
    const p = rooms[roomId]?.participants[socket.id]; if (!p) return;
    p.camOn = camOn;
    socket.to(roomId).emit('participant-cam-changed', { socketId: socket.id, camOn });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  socket.on('screen-share-start', ({ roomId }) => {
    const p = rooms[roomId]?.participants[socket.id]; if (!p) return;
    if (p.userRole === 'Estudiante' && p.screenPermission !== 'granted') { socket.emit('permission-denied-action', { type:'screen' }); return; }
    p.isSharingScreen = true;
    io.to(roomId).emit('screen-share-started', { socketId: socket.id, userName: p.userName, peerId: p.peerId });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  socket.on('screen-share-stop', ({ roomId }) => {
    const p = rooms[roomId]?.participants[socket.id]; if (!p) return;
    p.isSharingScreen = false;
    io.to(roomId).emit('screen-share-stopped', { socketId: socket.id });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  socket.on('raise-hand', ({ roomId, raised }) => {
    const p = rooms[roomId]?.participants[socket.id]; if (!p) return;
    p.handRaised = raised;
    io.to(roomId).emit('hand-raised', { socketId: socket.id, userName: p.userName, raised });
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });

  // Grabación
  socket.on('start-recording', ({ roomId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    if (rooms[roomId]) rooms[roomId].recording = true;
    io.to(roomId).emit('recording-started', { startedBy: rooms[roomId]?.participants[socket.id]?.userName });
  });
  socket.on('stop-recording', ({ roomId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    if (rooms[roomId]) rooms[roomId].recording = false;
    io.to(roomId).emit('recording-stopped');
  });

  // Chat
  socket.on('chat-message', ({ roomId, message }) => {
    const room = rooms[roomId]; const p = room?.participants[socket.id]; if (!p) return;
    const full = { id:`${Date.now()}_${socket.id}`, senderSocketId: socket.id, senderName: p.userName, senderRole: p.userRole, text: message.text, timestamp: Date.now() };
    room.messages.push(full);
    if (room.messages.length > 200) room.messages.shift();
    io.to(roomId).emit('chat-message', full);
  });

  // Reacciones y pizarra
  socket.on('reaction',         ({ roomId, emoji }) => socket.to(roomId).emit('reaction', { emoji, userName: rooms[roomId]?.participants[socket.id]?.userName }));
  socket.on('whiteboard-draw',  ({ roomId, drawData }) => socket.to(roomId).emit('whiteboard-draw', drawData));
  socket.on('whiteboard-clear', ({ roomId }) => socket.to(roomId).emit('whiteboard-clear'));
  socket.on('whiteboard-text',  ({ roomId, textData }) => socket.to(roomId).emit('whiteboard-text', textData));

  // Moderación
  socket.on('mute-participant', ({ roomId, targetSocketId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    const t = rooms[roomId]?.participants[targetSocketId]; if (!t) return;
    t.micOn = false; t.micPermission = 'none';
    io.to(targetSocketId).emit('force-mute');
    io.to(roomId).emit('participants-update', getParticipants(roomId));
  });
  socket.on('kick-participant', ({ roomId, targetSocketId }) => {
    if (!isTeacher(roomId, socket.id)) return;
    io.to(targetSocketId).emit('force-kick');
  });

  // Desconexión
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
      io.to(roomId).emit('participants-update', getParticipants(roomId));
      if (Object.keys(room.participants).length === 0) { delete rooms[roomId]; console.log(`[Room ${roomId}] Eliminada`); }
    }
  });

  socket.on('disconnect', () => console.log('[Socket] -', socket.id));
});

// ─── API ───────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status:'ok', uptime: process.uptime(), time: new Date().toISOString() }));
app.get('/api/rooms', (req, res) => res.json(Object.entries(rooms).map(([id,r]) => ({ roomId:id, participants: Object.keys(r.participants).length, hasPassword: !!r.password }))));

// ─── START ─────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║  🎓 EduCall v5 — Puerto ${PORT}          ║
║  🔗 PeerJS en /peerjs                ║
║  🏓 Ping en /ping                    ║
╚══════════════════════════════════════╝`);
});
