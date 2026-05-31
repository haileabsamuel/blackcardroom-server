// ─────────────────────────────────────────────
//  TONK GAME ENGINE
// ─────────────────────────────────────────────
const { createDeck, shuffle } = require('./deck');

const FACE_VALUES = { 'J':10,'Q':10,'K':10,'A':1 };
const NUM_VALUES = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10};

function cardValue(card) {
  if (FACE_VALUES[card.rank] !== undefined) return FACE_VALUES[card.rank];
  if (NUM_VALUES[card.rank] !== undefined) return NUM_VALUES[card.rank];
  return 0;
}

function handCount(hand) {
  return hand.reduce((s, c) => s + cardValue(c), 0);
}

function createTonkGame(roomId, playerIds) {
  return {
    roomId, game: 'tonk',
    phase: 'waiting', // waiting | playing | spreading | gameover
    players: playerIds.map((id, i) => ({
      id, seat: i, hand: [], spreads: [], chips: 5, folded: false,
    })),
    pot: 0,
    ante: 1,
    deck: [],
    discard: [],
    currentSeat: 0,
    direction: 1,
    drewThisTurn: false,
    turnCount: 0,
    roundHistory: [],
  };
}

function dealTonk(state) {
  const deck = shuffle(createDeck());
  const numPlayers = state.players.length;
  const cardsEach = numPlayers <= 4 ? 5 : 5;
  const hands = state.players.map(() => []);
  for (let i = 0; i < cardsEach; i++) {
    for (let j = 0; j < numPlayers; j++) {
      hands[j].push(deck.pop());
    }
  }
  state.deck = deck;
  state.discard = [deck.pop()];
  state.players.forEach((p, i) => {
    p.hand = hands[i];
    p.spreads = [];
    p.folded = false;
  });
  // ante up
  state.pot = 0;
  state.players.forEach(p => {
    if (p.chips >= state.ante) { p.chips -= state.ante; state.pot += state.ante; }
  });
  state.phase = 'playing';
  state.currentSeat = 0;
  state.drewThisTurn = false;
  state.turnCount = 0;

  // Check for tonk on deal (50 or 49 with no spreads)
  for (const p of state.players) {
    const count = handCount(p.hand);
    if (count === 50) {
      // tonk - double the pot win
      state.phase = 'gameover';
      state.winner = p.seat;
      state.winReason = 'tonk-deal';
      return state;
    }
  }
  return state;
}

function drawFromDeck(state, seat) {
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  if (state.drewThisTurn) return { error: 'Already drew this turn' };
  if (state.deck.length === 0) {
    // reshuffle discard
    const top = state.discard.pop();
    state.deck = shuffle(state.discard);
    state.discard = [top];
  }
  const card = state.deck.pop();
  state.players[seat].hand.push(card);
  state.drewThisTurn = true;
  return state;
}

function drawFromDiscard(state, seat) {
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  if (state.drewThisTurn) return { error: 'Already drew this turn' };
  if (state.discard.length === 0) return { error: 'No discard pile' };
  const card = state.discard.pop();
  state.players[seat].hand.push(card);
  state.drewThisTurn = true;
  return state;
}

function discardCard(state, seat, cardIndex) {
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  if (!state.drewThisTurn) return { error: 'Must draw first' };
  const p = state.players[seat];
  const card = p.hand[cardIndex];
  if (!card) return { error: 'Invalid card' };
  p.hand.splice(cardIndex, 1);
  state.discard.push(card);
  state.drewThisTurn = false;
  state.turnCount++;
  state.currentSeat = (seat + 1) % state.players.filter(p => !p.folded).length;
  // Fix: advance to next non-folded player
  let next = (seat + 1) % state.players.length;
  while (state.players[next].folded) next = (next + 1) % state.players.length;
  state.currentSeat = next;
  return state;
}

function isValidSpread(cards) {
  if (cards.length < 3) return false;
  // set: same rank
  if (cards.every(c => c.rank === cards[0].rank)) return true;
  // run: same suit, consecutive ranks
  const RANK_ORDER = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  if (cards.every(c => c.suit === cards[0].suit)) {
    const indices = cards.map(c => RANK_ORDER.indexOf(c.rank)).sort((a,b)=>a-b);
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i-1] + 1) return false;
    }
    return true;
  }
  return false;
}

function spread(state, seat, cardIndices) {
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  const p = state.players[seat];
  const cards = cardIndices.map(i => p.hand[i]);
  if (!isValidSpread(cards)) return { error: 'Invalid spread' };
  cards.forEach(c => { p.hand.splice(p.hand.indexOf(c), 1); });
  p.spreads.push(cards);
  if (p.hand.length === 0) {
    state.phase = 'gameover';
    state.winner = seat;
    state.winReason = 'rummy-out';
    return resolveTonk(state, seat);
  }
  return state;
}

function hitSpread(state, seat, cardIndex, targetSeat, spreadIndex) {
  const p = state.players[seat];
  const target = state.players[targetSeat];
  const card = p.hand[cardIndex];
  const targetSpread = target.spreads[spreadIndex];
  if (!targetSpread) return { error: 'Invalid spread target' };
  const testSpread = [...targetSpread, card];
  if (!isValidSpread(testSpread)) return { error: 'Card does not fit that spread' };
  p.hand.splice(cardIndex, 1);
  targetSpread.push(card);
  if (p.hand.length === 0) {
    state.phase = 'gameover';
    state.winner = seat;
    return resolveTonk(state, seat);
  }
  return state;
}

function knock(state, seat) {
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  if (!state.drewThisTurn) return { error: 'Must draw first' };
  // compare hand counts
  const knockerCount = handCount(state.players[seat].hand);
  let lowestCount = knockerCount;
  let winners = [seat];
  for (let i = 0; i < state.players.length; i++) {
    if (i === seat) continue;
    const c = handCount(state.players[i].hand);
    if (c < lowestCount) { lowestCount = c; winners = [i]; }
    else if (c === lowestCount) winners.push(i);
  }
  if (winners.includes(seat)) {
    // caught - knocker pays double
    state.phase = 'gameover';
    state.winner = winners.find(w => w !== seat) || winners[0];
    state.winReason = 'knock-caught';
  } else {
    state.phase = 'gameover';
    state.winner = seat;
    state.winReason = 'knock';
  }
  return resolveTonk(state, state.winner);
}

function resolveTonk(state, winnerSeat) {
  const p = state.players[winnerSeat];
  p.chips += state.pot;
  state.pot = 0;
  if (state.winReason === 'tonk-deal') p.chips += state.ante * state.players.length;
  return state;
}

module.exports = { createTonkGame, dealTonk, drawFromDeck, drawFromDiscard, discardCard, spread, hitSpread, knock };
