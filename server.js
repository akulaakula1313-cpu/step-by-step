/**
 * SANI GROUP — ДУРАК PREMIUM
 * Серверная логика (Express + Socket.IO)
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const RANKS = [
  { rank: 6, value: 6 }, { rank: 7, value: 7 }, { rank: 8, value: 8 },
  { rank: 9, value: 9 }, { rank: 10, value: 10 }, { rank: 'J', value: 11 },
  { rank: 'Q', value: 12 }, { rank: 'K', value: 13 }, { rank: 'A', value: 14 }
];
const SUITS = ['♠', '♥', '♦', '♣'];

let io = null;
const rooms = {};

function setIO(instance) { io = instance; }
function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

function createDeck() {
  const deck = [];
  let id = 0;
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: id++, suit: s, rank: r.rank, value: r.value });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sortHand(hand, trumpSuit, mode = 'trump-right') {
  hand.sort((a, b) => {
    const aT = a.suit === trumpSuit ? 1 : 0;
    const bT = b.suit === trumpSuit ? 1 : 0;
    if (mode === 'trump-left') {
      if (aT !== bT) return bT - aT;
    } else {
      if (aT !== bT) return aT - bT;
    }
    if (a.suit !== b.suit) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    return a.value - b.value;
  });
}

function canBeat(att, def, trumpSuit) {
  const aT = att.suit === trumpSuit;
  const dT = def.suit === trumpSuit;
  if (aT && !dT) return false;
  if (aT && dT) return def.value > att.value;
  if (!dT) return att.suit === def.suit && def.value > att.value;
  return true;
}

function getTableRanks(table) {
  const r = new Set();
  for (const p of table) {
    r.add(p.attack.rank);
    if (p.defense) r.add(p.defense.rank);
  }
  return r;
}

function countDefendedPairs(table) {
  return table.filter(p => p.defense !== null).length;
}

// Возвращает следующий индекс игрока, у которого есть карты.
// Пока колода не пуста, после каждого завершённого боя все руки
// по возможности доводятся до 6, поэтому пропуск нужен прежде всего
// в эндшпиле после исчерпания колоды.
function nextActiveIndex(state, startIdx) {
  const n = state.playersInfo.length;
  for (let step = 1; step <= n; step++) {
    const idx = (startIdx + step) % n;
    const id = state.playersInfo[idx].id;
    if ((state.hands[id] || []).length > 0) return idx;
  }
  return -1;
}

function initGameState(room) {
  const deck = shuffleDeck(createDeck());
  const trumpCard = deck[deck.length - 1];
  const trumpSuit = trumpCard.suit;
  const hands = {};

  for (const p of room.players) {
    hands[p.id] = deck.splice(0, 6);
    sortHand(hands[p.id], trumpSuit);
  }

  let firstIdx = 0;
  let minV = Infinity;
  let foundTrump = false;
  room.players.forEach((p, idx) => {
    const trumps = hands[p.id].filter(c => c.suit === trumpSuit);
    for (const c of trumps) {
      if (c.value < minV) { minV = c.value; firstIdx = idx; foundTrump = true; }
    }
  });
  if (!foundTrump) {
    firstIdx = Math.floor(Math.random() * room.players.length);
  }

  const n = room.players.length;
  const defIdx = (firstIdx + 1) % n;

  room.state = {
    roomCode: room.id,
    deck, trumpCard, trumpSuit, hands,
    table: [],
    discard: [],
    attackerIdx: firstIdx,
    defenderIdx: defIdx,
    // Лимит подкидываний фиксируется в начале каждого боя.
    // Нельзя пересчитывать его по текущей руке защитника: во время боя
    // защитник может потратить карты на отбивку.
    attackLimit: Math.min(6, (hands[room.players[defIdx].id] || []).length),
    currentThrowerIdx: firstIdx,
    playersInfo: room.players.map(p => ({
      id: p.id, name: p.name, isBot: !!p.isBot,
      botDifficulty: p.botDifficulty || 'normal'
    })),
    isGameOver: false,
    winners: [],
    loser: null,
    turnStartedAt: Date.now(),
    moveLog: [],
    pendingTake: false,
    pendingTakePassed: []
  };
  room.rematchVotes.clear();
}

function logMove(state, text) {
  state.moveLog.push({ t: Date.now(), text });
  if (state.moveLog.length > 60) state.moveLog.shift();
}

function handlePlayCard(room, pId, cardId) {
  const state = room.state;
  const hand = state.hands[pId];
  if (!hand) { getIO().to(pId).emit('error_msg', 'Нет карт на руке'); return false; }
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) { getIO().to(pId).emit('error_msg', 'Карта не найдена'); return false; }

  const card = hand[idx];
  const defId = state.playersInfo[state.defenderIdx].id;
  const attId = state.playersInfo[state.attackerIdx].id;
  const pIdx = state.playersInfo.findIndex(p => p.id === pId);
  const pName = state.playersInfo[pIdx].name;

  if (state.pendingTake) {
    if (pId === defId) {
      getIO().to(pId).emit('error_msg', 'Вы уже взяли — ждём подкидывания');
      return false;
    }
    if (pIdx !== state.currentThrowerIdx) {
      getIO().to(pId).emit('error_msg', 'Сейчас не ваша очередь');
      return false;
    }
    const ranks = getTableRanks(state.table);
    if (!ranks.has(card.rank)) {
      getIO().to(pId).emit('error_msg', 'Такого достоинства нет на столе');
      return false;
    }
    if (state.table.length >= state.attackLimit) {
      getIO().to(pId).emit('error_msg', 'Больше подкидывать нельзя');
      return false;
    }
    hand.splice(idx, 1);
    state.table.push({ attack: card, defense: null, attackerId: pId });
    logMove(state, `${pName}: подкинул ${card.rank}${card.suit}`);
    state.turnStartedAt = Date.now();
    return true;
  }

  if (pId === defId) {
    if (state.table.length === 0) {
      getIO().to(pId).emit('error_msg', 'Стол пуст'); return false;
    }
    const unIdx = state.table.findIndex(p => p.defense === null);
    if (unIdx === -1) {
      getIO().to(pId).emit('error_msg', 'Всё уже отбито'); return false;
    }
    const attCard = state.table[unIdx].attack;
    if (!canBeat(attCard, card, state.trumpSuit)) {
      getIO().to(pId).emit('error_msg', 'Карта не бьёт атаку'); return false;
    }
    hand.splice(idx, 1);
    state.table[unIdx].defense = card;
    logMove(state, `${pName}: отбил ${attCard.rank}${attCard.suit} → ${card.rank}${card.suit}`);
    state.turnStartedAt = Date.now();
    return true;
  }

  if (state.table.length === 0) {
    if (pId !== attId) {
      getIO().to(pId).emit('error_msg', 'Сейчас ход другого игрока'); return false;
    }
  } else {
    if (pIdx !== state.currentThrowerIdx) {
      getIO().to(pId).emit('error_msg', 'Сейчас не ваша очередь подкидывать'); return false;
    }
    const ranks = getTableRanks(state.table);
    if (!ranks.has(card.rank)) {
      getIO().to(pId).emit('error_msg', 'Такого достоинства нет на столе'); return false;
    }
    const maxPairs = state.attackLimit;
    if (state.table.length >= maxPairs) {
      getIO().to(pId).emit('error_msg', 'Больше подкидывать нельзя'); return false;
    }
  }
  hand.splice(idx, 1);
  state.table.push({ attack: card, defense: null, attackerId: pId });
  state.currentThrowerIdx = pIdx;
  logMove(state, `${pName}: ${card.rank}${card.suit}`);
  state.turnStartedAt = Date.now();
  return true;
}

function handlePass(room, pId) {
  const state = room.state;
  const pIdx = state.playersInfo.findIndex(p => p.id === pId);
  if (pIdx === -1) return false;

  if (state.pendingTake) {
    if (pIdx !== state.currentThrowerIdx) {
      getIO().to(pId).emit('error_msg', 'Сейчас не ваша очередь');
      return false;
    }
    if (!state.pendingTakePassed.includes(pId)) state.pendingTakePassed.push(pId);

    const defId = state.playersInfo[state.defenderIdx].id;
    const n = state.playersInfo.length;
    const ranks = getTableRanks(state.table);
    const canAdd = state.table.length < state.attackLimit;

    for (let i = 1; i < n; i++) {
      const idx = (pIdx + i) % n;
      const p = state.playersInfo[idx];
      if (p.id === defId) continue;
      if (state.pendingTakePassed.includes(p.id)) continue;
      if (canAdd && (state.hands[p.id] || []).some(c => ranks.has(c.rank))) {
        state.currentThrowerIdx = idx;
        state.turnStartedAt = Date.now();
        return true;
      }
    }
    return finalizeTake(room);
  }

  if (pIdx !== state.currentThrowerIdx) return false;
  if (state.table.length === 0) {
    getIO().to(pId).emit('error_msg', 'На столе пусто'); return false;
  }
  if (!state.table.every(p => p.defense !== null)) {
    getIO().to(pId).emit('error_msg', 'Сначала нужно отбить все карты'); return false;
  }
  // Если достигнут лимит атаки, новые подкидки невозможны: сразу
  // завершаем бой. Иначе право подкидывать может ошибочно переходить
  // между игроками даже при заполненном лимите.
  if (state.table.length >= state.attackLimit) {
    return handleDone(room, pId);
  }
  // Когда все карты отбиты, передаём право подкидывать только игроку,
  // у которого действительно есть подходящая карта. Если таких игроков
  // больше нет — автоматически завершаем атаку. Это не даёт PASS зациклить
  // розыгрыш между игроками.
  const ranks = getTableRanks(state.table);
  const n = state.playersInfo.length;
  for (let step = 1; step < n; step++) {
    const next = (state.currentThrowerIdx + step) % n;
    if (next === state.defenderIdx) continue;
    const nextId = state.playersInfo[next].id;
    if (
      (state.hands[nextId] || []).length > 0 &&
      (state.hands[nextId] || []).some(c => ranks.has(c.rank))
    ) {
      state.currentThrowerIdx = next;
      state.turnStartedAt = Date.now();
      return true;
    }
  }

  // Никто больше не может подкинуть — атака завершена.
  return handleDone(room, pId);
}

function handleTake(room, pId) {
  const state = room.state;
  if (state.pendingTake) return false;
  const defId = state.playersInfo[state.defenderIdx].id;
  if (pId !== defId) {
    getIO().to(pId).emit('error_msg', 'Брать может только защищающийся'); return false;
  }
  if (state.table.length === 0) {
    getIO().to(pId).emit('error_msg', 'На столе нет карт'); return false;
  }

  const n = state.playersInfo.length;
  const ranks = getTableRanks(state.table);
  const canAddMore = state.table.length < state.attackLimit;

  let hasThrower = false;
  if (canAddMore) {
    for (const p of state.playersInfo) {
      if (p.id === defId) continue;
      if ((state.hands[p.id] || []).some(c => ranks.has(c.rank))) {
        hasThrower = true; break;
      }
    }
  }

  if (!hasThrower) return finalizeTake(room);

  state.pendingTake = true;
  state.pendingTakePassed = [];
  for (let i = 1; i < n; i++) {
    const idx = (state.defenderIdx + i) % n;
    const p = state.playersInfo[idx];
    if (p.id === defId) continue;
    if ((state.hands[p.id] || []).some(c => ranks.has(c.rank))) {
      state.currentThrowerIdx = idx;
      break;
    }
  }
  const defName = state.playersInfo[state.defenderIdx].name;
  logMove(state, `${defName}: БЕРУ (ждём подкидывания)`);
  state.turnStartedAt = Date.now();
  return true;
}

function finalizeTake(room) {
  const state = room.state;
  const defId = state.playersInfo[state.defenderIdx].id;
  const takenCount = state.table.reduce((s, p) => s + (p.defense ? 2 : 1), 0);
  for (const p of state.table) {
    state.hands[defId].push(p.attack);
    if (p.defense) state.hands[defId].push(p.defense);
  }
  state.table = [];
  state.pendingTake = false;
  state.pendingTakePassed = [];
  sortHand(state.hands[defId], state.trumpSuit);
  const defName = state.playersInfo[state.defenderIdx].name;
  logMove(state, `${defName}: ЗАБРАЛ ${takenCount} карт`);
  const oldDef = state.defenderIdx;

  // По правилам подкидного дурака после того, как защитник забрал карты,
  // он НЕ начинает следующую атаку. Следующим атакует игрок после него.
  // В игре 1×1 это означает, что атакующий остаётся атакующим.
  refillAllHands(state);

  let nextAttacker = nextActiveIndex(state, oldDef);
  if (nextAttacker === -1) {
    // Теоретически все карты оказались у защитника — бой завершён.
    checkGameOver(room);
    return true;
  }
  state.attackerIdx = nextAttacker;
  state.defenderIdx = nextActiveIndex(state, nextAttacker);
  state.attackLimit = state.defenderIdx === -1 ? 0 : Math.min(6, (state.hands[state.playersInfo[state.defenderIdx].id] || []).length);
  if (state.defenderIdx === -1) {
    checkGameOver(room);
    return true;
  }
  state.currentThrowerIdx = state.attackerIdx;
  if (checkGameOver(room)) return true;
  state.turnStartedAt = Date.now();
  return true;
}

function handleDone(room, pId) {
  const state = room.state;
  const pIdx = state.playersInfo.findIndex(p => p.id === pId);
  const defId = state.playersInfo[state.defenderIdx].id;
  if (pIdx === -1 || pIdx !== state.currentThrowerIdx) {
    getIO().to(pId).emit('error_msg', 'Сейчас не ваш ход'); return false;
  }
  if (pId === defId) {
    getIO().to(pId).emit('error_msg', 'Защищающийся не может сказать «Бито»'); return false;
  }
  if (state.table.length === 0 || !state.table.every(p => p.defense !== null)) {
    getIO().to(pId).emit('error_msg', 'Не все карты отбиты'); return false;
  }
  // Все карты завершённого боя уходят в сброс и больше не участвуют
  // в раздаче.
  for (const pair of state.table) {
    state.discard.push(pair.attack);
    if (pair.defense) state.discard.push(pair.defense);
  }
  state.table = [];
  const pName = state.playersInfo[pIdx].name;
  logMove(state, `${pName}: БИТО`);
  const oldDef = state.defenderIdx;
  refillAllHands(state);

  // При успешной защите защищавшийся становится новым атакующим.
  // В эндшпиле игроки без карт пропускаются.
  const defenderStillActive = (state.hands[state.playersInfo[oldDef].id] || []).length > 0;
  const nextAttacker = defenderStillActive ? oldDef : nextActiveIndex(state, oldDef);
  if (nextAttacker === -1) {
    checkGameOver(room);
    return true;
  }
  state.attackerIdx = nextAttacker;
  state.defenderIdx = nextActiveIndex(state, nextAttacker);
  state.attackLimit = state.defenderIdx === -1 ? 0 : Math.min(6, (state.hands[state.playersInfo[state.defenderIdx].id] || []).length);
  if (state.defenderIdx === -1) {
    checkGameOver(room);
    return true;
  }
  state.currentThrowerIdx = state.attackerIdx;
  if (checkGameOver(room)) return true;
  state.turnStartedAt = Date.now();
  return true;
}

function refillAllHands(state) {
  const n = state.playersInfo.length;
  for (let i = 0; i < n; i++) {
    const idx = (state.attackerIdx + i) % n;
    const pId = state.playersInfo[idx].id;
    if (!state.hands[pId]) state.hands[pId] = [];
    while (state.hands[pId].length < 6 && state.deck.length > 0) {
      state.hands[pId].push(state.deck.pop());
    }
    sortHand(state.hands[pId], state.trumpSuit);
  }
}

function checkGameOver(room) {
  const state = room.state;
  if (state.isGameOver) return true;

  // Партия может закончиться только в конце боя. Нельзя объявлять
  // победителя прямо после выкладывания/отбивания отдельной карты:
  // на столе ещё может продолжаться текущая атака.
  if (state.table.length !== 0) return false;
  if (state.deck.length > 0) return false;

  const withCards = state.playersInfo.filter(
    p => (state.hands[p.id] || []).length > 0
  );

  if (withCards.length === 0) {
    state.isGameOver = true;
    state.loser = null;
    state.winners = state.playersInfo.map(p => p.id);
    getIO().to(room.id).emit('game_over', {
      state, winners: state.winners, loser: null, draw: true
    });
    startRematchCountdown(room);
    return true;
  }

  if (withCards.length === 1) {
    state.isGameOver = true;
    state.loser = withCards[0].id;
    state.winners = state.playersInfo
      .filter(p => p.id !== state.loser)
      .map(p => p.id);
    getIO().to(room.id).emit('game_over', {
      state, winners: state.winners, loser: state.loser, draw: false
    });
    startRematchCountdown(room);
    return true;
  }

  return false;
}

function pickDefenseCard(hand, attCard, trumpSuit, difficulty) {
  const valid = hand.filter(c => canBeat(attCard, c, trumpSuit));
  if (valid.length === 0) return null;
  if (difficulty === 'easy') return valid[0];
  const attIsTrump = attCard.suit === trumpSuit;
  let best = null, bestScore = Infinity;
  for (const c of valid) {
    const isT = c.suit === trumpSuit;
    let score = isT ? 100 + c.value : c.value;
    if (difficulty === 'hard' && isT && !attIsTrump && c.value > 10) score += 50;
    if (score < bestScore) { bestScore = score; best = c; }
  }

  // Среди близких по цене карт иногда выбираем альтернативу, чтобы бот
  // не воспроизводил бесконечную одну и ту же последовательность.
  const near = valid.filter(c => {
    const isT = c.suit === trumpSuit;
    let score = isT ? 100 + c.value : c.value;
    if (difficulty === 'hard' && isT && !attIsTrump && c.value > 10) score += 50;
    return score <= bestScore + 2;
  });
  if (difficulty === 'hard' && near.length > 1) {
    return near[Math.floor(Math.random() * near.length)];
  }
  return best;
}

function pickAttackCard(hand, trumpSuit, deckSize, difficulty) {
  if (!hand.length) return null;
  const nonT = hand.filter(c => c.suit !== trumpSuit);
  const t = hand.filter(c => c.suit === trumpSuit);
  if (difficulty === 'easy') {
    const pool = nonT.length ? nonT : t;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (difficulty === 'hard') {
    const late = deckSize < 10;
    if (nonT.length) {
      nonT.sort((a, b) => late ? b.value - a.value : a.value - b.value);
      // Не зацикливаем бота на одной и той же минимальной карте.
      // Берём одну из нескольких лучших карт с небольшим случайным выбором.
      const pool = nonT.slice(0, Math.min(3, nonT.length));
      return pool[Math.floor(Math.random() * pool.length)];
    }
    t.sort((a, b) => a.value - b.value);
    const pool = t.slice(0, Math.min(3, t.length));
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }
  if (nonT.length) {
    nonT.sort((a, b) => a.value - b.value);
    return nonT[0];
  }
  t.sort((a, b) => a.value - b.value);
  return t[0] || null;
}

function pickThrowCard(matches, trumpSuit, difficulty) {
  if (!matches.length) return null;
  const sorted = [...matches].sort((a, b) => {
    const aT = a.suit === trumpSuit ? 1 : 0;
    const bT = b.suit === trumpSuit ? 1 : 0;
    if (aT !== bT) return aT - bT;
    return a.value - b.value;
  });
  if (difficulty === 'easy') return matches[0];
  if (difficulty === 'hard' && Math.random() < 0.2 && sorted.length > 1) {
    return sorted[sorted.length - 1];
  }
  return sorted[0];
}

function executeBotTurnChain(room) {
  if (!room || !room.state || room.state.isGameOver) return false;
  const state = room.state;
  const defP = state.playersInfo[state.defenderIdx];
  const n = state.playersInfo.length;
  const hasCards = id => (state.hands[id] || []).length > 0;

  // Защита от редкого стратегического зацикливания ботов при пустой колоде.
  // Это не меняет правила: принудительное действие всегда остаётся легальным.
  const botSignature = JSON.stringify({
    a: state.attackerIdx, d: state.defenderIdx, t: state.currentThrowerIdx,
    p: state.pendingTake,
    table: state.table.map(x => [x.attack.id, x.defense ? x.defense.id : null]),
    hands: state.playersInfo.map(p => [p.id, (state.hands[p.id] || []).map(c => c.id)]) ,
    deck: state.deck.map(c => c.id)
  });
  if (!room.botStateSeen) room.botStateSeen = new Map();
  const seen = (room.botStateSeen.get(botSignature) || 0) + 1;
  room.botStateSeen.set(botSignature, seen);
  if (room.botStateSeen.size > 250) {
    const first = room.botStateSeen.keys().next().value;
    room.botStateSeen.delete(first);
  }
  if (seen >= 4) {
    room.botStateSeen.clear();
    if (state.pendingTake) {
      const cur = state.playersInfo[state.currentThrowerIdx];
      if (cur && cur.isBot) return handlePass(room, cur.id);
    }
    const unIdx = state.table.findIndex(p => p.defense === null);
    if (unIdx !== -1 && defP.isBot) return handleTake(room, defP.id);
    if (unIdx === -1 && state.table.length > 0) {
      const cur = state.playersInfo[state.currentThrowerIdx];
      if (cur && cur.isBot) return handleDone(room, cur.id);
    }
    if (state.table.length === 0) {
      const att = state.playersInfo[state.attackerIdx];
      if (att && att.isBot && hasCards(att.id)) {
        const hand = state.hands[att.id];
        const card = hand[Math.floor(Math.random() * hand.length)];
        if (card) return handlePlayCard(room, att.id, card.id);
      }
    }
  }

  if (state.pendingTake) {
    const curP = state.playersInfo[state.currentThrowerIdx];
    if (!curP.isBot) return false;
    const ranks = getTableRanks(state.table);
    const matches = (state.hands[curP.id] || []).filter(c => ranks.has(c.rank));
    const canAdd = state.table.length < state.attackLimit;
    if (matches.length && canAdd) {
      const card = pickThrowCard(matches, state.trumpSuit, curP.botDifficulty);
      if (card) return handlePlayCard(room, curP.id, card.id);
    }
    return handlePass(room, curP.id);
  }

  const unIdx = state.table.findIndex(p => p.defense === null);

  if (unIdx !== -1) {
    if (!defP.isBot) return false;
    const attCard = state.table[unIdx].attack;
    const hand = state.hands[defP.id] || [];
    const card = pickDefenseCard(hand, attCard, state.trumpSuit, defP.botDifficulty);
    if (card) return handlePlayCard(room, defP.id, card.id);
    return handleTake(room, defP.id);
  }

  if (state.table.length === 0) {
    let iter = 0;
    while (iter < n && !hasCards(state.playersInfo[state.attackerIdx].id)) {
      state.attackerIdx = (state.attackerIdx + 1) % n;
      state.defenderIdx = (state.attackerIdx + 1) % n;
      state.currentThrowerIdx = state.attackerIdx;
      iter++;
    }
    if (checkGameOver(room)) return false;
    const att = state.playersInfo[state.attackerIdx];
    if (!att.isBot || !hasCards(att.id)) return false;
    const card = pickAttackCard(state.hands[att.id], state.trumpSuit, state.deck.length, att.botDifficulty);
    if (!card) return false;
    return handlePlayCard(room, att.id, card.id);
  }

  const tRanks = getTableRanks(state.table);
  const maxPairs = state.attackLimit;
  const canAdd = state.table.length < maxPairs;

  let cur = state.currentThrowerIdx;
  let iter = 0;
  while (iter < n) {
    const p = state.playersInfo[cur];
    if (p.id !== defP.id) break;
    cur = (cur + 1) % n;
    iter++;
  }
  if (iter >= n) return false;
  state.currentThrowerIdx = cur;
  const curP = state.playersInfo[cur];
  if (!curP.isBot) return false;

  const hand = state.hands[curP.id] || [];
  // Если у текущего атакующего уже нет карт, он не может продолжать
  // атаку. Передаём приоритет следующему допустимому атакующему;
  // если таких нет, бой завершается.
  if (hand.length === 0) return handlePass(room, curP.id);
  const matches = hand.filter(c => tRanks.has(c.rank));
  if (matches.length && canAdd) {
    const card = pickThrowCard(matches, state.trumpSuit, curP.botDifficulty);
    if (card && handlePlayCard(room, curP.id, card.id)) return true;
  }

  const others = state.playersInfo.some((p, i) =>
    i !== cur && p.id !== defP.id && hasCards(p.id) &&
    (state.hands[p.id] || []).some(c => tRanks.has(c.rank))
  );
  if (!others) return handleDone(room, curP.id);

  let next = (cur + 1) % n;
  if (next === state.defenderIdx) next = (next + 1) % n;
  state.currentThrowerIdx = next;
  return true;
}

function scheduleBotTurn(room) {
  if (!room || !room.state || room.state.isGameOver) return;
  if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
  room.botLoopTimeout = setTimeout(() => {
    if (!room || !room.state || room.state.isGameOver) return;
    const acted = executeBotTurnChain(room);
    if (acted) {
      broadcastState(room);
      if (!room.state.isGameOver) scheduleBotTurn(room);
    }
  }, 700);
}

function broadcastState(room) {
  if (!room.state) return;
  for (const target of room.players) {
    if (target.isBot) continue;
    const copy = JSON.parse(JSON.stringify(room.state));
    const realHands = {};
    for (const p of room.players) {
      realHands[p.id] = p.id === target.id
        ? (room.state.hands[p.id] || [])
        : new Array((room.state.hands[p.id] || []).length).fill({});
    }
    copy.hands = realHands;
    copy.playersInfo.forEach(info => { info.isYou = info.id === target.id; });
    getIO().to(target.id).emit('game_update', copy);
  }
}

function generateRoomCode() {
  let code, attempts = 0;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
    if (++attempts > 9000) throw new Error('No free room codes');
  } while (rooms[code]);
  return code;
}

function updateLobby(room) {
  const humans = room.players.filter(p => !p.isBot).length;
  getIO().to(room.id).emit('lobby_update', {
    code: room.id,
    current: room.players.length,
    max: room.maxPlayers,
    humanCount: humans
  });
}

function fillRoomWithBots(room, difficulty) {
  const names = ['Бот Валера', 'Бот Степан', 'Бот Гриша'];
  let i = 0;
  while (room.players.length < room.maxPlayers) {
    room.players.push({
      id: 'BOT_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      isBot: true,
      name: names[i++ % names.length],
      botDifficulty: difficulty
    });
  }
}

function startRematchCountdown(room) {
  if (room.rematchTimer) clearInterval(room.rematchTimer);
  room.rematchVotes.clear();
  let t = 15;
  getIO().to(room.id).emit('rematch_timer', t);
  room.rematchTimer = setInterval(() => {
    t--;
    getIO().to(room.id).emit('rematch_timer', t);
    if (t <= 0) {
      clearInterval(room.rematchTimer);
      const humans = room.players.filter(p => !p.isBot);
      if (humans.length > 0 && room.rematchVotes.size >= humans.length) {
        startRematch(room);
      } else {
        getIO().to(room.id).emit('room_expired');
        delete rooms[room.id];
      }
    }
  }, 1000);
}

function startRematch(room) {
  if (room.rematchTimer) clearInterval(room.rematchTimer);
  initGameState(room);
  getIO().to(room.id).emit('game_restarted');
  broadcastState(room);
  scheduleBotTurn(room);
}

function attachHandlers(socket) {
  socket.on('create_room', data => {
    let maxPlayers = 2, playerName = 'Игрок 1';
    if (data && typeof data === 'object') {
      maxPlayers = parseInt(data.maxPlayers) || 2;
      if (data.playerName) playerName = String(data.playerName).trim().slice(0, 12);
    }
    maxPlayers = Math.max(2, Math.min(4, maxPlayers));
    let code;
    try { code = generateRoomCode(); }
    catch { socket.emit('error_msg', 'Сервер перегружен'); return; }

    const room = {
      id: code, maxPlayers,
      players: [{ id: socket.id, isBot: false, name: playerName || 'Игрок 1' }],
      state: null, rematchVotes: new Set(),
      rematchTimer: null, botLoopTimeout: null
    };
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room_created', { code, maxPlayers });
    updateLobby(room);
  });

  socket.on('join_room', data => {
    let code = '', playerName = '';
    if (data && typeof data === 'object') {
      code = data.roomCode || '';
      playerName = data.playerName || '';
    } else if (typeof data === 'string') {
      code = data;
    }
    code = String(code).trim();
    if (!/^\d{4}$/.test(code)) {
      socket.emit('error_msg', 'Код комнаты — 4 цифры');
      return;
    }
    const room = rooms[code];
    if (!room) { socket.emit('error_msg', 'Комната не найдена'); return; }
    if (room.state) { socket.emit('error_msg', 'Игра уже началась'); return; }
    if (room.players.length >= room.maxPlayers) { socket.emit('error_msg', 'Комната заполнена'); return; }

    const name = String(playerName || `Игрок ${room.players.length + 1}`).trim().slice(0, 12);
    room.players.push({ id: socket.id, isBot: false, name });
    socket.join(code);
    socket.roomCode = code;
    updateLobby(room);
    if (room.players.length === room.maxPlayers) {
      initGameState(room);
      broadcastState(room);
      scheduleBotTurn(room);
    }
  });

  socket.on('play_with_bots', data => {
    let playerName = 'Вы', botDifficulty = 'normal';
    if (data && typeof data === 'object') {
      if (data.playerName) playerName = String(data.playerName).trim().slice(0, 12);
      if (['easy', 'normal', 'hard'].includes(data.botDifficulty)) botDifficulty = data.botDifficulty;
    }
    const code = 'BOTS_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const room = {
      id: code, maxPlayers: 2,
      players: [{ id: socket.id, isBot: false, name: playerName || 'Вы' }],
      state: null, rematchVotes: new Set(),
      rematchTimer: null, botLoopTimeout: null,
      botDifficulty
    };
    rooms[code] = room;
    socket.join(code);
    socket.roomCode = code;
    fillRoomWithBots(room, botDifficulty);
    initGameState(room);
    broadcastState(room);
    scheduleBotTurn(room);
  });

  socket.on('player_action', ({ roomCode, action, cardId }) => {
    const room = rooms[roomCode];
    if (!room || !room.state || room.state.isGameOver) return;
    if (!room.players.find(p => p.id === socket.id)) return;
    if (room.botLoopTimeout) { clearTimeout(room.botLoopTimeout); room.botLoopTimeout = null; }

    let ok = false;
    if (action === 'play_card') ok = handlePlayCard(room, socket.id, cardId);
    else if (action === 'take') ok = handleTake(room, socket.id);
    else if (action === 'done') ok = handleDone(room, socket.id);
    else if (action === 'pass') ok = handlePass(room, socket.id);

    if (ok) {
      broadcastState(room);
      scheduleBotTurn(room);
    }
  });

  socket.on('emoji', ({ roomCode, emoji }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.players.find(p => p.id === socket.id)) return;
    const clean = String(emoji || '').slice(0, 8);
    getIO().to(room.id).emit('emoji', { playerId: socket.id, emoji: clean });
  });

  socket.on('send_message', ({ roomCode, message }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const clean = String(message || '').trim().slice(0, 150);
    if (!clean) return;
    getIO().to(room.id).emit('chat_message', {
      senderId: socket.id,
      senderName: player.name,
      message: clean
    });
  });

  socket.on('vote_rematch', roomCode => {
    const room = rooms[roomCode];
    if (!room || !room.state || !room.state.isGameOver) return;
    room.rematchVotes.add(socket.id);
    const humans = room.players.filter(p => !p.isBot);
    getIO().to(room.id).emit('rematch_voted', {
      votesCount: room.rematchVotes.size,
      totalNeeded: humans.length
    });
    if (room.rematchVotes.size >= humans.length) {
      if (room.rematchTimer) clearInterval(room.rematchTimer);
      startRematch(room);
    }
  });

  socket.on('client_ready', () => {
    for (const room of Object.values(rooms)) {
      if (room.players.find(p => p.id === socket.id) && room.state) {
        broadcastState(room);
        break;
      }
    }
  });

  socket.on('leave_room', roomCode => {
    const room = rooms[roomCode];
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    if (room.rematchTimer) clearInterval(room.rematchTimer);
    if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
    socket.leave(roomCode);
    socket.roomCode = null;
    room.players.splice(idx, 1);
    const humans = room.players.filter(p => !p.isBot).length;
    if (humans === 0) delete rooms[roomCode];
    else if (room.state && !room.state.isGameOver) {
      getIO().to(roomCode).emit('opponent_disconnected');
      delete rooms[roomCode];
    } else updateLobby(room);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    if (room.rematchTimer) clearInterval(room.rematchTimer);
    if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
    room.players.splice(idx, 1);
    const humans = room.players.filter(p => !p.isBot).length;
    if (humans === 0) delete rooms[code];
    else if (room.state && !room.state.isGameOver) {
      getIO().to(code).emit('opponent_disconnected');
      delete rooms[code];
    } else updateLobby(room);
  });
}

function createApp() {
  const app = express();
  const httpServer = http.createServer(app);

  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  const socketServer = new Server(httpServer, {
    cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  app.use(express.static(__dirname));

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  socketServer.on('connection', attachHandlers);
  return { app, httpServer, socketServer };
}

if (require.main === module) {
  const { httpServer, socketServer } = createApp();
  setIO(socketServer);
  const PORT = process.env.PORT || 3000;

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Сервер] слушает http://0.0.0.0:${PORT}`);
    console.log(`[Health] http://0.0.0.0:${PORT}/health`);
  });
}

module.exports = {
  RANKS, SUITS,
  createDeck, shuffleDeck, sortHand, canBeat,
  getTableRanks, countDefendedPairs, nextActiveIndex,
  initGameState, refillAllHands, checkGameOver,
  handlePlayCard, handleTake, handleDone, handlePass,
  finalizeTake,
  executeBotTurnChain, scheduleBotTurn,
  broadcastState, setIO, createApp
};