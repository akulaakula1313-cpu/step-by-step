const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const rooms = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = () => Math.random().toString(36).slice(2, 9);

function makeDeck() {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ id: id(), suit, rank })));
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function value(card) {
  return RANKS.indexOf(card.rank);
}

function beats(attack, defense, trump) {
  if (attack.suit === defense.suit) return value(attack) > value(defense);
  return defense.suit === trump && attack.suit !== trump;
}

function canAttack(card, table) {
  if (!table.length) return true;
  const ranks = new Set(
    table.flatMap(pair => [pair.attack?.rank, pair.defense?.rank]).filter(Boolean)
  );
  return ranks.has(card.rank);
}

function roomState(room, viewerId) {
  return {
    id: room.id,
    ownerId: room.ownerId,
    botMode: room.botMode,
    trump: room.trump,
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    phase: room.phase,
    attacker: room.attacker,
    defender: room.defender,
    turn: room.turn,
    table: room.table,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      bot: p.bot,
      connected: p.connected,
      cards: p.id === viewerId ? p.hand : [],
      cardCount: p.hand.length,
      status: p.status || ""
    }))
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit("state", roomState(room, p.id));
  }
}

function getPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function nextPlayer(room, playerId) {
  const index = room.players.findIndex(p => p.id === playerId);
  if (index < 0 || !room.players.length) return null;
  return room.players[(index + 1) % room.players.length];
}

// Clockwise next player who is allowed to throw.
// The defender never throws into their own defense.
function nextThrower(room, playerId) {
  if (!room.players.length) return null;
  let index = room.players.findIndex(p => p.id === playerId);
  if (index < 0) return null;

  for (let step = 1; step <= room.players.length; step++) {
    const candidate = room.players[(index + step) % room.players.length];
    if (candidate.id !== room.defender) return candidate;
  }
  return null;
}

function firstThrower(room) {
  // The initial attacker gets the first chance to add a card.
  if (getPlayer(room, room.attacker)?.id !== room.defender) {
    return getPlayer(room, room.attacker);
  }
  return nextThrower(room, room.attacker);
}

function drawToSix(room, startPlayerId) {
  const startIndex = room.players.findIndex(p => p.id === startPlayerId);
  if (startIndex < 0) return;

  for (let round = 0; round < 6; round++) {
    for (let n = 0; n < room.players.length; n++) {
      const p = room.players[(startIndex + n) % room.players.length];
      if (p.hand.length < 6 && room.deck.length) {
        p.hand.push(room.deck.pop());
      }
    }
  }
}

function resetStatuses(room) {
  for (const p of room.players) p.status = "";
}

function startGame(room) {
  if (room.players.length < 2 || room.players.length > 4) return;

  room.deck = shuffle(makeDeck());
  room.discard = [];
  room.table = [];
  room.phase = "attack";
  room.finished = false;

  for (const p of room.players) {
    p.hand = [];
    p.status = "";
  }

  room.trump = room.deck[room.deck.length - 1].suit;

  // Six cards each, round-robin.
  for (let i = 0; i < 6; i++) {
    for (const p of room.players) {
      if (room.deck.length) p.hand.push(room.deck.pop());
    }
  }

  // Lowest trump starts. If nobody has trump, first player starts.
  let starter = null;
  for (const p of room.players) {
    const trumps = p.hand.filter(card => card.suit === room.trump);
    if (trumps.length) {
      const low = Math.min(...trumps.map(value));
      if (!starter || low < starter.low) starter = { p, low };
    }
  }

  room.attacker = starter ? starter.p.id : room.players[0].id;
  room.defender = nextPlayer(room, room.attacker).id;
  room.turn = room.attacker;

  broadcast(room);
  executeBotTurnChain(room);
}

function startNextRound(room, oldAttackerId, newAttackerId) {
  resetStatuses(room);
  drawToSix(room, oldAttackerId);

  room.attacker = newAttackerId;
  room.defender = nextPlayer(room, newAttackerId).id;
  room.turn = room.attacker;
  room.phase = "attack";
  room.table = [];

  broadcast(room);
  executeBotTurnChain(room);
}

function finishRound(room, tookCards) {
  const oldAttackerId = room.attacker;
  const oldDefenderId = room.defender;
  const oldDefender = getPlayer(room, oldDefenderId);
  if (!oldDefender) return;

  if (tookCards) {
    const cards = [];
    for (const pair of room.table) {
      if (pair.attack) cards.push(pair.attack);
      if (pair.defense) cards.push(pair.defense);
    }

    oldDefender.hand.push(...cards);
    room.table = [];

    // The player who took the cards becomes the new attacker.
    startNextRound(room, oldAttackerId, oldDefenderId);
    return;
  }

  for (const pair of room.table) {
    if (pair.attack) room.discard.push(pair.attack);
    if (pair.defense) room.discard.push(pair.defense);
  }
  room.table = [];

  // After successful defense, the old defender becomes attacker.
  startNextRound(room, oldAttackerId, oldDefenderId);
}

function enterThrowPhase(room) {
  const open = room.table.find(pair => !pair.defense);
  if (open) {
    room.phase = "defense";
    room.turn = room.defender;
  } else {
    room.phase = "throw";
    room.turn = firstThrower(room).id;
  }
}

function playAttack(room, player, card) {
  player.hand = player.hand.filter(c => c.id !== card.id);
  room.table.push({ attack: card, defense: null });
  room.phase = "defense";
  room.turn = room.defender;
  player.status = "";
  broadcast(room);
  executeBotTurnChain(room);
}

function playDefense(room, player, card) {
  const open = room.table.find(pair => !pair.defense);
  if (!open || player.id !== room.defender) return false;
  if (!beats(open.attack, card, room.trump)) return false;

  player.hand = player.hand.filter(c => c.id !== card.id);
  open.defense = card;
  player.status = "Кроюсь";

  enterThrowPhase(room);
  broadcast(room);
  executeBotTurnChain(room);
  return true;
}

function playThrow(room, player, card) {
  if (room.phase !== "throw" || room.turn !== player.id) return false;
  if (player.id === room.defender) return false;
  if (room.table.length >= 6) return false;
  if (!canAttack(card, room.table)) return false;

  player.hand = player.hand.filter(c => c.id !== card.id);
  room.table.push({ attack: card, defense: null });
  player.status = "";

  room.phase = "defense";
  room.turn = room.defender;
  broadcast(room);
  executeBotTurnChain(room);
  return true;
}

function finishThrowTurn(room, player) {
  player.status = "Пас";

  const next = nextThrower(room, player.id);
  if (!next || next.id === room.attacker) {
    // Everyone allowed to throw had their turn.
    const attacker = getPlayer(room, room.attacker);
    if (attacker?.bot) {
      return finishRound(room, false);
    }

    room.phase = "end";
    room.turn = room.attacker;
    attacker.status = "Нажмите БИТО";
    broadcast(room);
    return;
  }

  room.turn = next.id;
  broadcast(room);
  executeBotTurnChain(room);
}

async function executeBotTurnChain(room) {
  if (room.finished) return;

  await sleep(120);

  const current = getPlayer(room, room.turn);
  if (!current) return;

  if (room.phase === "attack") {
    const attacker = getPlayer(room, room.attacker);
    if (!attacker) return;

    if (!attacker.bot) {
      attacker.status = "Ходите";
      broadcast(room);
      return;
    }

    attacker.status = "Ходит...";
    broadcast(room);
    await sleep(800);

    const card = attacker.hand.find(c => canAttack(c, room.table));
    if (!card) {
      attacker.status = "Нет карты для хода";
      broadcast(room);
      return;
    }

    playAttack(room, attacker, card);
    return;
  }

  if (room.phase === "defense") {
    const defender = getPlayer(room, room.defender);
    if (!defender) return;

    if (!defender.bot) {
      defender.status = "Кроюсь";
      broadcast(room);
      return;
    }

    defender.status = "Кроюсь...";
    broadcast(room);
    await sleep(800);

    const open = room.table.find(pair => !pair.defense);
    if (!open) {
      enterThrowPhase(room);
      broadcast(room);
      return executeBotTurnChain(room);
    }

    const card = defender.hand.find(c => beats(open.attack, c, room.trump));
    if (card) {
      playDefense(room, defender, card);
    } else {
      defender.status = "Беру";
      broadcast(room);
      await sleep(500);
      finishRound(room, true);
    }
    return;
  }

  if (room.phase === "throw") {
    // If a new attack was somehow left open, defender must act first.
    const open = room.table.find(pair => !pair.defense);
    if (open) {
      room.phase = "defense";
      room.turn = room.defender;
      broadcast(room);
      return executeBotTurnChain(room);
    }

    const p = getPlayer(room, room.turn);
    if (!p || p.id === room.defender) return;

    if (!p.bot) {
      p.status = "Подкидывает...";
      broadcast(room);
      return;
    }

    p.status = "Подкидывает...";
    broadcast(room);
    await sleep(800);

    const card = room.table.length < 6
      ? p.hand.find(c => canAttack(c, room.table))
      : null;

    if (card) {
      playThrow(room, p, card);
      return;
    }

    p.status = "";
    finishThrowTurn(room, p);
  }
}

function createRoom(code, botMode) {
  const room = {
    id: code,
    ownerId: null,
    players: [],
    deck: [],
    discard: [],
    table: [],
    trump: null,
    attacker: null,
    defender: null,
    turn: null,
    phase: "lobby",
    finished: false,
    botMode: Boolean(botMode)
  };

  rooms.set(code, room);
  return room;
}

function uniqueCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (rooms.has(code));
  return code;
}

io.on("connection", socket => {
  socket.on("createBotGame", ({ count = 4, name = "Игрок" } = {}, cb) => {
    count = Math.min(4, Math.max(2, Number(count)));
    const room = createRoom(uniqueCode(), true);

    for (let i = 0; i < count; i++) {
      room.players.push({
        id: id(),
        name: i === 0 ? String(name).slice(0, 20) || "Игрок" : `Бот ${i}`,
        bot: i !== 0,
        connected: i === 0,
        socketId: i === 0 ? socket.id : null,
        hand: [],
        status: ""
      });
    }

    room.ownerId = room.players[0].id;
    socket.join(room.id);
    startGame(room);

    cb?.({ ok: true, room: room.id, playerId: room.players[0].id });
  });

  socket.on("createRoom", ({ name = "Игрок" } = {}, cb) => {
    const room = createRoom(uniqueCode(), false);
    const player = {
      id: id(),
      name: String(name).slice(0, 20) || "Игрок",
      bot: false,
      connected: true,
      socketId: socket.id,
      hand: [],
      status: ""
    };

    room.ownerId = player.id;
    room.players.push(player);
    socket.join(room.id);

    cb?.({ ok: true, room: room.id, playerId: player.id });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name = "Игрок" } = {}, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());

    if (!room) return cb?.({ ok: false, error: "Комната не найдена" });
    if (room.phase !== "lobby") return cb?.({ ok: false, error: "Игра уже началась" });
    if (room.players.length >= 4) return cb?.({ ok: false, error: "Комната заполнена" });

    const player = {
      id: id(),
      name: String(name).slice(0, 20) || "Игрок",
      bot: false,
      connected: true,
      socketId: socket.id,
      hand: [],
      status: ""
    };

    room.players.push(player);
    socket.join(room.id);

    cb?.({ ok: true, room: room.id, playerId: player.id });
    broadcast(room);
  });

  socket.on("startRoom", ({ room: code, playerId } = {}, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());

    if (!room) return cb?.({ ok: false, error: "Комната не найдена" });
    if (room.phase !== "lobby") return cb?.({ ok: false, error: "Игра уже началась" });
    if (room.ownerId !== playerId) return cb?.({ ok: false, error: "Начать игру может создатель комнаты" });
    if (room.players.length < 2) return cb?.({ ok: false, error: "Нужно минимум 2 игрока" });

    startGame(room);
    cb?.({ ok: true });
  });

  socket.on("playCard", ({ room: code, playerId, cardId } = {}) => {
    const roomObj = rooms.get(String(code || "").toUpperCase());
    if (!roomObj) return;

    const player = getPlayer(roomObj, playerId);
    if (!player || player.socketId !== socket.id) return;

    const card = player.hand.find(c => c.id === cardId);
    if (!card) return;

    if (
      roomObj.phase === "attack" &&
      playerId === roomObj.turn &&
      playerId === roomObj.attacker &&
      canAttack(card, roomObj.table)
    ) {
      playAttack(roomObj, player, card);
      return;
    }

    if (roomObj.phase === "defense") {
      playDefense(roomObj, player, card);
      return;
    }

    if (roomObj.phase === "throw") {
      playThrow(roomObj, player, card);
    }
  });

  socket.on("pass", ({ room: code, playerId } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "throw" || room.turn !== playerId) return;

    const player = getPlayer(room, playerId);
    if (!player || player.bot || player.id === room.defender) return;

    finishThrowTurn(room, player);
  });

  socket.on("take", ({ room: code, playerId } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "defense" || room.defender !== playerId) return;

    const player = getPlayer(room, playerId);
    if (!player || player.bot) return;

    finishRound(room, true);
  });

  socket.on("bito", ({ room: code, playerId } = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.phase !== "end" || room.attacker !== playerId) return;

    const player = getPlayer(room, playerId);
    if (!player || player.bot) return;

    finishRound(room, false);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.find(p => p.socketId === socket.id);
      if (!player) continue;

      player.connected = false;
      player.socketId = null;
      player.status = "Отключен";
      broadcast(room);
    }
  });
});

app.get("/health", (_, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => {
  console.log(`Durak server: http://localhost:${PORT}`);
});
