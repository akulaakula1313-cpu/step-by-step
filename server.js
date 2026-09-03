const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.resolve(__dirname, 'index.html')); });

const rooms = {};
const RANKS = [
    {rank: "6", value: 6}, {rank: "7", value: 7}, {rank: "8", value: 8},
    {rank: "9", value: 9}, {rank: "10", value: 10}, {rank: "J", value: 11},
    {rank: "Q", value: 12}, {rank: "K", value: 13}, {rank: "A", value: 14}
];
const SUITS = ["♠", "♥", "♦", "♣"];

io.on('connection', (socket) => {
    console.log('Игрок подключился:', socket.id);

    socket.on('create_room', (maxPlayers) => {
        maxPlayers = parseInt(maxPlayers) || 2;
        if (maxPlayers < 2) maxPlayers = 2;
        if (maxPlayers > 4) maxPlayers = 4;
        let code = Math.random().toString(36).substring(2, 8).toUpperCase();
        while (rooms[code]) { code = Math.random().toString(36).substring(2, 8).toUpperCase(); }
        let room = {
            id: code, maxPlayers: maxPlayers,
            players: [{ id: socket.id, isBot: false, name: 'Игрок 1' }],
            state: null, rematchVotes: new Set(), rematchTimer: null, botTimer: null, botLoopTimeout: null
        };
        rooms[code] = room;
        socket.join(code);
        socket.emit('room_created', { code, maxPlayers });
        updateLobby(room);
        room.botTimer = setTimeout(() => {
            if (room && !room.state && room.players.length < room.maxPlayers) {
                fillRoomWithBots(room); initGameState(room); broadcastState(room); scheduleBotTurn(room);
            }
        }, 60000);
    });

    socket.on('play_with_bots', (maxPlayers) => {
        maxPlayers = parseInt(maxPlayers) || 2;
        if (maxPlayers < 2) maxPlayers = 2;
        if (maxPlayers > 4) maxPlayers = 4;
        let code = 'BOTS_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        let room = {
            id: code, maxPlayers: maxPlayers,
            players: [{ id: socket.id, isBot: false, name: 'Вы' }],
            state: null, rematchVotes: new Set(), rematchTimer: null, botTimer: null, botLoopTimeout: null
        };
        rooms[code] = room;
        socket.join(code);
        fillRoomWithBots(room); initGameState(room); broadcastState(room); scheduleBotTurn(room);
    });

    socket.on('join_room', (code) => {
        let room = rooms[code];
        if (!room) { socket.emit('error_msg', 'Комната не найдена'); return; }
        if (room.state) { socket.emit('error_msg', 'Игра уже началась'); return; }
        if (room.players.length >= room.maxPlayers) { socket.emit('error_msg', 'Комната заполнена'); return; }
        room.players.push({ id: socket.id, isBot: false, name: `Игрок ${room.players.length + 1}` });
        socket.join(code);
        updateLobby(room);
        if (room.players.length === room.maxPlayers) {
            if (room.botTimer) clearTimeout(room.botTimer);
            initGameState(room); broadcastState(room); scheduleBotTurn(room);
        }
    });

    socket.on('vote_rematch', (roomCode) => {
        let room = rooms[roomCode];
        if (!room || !room.state || !room.state.isGameOver) return;
        room.rematchVotes.add(socket.id);
        let humanPlayers = room.players.filter(p => !p.isBot);
        io.to(room.id).emit('rematch_voted', { votesCount: room.rematchVotes.size, totalNeeded: humanPlayers.length });
        if (room.rematchVotes.size >= humanPlayers.length) {
            if (room.rematchTimer) clearTimeout(room.rematchTimer);
            startRematch(room);
        }
    });

    socket.on('player_action', ({ roomCode, action, cardIdx }) => {
        console.log('Действие от игрока:', { socketId: socket.id, roomCode, action, cardIdx });
        let room = rooms[roomCode];
        if (!room) { socket.emit('error_msg', 'Комната не найдена на сервере'); return; }
        if (!room.state || room.state.isGameOver) return;
        let humanP = room.players.find(p => p.id === socket.id);
        if (!humanP) return;
        let success = false;
        if (action === 'play_card') success = handlePlayCard(room, socket.id, cardIdx);
        else if (action === 'take') success = handleTake(room, socket.id);
        else if (action === 'done') success = handleDone(room, socket.id);
        if (success) scheduleBotTurn(room);
    });

    socket.on('disconnect', () => {
        for (let code in rooms) {
            let room = rooms[code];
            let idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                if (room.botTimer) clearTimeout(room.botTimer);
                if (room.rematchTimer) clearTimeout(room.rematchTimer);
                if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
                room.players.splice(idx, 1);
                let humansLeft = room.players.filter(p => !p.isBot).length;
                if (humansLeft === 0) delete rooms[code];
                else { io.to(code).emit('opponent_disconnected'); delete rooms[code]; }
                break;
            }
        }
    });
});

function fillRoomWithBots(room) {
    if (room.botTimer) clearTimeout(room.botTimer);
    let botNames = ["Бот Валера", "Бот Степан", "Бот Гриша"];
    let nameIdx = 0;
    while (room.players.length < room.maxPlayers) {
        room.players.push({ id: 'BOT_' + Math.random().toString(36).substring(2, 8), isBot: true, name: botNames[nameIdx++ % botNames.length] });
    }
}

function updateLobby(room) {
    let humanCount = room.players.filter(p => !p.isBot).length;
    io.to(room.id).emit('lobby_update', { code: room.id, current: room.players.length, max: room.maxPlayers, humanCount });
}

function initGameState(room) {
    let deck = []; let id = 0;
    for (let s of SUITS) { for (let r of RANKS) { deck.push({ id: id++, suit: s, rank: r.rank, value: r.value }); } }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    let trumpCard = deck[deck.length - 1];
    let hands = {};
    room.players.forEach(p => { hands[p.id] = deck.splice(0, 6); sortHand(hands[p.id], trumpCard.suit); });
    let firstAttackerIdx = 0; let minTrumpValue = 999;
    room.players.forEach((p, idx) => {
        let trCards = hands[p.id].filter(c => c.suit === trumpCard.suit);
        trCards.forEach(c => { if (c.value < minTrumpValue) { minTrumpValue = c.value; firstAttackerIdx = idx; } });
    });
    let defenderIdx = (firstAttackerIdx + 1) % room.players.length;
    room.state = {
        roomCode: room.id, deck, trumpCard, trumpSuit: trumpCard.suit, hands, table: [],
        attackerIdx: firstAttackerIdx, defenderIdx: defenderIdx,
        playersInfo: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot })),
        isGameOver: false, winner: null
    };
    room.rematchVotes.clear();
}

function sortHand(hand, trumpSuit) {
    hand.sort((a, b) => {
        let aTr = a.suit === trumpSuit ? 1 : 0; let bTr = b.suit === trumpSuit ? 1 : 0;
        if (aTr !== bTr) return aTr - bTr;
        return a.value - b.value;
    });
}

function canBeat(att, def, trumpSuit) {
    let aTr = att.suit === trumpSuit, dTr = def.suit === trumpSuit;
    if (aTr && !dTr) return false;
    if (aTr && dTr) return def.value > att.value;
    if (!dTr) return att.suit === def.suit && def.value > att.value;
    return true;
}

function getTableRanks(table) {
    let ranks = new Set();
    for (let p of table) { ranks.add(p.attack.rank); if (p.defense) ranks.add(p.defense.rank); }
    return ranks;
}

function countDefendedPairs(table) { return table.filter(p => p.defense !== null).length; }

function handlePlayCard(room, pId, cardIdx) {
    let state = room.state;
    let hand = state.hands[pId];
    if (!hand || cardIdx < 0 || cardIdx >= hand.length) { io.to(pId).emit('error_msg', 'Неверная карта'); return false; }
    let card = hand[cardIdx];
    let attackerId = state.playersInfo[state.attackerIdx].id;
    let defenderId = state.playersInfo[state.defenderIdx].id;
    let isAttackerParty = state.table.length === 0 ? (pId === attackerId) : (pId !== defenderId);
    if (isAttackerParty) {
        if (state.table.length === 0 && pId !== attackerId) { io.to(pId).emit('error_msg', 'Сейчас ход другого игрока!'); return false; }
        if (state.table.length > 0) {
            let tRanks = getTableRanks(state.table);
            if (!tRanks.has(card.rank)) { io.to(pId).emit('error_msg', 'Такой карты нет на столе'); return false; }
            let defHandLen = state.hands[defenderId].length;
            if (state.table.length >= Math.min(6, defHandLen + countDefendedPairs(state.table))) {
                io.to(pId).emit('error_msg', 'У защищающегося нет столько карт'); return false;
            }
        }
        hand.splice(cardIdx, 1);
        state.table.push({ attack: card, defense: null, attackerId: pId });
        checkGameOver(room); broadcastState(room); return true;
    } else if (pId === defenderId) {
        if (state.table.length === 0) { io.to(pId).emit('error_msg', 'Стол пуст'); return false; }
        let uncoveredIdx = state.table.findIndex(p => p.defense === null);
        if (uncoveredIdx === -1) { io.to(pId).emit('error_msg', 'Все отбито'); return false; }
        let attCard = state.table[uncoveredIdx].attack;
        if (!canBeat(attCard, card, state.trumpSuit)) { io.to(pId).emit('error_msg', 'Не бьет карту'); return false; }
        hand.splice(cardIdx, 1);
        state.table[uncoveredIdx].defense = card;
        checkGameOver(room); broadcastState(room); return true;
    } else { io.to(pId).emit('error_msg', 'Не ваш ход'); return false; }
}

function handleTake(room, pId) {
    let state = room.state;
    let defenderId = state.playersInfo[state.defenderIdx].id;
    if (pId !== defenderId) { io.to(pId).emit('error_msg', 'Брать может только защищающийся'); return false; }
    if (state.table.length === 0) { io.to(pId).emit('error_msg', 'На столе нет карт'); return false; }
    for (let p of state.table) { 
        state.hands[pId].push(p.attack); 
        if (p.defense) state.hands[pId].push(p.defense); 
    }
    state.table = []; 
    sortHand(state.hands[pId], state.trumpSuit);
    refillAllHands(state);
    if (checkGameOver(room)) { broadcastState(room); return true; }
    state.attackerIdx = (state.defenderIdx + 1) % state.playersInfo.length;
    state.defenderIdx = (state.attackerIdx + 1) % state.playersInfo.length;
    broadcastState(room); 
    return true;
}

function handleDone(room, pId) {
    let state = room.state;
    let attackerId = state.playersInfo[state.attackerIdx].id;
    if (pId !== attackerId) { io.to(pId).emit('error_msg', 'Только атакующий может завершить ход'); return false; }
    if (state.table.length === 0 || !state.table.every(p => p.defense !== null)) { 
        io.to(pId).emit('error_msg', 'Не все карты отбиты'); 
        return false; 
    }
    state.table = []; 
    refillAllHands(state);
    if (checkGameOver(room)) { broadcastState(room); return true; }
    state.attackerIdx = state.defenderIdx;
    state.defenderIdx = (state.attackerIdx + 1) % state.playersInfo.length;
    broadcastState(room); 
    return true;
}

function refillAllHands(state) {
    let count = state.playersInfo.length;
    for (let i = 0; i < count; i++) {
        let idx = (state.attackerIdx + i) % count;
        let pId = state.playersInfo[idx].id;
        while (state.hands[pId].length < 6 && state.deck.length > 0) { 
            state.hands[pId].push(state.deck.pop()); 
        }
        sortHand(state.hands[pId], state.trumpSuit);
    }
    if (state.deck.length === 0) state.trumpCard = null;
}

function checkGameOver(room) {
    let state = room.state;
    if (state.deck.length > 0) return false;
    let playersWithCards = state.playersInfo.filter(p => state.hands[p.id].length > 0);
    if (playersWithCards.length <= 1) {
        state.isGameOver = true;
        state.winner = playersWithCards.length === 1 ? playersWithCards[0].id : null;
        io.to(room.id).emit('game_over', { state: state, winner: state.winner });
        startRematchCountdown(room); 
        return true;
    }
    return false;
}

function scheduleBotTurn(room) {
    if (!room || !room.state || room.state.isGameOver) return;
    if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
    room.botLoopTimeout = setTimeout(() => { executeBotTurn(room); }, 1200);
}

function executeBotTurn(room) {
    if (!room || !room.state || room.state.isGameOver) return;
    let state = room.state;
    let defP = state.playersInfo[state.defenderIdx];
    let attP = state.playersInfo[state.attackerIdx];
    if (defP.isBot) {
        let uncoveredIdx = state.table.findIndex(p => p.defense === null);
        if (uncoveredIdx !== -1) {
            let attCard = state.table[uncoveredIdx].attack;
            let botHand = state.hands[defP.id];
            let bestCardIdx = -1;
            for (let i = 0; i < botHand.length; i++) {
                if (canBeat(attCard, botHand[i], state.trumpSuit)) { bestCardIdx = i; break; }
            }
            if (bestCardIdx !== -1) { 
                handlePlayCard(room, defP.id, bestCardIdx); 
                scheduleBotTurn(room); 
                return; 
            } else { 
                handleTake(room, defP.id); 
                scheduleBotTurn(room); 
                return; 
            }
        }
    }
    let activeBot = state.playersInfo.find(p => p.isBot && p.id !== defP.id && state.hands[p.id].length > 0);
    if (activeBot) {
        let botHand = state.hands[activeBot.id];
        if (state.table.length === 0 && activeBot.id === attP.id) {
            let nonTrumpIdx = botHand.findIndex(c => c.suit !== state.trumpSuit);
            let cardIdxToPlay = nonTrumpIdx !== -1 ? nonTrumpIdx : 0;
            handlePlayCard(room, activeBot.id, cardIdxToPlay); 
            scheduleBotTurn(room); 
            return;
        } else if (state.table.length > 0) {
            let tRanks = getTableRanks(state.table);
            let defHandLen = state.hands[defP.id].length;
            let canAddMore = state.table.length < Math.min(6, defHandLen + countDefendedPairs(state.table));
            if (canAddMore) {
                let matchIdx = botHand.findIndex(c => tRanks.has(c.rank) && c.suit !== state.trumpSuit);
                if (matchIdx === -1) matchIdx = botHand.findIndex(c => tRanks.has(c.rank));
                if (matchIdx !== -1) { 
                    handlePlayCard(room, activeBot.id, matchIdx); 
                    scheduleBotTurn(room); 
                    return; 
                }
            }
            if (activeBot.id === attP.id && state.table.length > 0 && state.table.every(p => p.defense !== null)) {
                if (Math.random() < 0.8 || botHand.length === 0) { 
                    handleDone(room, activeBot.id); 
                    scheduleBotTurn(room); 
                    return; 
                }
            }
        }
    }
    if (attP.isBot && state.table.length > 0 && state.table.every(p => p.defense !== null)) {
        handleDone(room, attP.id); 
        scheduleBotTurn(room);
    }
}

function startRematchCountdown(room) {
    let timeLeft = 10;
    room.rematchVotes.clear();
    if (room.rematchTimer) clearInterval(room.rematchTimer);
    room.rematchTimer = setInterval(() => {
        timeLeft--;
        io.to(room.id).emit('rematch_timer', timeLeft);
        if (timeLeft <= 0) {
            clearInterval(room.rematchTimer);
            let humanPlayers = room.players.filter(p => !p.isBot);
            if (room.rematchVotes.size >= humanPlayers.length) startRematch(room);
            else { io.to(room.id).emit('room_expired'); delete rooms[room.id]; }
        }
    }, 1000);
}

function startRematch(room) {
    initGameState(room); 
    io.to(room.id).emit('game_restarted'); 
    broadcastState(room); 
    scheduleBotTurn(room);
}

function broadcastState(room) {
    room.players.forEach(p => {
        if (!p.isBot) {
            let adaptedState = JSON.parse(JSON.stringify(room.state));
            adaptedState.playersInfo.forEach(info => { if (info.id === p.id) info.name = 'Вы'; });
            io.to(p.id).emit('game_update', adaptedState);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Сервер запущен на порту ${PORT}`); });
