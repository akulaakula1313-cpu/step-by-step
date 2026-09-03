// server.js — сервер для онлайн-мультиплеера "Дурак"
// Хранит игру полностью на сервере (авторитетно), клиенты только
// присылают действия и получают персональный "вид" состояния —
// поэтому карты соперника реально скрыты, а не просто спрятаны в CSS.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const RANKS = [
    { rank: "6", value: 6 }, { rank: "7", value: 7 }, { rank: "8", value: 8 },
    { rank: "9", value: 9 }, { rank: "10", value: 10 }, { rank: "J", value: 11 },
    { rank: "Q", value: 12 }, { rank: "K", value: 13 }, { rank: "A", value: 14 }
];
const SUITS = ["♠", "♥", "♦", "♣"];

// code -> { code, sockets: {p1, p2}, status: 'waiting'|'playing', state }
const rooms = new Map();

function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

function buildDeck() {
    const deck = [];
    let id = 0;
    for (const s of SUITS) for (const r of RANKS) deck.push({ id: id++, suit: s, rank: r.rank, value: r.value });
    shuffle(deck);
    return deck;
}

function sortHand(hand, trumpSuit) {
    hand.sort((a, b) => {
        const aTr = a.suit === trumpSuit ? 1 : 0;
        const bTr = b.suit === trumpSuit ? 1 : 0;
        if (aTr !== bTr) return aTr - bTr;
        return a.value - b.value;
    });
}

function chooseFirstAttacker(state) {
    const p1T = state.hands.p1.filter(c => c.suit === state.trumpSuit);
    const p2T = state.hands.p2.filter(c => c.suit === state.trumpSuit);
    const p1Min = p1T.length ? Math.min(...p1T.map(c => c.value)) : null;
    const p2Min = p2T.length ? Math.min(...p2T.map(c => c.value)) : null;
    if (p1Min !== null && p2Min !== null) {
        state.attacker = p1Min < p2Min ? 'p1' : (p2Min < p1Min ? 'p2' : (Math.random() < 0.5 ? 'p1' : 'p2'));
    } else if (p1Min !== null) state.attacker = 'p1';
    else if (p2Min !== null) state.attacker = 'p2';
    else state.attacker = Math.random() < 0.5 ? 'p1' : 'p2';
}

function dealGame(room) {
    const state = {
        deck: buildDeck(),
        hands: { p1: [], p2: [] },
        table: [],
        trumpCard: null, trumpSuit: '',
        attacker: '', defender: '',
        phase: 'ATTACK', gameOver: false, winner: null, startedRoundCards: 0
    };
    state.trumpCard = state.deck[0];
    state.trumpSuit = state.trumpCard.suit;
    for (let i = 0; i < 6; i++) {
        if (state.deck.length) state.hands.p1.push(state.deck.pop());
        if (state.deck.length) state.hands.p2.push(state.deck.pop());
    }
    sortHand(state.hands.p1, state.trumpSuit);
    sortHand(state.hands.p2, state.trumpSuit);
    chooseFirstAttacker(state);
    state.defender = state.attacker === 'p1' ? 'p2' : 'p1';
    state.startedRoundCards = state.hands[state.defender].length;
    room.state = state;
    room.status = 'playing';
}

function canBeat(att, def, trumpSuit) {
    const aTr = att.suit === trumpSuit, dTr = def.suit === trumpSuit;
    if (aTr && !dTr) return false;
    if (aTr && dTr) return def.value > att.value;
    if (!dTr) return att.suit === def.suit && def.value > att.value;
    return true;
}
function getTableRanks(table) {
    const s = new Set();
    for (const p of table) { s.add(p.rank); if (p.defense) s.add(p.defense.rank); }
    return s;
}
function allCovered(table) { return table.length > 0 && table.every(p => p.defense !== null); }
function firstUncoveredIndex(table) { return table.findIndex(p => p.defense === null); }
function actingRole(state) {
    if (state.phase === 'ATTACK' || state.phase === 'THROW') return state.attacker;
    if (state.phase === 'DEFEND') return state.defender;
    return null;
}
function drawCards(state, oldAtt) {
    const oldDef = oldAtt === 'p1' ? 'p2' : 'p1';
    for (const role of [oldAtt, oldDef]) {
        while (state.hands[role].length < 6 && state.deck.length > 0) state.hands[role].push(state.deck.pop());
        sortHand(state.hands[role], state.trumpSuit);
    }
}
function checkWinner(state) {
    if (state.deck.length > 0) return false;
    const p1E = state.hands.p1.length === 0, p2E = state.hands.p2.length === 0;
    if (p1E && p2E) { state.winner = 'draw'; state.gameOver = true; return true; }
    if (p1E) { state.winner = 'p1'; state.gameOver = true; return true; }
    if (p2E) { state.winner = 'p2'; state.gameOver = true; return true; }
    return false;
}
function startRound(state) {
    state.table = [];
    state.defender = state.attacker === 'p1' ? 'p2' : 'p1';
    state.startedRoundCards = state.hands[state.defender].length;
    state.phase = 'ATTACK';
}
function doTake(state) {
    const def = state.defender;
    for (const p of state.table) { state.hands[def].push(p.attack); if (p.defense) state.hands[def].push(p.defense); }
    state.table = [];
    sortHand(state.hands[def], state.trumpSuit);
    const oldAtt = state.attacker;
    drawCards(state, oldAtt);
    if (checkWinner(state)) return;
    state.attacker = oldAtt;
    startRound(state);
}
function doFinish(state) {
    const oldDef = state.defender;
    state.table = [];
    const oldAtt = state.attacker;
    drawCards(state, oldAtt);
    if (checkWinner(state)) return;
    state.attacker = oldDef;
    startRound(state);
}

function viewFor(room, role) {
    if (!room.state) return { status: room.status, myRole: role };
    const state = room.state;
    const oppRole = role === 'p1' ? 'p2' : 'p1';
    return {
        status: room.status,
        myRole: role,
        myHand: state.hands[role],
        oppCount: state.hands[oppRole].length,
        table: state.table,
        trumpCard: state.trumpCard,
        trumpSuit: state.trumpSuit,
        deckCount: state.deck.length,
        phase: state.phase,
        attacker: state.attacker,
        defender: state.defender,
        startedRoundCards: state.startedRoundCards,
        gameOver: state.gameOver,
        winner: state.winner
    };
}

function broadcastState(room) {
    if (room.sockets.p1) io.to(room.sockets.p1).emit('state', viewFor(room, 'p1'));
    if (room.sockets.p2) io.to(room.sockets.p2).emit('state', viewFor(room, 'p2'));
}

function cleanupRoom(socket, notifyOpponent) {
    const code = socket.data.code;
    if (!code) return;
    const room = rooms.get(code);
    socket.leave(code);
    socket.data.code = null;
    socket.data.role = null;
    if (!room) return;
    const otherId = socket.id === room.sockets.p1 ? room.sockets.p2 : room.sockets.p1;
    if (notifyOpponent && otherId) io.to(otherId).emit('opponent_left');
    rooms.delete(code);
}

io.on('connection', (socket) => {
    socket.data.code = null;
    socket.data.role = null;

    socket.on('create_room', (cb) => {
        let code;
        do { code = genCode(); } while (rooms.has(code));
        const room = { code, sockets: { p1: socket.id, p2: null }, status: 'waiting', state: null };
        rooms.set(code, room);
        socket.join(code);
        socket.data.code = code;
        socket.data.role = 'p1';
        cb({ ok: true, code });
    });

    socket.on('join_room', (rawCode, cb) => {
        const code = (rawCode || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) { cb({ ok: false, error: 'Комната не найдена. Проверьте код.' }); return; }
        if (room.sockets.p2 && room.sockets.p2 !== socket.id) { cb({ ok: false, error: 'В этой комнате уже два игрока.' }); return; }
        room.sockets.p2 = socket.id;
        socket.join(code);
        socket.data.code = code;
        socket.data.role = 'p2';
        cb({ ok: true, code });
        if (!room.state) dealGame(room);
        broadcastState(room);
    });

    function withRoom(fn) {
        const code = socket.data.code, role = socket.data.role;
        const room = rooms.get(code);
        if (!room || !room.state || room.state.gameOver) return;
        if (actingRole(room.state) !== role) return; // не ваш ход — игнорируем
        fn(room, room.state, role);
    }

    socket.on('attack_card', (cardId) => {
        withRoom((room, state, role) => {
            if (!(state.phase === 'ATTACK' || state.phase === 'THROW') || state.attacker !== role) return;
            const hand = state.hands[role];
            const idx = hand.findIndex(c => c.id === cardId);
            if (idx === -1) return;
            const card = hand[idx];
            if (state.table.length > 0 && state.table.length >= Math.min(6, state.startedRoundCards)) return;
            if (state.table.length > 0 && !getTableRanks(state.table).has(card.rank)) return;
            hand.splice(idx, 1);
            state.table.push({ attack: card, defense: null, rank: card.rank });
            state.phase = 'DEFEND';
            broadcastState(room);
        });
    });

    socket.on('defend_card', (cardId) => {
        withRoom((room, state, role) => {
            if (state.phase !== 'DEFEND' || state.defender !== role) return;
            const uIdx = firstUncoveredIndex(state.table);
            if (uIdx === -1) return;
            const hand = state.hands[role];
            const idx = hand.findIndex(c => c.id === cardId);
            if (idx === -1) return;
            const card = hand[idx];
            const attCard = state.table[uIdx].attack;
            if (!canBeat(attCard, card, state.trumpSuit)) return;
            hand.splice(idx, 1);
            state.table[uIdx].defense = card;
            if (allCovered(state.table)) state.phase = 'THROW';
            broadcastState(room);
        });
    });

    socket.on('take_cards', () => {
        withRoom((room, state, role) => {
            if (state.defender !== role || state.phase !== 'DEFEND' || state.table.length === 0) return;
            doTake(state);
            broadcastState(room);
        });
    });

    socket.on('finish_attack', () => {
        withRoom((room, state, role) => {
            if (state.attacker !== role || state.phase !== 'THROW' || !allCovered(state.table) || state.table.length === 0) return;
            doFinish(state);
            broadcastState(room);
        });
    });

    socket.on('leave_room', () => cleanupRoom(socket, true));
    socket.on('disconnect', () => cleanupRoom(socket, true));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Durak server listening on port ${PORT}`));
