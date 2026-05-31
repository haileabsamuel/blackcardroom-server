// ─────────────────────────────────────────────
//  BLACK CARD ROOM — MAIN SERVER
//  Node.js + Express + Socket.IO
// ─────────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const { createSpadesGame, dealSpades, placeBid, playCard: playSpadesCard } = require('./games/spades');
const { createBidWhistGame, dealBidWhist, placeBidWhistBid, takeKitty, setTrump, playBidWhistCard } = require('./games/bidwhist');
const { createTonkGame, dealTonk, drawFromDeck, drawFromDiscard, discardCard, spread, hitSpread, knock } = require('./games/tonk');
const { createUnoGame, dealUno, playUnoCard, drawUnoCard, sayUno, catchUno } = require('./games/uno');
const { createDominoesGame, dealDominoes, playDomino, drawFromBoneyard, passDomino } = require('./games/dominoes');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));
app.use(express.json());

// ── In-memory stores ──────────────────────────
const rooms = new Map();    // roomId -> Room
const players = new Map();  // socketId -> Player info

// ── Room structure ────────────────────────────
function createRoom(code, hostId, hostName, gameType) {
  return {
    id: uuidv4(),
    code,
    hostId,
    gameType,
    phase: 'lobby',    // lobby | playing | ended
    players: [],       // [{ socketId, userId, name, seat, ready, avatar }]
    maxPlayers: gameType === 'dominoes' ? 4 : 4,
    gameState: null,
    chatHistory: [],
    createdAt: Date.now(),
  };
}

function roomSummary(room) {
  return {
    id: room.id,
    code: room.code,
    gameType: room.gameType,
    phase: room.phase,
    playerCount: room.players.length,
    maxPlayers: room.maxPlayers,
    players: room.players.map(p => ({
      userId: p.userId,
      name: p.name,
      seat: p.seat,
      ready: p.ready,
      avatar: p.avatar,
    })),
  };
}

function playerView(room, socketId) {
  if (!room.gameState) return null;
  const rp = room.players.find(p => p.socketId === socketId);
  if (!rp) return null;
  const seat = rp.seat;
  const gs = room.gameState;

  // Build a player-specific view (hide other players' hands)
  const view = {
    ...gs,
    players: gs.players.map((gp, i) => ({
      ...gp,
      hand: i === seat ? gp.hand : gp.hand.map(() => ({ hidden: true })),
      handCount: gp.hand.length,
    })),
    myHand: gs.players[seat]?.hand || [],
    mySeat: seat,
  };
  return view;
}

// ── HTTP Routes ────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size, players: players.size }));

app.post('/rooms', (req, res) => {
  const { hostName, gameType } = req.body;
  if (!hostName || !gameType) return res.status(400).json({ error: 'hostName and gameType required' });
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const room = createRoom(code, null, hostName, gameType);
  rooms.set(room.code, room);
  res.json({ code: room.code, id: room.id });
});

app.get('/rooms/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(roomSummary(room));
});

// ── Socket Events ──────────────────────────────
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // ── JOIN ROOM ──────────────────────────────
  socket.on('join_room', ({ code, userId, name, avatar }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return socket.emit('error', { message: 'Room not found' });
    if (room.players.length >= room.maxPlayers && !room.players.find(p => p.userId === userId)) {
      return socket.emit('error', { message: 'Room is full' });
    }

    // Reconnect handling
    const existing = room.players.find(p => p.userId === userId);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
    } else {
      const seat = room.players.length;
      room.players.push({ socketId: socket.id, userId, name, seat, ready: false, avatar: avatar || 'default', connected: true });
    }

    players.set(socket.id, { userId, name, roomCode: code.toUpperCase(), avatar });
    socket.join(code.toUpperCase());
    socket.emit('room_joined', { room: roomSummary(room), seat: room.players.find(p => p.userId === userId).seat });
    io.to(code.toUpperCase()).emit('room_updated', roomSummary(room));
    console.log(`[JOIN] ${name} joined room ${code}`);
  });

  // ── READY UP ──────────────────────────────
  socket.on('player_ready', () => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const rp = room.players.find(p => p.socketId === socket.id);
    if (rp) { rp.ready = true; }
    io.to(info.roomCode).emit('room_updated', roomSummary(room));

    // Auto-start if all players ready and min 2
    if (room.players.length >= 2 && room.players.every(p => p.ready) && room.phase === 'lobby') {
      startGame(room);
    }
  });

  // ── CHAT ──────────────────────────────────
  socket.on('chat_message', ({ message }) => {
    const info = players.get(socket.id);
    if (!info || !message?.trim()) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const msg = { sender: info.name, message: message.trim().substring(0, 200), ts: Date.now() };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > 100) room.chatHistory.shift();
    io.to(info.roomCode).emit('chat_message', msg);
  });

  // ── GAME ACTIONS ───────────────────────────
  socket.on('game_action', ({ action, payload }) => {
    const info = players.get(socket.id);
    if (!info) return socket.emit('error', { message: 'Not in a room' });
    const room = rooms.get(info.roomCode);
    if (!room || !room.gameState) return socket.emit('error', { message: 'No active game' });
    const rp = room.players.find(p => p.socketId === socket.id);
    if (!rp) return;
    const seat = rp.seat;

    let result = handleGameAction(room.gameType, room.gameState, seat, action, payload);

    if (result?.error) {
      return socket.emit('game_error', { message: result.error });
    }

    room.gameState = result;
    broadcastGameState(room);

    if (result.phase === 'gameover' || result.phase === 'scoring') {
      io.to(info.roomCode).emit('game_event', {
        type: result.phase === 'gameover' ? 'game_over' : 'round_over',
        winner: result.winner,
        winReason: result.winReason,
        teams: result.teams,
        scores: result.scores,
      });
    }
  });

  // ── START NEW ROUND ────────────────────────
  socket.on('start_round', () => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const rp = room.players.find(p => p.socketId === socket.id);
    if (!rp || rp.seat !== 0) return; // only host can start round

    const playerIds = room.players.map(p => p.userId);
    room.gameState = startNewRound(room.gameType, room.gameState, playerIds);
    broadcastGameState(room);
  });

  // ── DISCONNECT ────────────────────────────
  socket.on('disconnect', () => {
    const info = players.get(socket.id);
    if (info) {
      const room = rooms.get(info.roomCode);
      if (room) {
        const rp = room.players.find(p => p.socketId === socket.id);
        if (rp) { rp.connected = false; }
        io.to(info.roomCode).emit('player_disconnected', { name: info.name, seat: rp?.seat });
        io.to(info.roomCode).emit('room_updated', roomSummary(room));
      }
      players.delete(socket.id);
    }
    console.log(`[DISCONNECT] ${socket.id}`);
  });
});

// ── Game Initialization ────────────────────────
function startGame(room) {
  room.phase = 'playing';
  const playerIds = room.players.map(p => p.userId);
  room.gameState = initGame(room.gameType, room.id, playerIds);
  broadcastGameState(room);
  io.to(room.code).emit('game_started', { gameType: room.gameType });
}

function initGame(gameType, roomId, playerIds) {
  switch (gameType) {
    case 'spades':    return dealSpades(createSpadesGame(roomId, playerIds));
    case 'bidwhist':  return dealBidWhist(createBidWhistGame(roomId, playerIds));
    case 'tonk':      return dealTonk(createTonkGame(roomId, playerIds));
    case 'uno':       return dealUno(createUnoGame(roomId, playerIds));
    case 'dominoes':  return dealDominoes(createDominoesGame(roomId, playerIds));
    default: throw new Error(`Unknown game type: ${gameType}`);
  }
}

function startNewRound(gameType, prevState, playerIds) {
  switch (gameType) {
    case 'spades': {
      const ns = { ...prevState };
      ns.players.forEach(p => { p.bid = null; p.tricks = 0; p.nilBid = false; p.blindNil = false; });
      return dealSpades(ns);
    }
    case 'bidwhist': return dealBidWhist({ ...prevState });
    case 'tonk':     return dealTonk({ ...prevState });
    case 'uno':      return dealUno({ ...prevState });
    case 'dominoes': return dealDominoes({ ...prevState });
    default: return prevState;
  }
}

// ── Action Router ──────────────────────────────
function handleGameAction(gameType, state, seat, action, payload) {
  switch (gameType) {
    case 'spades':   return handleSpadesAction(state, seat, action, payload);
    case 'bidwhist': return handleBidWhistAction(state, seat, action, payload);
    case 'tonk':     return handleTonkAction(state, seat, action, payload);
    case 'uno':      return handleUnoAction(state, seat, action, payload);
    case 'dominoes': return handleDominoesAction(state, seat, action, payload);
    default: return { error: 'Unknown game type' };
  }
}

function handleSpadesAction(state, seat, action, payload) {
  switch (action) {
    case 'bid':       return placeBid(state, seat, payload.bid);
    case 'play_card': return playSpadesCard(state, seat, payload.cardIndex);
    default: return { error: `Unknown spades action: ${action}` };
  }
}

function handleBidWhistAction(state, seat, action, payload) {
  switch (action) {
    case 'bid':        return placeBidWhistBid(state, seat, payload.bid);
    case 'take_kitty': return takeKitty(state, seat, payload.discardIndices);
    case 'set_trump':  return setTrump(state, seat, payload.suit);
    case 'play_card':  return playBidWhistCard(state, seat, payload.cardIndex);
    default: return { error: `Unknown bidwhist action: ${action}` };
  }
}

function handleTonkAction(state, seat, action, payload) {
  switch (action) {
    case 'draw_deck':    return drawFromDeck(state, seat);
    case 'draw_discard': return drawFromDiscard(state, seat);
    case 'discard':      return discardCard(state, seat, payload.cardIndex);
    case 'spread':       return spread(state, seat, payload.cardIndices);
    case 'hit_spread':   return hitSpread(state, seat, payload.cardIndex, payload.targetSeat, payload.spreadIndex);
    case 'knock':        return knock(state, seat);
    default: return { error: `Unknown tonk action: ${action}` };
  }
}

function handleUnoAction(state, seat, action, payload) {
  switch (action) {
    case 'play_card': return playUnoCard(state, seat, payload.cardIndex, payload.chosenColor);
    case 'draw_card': return drawUnoCard(state, seat);
    case 'say_uno':   return sayUno(state, seat);
    case 'catch_uno': return catchUno(state, seat, payload.targetSeat);
    default: return { error: `Unknown uno action: ${action}` };
  }
}

function handleDominoesAction(state, seat, action, payload) {
  switch (action) {
    case 'play_tile': return playDomino(state, seat, payload.tileIndex, payload.end);
    case 'draw':      return drawFromBoneyard(state, seat);
    case 'pass':      return passDomino(state, seat);
    default: return { error: `Unknown dominoes action: ${action}` };
  }
}

// ── Broadcast helpers ──────────────────────────
function broadcastGameState(room) {
  room.players.forEach(rp => {
    if (rp.connected) {
      const socketId = rp.socketId;
      const view = playerView(room, socketId);
      io.to(socketId).emit('game_state', view);
    }
  });
}

// ── Start server ───────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════╗
║   BLACK CARD ROOM SERVER          ║
║   Running on port ${PORT}            ║
║   Games: Spades, Bid Whist,       ║
║          Tonk, Uno, Dominoes      ║
╚═══════════════════════════════════╝
  `);
});

module.exports = { app, server };
