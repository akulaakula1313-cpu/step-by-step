const assert = require('node:assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'express') {
    const express = () => ({ use(){}, get(){} });
    express.static = () => () => {};
    return express;
  }
  if (request === 'socket.io') return { Server: class {} };
  return originalLoad(request, parent, isMain);
};

const game = require('./server.js');
const emitted = [];
game.setIO({ to(id) { return { emit(event, data) { emitted.push({ id, event, data }); } }; } });

function makeRoom(count) {
  return {
    id: 'TEST_' + count,
    maxPlayers: count,
    players: Array.from({length: count}, (_, i) => ({
      id: 'P' + i,
      isBot: true,
      name: 'Player ' + i,
      botDifficulty: 'normal'
    })),
    state: null,
    rematchVotes: new Set(),
    rematchTimer: null,
    botLoopTimeout: null
  };
}

function allCards(room) {
  const s = room.state;
  return [
    ...Object.values(s.hands).flat(),
    ...s.deck,
    ...(s.discard || []),
    ...s.table.flatMap(p => [p.attack, p.defense].filter(Boolean))
  ];
}

function assertIntegrity(room) {
  const cards = allCards(room);
  assert.equal(cards.length, 36, 'all 36 cards must always remain in the game state');
  assert.equal(new Set(cards.map(c => c.id)).size, 36, 'card ids must remain unique');
  for (const c of cards) {
    assert.ok(game.SUITS.includes(c.suit), 'invalid suit');
    assert.ok(game.RANKS.some(r => r.rank === c.rank && r.value === c.value), 'invalid rank');
  }
}

function testInitialization() {
  for (const count of [2, 3, 4]) {
    for (let i = 0; i < 100; i++) {
      const room = makeRoom(count);
      game.initGameState(room);
      const s = room.state;
      assert.equal(s.deck.length, 36 - count * 6);
      assert.ok(s.trumpCard);
      assert.equal(new Set(Object.values(s.hands).flat().map(c => c.id)).size, count * 6);
      for (const h of Object.values(s.hands)) assert.equal(h.length, 6);
      assertIntegrity(room);
    }
  }
}

function finishPendingTake(room, defenderId) {
  const s = room.state;
  let guard = 0;
  while (s.pendingTake && guard++ < s.playersInfo.length + 2) {
    const p = s.playersInfo[s.currentThrowerIdx];
    assert.notEqual(p.id, defenderId);
    assert.equal(game.handlePass(room, p.id), true);
  }
  assert.equal(s.pendingTake, false);
}

function testTakeRotation() {
  for (const count of [2, 3, 4]) {
    const room = makeRoom(count);
    game.initGameState(room);
    const s = room.state;
    const oldAttacker = s.attackerIdx;
    const oldDefender = s.defenderIdx;
    const attackerId = s.playersInfo[oldAttacker].id;
    const defenderId = s.playersInfo[oldDefender].id;

    const attack = s.hands[attackerId][0];
    assert.equal(game.handlePlayCard(room, attackerId, attack.id), true);
    assert.equal(game.handleTake(room, defenderId), true);
    finishPendingTake(room, defenderId);

    const expectedAttacker = (oldDefender + 1) % count;
    assert.equal(s.attackerIdx, expectedAttacker,
      'after TAKE, the player after the defender must attack next');
    assert.equal(s.defenderIdx, (expectedAttacker + 1) % count,
      'the next player after the new attacker must defend');
    assert.equal(s.currentThrowerIdx, s.attackerIdx);
    assertIntegrity(room);
  }
}

function testSuccessfulDefenseRotation() {
  const room = makeRoom(2);
  game.initGameState(room);
  const s = room.state;
  const attacker = s.playersInfo[s.attackerIdx].id;
  const defender = s.playersInfo[s.defenderIdx].id;
  const attack = s.hands[attacker][0];
  const defense = s.hands[defender].find(c => game.canBeat(attack, c, s.trumpSuit));
  if (!defense) return; // random deal can lack a legal defense

  assert.equal(game.handlePlayCard(room, attacker, attack.id), true);
  assert.equal(game.handlePlayCard(room, defender, defense.id), true);
  assert.equal(game.handleDone(room, attacker), true);
  assert.equal(s.attackerIdx, s.playersInfo.findIndex(p => p.id === defender),
    'after successful defense, defender attacks next');
  assert.equal(s.defenderIdx, s.playersInfo.findIndex(p => p.id === attacker),
    'previous attacker defends next');
  assertIntegrity(room);
}

function testNoPrematureGameOver() {
  const room = makeRoom(2);
  game.initGameState(room);
  const s = room.state;
  const attacker = s.playersInfo[s.attackerIdx].id;
  const defender = s.playersInfo[s.defenderIdx].id;

  // Force the endgame: one card each, no talon.
  const aCard = s.hands[attacker][0];
  const dCard = s.hands[defender].find(c => game.canBeat(aCard, c, s.trumpSuit));
  if (!dCard) return;
  const keep = new Set([aCard.id, dCard.id]);
  const remaining = allCards(room).filter(c => !keep.has(c.id));
  s.hands[attacker] = [aCard];
  s.hands[defender] = [dCard];
  s.deck = [];
  s.table = [];
  s.discard = remaining;
  s.isGameOver = false;

  assert.equal(game.handlePlayCard(room, attacker, aCard.id), true);
  assert.equal(s.isGameOver, false, 'game must not end while the attack is unresolved');
  assert.equal(game.handlePlayCard(room, defender, dCard.id), true);
  assert.equal(s.isGameOver, false, 'game must not end before the bout is closed');
  assert.equal(game.handleDone(room, attacker), true);
  assert.equal(s.isGameOver, true, 'game ends only after the final bout');
  assert.equal(s.loser, null, 'both players used their last cards: draw');
  const lastGameOver = [...emitted].reverse().find(x => x.event === 'game_over');
  assert.ok(lastGameOver, 'game_over event must be emitted');
  assert.equal(lastGameOver.data.draw, true);
  if (room.rematchTimer) clearInterval(room.rematchTimer);
  assertIntegrity(room);
}

function testBotSimulation() {
  for (const count of [2, 3, 4]) {
    for (const difficulty of ['easy', 'normal', 'hard']) {
      for (let run = 0; run < 10; run++) {
        const room = makeRoom(count);
        room.players.forEach(p => p.botDifficulty = difficulty);
        game.initGameState(room);
        let steps = 0;
        while (!room.state.isGameOver && steps < 10000) {
          const acted = game.executeBotTurnChain(room);
          assert.ok(acted || room.state.isGameOver, `bot loop stalled: ${count} / ${difficulty}`);
          assertIntegrity(room);
          steps++;
        }
        if (room.rematchTimer) clearInterval(room.rematchTimer);
        assert.ok(room.state.isGameOver, `bot game did not finish: ${count} / ${difficulty}`);
        assert.ok(steps < 10000, `bot game exceeded safety limit: ${count} / ${difficulty}`);
      }
    }
  }
}

function main() {
  testInitialization();
  testTakeRotation();
  testSuccessfulDefenseRotation();
  testNoPrematureGameOver();
  testBotSimulation();
  console.log('SANI GROUP Durak: all logic tests passed.');
}

main();
