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

const sleep = ms => new Promise(r => setTimeout(r, ms));
const id = () => Math.random().toString(36).slice(2, 9);

function makeDeck() {
  return SUITS.flatMap(s => RANKS.map(r => ({ id: id(), suit: s, rank: r })));
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function value(card) { return RANKS.indexOf(card.rank); }
function beats(a, d, trump) {
  if (a.suit === d.suit) return value(a) > value(d);
  return a.suit === trump && d.suit !== trump;
}
function canAttack(card, table) {
  if (!table.length) return true;
  const ranks = new Set(table.flatMap(p => [p.attack?.rank, p.defense?.rank]).filter(Boolean));
  return ranks.has(card.rank);
}
function roomState(room, viewerId) {
  return {
    id: room.id,
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
function getPlayer(room, pid) { return room.players.find(p => p.id === pid); }
function nextIndex(room, index) { return (index + 1) % room.players.length; }
function nextPlayer(room, pid) {
  const i = room.players.findIndex(p => p.id === pid);
  return room.players[nextIndex(room, i)];
}
function livingPlayers(room) {
  return room.players.filter(p => p.hand.length || !room.deck.length);
}

function startGame(room) {
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
  for (let i = 0; i < 6; i++) {
    for (const p of room.players) {
      if (room.deck.length) p.hand.push(room.deck.pop());
    }
  }

  // Player with the lowest trump starts.
  let starter = null;
  for (const p of room.players) {
    const trumps = p.hand.filter(c => c.suit === room.trump);
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

function drawToSix(room) {
  // Drawing order starts from the attacker, then clockwise.
  let idx = room.players.findIndex(p => p.id === room.attacker);
  for (let round = 0; round < 6; round++) {
    for (let n = 0; n < room.players.length; n++) {
      const p = room.players[(idx + n) % room.players.length];
      if (p.hand.length < 6 && room.deck.length) p.hand.push(room.deck.pop());
    }
  }
}

function beginNextRound(room) {
  drawToSix(room);
  const defender = getPlayer(room, room.defender);
  room.attacker = defender.id;
  room.defender = nextPlayer(room, defender.id).id;
  room.turn = room.attacker;
  room.phase = "attack";
  room.table = [];
  for (const p of room.players) p.status = "";
  broadcast(room);
  executeBotTurnChain(room);
}

function finishRound(room, tookCards) {
  if (tookCards) {
    const defender = getPlayer(room, room.defender);
    const cards = [];
    for (const pair of room.table) {
      if (pair.attack) cards.push(pair.attack);
      if (pair.defense) cards.push(pair.defense);
    }
    defender.hand.push(...cards);
    room.table = [];
    room.phase = "attack";
    room.turn = nextPlayer(room, defender.id).id;
    room.attacker = room.turn;
    room.defender = nextPlayer(room, room.attacker).id;
    for (const p of room.players) p.status = "";
    drawToSix(room);
    broadcast(room);
    executeBotTurnChain(room);
    return;
  }

  for (const pair of room.table) {
    if (pair.attack) room.discard.push(pair.attack);
    if (pair.defense) room.discard.push(pair.defense);
  }
  room.table = [];
  for (const p of room.players) p.status = "";
  drawToSix(room);
  const oldDefender = getPlayer(room, room.defender);
  room.attacker = oldDefender.id;
  room.defender = nextPlayer(room, oldDefender.id).id;
  room.turn = room.attacker;
  room.phase = "attack";
  broadcast(room);
  executeBotTurnChain(room);
}

function legalDefense(room, player, card) {
  const open = room.table.find(x => !x.defense);
  if (!open || player.id !== room.defender) return false;
  return beats(card, open.attack, room.trump);
}

function legalAttack(room, player, card) {
  return player.id === room.turn && room.phase === "attack" && canAttack(card, room.table);
}

async function executeBotTurnChain(room) {
  if (room.finished) return;
  await sleep(120);

  const current = getPlayer(room, room.turn);
  if (!current) return;

  if (room.phase === "defense") {
    const defender = getPlayer(room, room.defender);
    if (!defender) return;

    if (defender.bot) {
      defender.status = "Кроюсь...";
      broadcast(room);
      await sleep(800);

      const open = room.table.find(x => !x.defense);
      if (!open) {
        room.phase = "throw";
        room.turn = nextPlayer(room, room.attacker).id;
        broadcast(room);
        return executeBotTurnChain(room);
      }

      const card = defender.hand.find(c => beats(c, open.attack, room.trump));
      if (card) {
        defender.hand = defender.hand.filter(c => c.id !== card.id);
        open.defense = card;
        defender.status = "Кроюсь";
        room.phase = "throw";
        room.turn = nextPlayer(room, room.attacker).id;
        broadcast(room);
        return executeBotTurnChain(room);
      }

      defender.status = "Беру";
      broadcast(room);
      await sleep(500);
      return finishRound(room, true);
    }

    // Human defender: stop here.
    defender.status = "Кроюсь";
    broadcast(room);
    return;
  }

  if (room.phase === "attack") {
    const attacker = getPlayer(room, room.attacker);
    if (!attacker) return;

    if (attacker.bot) {
      attacker.status = "Ходит...";
      broadcast(room);
      await sleep(800);

      const card = attacker.hand.find(c => canAttack(c, room.table));
      if (!card) {
        // Empty attack is only possible after a completed table.
        return;
      }
      attacker.hand = attacker.hand.filter(c => c.id !== card.id);
      room.table.push({ attack: card, defense: null });
      room.phase = "defense";
      room.turn = room.defender;
      attacker.status = "";
      broadcast(room);
      return executeBotTurnChain(room);
    }

    broadcast(room);
    return;
  }

  if (room.phase === "throw") {
    // If every pair is covered, the next thrower gets a real choice.
    const open = room.table.find(x => !x.defense);
    if (open) {
      room.phase = "defense";
      room.turn = room.defender;
      broadcast(room);
      return executeBotTurnChain(room);
    }

    const p = getPlayer(room, room.turn);
    if (!p) return;

    // Strict clockwise order. A human immediately pauses the chain.
    if (!p.bot) {
      p.status = "Подкидывает...";
      broadcast(room);
      return;
    }

    p.status = "Подкидывает...";
    broadcast(room);
    await sleep(800);

    const card = p.hand.find(c => canAttack(c, room.table));
    if (card && room.table.length < 6) {
      p.hand = p.hand.filter(c => c.id !== card.id);
      room.table.push({ attack: card, defense: null });
      room.phase = "defense";
      room.turn = room.defender;
      p.status = "";
      broadcast(room);
      return executeBotTurnChain(room);
    }

    // Bot has nothing to throw: automatically pass.
    p.status = "";
    const next = nextPlayer(room, p.id);
    if (next.id === room.attacker) {
      if (getPlayer(room, room.attacker).bot) {
        finishRound(room, false);
      } else {
        room.phase = "end";
        room.turn = room.attacker;
        const a = getPlayer(room, room.attacker);
        a.status = "Нажмите БИТО";
        broadcast(room);
      }
      return;
    }
    room.turn = next.id;
    broadcast(room);
    return executeBotTurnChain(room);
  }
}

function createRoom(code, count, botMode) {
  const room = {
    id: code,
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
    botMode
  };

  if (botMode) {
    for (let i = 0; i < count; i++) {
      room.players.push({
        id: id(),
        name: i === 0 ? "Вы" : `Бот ${i}`,
        bot: i !== 0,
        connected: i === 0,
        socketId: null,
        hand: [],
        status: ""
      });
    }
  }
  rooms.set(code, room);
  return room;
}

function uniqueCode() {
  let code;
  do code = Math.random().toString(36).slice(2, 7).toUpperCase();
  while (rooms.has(code));
  return code;
}

io.on("connection", socket => {
  socket.on("createBotGame", ({ count = 4, name = "Игрок" } = {}, cb) => {
    count = Math.min(4, Math.max(2, Number(count)));
    const room = createRoom(uniqueCode(), count, true);
    const me = room.players[0];
    me.name = String(name).slice(0, 20) || "Игрок";
    me.socketId = socket.id;
    me.connected = true;
    socket.join(room.id);
    startGame(room);
    cb?.({ ok: true, room: room.id, playerId: me.id });
  });

  socket.on("createRoom", ({ name = "Игрок" } = {}, cb) => {
    const room = createRoom(uniqueCode(), 4, false);
    const p = {
      id: id(), name: String(name).slice(0, 20) || "Игрок",
      bot: false, connected: true, socketId: socket.id, hand: [], status: ""
    };
    room.players.push(p);
    socket.join(room.id);
    cb?.({ ok: true, room: room.id, playerId: p.id });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name = "Игрок" } = {}, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "Комната не найдена" });
    if (room.phase !== "lobby") return cb?.({ ok: false, error: "Игра уже началась" });
    if (room.players.length >= 4) return cb?.({ ok: false, error: "Комната заполнена" });

    const p = {
      id: id(), name: String(name).slice(0, 20) || "Игрок",
      bot: false, connected: true, socketId: socket.id, hand: [], status: ""
    };
    room.players.push(p);
    socket.join(room.id);
    cb?.({ ok: true, room: room.id, playerId: p.id });
    broadcast(room);

    if (room.players.length >= 2) {
      startGame(room);
    }
  });

  socket.on("playCard", ({ room: code, playerId, cardId } = {}) => {
    const room = rooms.get(code);
    if (!room) return;
    const p = getPlayer(room, playerId);
    if (!p || p.socketId !== socket.id) return;

    const card = p.hand.find(c => c.id === cardId);
    if (!card) return;

    if (room.phase === "attack" && playerId === room.turn && playerId === room.attacker && canAttack(card, room.table)) {
      p.hand = p.hand.filter(c => c.id !== cardId);
      room.table.push({ attack: card, defense: null });
      room.phase = "defense";
      room.turn = room.defender;
      p.status = "";
      broadcast(room);
      return executeBotTurnChain(room);
    }

    if (room.phase === "defense" && playerId === room.defender && legalDefense(room, p, card)) {
      const open = room.table.find(x => !x.defense);
      p.hand = p.hand.filter(c => c.id !== cardId);
      open.defense = card;
      room.phase = "throw";
      room.turn = nextPlayer(room, room.attacker).id;
      p.status = "";
      broadcast(room);
      return executeBotTurnChain(room);
    }
  });

  socket.on("pass", ({ room: code, playerId } = {}) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "throw" || room.turn !== playerId) return;
    const p = getPlayer(room, playerId);
    if (!p || p.bot) return;

    p.status = "Пас";
    const next = nextPlayer(room, p.id);

    if (next.id === room.attacker) {
      if (getPlayer(room, room.attacker).bot) {
        return finishRound(room, false);
      }
      room.phase = "end";
      room.turn = room.attacker;
      getPlayer(room, room.attacker).status = "Нажмите БИТО";
      broadcast(room);
      return;
    }

    room.turn = next.id;
    broadcast(room);
    executeBotTurnChain(room);
  });

  socket.on("take", ({ room: code, playerId } = {}) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "defense" || room.defender !== playerId) return;
    const p = getPlayer(room, playerId);
    if (!p || p.bot) return;
    finishRound(room, true);
  });

  socket.on("bito", ({ room: code, playerId } = {}) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "end" || room.attacker !== playerId) return;
    finishRound(room, false);
  });

  socket.on("startRoom", ({ room: code } = {}, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "lobby" || room.players.length < 2) {
      return cb?.({ ok: false, error: "Нужно минимум 2 игрока" });
    }
    startGame(room);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = room.players.find(x => x.socketId === socket.id);
      if (p) {
        p.connected = false;
        p.socketId = null;
        p.status = "Отключен";
        broadcast(room);
      }
    }
  });
});

app.get("/health", (_, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, () => {
  console.log(`Durak server: http://localhost:${PORT}`);
});
