'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'wizard.html')));

// ─── Konstanten ───────────────────────────────────────────────────────────────

const SUITS = ['rot', 'blau', 'grün', 'gelb'];
const SUIT_CLASS = { rot: 'red', blau: 'blue', grün: 'green', gelb: 'yellow' };
const SUIT_SYMBOL = { rot: '💧', blau: '🌊', grün: '🌳', gelb: '☀️' };
const NUM_PLAYERS = 4;
const AI_NAMES = ['Anke', 'Bruno', 'Carla', 'Dieter', 'Erika', 'Felix'];

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeName(s) {
  return escapeHtml(String(s || '').trim().slice(0, 16)) || 'Spieler';
}

function generateCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); }
  while (tables[code]);
  return code;
}

// ─── Tisch-Verwaltung ─────────────────────────────────────────────────────────

const tables = {};

setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [code, t] of Object.entries(tables)) {
    if (t.lastActivity < cutoff) {
      io.to(`t:${code}`).emit('table_deleted');
      delete tables[code];
    }
  }
}, 30 * 60 * 1000);

function createTable(hostClientId, hostName, allowLateJoin = false) {
  const code = generateCode();
  const aiPick = AI_NAMES.filter(n => n !== hostName);
  const names = [sanitizeName(hostName), aiPick[0], aiPick[1], aiPick[2]];
  const seats = [`h:${hostClientId}`, 'AI', 'AI', 'AI'];
  tables[code] = {
    code,
    hostClientId,
    seats,
    names,
    started: false,
    allowLateJoin,
    pendingSeats: [], // seats taken by humans mid-round; AI plays until round ends
    clientSockets: { [hostClientId]: null },
    state: null,
    logLines: [],
    highscores: [],
    lastActivity: Date.now(),
  };
  return tables[code];
}

// ─── Deck ─────────────────────────────────────────────────────────────────────

function makeDeck() {
  const d = [];
  for (const suit of SUITS)
    for (let v = 1; v <= 13; v++)
      d.push({ type: 'number', suit, value: v });
  for (let i = 0; i < 4; i++) {
    d.push({ type: 'wizard', id: i });
    d.push({ type: 'jester', id: i });
  }
  return d;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortHand(hand, trump) {
  hand.sort((a, b) => {
    const gA = a.type === 'jester' ? 0 : a.type === 'wizard' ? 3 : a.suit === trump ? 2 : 1;
    const gB = b.type === 'jester' ? 0 : b.type === 'wizard' ? 3 : b.suit === trump ? 2 : 1;
    if (gA !== gB) return gA - gB;
    if (gA === 1) {
      const sr = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
      return sr !== 0 ? sr : a.value - b.value;
    }
    if (gA === 2) return a.value - b.value;
    return 0;
  });
}

// ─── Spielzustand ─────────────────────────────────────────────────────────────

function freshState() {
  return {
    round: 1,
    dealerIndex: 0,
    scores: [0, 0, 0, 0],
    hands: [[], [], [], []],
    trumpCard: null,
    trumpSuit: null,
    bids: [null, null, null, null],
    tricksWon: [0, 0, 0, 0],
    currentTrick: [],
    leadSuit: null,
    currentPlayer: 0,
    trickLeader: 0,
    biddingOrder: [],
    biddingIndex: 0,
    phase: 'bidding',
    winnerBanner: '',
    lastRoundResults: null,
  };
}

// ─── Spiellogik – Hilfsfunktionen ─────────────────────────────────────────────

const MAX_ROUNDS = Math.floor(60 / NUM_PLAYERS); // 15

function isAI(table, seat) {
  if (table.seats[seat] === 'AI') return true;
  // Spieler hat mitten in einer Runde übernommen — KI spielt diese Runde noch zu Ende
  return !!(table.pendingSeats && table.pendingSeats.includes(seat));
}

function legalCards(table, seat) {
  const { hands, currentTrick, leadSuit } = table.state;
  const hand = hands[seat];
  if (currentTrick.length === 0 || !leadSuit) return hand.map((_, i) => i);
  const hasLead = hand.some(c => c.type === 'number' && c.suit === leadSuit);
  if (!hasLead) return hand.map((_, i) => i);
  return hand.map((c, i) => c.type !== 'number' || c.suit === leadSuit ? i : -1).filter(i => i !== -1);
}

function whoWinsTrick(plays, trumpSuit) {
  const wiz = plays.find(p => p.card.type === 'wizard');
  if (wiz) return wiz.playerIndex;
  const real = plays.filter(p => p.card.type !== 'jester');
  if (!real.length) return plays[0].playerIndex;
  const trumps = real.filter(p => p.card.suit === trumpSuit);
  const pool = trumps.length ? trumps : real.filter(p => p.card.suit === plays.find(p2 => p2.card.type === 'number')?.card.suit);
  const best = (pool.length ? pool : real).reduce((b, p) => p.card.value > b.card.value ? p : b);
  return best.playerIndex;
}

function cardLabel(card) {
  if (card.type === 'wizard') return 'Zauberer';
  if (card.type === 'jester') return 'Narr';
  return `${card.value} <span class="${SUIT_CLASS[card.suit]}">${SUIT_SYMBOL[card.suit]}</span>`;
}

function log(table, msg) {
  table.logLines.push(msg);
  if (table.logLines.length > 300) table.logLines.shift();
}

// ─── Spiellogik – KI ─────────────────────────────────────────────────────────

function estimateTricks(table, seat) {
  const { hands, trumpSuit, round } = table.state;
  let expected = 0, trumpCount = 0;
  for (const c of hands[seat]) {
    if (c.type === 'wizard') { expected += 1; }
    else if (c.type === 'jester') { /* 0 */ }
    else if (c.suit === trumpSuit) { trumpCount++; expected += 0.5 + (c.value / 13) * 0.5; }
    else { expected += (c.value / 13) * (0.5 / Math.max(1, round * 0.5)); }
  }
  if (trumpCount > 1) expected += (trumpCount - 1) * 0.2;
  return expected;
}

function aiChooseBid(table, seat) {
  let bid = Math.round(estimateTricks(table, seat));
  bid = Math.max(0, Math.min(table.state.round, bid));
  if (Math.random() < 0.15) bid = Math.max(0, Math.min(table.state.round, bid + (Math.random() < 0.5 ? -1 : 1)));
  // Letzter Spieler darf Summe nicht gleich Runde machen
  const { biddingOrder, bids, round } = table.state;
  if (biddingOrder[biddingOrder.length - 1] === seat) {
    const sum = bids.reduce((s, b) => s + (b ?? 0), 0);
    const forbidden = round - sum;
    if (forbidden >= 0 && forbidden <= round && bid === forbidden)
      bid = bid < round ? bid + 1 : Math.max(0, bid - 1);
  }
  return bid;
}

function cardStrength(card, trumpSuit, leadSuit) {
  if (card.type === 'wizard') return 100;
  if (card.type === 'jester') return -100;
  if (card.suit === trumpSuit) return 50 + card.value;
  if (leadSuit && card.suit === leadSuit) return card.value;
  return card.value - 20;
}

function aiChooseCard(table, seat) {
  const { state } = table;
  const hand = state.hands[seat];
  const legal = legalCards(table, seat);
  const bid = state.bids[seat] ?? 0;
  const won = state.tricksWon[seat];
  const needsMore = won < bid;

  function wouldWin(cardIdx) {
    const trick = [...state.currentTrick, { playerIndex: seat, card: hand[cardIdx] }];
    const saved = state.currentTrick;
    state.currentTrick = trick;
    const w = whoWinsTrick(trick, state.trumpSuit);
    state.currentTrick = saved;
    return w === seat;
  }

  const opts = legal
    .map(i => ({ i, s: cardStrength(hand[i], state.trumpSuit, state.leadSuit) }))
    .sort((a, b) => a.s - b.s);

  let chosen;
  if (needsMore) {
    if (state.currentTrick.length === 0) {
      chosen = opts.length - 1;
    } else {
      const wins = opts.filter(o => wouldWin(o.i));
      chosen = wins.length > 0 ? opts.indexOf(wins[0]) : 0;
    }
  } else {
    const loses = opts.filter(o => !wouldWin(o.i));
    chosen = loses.length > 0 ? opts.indexOf(loses[0]) : 0;
  }

  if (opts.length > 1 && Math.random() < 0.08) {
    const nb = chosen + (Math.random() < 0.5 ? -1 : 1);
    if (nb >= 0 && nb < opts.length) chosen = nb;
  }

  return opts[chosen].i;
}

// ─── Spiellogik – Ablauf ──────────────────────────────────────────────────────

function broadcast(tableCode) {
  const table = tables[tableCode];
  if (!table) return;
  const logHTML = table.logLines.map(l => `<div>${l}</div>`).join('');
  const connectedSeats = table.seats.map((s, i) =>
    s === 'AI' ? true : !!table.clientSockets[s.slice(2)]
  );

  for (let seat = 0; seat < NUM_PLAYERS; seat++) {
    const s = table.seats[seat];
    if (s === 'AI') continue;
    const clientId = s.slice(2);
    const socketId = table.clientSockets[clientId];
    if (!socketId) continue;
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('state_update', {
      state: table.state,
      logHTML,
      mySeat: seat,
      names: table.names,
      seats: table.seats,
      connectedSeats,
      isHost: clientId === table.hostClientId,
      pendingSeats: table.pendingSeats || [],
      allowLateJoin: table.allowLateJoin,
    });
  }
}

function startRound(code) {
  const table = tables[code];
  if (!table) return;
  const s = table.state;
  s.phase = 'bidding';
  s.hands = [[], [], [], []];
  s.bids = [null, null, null, null];
  s.tricksWon = [0, 0, 0, 0];
  s.currentTrick = [];
  s.leadSuit = null;
  s.winnerBanner = '';
  s.lastRoundResults = null;

  const deck = shuffle(makeDeck());
  for (let p = 0; p < NUM_PLAYERS; p++)
    for (let c = 0; c < s.round; c++)
      s.hands[p].push(deck.pop());

  s.trumpCard = deck.length > 0 ? deck.pop() : null;

  if (!s.trumpCard) {
    s.trumpSuit = null;
  } else if (s.trumpCard.type === 'number') {
    s.trumpSuit = s.trumpCard.suit;
  } else if (s.trumpCard.type === 'wizard') {
    s.trumpSuit = SUITS[Math.floor(Math.random() * SUITS.length)];
    log(table, `Zauberer aufgedeckt — Dealer wählt <b>${s.trumpSuit}</b> als Trumpf.`);
  } else {
    s.trumpSuit = null;
  }

  for (let p = 0; p < NUM_PLAYERS; p++) sortHand(s.hands[p], s.trumpSuit);

  s.biddingOrder = [];
  for (let i = 1; i <= NUM_PLAYERS; i++)
    s.biddingOrder.push((s.dealerIndex + i) % NUM_PLAYERS);
  s.biddingIndex = 0;
  s.trickLeader = s.biddingOrder[0];
  s.currentPlayer = s.trickLeader;

  log(table, `<span class="log-entry highlight">— Runde ${s.round} (${s.round} Karte${s.round > 1 ? 'n' : ''} pro Spieler) —</span>`);
  table.lastActivity = Date.now();
  broadcast(code);
  processBidding(code);
}

function processBidding(code) {
  const table = tables[code];
  if (!table) return;
  const s = table.state;
  if (s.biddingIndex >= NUM_PLAYERS) {
    s.phase = 'playing';
    log(table, `Vorhersagen: ${s.bids.map((b, i) => `${table.names[i]}: ${b}`).join(', ')}`);
    broadcast(code);
    setTimeout(() => playTurn(code), 600);
    return;
  }
  const seat = s.biddingOrder[s.biddingIndex];
  if (isAI(table, seat)) {
    setTimeout(() => {
      const bid = aiChooseBid(table, seat);
      applyBid(code, seat, bid);
    }, 500);
  } else {
    broadcast(code);
  }
}

function applyBid(code, seat, bid) {
  const table = tables[code];
  if (!table) return;
  const s = table.state;
  s.bids[seat] = bid;
  log(table, `${table.names[seat]} sagt <b>${bid}</b> Stich${bid === 1 ? '' : 'e'} an.`);
  s.biddingIndex++;
  broadcast(code);
  processBidding(code);
}

function playTurn(code) {
  const table = tables[code];
  if (!table || table.state.phase !== 'playing') return;
  const seat = table.state.currentPlayer;

  // Auto-play wenn nur noch eine Karte
  if (!isAI(table, seat) && table.state.hands[seat].length === 1) {
    setTimeout(() => doPlayCard(code, seat, 0), 500);
    return;
  }

  if (isAI(table, seat)) {
    setTimeout(() => {
      const idx = aiChooseCard(table, seat);
      doPlayCard(code, seat, idx);
    }, 600);
  } else {
    broadcast(code);
  }
}

function doPlayCard(code, seat, cardIndex) {
  const table = tables[code];
  if (!table) return;
  const s = table.state;
  const card = s.hands[seat].splice(cardIndex, 1)[0];
  s.currentTrick.push({ playerIndex: seat, card });

  if (s.currentTrick.length === 1) {
    s.leadSuit = card.type === 'number' ? card.suit : null;
  } else if (!s.leadSuit && card.type === 'number') {
    const hasWiz = s.currentTrick.some(p => p.card.type === 'wizard');
    if (!hasWiz) s.leadSuit = card.suit;
  }

  log(table, `${table.names[seat]} spielt ${cardLabel(card)}.`);
  table.lastActivity = Date.now();
  broadcast(code);

  if (s.currentTrick.length === NUM_PLAYERS) {
    setTimeout(() => resolveTrick(code), 1000);
  } else {
    s.currentPlayer = (seat + 1) % NUM_PLAYERS;
    setTimeout(() => playTurn(code), 500);
  }
}

function resolveTrick(code) {
  const table = tables[code];
  if (!table) return;
  const s = table.state;
  const winner = whoWinsTrick(s.currentTrick, s.trumpSuit);
  s.tricksWon[winner]++;
  log(table, `<span class="log-entry highlight">${table.names[winner]} gewinnt den Stich.</span>`);
  s.winnerBanner = `${table.names[winner]} gewinnt den Stich`;
  broadcast(code);

  setTimeout(() => {
    s.currentTrick = [];
    s.leadSuit = null;
    s.winnerBanner = '';
    if (s.hands.every(h => h.length === 0)) {
      endRound(code);
    } else {
      s.trickLeader = winner;
      s.currentPlayer = winner;
      broadcast(code);
      playTurn(code);
    }
  }, 1200);
}

function endRound(code) {
  const table = tables[code];
  if (!table) return;
  const s = table.state;
  s.phase = 'roundEnd';
  const results = [];
  for (let p = 0; p < NUM_PLAYERS; p++) {
    const bid = s.bids[p], won = s.tricksWon[p];
    const pts = bid === won ? 20 + won * 10 : -10 * Math.abs(bid - won);
    s.scores[p] += pts;
    results.push({ name: table.names[p], bid, won, points: pts, total: s.scores[p] });
    log(table, `${table.names[p]}: ${bid} vorhergesagt, ${won} gewonnen → <b>${pts >= 0 ? '+' : ''}${pts}</b> (Gesamt: ${s.scores[p]})`);
  }
  s.lastRoundResults = results;

  const maxRounds = Math.floor(60 / NUM_PLAYERS);
  s.isLastRound = s.round >= maxRounds;

  // Nachzügler sind ab nächster Runde vollwertig dabei
  if (table.pendingSeats && table.pendingSeats.length > 0) {
    const names = table.pendingSeats.map(i => table.names[i]).join(', ');
    log(table, `<span class="log-entry highlight">🙋 ${names} übernimmt ab der nächsten Runde!</span>`);
    table.pendingSeats = [];
  }

  if (s.isLastRound) {
    const maxScore = Math.max(...s.scores);
    const winnerIdx = s.scores.indexOf(maxScore);
    log(table, `<span class="log-entry highlight">🏆 Spiel vorbei! ${table.names[winnerIdx]} gewinnt mit ${maxScore} Punkten.</span>`);
    // Highscore speichern
    table.highscores.push({ name: table.names[winnerIdx], score: maxScore, date: new Date().toISOString() });
    table.highscores.sort((a, b) => b.score - a.score);
    if (table.highscores.length > 20) table.highscores.length = 20;
  }

  table.lastActivity = Date.now();
  broadcast(code);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let myCode = null;
  let myClientId = null;
  let mySeat = null;

  function getTable() { return myCode ? tables[myCode] : null; }

  // Registriere Socket-ID beim Klienten
  function registerSocket() {
    const t = getTable();
    if (t && myClientId) t.clientSockets[myClientId] = socket.id;
  }

  socket.on('create_table', ({ name, clientId, allowLateJoin }, cb) => {
    myClientId = clientId;
    mySeat = 0;
    const table = createTable(clientId, name, !!allowLateJoin);
    myCode = table.code;
    table.clientSockets[clientId] = socket.id;
    socket.join(`t:${table.code}`);
    cb({ code: table.code, seat: 0, names: table.names, seats: table.seats, isHost: true });
  });

  socket.on('join_table', ({ code, name, clientId }, cb) => {
    const table = tables[code];
    if (!table) return cb({ error: 'Diesen Tisch gibt es nicht.' });

    if (table.started) {
      // Late-Join prüfen
      if (!table.allowLateJoin) return cb({ error: 'Das Spiel hat bereits begonnen.' });
      const roundsLeft = MAX_ROUNDS - table.state.round; // Runden nach der laufenden
      if (roundsLeft < 4) return cb({ error: `Zu wenige Runden verbleibend (${roundsLeft} nach dieser — mind. 4 nötig).` });
      const aiSeat = table.seats.findIndex(s => s === 'AI');
      if (aiSeat === -1) return cb({ error: 'Keine freien KI-Plätze mehr.' });

      table.seats[aiSeat] = `h:${clientId}`;
      table.names[aiSeat] = sanitizeName(name);
      table.clientSockets[clientId] = socket.id;

      const roundInProgress = table.state.phase !== 'roundEnd';
      if (roundInProgress) table.pendingSeats.push(aiSeat);

      myClientId = clientId;
      myCode = code;
      mySeat = aiSeat;
      table.lastActivity = Date.now();
      socket.join(`t:${code}`);

      const logHTML = table.logLines.map(l => `<div>${l}</div>`).join('');
      const connectedSeats = table.seats.map(s => s === 'AI' ? true : !!table.clientSockets[s.slice(2)]);
      socket.emit('state_update', {
        state: table.state,
        logHTML,
        mySeat: aiSeat,
        names: table.names,
        seats: table.seats,
        connectedSeats,
        isHost: false,
        pendingSeats: table.pendingSeats,
        allowLateJoin: table.allowLateJoin,
        lateJoin: true,
        roundInProgress,
      });
      broadcast(code); // restliche Spieler über neuen Mitspieler informieren
      cb({ code, seat: aiSeat, names: table.names, seats: table.seats, isHost: false, lateJoin: true, roundInProgress });
      return;
    }

    // Normaler Beitritt (Warteraum)
    let seat = table.seats.findIndex(s => s === `h:${clientId}`);
    if (seat === -1) {
      seat = table.seats.findIndex(s => s === 'AI');
      if (seat === -1) return cb({ error: 'Der Tisch ist voll.' });
      table.seats[seat] = `h:${clientId}`;
      table.names[seat] = sanitizeName(name);
    }

    myClientId = clientId;
    myCode = code;
    mySeat = seat;
    table.clientSockets[clientId] = socket.id;
    table.lastActivity = Date.now();

    socket.join(`t:${code}`);
    io.to(`t:${code}`).emit('waiting_room', { names: table.names, seats: table.seats, code });
    cb({ code, seat, names: table.names, seats: table.seats, isHost: false });
  });

  socket.on('reconnect_table', ({ code, clientId }, cb) => {
    const table = tables[code];
    if (!table) return cb({ error: 'Tisch nicht mehr vorhanden.' });

    let seat = table.seats.findIndex(s => s === `h:${clientId}`);
    if (seat === -1) return cb({ error: 'Kein Sitzplatz gefunden.' });

    myClientId = clientId;
    myCode = code;
    mySeat = seat;
    table.clientSockets[clientId] = socket.id;
    table.lastActivity = Date.now();
    socket.join(`t:${code}`);

    const isHost = clientId === table.hostClientId;
    if (!table.started) {
      io.to(`t:${code}`).emit('waiting_room', { names: table.names, seats: table.seats, code });
      cb({ seat, names: table.names, seats: table.seats, started: false, isHost });
    } else {
      cb({ seat, names: table.names, seats: table.seats, started: true, isHost });
      const logHTML = table.logLines.map(l => `<div>${l}</div>`).join('');
      const connectedSeats = table.seats.map(s =>
        s === 'AI' ? true : !!table.clientSockets[s.slice(2)]
      );
      socket.emit('state_update', {
        state: table.state,
        logHTML,
        mySeat: seat,
        names: table.names,
        seats: table.seats,
        connectedSeats,
        isHost,
        pendingSeats: table.pendingSeats || [],
        allowLateJoin: table.allowLateJoin,
      });
    }
  });

  socket.on('start_game', () => {
    const table = getTable();
    if (!table || table.hostClientId !== myClientId || table.started) return;
    table.started = true;
    table.state = freshState();
    table.lastActivity = Date.now();
    io.to(`t:${myCode}`).emit('game_started', { names: table.names, seats: table.seats });
    log(table, '<span class="log-entry highlight">— Spiel gestartet —</span>');
    log(table, `Spieler: ${table.names.map((n, i) => n + (table.seats[i] === 'AI' ? ' (KI)' : '')).join(', ')}`);
    setTimeout(() => startRound(myCode), 300);
  });

  socket.on('action', ({ type, value, cardIndex }) => {
    const table = getTable();
    if (!table || !table.started || mySeat === null) return;
    const s = table.state;

    if (type === 'bid') {
      if (s.phase !== 'bidding') return;
      if (s.biddingOrder[s.biddingIndex] !== mySeat) return;
      applyBid(myCode, mySeat, value);
    } else if (type === 'play') {
      if (s.phase !== 'playing') return;
      if (s.currentPlayer !== mySeat) return;
      const legal = legalCards(table, mySeat);
      if (!legal.includes(cardIndex)) return;
      doPlayCard(myCode, mySeat, cardIndex);
    }
  });

  socket.on('next_round', () => {
    const table = getTable();
    if (!table || table.hostClientId !== myClientId) return;
    if (table.state?.phase !== 'roundEnd') return;
    table.state.round++;
    table.state.dealerIndex = (table.state.dealerIndex + 1) % NUM_PLAYERS;
    startRound(myCode);
  });

  socket.on('new_game', () => {
    const table = getTable();
    if (!table || table.hostClientId !== myClientId) return;
    table.state = freshState();
    table.logLines = [];
    log(table, '<span class="log-entry highlight">— Neues Spiel gestartet —</span>');
    startRound(myCode);
  });

  socket.on('get_highscores', (cb) => {
    const table = getTable();
    if (!table) return cb([]);
    cb(table.highscores);
  });

  socket.on('chat', ({ text }) => {
    const table = getTable();
    if (!table || mySeat === null) return;
    io.to(`t:${myCode}`).emit('chat_message', {
      name: table.names[mySeat],
      text: escapeHtml(String(text || '').slice(0, 200)),
      time: Date.now(),
    });
  });

  socket.on('leave_table', () => {
    const table = getTable();
    if (table && mySeat !== null) {
      const ai = AI_NAMES.find(n => !table.names.includes(n)) || AI_NAMES[mySeat % AI_NAMES.length];
      table.seats[mySeat] = 'AI';
      table.names[mySeat] = ai;
      delete table.clientSockets[myClientId];
      if (!table.started) {
        io.to(`t:${myCode}`).emit('waiting_room', { names: table.names, seats: table.seats, code: myCode });
      }
    }
    socket.leave(`t:${myCode}`);
    myCode = null; myClientId = null; mySeat = null;
  });

  socket.on('end_table', () => {
    const table = getTable();
    if (!table || table.hostClientId !== myClientId) return;
    io.to(`t:${myCode}`).emit('table_deleted');
    delete tables[myCode];
  });

  socket.on('disconnect', () => {
    const table = getTable();
    if (table && myClientId && table.clientSockets[myClientId] === socket.id) {
      delete table.clientSockets[myClientId];
      // Kurz warten — evtl. reconnect
      setTimeout(() => {
        const t = tables[myCode];
        if (t && !t.clientSockets[myClientId]) {
          // Immer noch weg — verbundene anzeigen
          broadcast(myCode);
        }
      }, 5000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Wizard-Server läuft auf http://0.0.0.0:${PORT}`);
});
