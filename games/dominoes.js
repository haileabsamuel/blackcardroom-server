// ─────────────────────────────────────────────
//  DOMINOES GAME ENGINE (Draw Dominoes / Partners)
// ─────────────────────────────────────────────

function createDominoeSet() {
  const tiles = [];
  let id = 0;
  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) {
      tiles.push({ id: id++, high: j, low: i, pip: i + j });
    }
  }
  return tiles; // 28 tiles
}

function shuffleDominoes(tiles) {
  const d = [...tiles];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function createDominoesGame(roomId, playerIds) {
  return {
    roomId, game: 'dominoes',
    phase: 'waiting',
    players: playerIds.map((id, i) => ({
      id, seat: i,
      team: playerIds.length === 4 ? i % 2 : i,
      hand: [],
      score: 0,
    })),
    teams: playerIds.length === 4 ? [{ score: 0 }, { score: 0 }] : playerIds.map(() => ({ score: 0 })),
    boneyard: [],
    board: [], // [{tile, orientation, x, y}] for display
    boardEnds: { left: null, right: null, top: null, bottom: null },
    openEnds: [], // values at each open end
    currentSeat: 0,
    passCount: 0,
    roundHistory: [],
  };
}

function dealDominoes(state) {
  const tiles = shuffleDominoes(createDominoeSet());
  const handSize = state.players.length === 2 ? 7 : 5; // 4 player: 5 each, 2 player: 7 each
  state.players.forEach((p, i) => {
    p.hand = tiles.slice(i * handSize, (i + 1) * handSize);
    p.hand.sort((a, b) => b.pip - a.pip);
  });
  state.boneyard = tiles.slice(state.players.length * handSize);
  state.board = [];
  state.openEnds = [];
  state.boardEnds = { left: null, right: null };
  state.phase = 'playing';
  state.passCount = 0;

  // Player with highest double goes first, or highest pip
  let highestSeat = 0;
  let highestPip = -1;
  let highestDouble = -1;
  state.players.forEach((p, i) => {
    const doubles = p.hand.filter(t => t.high === t.low);
    doubles.forEach(t => { if (t.high > highestDouble) { highestDouble = t.high; highestSeat = i; } });
  });
  if (highestDouble === -1) {
    state.players.forEach((p, i) => {
      p.hand.forEach(t => { if (t.pip > highestPip) { highestPip = t.pip; highestSeat = i; } });
    });
  }
  state.currentSeat = highestSeat;
  return state;
}

function canPlay(tile, openEnds) {
  if (openEnds.length === 0) return true; // first play
  return openEnds.some(end => tile.high === end || tile.low === end);
}

function playDomino(state, seat, tileIndex, end) {
  if (state.phase !== 'playing') return { error: 'Not playing phase' };
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  const p = state.players[seat];
  const tile = p.hand[tileIndex];
  if (!tile) return { error: 'Invalid tile' };

  if (state.board.length === 0) {
    // First play
    state.board.push({ tile, seat, end: 'first' });
    state.openEnds = tile.high === tile.low ? [tile.high] : [tile.high, tile.low];
  } else {
    if (!canPlay(tile, state.openEnds)) return { error: 'Tile does not match any open end' };
    const endIndex = end === 'left' ? 0 : state.openEnds.length - 1;
    const endValue = state.openEnds[endIndex];
    let newEnd;
    if (tile.high === endValue) {
      newEnd = tile.low;
    } else if (tile.low === endValue) {
      newEnd = tile.high;
    } else {
      return { error: 'Tile does not match that end' };
    }
    state.openEnds.splice(endIndex, 1, newEnd);
    // doubles add both sides
    if (tile.high === tile.low) {
      state.openEnds.splice(endIndex, 1, tile.high, tile.high);
    }
    state.board.push({ tile, seat, end });
  }

  p.hand.splice(tileIndex, 1);
  state.passCount = 0;

  if (p.hand.length === 0) {
    return scoreDominoes(state, seat, 'out');
  }

  state.currentSeat = (seat + 1) % state.players.length;
  return state;
}

function drawFromBoneyard(state, seat) {
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  if (state.boneyard.length === 0) return { error: 'Boneyard is empty' };
  const tile = state.boneyard.pop();
  state.players[seat].hand.push(tile);
  return state;
}

function passDomino(state, seat) {
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  if (state.boneyard.length > 0 && canPlay(state.players[seat].hand.find(t => canPlay(t, state.openEnds)), state.openEnds)) {
    return { error: 'Cannot pass when you can play' };
  }
  state.passCount++;
  state.currentSeat = (seat + 1) % state.players.length;

  if (state.passCount >= state.players.length) {
    // All players blocked - count pip totals
    return scoreDominoes(state, -1, 'blocked');
  }
  return state;
}

function scoreDominoes(state, winnerSeat, reason) {
  state.phase = 'scoring';
  const pipCounts = state.players.map(p => p.hand.reduce((s, t) => s + t.pip, 0));
  const totalPips = pipCounts.reduce((s, c) => s + c, 0);

  if (reason === 'out') {
    // Winner scores total pips of all opponents (rounded to nearest 5)
    const score = Math.round(totalPips / 5) * 5;
    if (state.teams.length === 2) {
      const winTeam = state.players[winnerSeat].team;
      state.teams[winTeam].score += score;
    } else {
      state.players[winnerSeat].score += score;
    }
  } else if (reason === 'blocked') {
    // Lowest count team/player wins, scores difference
    if (state.teams.length === 2) {
      const teamPips = [
        state.players.filter(p => p.team === 0).reduce((s, p) => s + pipCounts[p.seat], 0),
        state.players.filter(p => p.team === 1).reduce((s, p) => s + pipCounts[p.seat], 0),
      ];
      const winTeam = teamPips[0] <= teamPips[1] ? 0 : 1;
      const score = Math.round(teamPips[1 - winTeam] / 5) * 5;
      state.teams[winTeam].score += score;
      winnerSeat = state.players.find(p => p.team === winTeam).seat;
    }
  }

  state.winner = winnerSeat;
  state.winReason = reason;
  state.pipCounts = pipCounts;

  const winThreshold = 150;
  if (state.teams.some(t => t.score >= winThreshold) ||
      state.players.some(p => p.score >= winThreshold)) {
    state.phase = 'gameover';
  }
  return state;
}

module.exports = { createDominoesGame, dealDominoes, playDomino, drawFromBoneyard, passDomino };
