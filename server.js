const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000
});

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
    socket.on('create_room', (maxPlayers) => {
        maxPlayers = parseInt(maxPlayers) || 2;
        if (maxPlayers < 2) maxPlayers = 2;
        if (maxPlayers > 4) maxPlayers = 4;
        
        let code = Math.random().toString(36).substring(2, 8).toUpperCase();
        while (rooms[code]) { code = Math.random().toString(36).substring(2, 8).toUpperCase(); }
        
        let room = {
            id: code, 
            maxPlayers: maxPlayers,
            players: [{ id: socket.id, isBot: false, name: 'Игрок 1' }],
            state: null, 
            rematchVotes: new Set(), 
            rematchTimer: null, 
            botTimer: null, 
            botLoopTimeout: null
        };
        rooms[code] = room;
        socket.join(code);
        socket.emit('room_created', { code, maxPlayers });
        updateLobby(room);

        room.botTimer = setTimeout(() => {
            if (room && !room.state && room.players.length < room.maxPlayers) {
                fillRoomWithBots(room); 
                initGameState(room); 
                broadcastState(room); 
                scheduleBotTurn(room);
            }
        }, 60000);
    });

    socket.on('play_with_bots', (maxPlayers) => {
        maxPlayers = parseInt(maxPlayers) || 2;
        if (maxPlayers < 2) maxPlayers = 2;
        if (maxPlayers > 4) maxPlayers = 4;
        
        let code = 'BOTS_' + Math.random().toString(36).substring(2, 6).toUpperCase();
        let room = {
            id: code, 
            maxPlayers: maxPlayers,
            players: [{ id: socket.id, isBot: false, name: 'Вы' }],
            state: null, 
            rematchVotes: new Set(), 
            rematchTimer: null, 
            botTimer: null, 
            botLoopTimeout: null
        };
        rooms[code] = room;
        socket.join(code);
        
        fillRoomWithBots(room); 
        initGameState(room); 
        broadcastState(room); 
        scheduleBotTurn(room);
    });

    socket.on('join_room', (code) => {
        if (!code || typeof code !== 'string') return;
        code = code.trim().toUpperCase();
        let room = rooms[code];
        
        if (!room) { socket.emit('error_msg', 'Комната не найдена'); return; }
        if (room.state) { socket.emit('error_msg', 'Игра уже началась'); return; }
        if (room.players.length >= room.maxPlayers) { socket.emit('error_msg', 'Комната заполнена'); return; }

        let pName = `Игрок ${room.players.length + 1}`;
        room.players.push({ id: socket.id, isBot: false, name: pName });
        socket.join(code);
        updateLobby(room);

        if (room.players.length === room.maxPlayers) {
            if (room.botTimer) clearTimeout(room.botTimer);
            initGameState(room); 
            broadcastState(room); 
            scheduleBotTurn(room);
        }
    });

    socket.on('player_action', ({ roomCode, action, cardIdx }) => {
        let room = rooms[roomCode];
        if (!room || !room.state || room.state.isGameOver) return;
        
        let humanP = room.players.find(p => p.id === socket.id);
        if (!humanP) return;
        
        let success = false;
        if (action === 'play_card') success = handlePlayCard(room, socket.id, cardIdx);
        else if (action === 'take') success = handleTake(room, socket.id);
        else if (action === 'pass') success = handlePass(room, socket.id);
        
        if (success) {
            if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
            scheduleBotTurn(room, 600);
        }
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
                
                if (humansLeft === 0) {
                    delete rooms[code];
                } else if (room.state && !room.state.isGameOver) {
                    io.to(code).emit('opponent_disconnected');
                    delete rooms[code];
                } else {
                    updateLobby(room);
                }
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
        room.players.push({ 
            id: 'BOT_' + Math.random().toString(36).substring(2, 8), 
            isBot: true, 
            name: botNames[nameIdx++ % botNames.length] 
        });
    }
}

function updateLobby(room) {
    let humanCount = room.players.filter(p => !p.isBot).length;
    io.to(room.id).emit('lobby_update', { code: room.id, current: room.players.length, max: room.maxPlayers, humanCount });
}

function initGameState(room) {
    let deck = []; let id = 0;
    for (let s of SUITS) { 
        for (let r of RANKS) { 
            deck.push({ id: id++, suit: s, rank: r.rank, value: r.value }); 
        } 
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    let trumpCard = deck[deck.length - 1];
    let hands = {};
    room.players.forEach(p => { 
        hands[p.id] = deck.splice(0, 6); 
        sortHand(hands[p.id], trumpCard.suit); 
    });
    
    let firstAttackerIdx = 0; let minTrumpValue = 999;
    room.players.forEach((p, idx) => {
        let trCards = hands[p.id].filter(c => c.suit === trumpCard.suit);
        trCards.forEach(c => { 
            if (c.value < minTrumpValue) { 
                minTrumpValue = c.value; 
                firstAttackerIdx = idx; 
            } 
        });
    });
    
    let defenderIdx = (firstAttackerIdx + 1) % room.players.length;
    room.state = {
        roomCode: room.id, 
        deck, 
        trumpCard, 
        trumpSuit: trumpCard.suit, 
        hands, 
        table: [],
        attackerIdx: firstAttackerIdx,
        defenderIdx: defenderIdx,
        turnSubIdx: firstAttackerIdx,
        passedSubPlayers: new Set(),
        playersInfo: room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot })),
        isGameOver: false, 
        winner: null
    };
    room.rematchVotes.clear();
}

function sortHand(hand, trumpSuit) {
    hand.sort((a, b) => {
        let aTr = a.suit === trumpSuit ? 1 : 0; 
        let bTr = b.suit === trumpSuit ? 1 : 0;
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
    for (let p of table) { 
        ranks.add(p.attack.rank); 
        if (p.defense) ranks.add(p.defense.rank); 
    }
    return ranks;
}

function countDefendedPairs(table) { 
    return table.filter(p => p.defense !== null).length; 
}

function handlePlayCard(room, pId, cardIdx) {
    let state = room.state;
    let hand = state.hands[pId];
    if (!hand || cardIdx < 0 || cardIdx >= hand.length) { 
        io.to(pId).emit('error_msg', 'Неверная карта'); 
        return false; 
    }
    
    let card = hand[cardIdx];
    let pIdx = state.playersInfo.findIndex(p => p.id === pId);
    let defenderId = state.playersInfo[state.defenderIdx].id;

    if (pId !== defenderId) {
        if (state.table.length === 0) {
            if (pIdx !== state.attackerIdx) {
                io.to(pId).emit('error_msg', 'Сейчас ход главного атакующего!');
                return false;
            }
        } else {
            if (pIdx !== state.turnSubIdx) {
                io.to(pId).emit('error_msg', 'Сейчас очередь другого игрока подкидывать!');
                return false;
            }
            let tRanks = getTableRanks(state.table);
            if (!tRanks.has(card.rank)) {
                io.to(pId).emit('error_msg', 'Такой карты нет на столе');
                return false;
            }
            let defHandLen = state.hands[defenderId].length;
            if (state.table.length >= Math.min(6, defHandLen + countDefendedPairs(state.table))) {
                io.to(pId).emit('error_msg', 'У защищающегося нет столько карт');
                return false;
            }
        }

        hand.splice(cardIdx, 1);
        state.table.push({ attack: card, defense: null, attackerId: pId });
        
        let tRanksAfter = getTableRanks(state.table);
        let hasMoreMatch = hand.some(c => tRanksAfter.has(c.rank));
        let defHandLenAfter = state.hands[defenderId].length;
        let canAddMoreTable = state.table.length < Math.min(6, defHandLenAfter + countDefendedPairs(state.table));

        if (!hasMoreMatch || !canAddMoreTable) {
            state.passedSubPlayers.add(pIdx);
            advanceSubTurn(room);
        }

        checkGameOver(room);
        broadcastState(room);
        return true;

    } else {
        if (state.table.length === 0) { io.to(pId).emit('error_msg', 'Стол пуст'); return false; }
        let uncoveredIdx = state.table.findIndex(p => p.defense === null);
        if (uncoveredIdx === -1) { io.to(pId).emit('error_msg', 'Все отбито'); return false; }
        
        let attCard = state.table[uncoveredIdx].attack;
        if (!canBeat(attCard, card, state.trumpSuit)) {
            io.to(pId).emit('error_msg', 'Карта не бьет атакующую');
            return false;
        }

        hand.splice(cardIdx, 1);
        state.table[uncoveredIdx].defense = card;

        checkGameOver(room);
        broadcastState(room);
        return true;
    }
}

function advanceSubTurn(room) {
    let state = room.state;
    let numPlayers = state.playersInfo.length;
    let nextIdx = (state.turnSubIdx + 1) % numPlayers;
    let tRanks = getTableRanks(state.table);
    let defHandLen = state.hands[state.playersInfo[state.defenderIdx].id].length;

    let loops = 0;
    while (loops < numPlayers) {
        let pId = state.playersInfo[nextIdx].id;
        let pHand = state.hands[pId] || [];
        let isDef = (nextIdx === state.defenderIdx);
        let hasPassed = state.passedSubPlayers.has(nextIdx);
        
        let hasValidCard = pHand.some(c => tRanks.has(c.rank));
        let tableLimit = Math.min(6, defHandLen + countDefendedPairs(state.table));
        let canAdd = state.table.length < tableLimit;

        if (!isDef && !hasPassed && hasValidCard && canAdd) {
            state.turnSubIdx = nextIdx;
            return;
        }

        if (isDef || !hasValidCard || !canAdd) {
            state.passedSubPlayers.add(nextIdx);
        }

        nextIdx = (nextIdx + 1) % numPlayers;
        loops++;
    }

    checkAutoDoneOrNext(room);
}

function handlePass(room, pId) {
    let state = room.state;
    let pIdx = state.playersInfo.findIndex(p => p.id === pId);
    if (pId === state.playersInfo[state.defenderIdx].id) return false;
    if (state.table.length === 0) return false;
    if (pIdx !== state.turnSubIdx) {
        io.to(pId).emit('error_msg', 'Сейчас не ваша очередь подкидывать');
        return false;
    }

    state.passedSubPlayers.add(pIdx);
    advanceSubTurn(room);
    broadcastState(room);
    scheduleBotTurn(room, 600);
    return true;
}

function checkAutoDoneOrNext(room) {
    let state = room.state;
    let numPlayers = state.playersInfo.length;
    let allCovered = state.table.length > 0 && state.table.every(p => p.defense !== null);
    
    if (!allCovered) return false;

    let tRanks = getTableRanks(state.table);
    let canAnyoneAdd = false;

    for (let i = 0; i < numPlayers; i++) {
        if (i === state.defenderIdx) continue;
        if (state.passedSubPlayers.has(i)) continue;
        
        let pId = state.playersInfo[i].id;
        let pHand = state.hands[pId] || [];
        let hasValidCard = pHand.some(c => tRanks.has(c.rank));
        let defHandLen = state.hands[state.playersInfo[state.defenderIdx].id].length;
        let tableLimit = Math.min(6, defHandLen + countDefendedPairs(state.table));
        
        if (hasValidCard && state.table.length < tableLimit) {
            canAnyoneAdd = true;
            break;
        }
    }

    if (!canAnyoneAdd || state.passedSubPlayers.size >= numPlayers - 1) {
        executeTableClear(room);
        return true;
    }
    return false;
}

function executeTableClear(room) {
    let state = room.state;
    state.table = [];
    state.passedSubPlayers.clear();
    refillAllHands(state);
    
    if (checkGameOver(room)) return;
    
    state.attackerIdx = state.defenderIdx;
    state.defenderIdx = (state.attackerIdx + 1) % state.playersInfo.length;
    state.turnSubIdx = state.attackerIdx;
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
    state.passedSubPlayers.clear();
    sortHand(state.hands[pId], state.trumpSuit);
    refillAllHands(state);
    
    if (checkGameOver(room)) { broadcastState(room); return true; }
    
    state.attackerIdx = (state.defenderIdx + 1) % state.playersInfo.length;
    state.defenderIdx = (state.attackerIdx + 1) % state.playersInfo.length;
    state.turnSubIdx = state.attackerIdx;
    
    broadcastState(room);
    scheduleBotTurn(room, 800);
    return true;
}

function refillAllHands(state) {
    let count = state.playersInfo.length;
    for (let i = 0; i < count; i++) {
        let idx = (state.attackerIdx + i) % count;
        let pId = state.playersInfo[idx].id;
        if (!state.hands[pId]) state.hands[pId] = [];
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
    
    let playersWithCards = state.playersInfo.filter(p => state.hands[p.id] && state.hands[p.id].length > 0);
    if (playersWithCards.length <= 1) {
        state.isGameOver = true;
        state.winner = playersWithCards.length === 1 ? playersWithCards.id : null;
        io.to(room.id).emit('game_over', { state: state, winner: state.winner });
        return true;
    }
    return false;
}

function scheduleBotTurn(room, delay = 1000) {
    if (!room || !room.state || room.state.isGameOver) return;
    if (room.botLoopTimeout) clearTimeout(room.botLoopTimeout);
    room.botLoopTimeout = setTimeout(() => { executeBotTurnChain(room); }, delay);
}

function executeBotTurnChain(room) {
    if (!room || !room.state || room.state.isGameOver) return;
    let state = room.state;
    
    if (checkAutoDoneOrNext(room)) {
        broadcastState(room);
        scheduleBotTurn(room, 1000);
        return;
    }

    let defP = state.playersInfo[state.defenderIdx];
    let currSubP = state.playersInfo[state.turnSubIdx];
    let uncoveredIdx = state.table.findIndex(p => p.defense === null);

    if (uncoveredIdx !== -1 && defP && defP.isBot) {
        let attCard = state.table[uncoveredIdx].attack;
        let botHand = state.hands[defP.id] || [];
        let bestIdx = -1; let minVal = 999;
        
        for (let i = 0; i < botHand.length; i++) {
            let c = botHand[i];
            if (canBeat(attCard, c, state.trumpSuit)) {
                let isTr = (c.suit === state.trumpSuit ? 1 : 0);
                let score = isTr * 100 + c.value;
                if (score < minVal) { minVal = score; bestIdx = i; }
            }
        }
        
        if (bestIdx !== -1) {
            handlePlayCard(room, defP.id, bestIdx);
            scheduleBotTurn(room, 1000);
        } else {
            handleTake(room, defP.id);
        }
        return;
    }

    if (state.table.length === 0 && currSubP && currSubP.isBot) {
        let botHand = state.hands[currSubP.id] || [];
        if (botHand.length > 0) {
            let nonTrumps = botHand.map((c, idx) => ({c, idx})).filter(o => o.c.suit !== state.trumpSuit);
            let targetIdx = nonTrumps.length > 0 ? nonTrumps.sort((a,b) => a.c.value - b.c.value).idx : 0;
            handlePlayCard(room, currSubP.id, targetIdx);
            scheduleBotTurn(room, 1000);
        }
        return;
    }

    if (currSubP && currSubP.isBot && state.table.length > 0) {
        let botHand = state.hands[currSubP.id] || [];
        let tRanks = getTableRanks(state.table);
        let defHandLen = (state.hands[defP.id] || []).length;
        let canAddMore = state.table.length < Math.min(6, defHandLen + countDefendedPairs(state.table));

        if (canAddMore) {
            let matchObj = botHand.map((c, idx) => ({c, idx})).filter(o => tRanks.has(o.c.rank));
            if (matchObj.length > 0) {
                matchObj.sort((a,b) => {
                    let aTr = a.c.suit === state.trumpSuit ? 1 : 0;
                    let bTr = b.c.suit === state.trumpSuit ? 1 : 0;
                    if (aTr !== bTr) return aTr - bTr;
                    return a.c.value - b.c.value;
                });
                handlePlayCard(room, currSubP.id, matchObj.idx);
                scheduleBotTurn(room, 1200);
                return;
            }
        }

        state.passedSubPlayers.add(state.turnSubIdx);
        advanceSubTurn(room);
        broadcastState(room);
        scheduleBotTurn(room, 800);
        return;
    }
}

function broadcastState(room) {
    room.players.forEach(p => {
        if (!p.isBot) {
            let adaptedState = JSON.parse(JSON.stringify(room.state));
            let realHands = {};
            room.players.forEach(targetP => {
                if (targetP.id === p.id) {
                    realHands[p.id] = room.state.hands[p.id] || [];
                } else {
                    realHands[targetP.id] = new Array((room.state.hands[targetP.id] || []).length).fill({});
                }
            });
            adaptedState.hands = realHands;
            adaptedState.playersInfo.forEach(info => {
                if (info.id === p.id) info.name = 'Вы';
            });
            io.to(p.id).emit('game_update', adaptedState);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`[Сервер] Запущен и слушает порт ${PORT}`); });
