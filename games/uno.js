// ─────────────────────────────────────────────
//  UNO GAME ENGINE
// ─────────────────────────────────────────────

const UNO_COLORS = ['R', 'G', 'B', 'Y'];
const UNO_NUMBERS = ['0','1','2','3','4','5','6','7','8','9'];
const UNO_ACTIONS = ['Skip','Reverse','Draw2'];
const UNO_WILDS = ['Wild','Wild4'];

function createUnoDeck() {
  const deck = [];
  let id = 0;
  for (const color of UNO_COLORS) {
    deck.push({ id: id++, color, value: '0' });
    for (const num of UNO_NUMBERS.slice(1)) {
      deck.push({ id: id++, color, value: num });
      deck.push({ id: id++, color, value: num });
    }
    for (const action of UNO_ACTIONS) {
      deck.push({ id: id++, color, value: action });
      deck.push({ id: id++, color, value: action });
    }
  }
  for (const wild of UNO_WILDS) {
    for (let i = 0; i < 4; i++) {
      deck.push({ id: id++, color: 'W', value: wild });
    }
  }
  return deck;
}

function shuffleUno(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function createUnoGame(roomId, playerIds) {
  return {
    roomId, game: 'uno',
    phase: 'playing',
    players: playerIds.map((id, i) => ({ id, seat: i, hand: [], saidUno: false })),
    deck: [],
    discard: [],
    currentSeat: 0,
    direction: 1,
    currentColor: null,
    drawStack: 0,
    skipNext: false,
    winner: null,
    scores: playerIds.map(() => 0),
    roundHistory: [],
  };
}

function dealUno(state) {
  const deck = shuffleUno(createUnoDeck());
  state.players.forEach(p => { p.hand = []; p.saidUno = false; });
  for (let i = 0; i < 7; i++) {
    state.players.forEach(p => p.hand.push(deck.pop()));
  }
  let topCard;
  do { topCard = deck.pop(); } while (topCard.color === 'W');
  state.discard = [topCard];
  state.deck = deck;
  state.currentColor = topCard.color;
  state.currentSeat = 0;
  state.direction = 1;
  state.drawStack = 0;
  state.skipNext = false;
  state.phase = 'playing';
  applyTopCard(state, topCard);
  return state;
}

function applyTopCard(state, card) {
  if (card.value === 'Reverse') {
    state.direction *= -1;
    if (state.players.length === 2) state.currentSeat = (state.currentSeat + state.direction + state.players.length) % state.players.length;
  }
  if (card.value === 'Skip') {
    state.currentSeat = (state.currentSeat + state.direction + state.players.length) % state.players.length;
  }
  if (card.value === 'Draw2') state.drawStack += 2;
}

function canPlay(card, topCard, currentColor) {
  if (card.color === 'W') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function playUnoCard(state, seat, cardIndex, chosenColor) {
  if (state.phase !== 'playing') return { error: 'Game not in play' };
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  const p = state.players[seat];
  const card = p.hand[cardIndex];
  if (!card) return { error: 'Invalid card' };

  const topCard = state.discard[state.discard.length - 1];

  // If there's a draw stack, can only play stacking card
  if (state.drawStack > 0) {
    if (card.value === 'Draw2' && topCard.value === 'Draw2') {
      // stack allowed
    } else if (card.value === 'Wild4' && (topCard.value === 'Wild4' || topCard.value === 'Draw2')) {
      // stack wild4
    } else {
      return { error: 'Must play a stacking card or draw' };
    }
  } else if (!canPlay(card, topCard, state.currentColor)) {
    return { error: 'Card cannot be played' };
  }

  p.hand.splice(cardIndex, 1);
  state.discard.push(card);
  p.saidUno = false;

  if (card.color === 'W') {
    state.currentColor = chosenColor || 'R';
  } else {
    state.currentColor = card.color;
  }

  // Check win
  if (p.hand.length === 0) {
    state.phase = 'scoring';
    state.winner = seat;
    return scoreUno(state, seat);
  }

  if (p.hand.length === 1 && !p.saidUno) {
    // penalty for not saying UNO - will be enforced separately
  }

  let nextSeat = (seat + state.direction + state.players.length) % state.players.length;

  if (card.value === 'Skip') {
    nextSeat = (nextSeat + state.direction + state.players.length) % state.players.length;
  }
  if (card.value === 'Reverse') {
    state.direction *= -1;
    if (state.players.length === 2) {
      nextSeat = seat; // reverse = skip in 2-player
    } else {
      nextSeat = (seat + state.direction + state.players.length) % state.players.length;
    }
  }
  if (card.value === 'Draw2') {
    state.drawStack += 2;
  }
  if (card.value === 'Wild4') {
    state.drawStack += 4;
  }

  state.currentSeat = nextSeat;
  return state;
}

function drawUnoCard(state, seat) {
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  const p = state.players[seat];
  const drawCount = state.drawStack > 0 ? state.drawStack : 1;
  state.drawStack = 0;

  for (let i = 0; i < drawCount; i++) {
    if (state.deck.length === 0) reshuffleUno(state);
    p.hand.push(state.deck.pop());
  }

  if (drawCount === 1) {
    // Can play drawn card if it matches
    const drawnCard = p.hand[p.hand.length - 1];
    const topCard = state.discard[state.discard.length - 1];
    if (!canPlay(drawnCard, topCard, state.currentColor)) {
      state.currentSeat = (seat + state.direction + state.players.length) % state.players.length;
    }
  } else {
    // forced draw from stack, turn passes
    state.currentSeat = (seat + state.direction + state.players.length) % state.players.length;
  }
  return state;
}

function sayUno(state, seat) {
  state.players[seat].saidUno = true;
  return state;
}

function catchUno(state, catcherSeat, targetSeat) {
  const target = state.players[targetSeat];
  if (target.hand.length === 1 && !target.saidUno) {
    // draw 2 penalty
    for (let i = 0; i < 2; i++) {
      if (state.deck.length === 0) reshuffleUno(state);
      target.hand.push(state.deck.pop());
    }
    return { ...state, caught: targetSeat };
  }
  return state;
}

function reshuffleUno(state) {
  const top = state.discard.pop();
  state.deck = shuffleUno(state.discard);
  state.discard = [top];
}

function scoreUno(state, winnerSeat) {
  let points = 0;
  state.players.forEach((p, i) => {
    if (i !== winnerSeat) {
      points += p.hand.reduce((s, c) => {
        if (c.color === 'W') return s + 50;
        if (['Skip','Reverse','Draw2'].includes(c.value)) return s + 20;
        return s + parseInt(c.value || 0);
      }, 0);
    }
  });
  state.scores[winnerSeat] = (state.scores[winnerSeat] || 0) + points;
  state.roundWinPoints = points;
  if (state.scores[winnerSeat] >= 500) {
    state.phase = 'gameover';
  }
  return state;
}

module.exports = { createUnoGame, dealUno, playUnoCard, drawUnoCard, sayUno, catchUno };
