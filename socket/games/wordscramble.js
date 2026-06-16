// ── WORD SCRAMBLE ENGINE ───────────────────────────────────
const { query } = require('../../db');

const WORD_BANK = [
  { word: 'JAVASCRIPT', hint: 'Popular programming language' },
  { word: 'NIGERIA', hint: 'West African country' },
  { word: 'CHAMPION', hint: 'Winner of a competition' },
  { word: 'PLATFORM', hint: 'A raised surface or software base' },
  { word: 'STRATEGY', hint: 'A plan of action' },
  { word: 'FOOTBALL', hint: 'Most popular sport in Nigeria' },
  { word: 'ECONOMY', hint: 'System of trade and money' },
  { word: 'TREASURE', hint: 'Hidden valuable things' },
  { word: 'PUZZLE', hint: 'A game that tests ingenuity' },
  { word: 'VICTORY', hint: 'Winning a contest' },
  { word: 'NOLLYWOOD', hint: 'Nigerian film industry' },
  { word: 'KEYBOARD', hint: 'Used for typing' },
  { word: 'PAYMENT', hint: 'Giving money for goods or services' },
  { word: 'QUESTION', hint: 'Something you ask' },
  { word: 'ADVENTURE', hint: 'An exciting experience' },
  { word: 'BLOCKCHAIN', hint: 'Distributed ledger technology' },
  { word: 'TOURNAMENT', hint: 'A series of competitions' },
  { word: 'LEADERBOARD', hint: 'Ranking of top players' },
  { word: 'COMMUNITY', hint: 'A group of people' },
  { word: 'TECHNOLOGY', hint: 'Application of science' },
];

const scramble = (word) => {
  const arr = word.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const result = arr.join('');
  return result === word ? scramble(word) : result;
};

const wordRooms = new Map();

const setupWordGame = (io, socket) => {

  socket.on('word:join', async ({ roomId }) => {
    try {
      socket.join(roomId);

      if (!wordRooms.has(roomId)) {
        const words = [...WORD_BANK].sort(() => Math.random() - 0.5).slice(0, 8);
        wordRooms.set(roomId, {
          words,
          currentIndex: 0,
          players: [],
          scores: {},
          status: 'waiting',
          timer: null,
        });
      }

      const game = wordRooms.get(roomId);
      if (!game.players.includes(socket.user.id)) {
        game.players.push(socket.user.id);
        game.scores[socket.user.id] = 0;
      }

      io.to(roomId).emit('word:joined', {
        players: game.players,
        scores: game.scores,
        status: game.status,
      });

      if (game.players.length === 2 && game.status === 'waiting') {
        game.status = 'countdown';
        io.to(roomId).emit('word:countdown', { seconds: 3 });
        setTimeout(() => sendWordRound(io, roomId), 3000);
      }
    } catch (err) {
      console.error('[Word] join error:', err);
    }
  });

  socket.on('word:guess', ({ roomId, guess }) => {
    try {
      const game = wordRooms.get(roomId);
      if (!game || game.status !== 'playing') return;

      const current = game.words[game.currentIndex];
      if (guess.toUpperCase() === current.word) {
        game.scores[socket.user.id] = (game.scores[socket.user.id] || 0) + 100;
        clearTimeout(game.timer);

        io.to(roomId).emit('word:correct', {
          playerId: socket.user.id,
          word: current.word,
          scores: game.scores,
        });

        game.currentIndex++;
        if (game.currentIndex >= game.words.length) {
          endWordGame(io, roomId);
        } else {
          setTimeout(() => sendWordRound(io, roomId), 1500);
        }
      } else {
        socket.emit('word:wrong', { guess });
      }
    } catch (err) {
      console.error('[Word] guess error:', err);
    }
  });
};

const sendWordRound = (io, roomId) => {
  const game = wordRooms.get(roomId);
  if (!game) return;

  game.status = 'playing';
  const current = game.words[game.currentIndex];
  const scrambled = scramble(current.word);

  io.to(roomId).emit('word:round', {
    index: game.currentIndex,
    total: game.words.length,
    scrambled,
    hint: current.hint,
    length: current.word.length,
    timeLimit: 30,
  });

  // Auto-advance after 30 seconds
  game.timer = setTimeout(() => {
    io.to(roomId).emit('word:timeout', { word: current.word });
    game.currentIndex++;
    if (game.currentIndex >= game.words.length) {
      endWordGame(io, roomId);
    } else {
      setTimeout(() => sendWordRound(io, roomId), 1500);
    }
  }, 30000);
};

const endWordGame = async (io, roomId) => {
  const game = wordRooms.get(roomId);
  if (!game) return;

  clearTimeout(game.timer);
  game.status = 'ended';

  const sorted = Object.entries(game.scores).sort(([,a],[,b]) => b - a);
  const winnerId = sorted[0]?.[0];
  const isDraw = sorted.length > 1 && sorted[0][1] === sorted[1][1];

  io.to(roomId).emit('word:ended', {
    scores: game.scores,
    winnerId: isDraw ? null : winnerId,
    rankings: sorted.map(([id, score], i) => ({ userId: id, score, rank: i + 1 })),
  });

  if (winnerId && !isDraw) {
    try {
      const roomResult = await query('SELECT stake_kobo, max_players FROM game_rooms WHERE id = $1', [roomId]);
      const room = roomResult.rows[0];
      if (room && room.stake_kobo > 0) {
        const pot   = room.stake_kobo * room.max_players;
        const prize = Math.round(pot * 0.9);
        await query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [prize, winnerId]);
        await query(
          `INSERT INTO transactions (user_id, type, amount, currency, status, description)
           VALUES ($1, 'win', $2, 'NGN', 'completed', 'Won Word Scramble match')`,
          [winnerId, prize]
        );
      }
    } catch (err) { console.error('[Word] prize error:', err); }
  }

  wordRooms.delete(roomId);
};

module.exports = { setupWordGame };
