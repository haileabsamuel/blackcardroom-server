// ─────────────────────────────────────────────
//  SPADES GAME ENGINE
// ─────────────────────────────────────────────
const { createDeck, shuffle, SUITS, RANKS } = require('./deck');

const SPADES_CONFIG = {
  players: 4,
  teams: [[0, 2], [1, 3]],
  winScore: 500,
  nilBonus: 100,
  blindNilBonus: 200,
  bagPenalty: 100,
  bagLimit: 10,
};

function createSpadesGame(roomId, playerIds) {
  return {
    roomId,
    game: 'spades',
    phase: 'bidding', // bidding | playing | scoring | gameover
    players: playerIds.map((id, i) => ({
      id,
      seat: i,
      team: i % 2,
      hand: [],
      bid: null,
      nilBid: false,
      blindNil: false,
      tricks: 0,
    })),
    teams: [
      { score: 0, bags: 0 },
      { score: 0, bags: 0 },
    ],
    deck: [],
    currentTrick: [],
    trickNumber: 0,
    leadSeat: 0,
    currentSeat: 0,
    spadesBroken: false,
    roundHistory: [],
  };
}

function dealSpades(state) {
  const deck = shuffle(createDeck());
  const hands = [[], [], [], []];
  deck.forEach((card, i) => hands[i % 4].push(card));
  state.players.forEach((p, i) => { p.hand = hands[i]; p.bid = null; p.tricks = 0; p.nilBid = false; });
  state.phase = 'bidding';
  state.currentSeat = state.leadSeat;
  state.spadesBroken = false;
  state.currentTrick = [];
  state.trickNumber = 0;
  return state;
}

function placeBid(state, seat, bid) {
  const p = state.players[seat];
  if (state.phase !== 'bidding') return { error: 'Not bidding phase' };
  if (state.currentSeat !== seat) return { error: 'Not your turn to bid' };
  if (bid === 'nil') { p.nilBid = true; p.bid = 0; }
  else if (bid === 'blindnil') { p.blindNil = true; p.nilBid = true; p.bid = 0; }
  else {
    const n = parseInt(bid);
    if (n < 0 || n > 13) return { error: 'Invalid bid' };
    p.bid = n;
  }
  state.currentSeat = (seat + 1) % 4;
  if (state.players.every(p => p.bid !== null)) {
    state.phase = 'playing';
    state.currentSeat = state.leadSeat;
  }
  return state;
}

function playCard(state, seat, cardIndex) {
  if (state.phase !== 'playing') return { error: 'Not playing phase' };
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  const p = state.players[seat];
  const card = p.hand[cardIndex];
  if (!card) return { error: 'Invalid card' };

  // Validate lead
  if (state.currentTrick.length === 0) {
    if (card.suit === 'S' && !state.spadesBroken) {
      const hasNonSpade = p.hand.some(c => c.suit !== 'S');
      if (hasNonSpade) return { error: 'Spades not broken yet' };
    }
  } else {
    const ledSuit = state.currentTrick[0].card.suit;
    if (card.suit !== ledSuit) {
      const hasSuit = p.hand.some(c => c.suit === ledSuit);
      if (hasSuit) return { error: `Must follow suit (${ledSuit})` };
    }
  }

  if (card.suit === 'S') state.spadesBroken = true;
  p.hand.splice(cardIndex, 1);
  state.currentTrick.push({ seat, card });
  state.currentSeat = (seat + 1) % 4;

  if (state.currentTrick.length === 4) {
    return resolveTrick(state);
  }
  return state;
}

function resolveTrick(state) {
  const ledSuit = state.currentTrick[0].card.suit;
  let winner = state.currentTrick[0];
  for (const play of state.currentTrick.slice(1)) {
    if (play.card.suit === 'S' && winner.card.suit !== 'S') {
      winner = play;
    } else if (play.card.suit === winner.card.suit && rankValue(play.card.rank) > rankValue(winner.card.rank)) {
      winner = play;
    }
  }
  state.players[winner.seat].tricks++;
  state.trickNumber++;
  state.currentSeat = winner.seat;
  state.leadSeat = winner.seat;
  state.currentTrick = [];

  if (state.trickNumber === 13) {
    return scoreRound(state);
  }
  return state;
}

function scoreRound(state) {
  state.roundHistory.push(state.players.map(p => ({ bid: p.bid, tricks: p.tricks, nilBid: p.nilBid })));

  for (let team = 0; team < 2; team++) {
    const members = SPADES_CONFIG.teams[team];
    let roundScore = 0;
    let bags = 0;

    for (const seat of members) {
      const p = state.players[seat];
      if (p.nilBid) {
        roundScore += p.tricks === 0 ? SPADES_CONFIG.nilBonus : -SPADES_CONFIG.nilBonus;
        if (p.blindNil) roundScore += p.tricks === 0 ? SPADES_CONFIG.blindNilBonus : -SPADES_CONFIG.blindNilBonus;
      }
    }

    const teamBid = members.reduce((s, i) => s + (state.players[i].nilBid ? 0 : state.players[i].bid), 0);
    const teamTricks = members.reduce((s, i) => s + (state.players[i].nilBid ? 0 : state.players[i].tricks), 0);

    if (teamTricks >= teamBid) {
      roundScore += teamBid * 10 + (teamTricks - teamBid);
      bags += teamTricks - teamBid;
    } else {
      roundScore -= teamBid * 10;
    }

    state.teams[team].bags += bags;
    if (state.teams[team].bags >= SPADES_CONFIG.bagLimit) {
      roundScore -= SPADES_CONFIG.bagPenalty;
      state.teams[team].bags -= SPADES_CONFIG.bagLimit;
    }
    state.teams[team].score += roundScore;
  }

  if (state.teams.some(t => Math.abs(t.score) >= SPADES_CONFIG.winScore)) {
    state.phase = 'gameover';
    state.winner = state.teams[0].score > state.teams[1].score ? 0 : 1;
  } else {
    state.phase = 'scoring';
    state.leadSeat = (state.leadSeat + 1) % 4;
  }
  return state;
}

function rankValue(rank) {
  const order = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  return order.indexOf(rank);
}

module.exports = { createSpadesGame, dealSpades, placeBid, playCard: (s,seat,ci) => playCard(s,seat,ci) };
