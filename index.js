// ─────────────────────────────────────────────
//  BLACK CARD ROOM — MAIN SERVER
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

// ── CORS — allow any origin dynamically ───────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://blackcardroom.com',
  'https://www.blackcardroom.com',
  'https://blackcardroom-client.vercel.app',
];

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.endsWith('.vercel.app')) return true;
  return false;
}

const corsOptions = {
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, origin);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, origin);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

// ── In-memory stores ──────────────────────────
const rooms = new Map();
const players = new Map();

function createRoom(code, hostId, hostName, gameType) {
  return {
    id: uuidv4(),
    code,
    hostId,
    gameType,
    phase: 'lobby',
    players: [],
    maxPlayers: 4,
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
  return {
    ...gs,
    players: gs.players.map((gp, i) => ({
      ...gp,
      hand: i === seat ? gp.hand : gp.hand.map(() => ({ hidden: true })),
      handCount: gp.hand.length,
    })),
    myHand: gs.players[seat]?.hand || [],
    mySeat: seat,
  };
}

// ── HTTP Routes ────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

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

  socket.on('join_room', ({ code, userId, name, avatar }) => {
    const room = rooms.get(code?.toUpperCase());
    if (!room) return socket.emit('error', { message: 'Room not found' });
    if (room.players.length >= room.maxPlayers && !room.players.find(p => p.userId === userId)) {
      return socket.emit('error', { message: 'Room is full' });
    }
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
  });

  socket.on('player_ready', () => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const rp = room.players.find(p => p.socketId === socket.id);
    if (rp) rp.ready = true;
    io.to(info.roomCode).emit('room_updated', roomSummary(room));
    if (room.players.length >= 2 && room.players.every(p => p.ready) && room.phase === 'lobby') {
      startGame(room);
    }
  });

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

  socket.on('game_action', ({ action, payload }) => {
    const info = players.get(socket.id);
    if (!info) return socket.emit('error', { message: 'Not in a room' });
    const room = rooms.get(info.roomCode);
    if (!room || !room.gameState) return socket.emit('error', { message: 'No active game' });
    const rp = room.players.find(p => p.socketId === socket.id);
    if (!rp) return;
    const seat = rp.seat;
    let result = handleGameAction(room.gameType, room.gameState, seat, action, payload);
    if (result?.error) return socket.emit('game_error', { message: result.error });
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

  socket.on('start_round', () => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    const rp = room.players.find(p => p.socketId === socket.id);
    if (!rp || rp.seat !== 0) return;
    const playerIds = room.players.map(p => p.userId);
    room.gameState = startNewRound(room.gameType, room.gameState, playerIds);
    broadcastGameState(room);
  });

  socket.on('disconnect', () => {
    const info = players.get(socket.id);
    if (info) {
      const room = rooms.get(info.roomCode);
      if (room) {
        const rp = room.players.find(p => p.socketId === socket.id);
        if (rp) rp.connected = false;
        io.to(info.roomCode).emit('player_disconnected', { name: info.name, seat: rp?.seat });
        io.to(info.roomCode).emit('room_updated', roomSummary(room));
      }
      players.delete(socket.id);
    }
    console.log(`[DISCONNECT] ${socket.id}`);
  });
});

// ── Game helpers ──────────────────────────────
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

function handleGameAction(gameType, state, seat, action, payload) {
  switch (gameType) {
    case 'spades':
      switch (action) {
        case 'bid': return placeBid(state, seat, payload.bid);
        case 'play_card': return playSpadesCard(state, seat, payload.cardIndex);
        default: return { error: `Unknown spades action: ${action}` };
      }
    case 'bidwhist':
      switch (action) {
        case 'bid': return placeBidWhistBid(state, seat, payload.bid);
        case 'take_kitty': return takeKitty(state, seat, payload.discardIndices);
        case 'set_trump': return setTrump(state, seat, payload.suit);
        case 'play_card': return playBidWhistCard(state, seat, payload.cardIndex);
        default: return { error: `Unknown bidwhist action: ${action}` };
      }
    case 'tonk':
      switch (action) {
        case 'draw_deck': return drawFromDeck(state, seat);
        case 'draw_discard': return drawFromDiscard(state, seat);
        case 'discard': return discardCard(state, seat, payload.cardIndex);
        case 'spread': return spread(state, seat, payload.cardIndices);
        case 'hit_spread': return hitSpread(state, seat, payload.cardIndex, payload.targetSeat, payload.spreadIndex);
        case 'knock': return knock(state, seat);
        default: return { error: `Unknown tonk action: ${action}` };
      }
    case 'uno':
      switch (action) {
        case 'play_card': return playUnoCard(state, seat, payload.cardIndex, payload.chosenColor);
        case 'draw_card': return drawUnoCard(state, seat);
        case 'say_uno': return sayUno(state, seat);
        case 'catch_uno': return catchUno(state, seat, payload.targetSeat);
        default: return { error: `Unknown uno action: ${action}` };
      }
    case 'dominoes':
      switch (action) {
        case 'play_tile': return playDomino(state, seat, payload.tileIndex, payload.end);
        case 'draw': return drawFromBoneyard(state, seat);
        case 'pass': return passDomino(state, seat);
        default: return { error: `Unknown dominoes action: ${action}` };
      }
    default: return { error: 'Unknown game type' };
  }
}

function broadcastGameState(room) {
  room.players.forEach(rp => {
    if (rp.connected) {
      io.to(rp.socketId).emit('game_state', playerView(room, rp.socketId));
    }
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Black Card Room Server running on port ${PORT}`);
});

module.exports = { app, server };
