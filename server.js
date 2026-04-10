const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const WORDS = [
  'colengo', 'configure', 'ecommerce', 'platform', 'dealer', 'showroom',
  'portal', 'dashboard', 'pricing', 'catalog', 'checkout', 'loyalty',
  'blender', 'texture', 'render', 'visualize', 'preview', 'customize',
  'manufacturer', 'furniture', 'integration', 'automate', 'scalable',
  'analytics', 'oneCORE', 'workflow', 'inventory', 'landing', 'deploy',
  'orders', 'digital', 'channel', 'modules', 'assets', 'product',
  'commerce', 'cloud', 'network', 'optimize', 'augmented', 'virtual',
  'factory', 'design', 'model', 'retail', 'wholesale', 'storefront',
  'shipping', 'domain', 'customer', 'supplier', 'backend', 'frontend',
];

// players[socketId] = { nickname, isAdmin, isAlive }
let players = {};
let adminId = null;

// game state: 'lobby' | 'countdown' | 'playing' | 'results'
let gameState = 'lobby';
let currentWord = '';
let roundStartTime = 0;
// submissions[socketId] = timestamp when they correctly typed the word
let submissions = {};
let roundTimeout = null;
let countdownInterval = null;

function getPlayerList() {
  return Object.entries(players).map(([id, p]) => ({
    id,
    nickname: p.nickname,
    isAdmin: p.isAdmin,
    isAlive: p.isAlive,
  }));
}

function getAlivePlayers() {
  return Object.entries(players).filter(([, p]) => p.isAlive);
}

function pickWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function startCountdown() {
  gameState = 'countdown';
  submissions = {};
  io.emit('countdown-start');

  let count = 3;
  io.emit('countdown-tick', { count });

  countdownInterval = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      startRound();
    } else {
      io.emit('countdown-tick', { count });
    }
  }, 1000);
}

function startRound() {
  currentWord = pickWord();
  gameState = 'playing';
  roundStartTime = Date.now();
  submissions = {};

  io.emit('round-start', { word: currentWord });

  // Auto-end round after 30 seconds for anyone who hasn't typed
  roundTimeout = setTimeout(() => {
    if (gameState === 'playing') {
      endRound();
    }
  }, 30000);
}

function endRound() {
  if (roundTimeout) {
    clearTimeout(roundTimeout);
    roundTimeout = null;
  }
  gameState = 'results';

  const alive = getAlivePlayers();

  // Find the slowest: whoever submitted last, or didn't submit at all
  let slowestId = null;
  let slowestTime = -1;

  alive.forEach(([id]) => {
    // Not submitted = treated as very slow
    const t = submissions[id] != null ? submissions[id] : Infinity;
    if (slowestId === null || t > slowestTime) {
      slowestId = id;
      slowestTime = t;
    }
  });

  if (slowestId && players[slowestId]) {
    players[slowestId].isAlive = false;
  }

  const results = alive
    .map(([id]) => ({
      nickname: players[id] ? players[id].nickname : '?',
      elapsed: submissions[id] != null ? submissions[id] - roundStartTime : null,
      eliminated: id === slowestId,
    }))
    .sort((a, b) => {
      const ta = a.elapsed != null ? a.elapsed : 999999;
      const tb = b.elapsed != null ? b.elapsed : 999999;
      return ta - tb;
    });

  io.emit('round-result', {
    results,
    eliminatedNickname: slowestId && players[slowestId] ? players[slowestId].nickname : null,
    players: getPlayerList(),
  });

  const stillAlive = getAlivePlayers();
  if (stillAlive.length <= 1) {
    setTimeout(endGame, 3000);
  } else {
    setTimeout(() => {
      if (Object.keys(players).length >= 2) {
        startCountdown();
      } else {
        gameState = 'lobby';
        io.emit('back-to-lobby', { players: getPlayerList() });
      }
    }, 4000);
  }
}

function endGame() {
  gameState = 'lobby';
  const alive = getAlivePlayers();
  const winnerName = alive.length > 0 && players[alive[0][0]]
    ? players[alive[0][0]].nickname
    : 'Nobody';

  // Reset everyone to alive for next game
  Object.keys(players).forEach((id) => {
    players[id].isAlive = true;
  });

  io.emit('game-over', {
    winner: winnerName,
    players: getPlayerList(),
  });
}

io.on('connection', (socket) => {
  socket.on('join-lobby', ({ nickname }) => {
    const clean = (nickname || '').trim().substring(0, 20);
    if (!clean) return;

    const isFirst = Object.keys(players).length === 0;
    if (isFirst) adminId = socket.id;

    players[socket.id] = {
      nickname: clean,
      isAdmin: isFirst,
      isAlive: true,
    };

    socket.emit('joined', {
      isAdmin: isFirst,
      players: getPlayerList(),
      gameState,
    });

    socket.broadcast.emit('player-joined', { players: getPlayerList() });
  });

  socket.on('start-game', () => {
    if (socket.id !== adminId) return;
    if (gameState !== 'lobby') return;
    if (getAlivePlayers().length < 2) {
      socket.emit('error-msg', { msg: 'Need at least 2 players to start.' });
      return;
    }

    // Reset alive status for all
    Object.keys(players).forEach((id) => {
      players[id].isAlive = true;
    });

    startCountdown();
  });

  socket.on('submit-word', ({ word }) => {
    if (gameState !== 'playing') return;
    if (!players[socket.id] || !players[socket.id].isAlive) return;
    if (submissions[socket.id] != null) return; // already submitted

    if (word.trim().toLowerCase() === currentWord.toLowerCase()) {
      submissions[socket.id] = Date.now();
      const elapsed = submissions[socket.id] - roundStartTime;

      socket.emit('submission-accepted', { elapsed });
      io.emit('player-submitted', {
        nickname: players[socket.id].nickname,
        elapsed,
      });

      // Check if all alive players have submitted
      const alive = getAlivePlayers();
      if (alive.every(([id]) => submissions[id] != null)) {
        endRound();
      }
    } else {
      socket.emit('submission-rejected');
    }
  });

  socket.on('disconnect', () => {
    if (!players[socket.id]) return;

    const wasAdmin = players[socket.id].isAdmin;
    delete players[socket.id];

    // Reassign admin if needed
    if (wasAdmin) {
      const remaining = Object.keys(players);
      if (remaining.length > 0) {
        adminId = remaining[0];
        players[adminId].isAdmin = true;
        io.to(adminId).emit('promoted-to-admin');
      } else {
        adminId = null;
      }
    }

    io.emit('player-left', { players: getPlayerList() });

    // If game is running, check if round should end or game over
    if (gameState === 'playing') {
      const alive = getAlivePlayers();
      if (alive.length <= 1) {
        if (roundTimeout) clearTimeout(roundTimeout);
        endGame();
        return;
      }
      if (alive.every(([id]) => submissions[id] != null)) {
        endRound();
      }
    }

    if (gameState === 'lobby' || gameState === 'countdown') {
      // If not enough players, abort countdown
      if (getAlivePlayers().length < 2 && gameState === 'countdown') {
        if (countdownInterval) clearInterval(countdownInterval);
        countdownInterval = null;
        gameState = 'lobby';
        io.emit('back-to-lobby', { players: getPlayerList() });
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
