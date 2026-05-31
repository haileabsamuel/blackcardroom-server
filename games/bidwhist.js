// ─────────────────────────────────────────────
//  BID WHIST GAME ENGINE
// ─────────────────────────────────────────────
const { createDeck, shuffle, rankValue } = require('./deck');

const BID_LEVELS = [3,4,5,6,7,'low3','low4','low5','low6','low7','no-trump'];

function createBidWhistGame(roomId, playerIds) {
  return {
    roomId, game: 'bidwhist',
    phase: 'bidding',
    players: playerIds.map((id, i) => ({
      id, seat: i, team: i % 2, hand: [], bid: null, tricks: 0,
    })),
    teams: [{ score: 0 }, { score: 0 }],
    deck: [],
    kitty: [],
    currentTrick: [],
    trickNumber: 0,
    leadSeat: 0,
    currentSeat: 0,
    currentBid: null,
    highBidder: null,
    trump: null,
    direction: 'uptown', // uptown (aces high) | downtown (deuces high)
    noTrump: false,
    passes: 0,
    roundHistory: [],
  };
}

function dealBidWhist(state) {
  const deck = shuffle(createDeck(true)); // includes jokers
  const hands = [[], [], [], []];
  // deal 12 cards each, 6 to kitty
  deck.slice(0, 48).forEach((card, i) => hands[i % 4].push(card));
  state.kitty = deck.slice(48, 54);
  state.players.forEach((p, i) => { p.hand = hands[i]; p.bid = null; p.tricks = 0; });
  state.phase = 'bidding';
  state.currentSeat = state.leadSeat;
  state.currentBid = null;
  state.highBidder = null;
  state.passes = 0;
  state.trump = null;
  state.noTrump = false;
  state.currentTrick = [];
  state.trickNumber = 0;
  return state;
}

function placeBidWhistBid(state, seat, bid) {
  if (state.phase !== 'bidding') return { error: 'Not bidding phase' };
  if (state.currentSeat !== seat) return { error: 'Not your turn' };

  if (bid === 'pass') {
    state.passes++;
    // must bid if all others passed
    if (state.passes === 3 && state.highBidder === null) {
      // force last player to bid 3
      state.players[seat].bid = { level: 3, direction: 'uptown', noTrump: false };
      state.highBidder = seat;
      state.currentBid = 3;
      state.phase = 'kitty';
      return state;
    }
  } else {
    const level = bid.level;
    if (state.currentBid !== null && level <= state.currentBid) return { error: 'Bid must be higher' };
    state.players[seat].bid = bid;
    state.highBidder = seat;
    state.currentBid = level;
    state.direction = bid.direction || 'uptown';
    state.noTrump = bid.noTrump || false;
  }

  state.currentSeat = (seat + 1) % 4;
  const activePlayers = state.players.filter(p => p.bid !== 'pass');

  // bidding ends when 3 players pass after a bid
  const totalBids = state.players.filter(p => p.bid && p.bid !== 'pass').length;
  const totalPasses = state.players.filter(p => p.bid === 'pass').length;

  if (totalPasses === 3 && totalBids === 1) {
    state.phase = 'kitty';
    state.currentSeat = state.highBidder;
  } else if (state.players.every(p => p.bid !== null)) {
    state.phase = 'kitty';
    state.currentSeat = state.highBidder;
  }
  return state;
}

function takeKitty(state, seat, discard6Indices) {
  if (state.phase !== 'kitty') return { error: 'Not kitty phase' };
  if (seat !== state.highBidder) return { error: 'Only high bidder takes kitty' };
  const p = state.players[seat];
  p.hand = [...p.hand, ...state.kitty];
  const toDiscard = discard6Indices.sort((a,b) => b-a);
  toDiscard.forEach(i => p.hand.splice(i, 1));
  state.kitty = [];
  state.phase = 'trump';
  return state;
}

function setTrump(state, seat, suit) {
  if (state.phase !== 'trump') return { error: 'Not trump phase' };
  if (seat !== state.highBidder) return { error: 'Only high bidder sets trump' };
  state.trump = state.noTrump ? null : suit;
  state.phase = 'playing';
  state.currentSeat = state.highBidder;
  state.leadSeat = state.highBidder;
  return state;
}

function playBidWhistCard(state, seat, cardIndex) {
  if (state.phase !== 'playing') return { error: 'Not playing phase' };
  if (state.currentSeat !== seat) return { error: 'Not your turn' };
  const p = state.players[seat];
  const card = p.hand[cardIndex];
  if (!card) return { error: 'Invalid card' };

  if (state.currentTrick.length > 0) {
    const ledSuit = state.currentTrick[0].card.suit;
    if (card.suit !== ledSuit) {
      const hasSuit = p.hand.some(c => c.suit === ledSuit);
      if (hasSuit) return { error: 'Must follow suit' };
    }
  }

  p.hand.splice(cardIndex, 1);
  state.currentTrick.push({ seat, card });
  state.currentSeat = (seat + 1) % 4;

  if (state.currentTrick.length === 4) return resolveBidWhistTrick(state);
  return state;
}

function cardRank(card, ledSuit, trump, direction) {
  const baseOrder = direction === 'uptown'
    ? ['2','3','4','5','6','7','8','9','10','J','Q','K','A']
    : ['A','K','Q','J','10','9','8','7','6','5','4','3','2'];
  let val = baseOrder.indexOf(card.rank);
  if (card.suit === trump) val += 100;
  if (card.suit !== ledSuit && card.suit !== trump) val = -1;
  // Jokers always win
  if (card.rank === 'JK') val = 200;
  return val;
}

function resolveBidWhistTrick(state) {
  const ledSuit = state.currentTrick[0].card.suit;
  let winner = state.currentTrick[0];
  for (const play of state.currentTrick.slice(1)) {
    const wv = cardRank(winner.card, ledSuit, state.trump, state.direction);
    const pv = cardRank(play.card, ledSuit, state.trump, state.direction);
    if (pv > wv) winner = play;
  }
  state.players[winner.seat].tricks++;
  state.trickNumber++;
  state.currentSeat = winner.seat;
  state.leadSeat = winner.seat;
  state.currentTrick = [];
  if (state.trickNumber === 13) return scoreBidWhist(state);
  return state;
}

function scoreBidWhist(state) {
  const bidLevel = state.currentBid || 3;
  const bidTeam = state.players[state.highBidder].team;
  const oppTeam = 1 - bidTeam;
  const bidTeamTricks = state.players.filter(p => p.team === bidTeam).reduce((s, p) => s + p.tricks, 0);
  const oppTricks = 13 - bidTeamTricks;

  if (bidTeamTricks >= bidLevel + 6) {
    state.teams[bidTeam].score += bidLevel;
  } else {
    state.teams[bidTeam].score -= bidLevel;
  }
  const oppBooks = Math.max(0, oppTricks - 6);
  if (oppBooks > 0) state.teams[oppTeam].score += oppBooks;

  if (state.teams.some(t => t.score >= 7 || t.score <= -7)) {
    state.phase = 'gameover';
    state.winner = state.teams[0].score > state.teams[1].score ? 0 : 1;
  } else {
    state.phase = 'scoring';
    state.leadSeat = (state.leadSeat + 1) % 4;
  }
  return state;
}

module.exports = { createBidWhistGame, dealBidWhist, placeBidWhistBid, takeKitty, setTrump, playBidWhistCard };
