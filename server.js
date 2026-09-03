// ============================================================================
//  ДУРАК — сервер (server.js)
//  Node.js + Express + Socket.io
//  Реализует полный игровой цикл: комнаты, боты, раздачу, атаку, защиту,
//  подкидывание по кругу, "Бито"/"Беру", добор карт.
// ============================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Константы колоды
// ---------------------------------------------------------------------------
const SUITS = ['♠', '♥', '♦', '♣'];
const RED_SUITS = new Set(['♥', '♦']);
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let i = 0; i < RANKS.length; i++) {
      deck.push({ id: RANKS[i] + suit, suit, rank: RANKS[i], value: 6 + i });
    }
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function canBeat(attackCard, defenseCard, trumpSuit) {
  if (defenseCard.suit === attackCard.suit && defenseCard.value > attackCard.value) return true;
  if (defenseCard.suit === trumpSuit && attackCard.suit !== trumpSuit) return true;
  return false;
}

function sortHand(hand, trumpSuit) {
  return [...hand].sort((a, b) => {
    const at = a.suit === trumpSuit ? 1 : 0;
    const bt = b.suit === trumpSuit ? 1 : 0;
    if (at !== bt) return at - bt;
    if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
    return a.value - b.value;
  });
}

// ---------------------------------------------------------------------------
// Состояние комнат
// ---------------------------------------------------------------------------
const rooms = {}; // code -> room

function makeRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms[code]);
  return code;
}

function makePlayer(id, name, isBot) {
  return { id, name, isBot, hand: [], connected: true, finished: false, socketId: isBot ? null : id };
}

function createRoom(numPlayers, hostSocketId, hostName) {
  const code = makeRoomCode();
  const room = {
    code,
    numPlayers,
    players: [makePlayer(hostSocketId, hostName || 'Игрок', false)],
    deck: [],
    trumpSuit: null,
    trumpCard: null,
    discard: [],
    table: [], // [{attack, defense|null}]
    attackerIdx: 0,
    defenderIdx: 1,
    throwQueue: [],
    throwPtr: 0,
    passed: new Set(),
    status: 'waiting', // waiting | playing | finished
    awaiting: null,
    botTimer: null,
    log: [],
    loser: null,
  };
  rooms[code] = room;
  return room;
}

function pushLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 40) room.log.shift();
}

function clearBotTimer(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

function activeIdx(room) {
  // indices of players still in the game (not finished)
  const res = [];
  room.players.forEach((p, i) => { if (!p.finished) res.push(i); });
  return res;
}

function nextIndex(room, i) {
  const n = room.players.length;
  let j = (i + 1) % n;
  let guard = 0;
  while (room.players[j].finished && guard < n) {
    j = (j + 1) % n;
    guard++;
  }
  return j;
}

function firstActiveFrom(room, i) {
  const n = room.players.length;
  let j = i;
  let guard = 0;
  while (room.players[j].finished && guard < n) {
    j = nextIndex(room, j);
    guard++;
  }
  return j;
}

// ---------------------------------------------------------------------------
// Запуск партии
// ---------------------------------------------------------------------------
function fillWithBots(room) {
  let botCount = 1;
  while (room.players.length < room.numPlayers) {
    room.players.push(makePlayer('bot_' + room.code + '_' + botCount, 'Бот ' + botCount, true));
    botCount++;
  }
}

function startGame(room) {
  fillWithBots(room);
  room.deck = shuffle(buildDeck());
  room.discard = [];
  room.table = [];
  room.players.forEach(p => { p.hand = []; p.finished = false; });

  for (let r = 0; r < 6; r++) {
    for (const p of room.players) {
      p.hand.push(room.deck.pop());
    }
  }
  // Козырная карта — последняя оставшаяся, кладём её "под низ" колоды
  room.trumpCard = room.deck.shift();
  room.trumpSuit = room.trumpCard.suit;
  room.deck.push(room.trumpCard); // хранится в самом низу колоды

  // Находим игрока с самым младшим козырем
  let starter = 0;
  let bestVal = 999;
  room.players.forEach((p, i) => {
    p.hand.forEach(c => {
      if (c.suit === room.trumpSuit && c.value < bestVal) {
        bestVal = c.value;
        starter = i;
      }
    });
  });

  room.attackerIdx = starter;
  room.defenderIdx = nextIndex(room, starter);
  room.table = [];
  room.passed = new Set();
  room.throwQueue = [];
  room.throwPtr = 0;
  room.status = 'playing';
  room.awaiting = null;
  room.loser = null;
  pushLog(room, `Игра началась! Козырь: ${room.trumpCard.rank}${room.trumpCard.suit}. Первым ходит ${room.players[starter].name}.`);

  loop(room);
  emitState(room);
}

// ---------------------------------------------------------------------------
// Вспомогательные игровые функции
// ---------------------------------------------------------------------------
function tableRanks(room) {
  const s = new Set();
  room.table.forEach(pair => {
    s.add(pair.attack.rank);
    if (pair.defense) s.add(pair.defense.rank);
  });
  return s;
}

function maxAttackCards(room) {
  const defenderHand = room.players[room.defenderIdx].hand.length + room.table.filter(p => p.defense).length;
  return Math.min(6, defenderHand);
}

function buildThrowQueue(room) {
  // Порядок по часовой стрелке начиная с атакующего, исключая защищающегося.
  // Шагаем ровно по числу АКТИВНЫХ (не выбывших) игроков через nextIndex
  // (которая уже пропускает выбывших), иначе при пропуске выбывших игроков
  // можно случайно вернуться на уже добавленного игрока и задвоить его.
  const order = [];
  const activeCount = activeIdx(room).length;
  let i = room.attackerIdx;
  for (let k = 0; k < activeCount; k++) {
    if (i !== room.defenderIdx) order.push(i);
    i = nextIndex(room, i);
  }
  return order;
}

function getValidThrowCards(room, playerIdx) {
  if (room.table.length === 0) return room.players[playerIdx].hand; // первая атака — любая карта
  const ranks = tableRanks(room);
  return room.players[playerIdx].hand.filter(c => ranks.has(c.rank));
}

function passSetComplete(room) {
  if (room.table.length >= maxAttackCards(room)) return true;
  return room.passed.size >= room.throwQueue.length;
}

function nextThrowerIdx(room) {
  const n = room.throwQueue.length;
  for (let k = 0; k < n; k++) {
    const pos = (room.throwPtr + k) % n;
    const idx = room.throwQueue[pos];
    if (!room.passed.has(idx) && !room.players[idx].finished) {
      room.throwPtr = (pos + 1) % n;
      return idx;
    }
  }
  return null;
}

function checkFinished(room) {
  room.players.forEach(p => {
    if (!p.finished && p.hand.length === 0 && room.deck.length === 0) {
      p.finished = true;
      pushLog(room, `${p.name} избавился от всех карт и выходит из игры!`);
    }
  });
  const remaining = activeIdx(room);
  if (room.deck.length === 0 && remaining.length <= 1) {
    room.status = 'finished';
    room.awaiting = null;
    clearBotTimer(room);
    room.loser = remaining.length === 1 ? room.players[remaining[0]].name : null;
    pushLog(room, room.loser ? `Игра окончена. Дурак: ${room.loser}!` : 'Игра окончена. Ничья!');
    return true;
  }
  return false;
}

function drawUpTo6(room, startIdx, excludeIdx) {
  let i = startIdx;
  for (let k = 0; k < room.players.length; k++) {
    const p = room.players[i];
    if (i !== excludeIdx && !p.finished) {
      while (p.hand.length < 6 && room.deck.length > 0) {
        p.hand.push(room.deck.shift());
      }
    }
    i = nextIndex(room, i);
  }
}

function endRoundBito(room) {
  pushLog(room, 'Раунд завершён — Бито! Карты уходят в отбой.');
  room.table.forEach(pair => {
    room.discard.push(pair.attack);
    if (pair.defense) room.discard.push(pair.defense);
  });
  room.table = [];
  const oldAttacker = room.attackerIdx;
  drawUpTo6(room, oldAttacker, -1);
  if (checkFinished(room)) return;
  room.attackerIdx = firstActiveFrom(room, room.defenderIdx);
  room.defenderIdx = nextIndex(room, room.attackerIdx);
  room.table = [];
  room.passed = new Set();
  room.throwQueue = [];
  room.throwPtr = 0;
  room.awaiting = null;
}

function takeCards(room) {
  const defender = room.players[room.defenderIdx];
  pushLog(room, `${defender.name} берёт карты со стола.`);
  room.table.forEach(pair => {
    defender.hand.push(pair.attack);
    if (pair.defense) defender.hand.push(pair.defense);
  });
  room.table = [];
  const oldAttacker = room.attackerIdx;
  drawUpTo6(room, oldAttacker, room.defenderIdx);
  if (checkFinished(room)) return;
  room.attackerIdx = firstActiveFrom(room, nextIndex(room, room.defenderIdx));
  room.defenderIdx = nextIndex(room, room.attackerIdx);
  room.table = [];
  room.passed = new Set();
  room.throwQueue = [];
  room.throwPtr = 0;
  room.awaiting = null;
}

// ---------------------------------------------------------------------------
// ИИ ботов
// ---------------------------------------------------------------------------
function botChooseDefense(room) {
  const defender = room.players[room.defenderIdx];
  const pending = room.table[room.table.length - 1];
  const options = defender.hand.filter(c => canBeat(pending.attack, c, room.trumpSuit));
  if (options.length === 0) return null;
  options.sort((a, b) => {
    const at = a.suit === room.trumpSuit ? 1 : 0;
    const bt = b.suit === room.trumpSuit ? 1 : 0;
    if (at !== bt) return at - bt;
    return a.value - b.value;
  });
  return options[0];
}

function botChooseFirstAttack(room) {
  const attacker = room.players[room.attackerIdx];
  const sorted = sortHand(attacker.hand, room.trumpSuit);
  return sorted[0];
}

function botChooseThrow(room, idx) {
  const valid = getValidThrowCards(room, idx);
  if (valid.length === 0) return null;
  // не кидать козырь, если есть некозырная карта подходящего ранга
  const nonTrump = valid.filter(c => c.suit !== room.trumpSuit);
  const pool = nonTrump.length > 0 ? nonTrump : valid;
  pool.sort((a, b) => a.value - b.value);
  return pool[0];
}

function botDefend(room) {
  const defender = room.players[room.defenderIdx];
  const pending = room.table[room.table.length - 1];
  const card = botChooseDefense(room);
  if (card) {
    defender.hand = defender.hand.filter(c => c.id !== card.id);
    pending.defense = card;
    room.passed = new Set();
    pushLog(room, `${defender.name} отбивается картой ${card.rank}${card.suit}.`);
  } else {
    takeCards(room);
  }
}

function botFirstAttack(room) {
  const attacker = room.players[room.attackerIdx];
  const card = botChooseFirstAttack(room);
  attacker.hand = attacker.hand.filter(c => c.id !== card.id);
  room.table.push({ attack: card, defense: null });
  room.throwQueue = buildThrowQueue(room);
  room.throwPtr = 0;
  room.passed = new Set();
  pushLog(room, `${attacker.name} ходит картой ${card.rank}${card.suit}.`);
}

function botThrow(room, throwerIdx) {
  if (throwerIdx === undefined) throwerIdx = nextThrowerIdx(room);
  if (throwerIdx === null || throwerIdx === undefined) return;
  const thrower = room.players[throwerIdx];
  const card = botChooseThrow(room, throwerIdx);
  if (card) {
    thrower.hand = thrower.hand.filter(c => c.id !== card.id);
    room.table.push({ attack: card, defense: null });
    room.passed = new Set();
    pushLog(room, `${thrower.name} подкидывает ${card.rank}${card.suit}.`);
  } else {
    room.passed.add(throwerIdx);
    pushLog(room, `${thrower.name} пасует.`);
  }
}

// ---------------------------------------------------------------------------
// ГЛАВНЫЙ ЦИКЛ ИГРЫ  (executeBotTurnChain)
// ---------------------------------------------------------------------------
function loop(room) {
  if (room.status !== 'playing') return;

  const pending = room.table.length > 0 ? room.table[room.table.length - 1] : null;
  const needsDefense = pending && !pending.defense;

  // 1. Кто-то должен защищаться
  if (needsDefense) {
    const defender = room.players[room.defenderIdx];
    if (defender.isBot) {
      clearBotTimer(room);
      room.awaiting = null;
      room.botTimer = setTimeout(() => {
        if (room.status !== 'playing') return;
        botDefend(room);
        loop(room);
        emitState(room);
      }, 800);
      emitState(room);
    } else {
      room.awaiting = { type: 'defend', playerIdx: room.defenderIdx };
      emitState(room);
    }
    return;
  }

  // 2. Стол пуст — первая атака
  if (room.table.length === 0) {
    const attacker = room.players[room.attackerIdx];
    if (attacker.isBot) {
      clearBotTimer(room);
      room.awaiting = null;
      room.botTimer = setTimeout(() => {
        if (room.status !== 'playing') return;
        botFirstAttack(room);
        loop(room);
        emitState(room);
      }, 800);
      emitState(room);
    } else {
      room.awaiting = { type: 'attack', playerIdx: room.attackerIdx };
      emitState(room);
    }
    return;
  }

  // 3. Всё отбито — фаза подкидывания / завершения раунда
  if (room.throwQueue.length === 0) room.throwQueue = buildThrowQueue(room);

  if (passSetComplete(room)) {
    const attacker = room.players[room.attackerIdx];
    if (attacker.isBot) {
      clearBotTimer(room);
      room.awaiting = null;
      room.botTimer = setTimeout(() => {
        if (room.status !== 'playing') return;
        endRoundBito(room);
        if (room.status === 'playing') loop(room);
        emitState(room);
      }, 800);
      emitState(room);
    } else {
      room.awaiting = { type: 'bito', playerIdx: room.attackerIdx };
      emitState(room);
    }
    return;
  }

  const throwerIdx = nextThrowerIdx(room);
  if (throwerIdx === null) {
    // защита на всякий случай — считаем раунд завершённым.
    // Планируем продолжение асинхронно, чтобы не накапливать стек вызовов.
    room.passed = new Set(room.throwQueue);
    clearBotTimer(room);
    room.botTimer = setTimeout(() => {
      if (room.status !== 'playing') return;
      loop(room);
      emitState(room);
    }, 0);
    return;
  }
  const thrower = room.players[throwerIdx];
  if (thrower.isBot) {
    clearBotTimer(room);
    room.awaiting = null;
    room.botTimer = setTimeout(() => {
      if (room.status !== 'playing') return;
      botThrow(room, throwerIdx);
      loop(room);
      emitState(room);
    }, 800);
    emitState(room);
  } else {
    room.awaiting = { type: 'throw', playerIdx: throwerIdx, isAttacker: throwerIdx === room.attackerIdx };
    emitState(room);
  }
}

// ---------------------------------------------------------------------------
// Отправка состояния клиентам
// ---------------------------------------------------------------------------
function publicPlayers(room, forIdx) {
  return room.players.map((p, i) => ({
    idx: i,
    name: p.name,
    isBot: p.isBot,
    connected: p.connected,
    finished: p.finished,
    handCount: p.hand.length,
    isYou: i === forIdx,
    isAttacker: i === room.attackerIdx,
    isDefender: i === room.defenderIdx,
  }));
}

function emitState(room) {
  room.players.forEach((p, idx) => {
    if (p.isBot || !p.socketId) return;
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) return;
    const state = {
      code: room.code,
      status: room.status,
      players: publicPlayers(room, idx),
      yourIdx: idx,
      yourHand: sortHand(p.hand, room.trumpSuit),
      table: room.table,
      trumpCard: room.trumpCard,
      trumpSuit: room.trumpSuit,
      deckCount: room.deck.length,
      discardCount: room.discard.length,
      attackerIdx: room.attackerIdx,
      defenderIdx: room.defenderIdx,
      awaiting: room.awaiting,
      log: room.log.slice(-8),
      loser: room.loser,
    };
    sock.emit('state', state);
  });
}

// ---------------------------------------------------------------------------
// Socket.io обработчики
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('createLocalGame', ({ numPlayers, name }) => {
    const room = createRoom(numPlayers, socket.id, name);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    startGame(room);
  });

  socket.on('createRoom', ({ numPlayers, name }) => {
    const room = createRoom(numPlayers, socket.id, name);
    socket.data.roomCode = room.code;
    socket.join(room.code);
    socket.emit('roomCreated', { code: room.code });
    emitLobby(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room || room.status !== 'waiting') {
      socket.emit('errorMsg', 'Комната не найдена или игра уже началась.');
      return;
    }
    if (room.players.length >= room.numPlayers) {
      socket.emit('errorMsg', 'Комната заполнена.');
      return;
    }
    room.players.push(makePlayer(socket.id, name || 'Игрок', false));
    socket.data.roomCode = room.code;
    socket.join(room.code);
    emitLobby(room);
    if (room.players.length === room.numPlayers) {
      startGame(room);
    }
  });

  socket.on('startRoomNow', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.status !== 'waiting') return;
    if (room.players[0].socketId !== socket.id) return; // только хост
    startGame(room);
  });

  socket.on('playCard', ({ cardId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.status !== 'playing') return;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1 || !room.awaiting) return;
    const player = room.players[idx];

    if (room.awaiting.type === 'attack' && room.awaiting.playerIdx === idx) {
      const card = player.hand.find(c => c.id === cardId);
      if (!card) return;
      player.hand = player.hand.filter(c => c.id !== cardId);
      room.table.push({ attack: card, defense: null });
      room.throwQueue = buildThrowQueue(room);
      room.throwPtr = 0;
      room.passed = new Set();
      pushLog(room, `${player.name} ходит картой ${card.rank}${card.suit}.`);
      loop(room);
      emitState(room);
    } else if (room.awaiting.type === 'throw' && room.awaiting.playerIdx === idx) {
      const valid = getValidThrowCards(room, idx);
      const card = valid.find(c => c.id === cardId);
      if (!card) return;
      if (room.table.length >= maxAttackCards(room)) return;
      player.hand = player.hand.filter(c => c.id !== cardId);
      room.table.push({ attack: card, defense: null });
      room.passed = new Set();
      pushLog(room, `${player.name} подкидывает ${card.rank}${card.suit}.`);
      loop(room);
      emitState(room);
    }
  });

  socket.on('defendCard', ({ cardId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.status !== 'playing' || !room.awaiting) return;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (room.awaiting.type !== 'defend' || room.awaiting.playerIdx !== idx) return;
    const player = room.players[idx];
    const pending = room.table[room.table.length - 1];
    const card = player.hand.find(c => c.id === cardId);
    if (!card || !pending || pending.defense) return;
    if (!canBeat(pending.attack, card, room.trumpSuit)) return;
    player.hand = player.hand.filter(c => c.id !== cardId);
    pending.defense = card;
    room.passed = new Set();
    pushLog(room, `${player.name} отбивается картой ${card.rank}${card.suit}.`);
    loop(room);
    emitState(room);
  });

  socket.on('takeCards', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.status !== 'playing' || !room.awaiting) return;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (room.awaiting.type !== 'defend' || room.awaiting.playerIdx !== idx) return;
    takeCards(room);
    if (room.status === 'playing') loop(room);
    emitState(room);
  });

  socket.on('pass', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.status !== 'playing' || !room.awaiting) return;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (room.awaiting.type !== 'throw' || room.awaiting.playerIdx !== idx) return;
    room.passed.add(idx);
    pushLog(room, `${room.players[idx].name} пасует.`);
    loop(room);
    emitState(room);
  });

  socket.on('bito', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.status !== 'playing' || !room.awaiting) return;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (room.awaiting.type !== 'bito' || room.awaiting.playerIdx !== idx) return;
    endRoundBito(room);
    if (room.status === 'playing') loop(room);
    emitState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    const p = room.players.find(pl => pl.socketId === socket.id);
    if (p) p.connected = false;
    emitState(room);
  });
});

function emitLobby(room) {
  room.players.forEach(p => {
    if (p.isBot || !p.socketId) return;
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) return;
    sock.emit('lobby', {
      code: room.code,
      numPlayers: room.numPlayers,
      players: room.players.map(pl => pl.name),
      isHost: room.players[0].socketId === p.socketId,
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Дурак-сервер запущен: http://localhost:${PORT}`);
});
