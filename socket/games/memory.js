// ── MEMORY MATCH ENGINE ────────────────────────────────────
const { query } = require('../../db');

const EMOJIS = ['🎯','💎','🔥','⚡','🎮','🏆','💰','🎪','🌟','🎭','🎸','🚀','🦁','🐯','🦊','🐺'];

const memoryRooms = new Map();

const createBoard = () => {
  const pairs = EMOJIS.slice(0, 8);
  const cards = [...pairs, ...pairs]
    .map((emoji, i) => ({ id: i, emoji, flipped: false, matched: false }))
    .sort(() => Math.random() - 0.5)
    .map((card, i) => ({ ...card, position: i }));
  return cards;
};

const setupMemoryGame = (io, socket) => {

  socket.on('mem:join', async ({ roomId }) => {
    try {
      socket.join(roomId);

      if (!memoryRooms.has(roomId)) {
        memoryRooms.set(roomId, {
          cards: createBoard(),
          players: [],
          scores: {},
          currentTurn: null,
          flippedCards: [],
          status: 'waiting',
          lockBoard: false,
        });
      }

      const game = memoryRooms.get(roomId);
      if (!game.players.includes(socket.user.id)) {
        game.players.push(socket.user.id);
        game.scores[socket.user.id] = 0;
      }

      // Send board without emoji (hidden)
      const hiddenBoard = game.cards.map(c => ({ position: c.position, matched: c.matched, flipped: c.flipped }));

      socket.emit('mem:state', {
        board: hiddenBoard,
        scores: game.scores,
        currentTurn: game.currentTurn,
        status: game.status,
      });

      io.to(roomId).emit('mem:joined', { players: game.players, scores: game.scores });

      if (game.players.length === 2 && game.status === 'waiting') {
        game.status = 'playing';
        game.currentTurn = game.players[0];
        io.to(roomId).emit('mem:start', { currentTurn: game.currentTurn });
      }
    } catch (err) {
      console.error('[Mem] join error:', err);
    }
  });

  socket.on('mem:flip', ({ roomId, position }) => {
    try {
      const game = memoryRooms.get(roomId);
      if (!game || game.status !== 'playing') return;
      if (game.currentTurn !== socket.user.id) return;
      if (game.lockBoard) return;

      const card = game.cards[position];
      if (!card || card.matched || card.flipped) return;

      card.flipped = true;
      game.flippedCards.push(position);

      // Reveal this card to all players
      io.to(roomId).emit('mem:flip', { position, emoji: card.emoji, playerId: socket.user.id });

      if (game.flippedCards.length === 2) {
        game.lockBoard = true;
        const [pos1, pos2] = game.flippedCards;
        const card1 = game.cards[pos1];
        const card2 = game.cards[pos2];

        if (card1.emoji === card2.emoji) {
          // Match!
          card1.matched = true;
          card2.matched = true;
          game.scores[socket.user.id] = (game.scores[socket.user.id] || 0) + 10;
          game.flippedCards = [];
          game.lockBoard = false;

          io.to(roomId).emit('mem:match', {
            positions: [pos1, pos2],
            playerId: socket.user.id,
            scores: game.scores,
          });

          // Check if all matched
          if (game.cards.every(c => c.matched)) {
            endMemoryGame(io, roomId);
          }
          // Same player goes again on match
        } else {
          // No match — flip back after delay
          setTimeout(() => {
            card1.flipped = false;
            card2.flipped = false;
            game.flippedCards = [];
            game.lockBoard = false;

            // Switch turn
            game.currentTurn = game.players.find(id => id !== socket.user.id);

            io.to(roomId).emit('mem:nomatch', {
              positions: [pos1, pos2],
              currentTurn: game.currentTurn,
            });
          }, 1200);
        }
      }
    } catch (err) {
      console.error('[Mem] flip error:', err);
    }
  });
};

const endMemoryGame = async (io, roomId) => {
  const game = memoryRooms.get(roomId);
  if (!game) return;

  const sorted = Object.entries(game.scores).sort(([,a],[,b]) => b - a);
  const winnerId = sorted[0][1] > (sorted[1]?.[1] || -1) ? sorted[0][0] : null;

  io.to(roomId).emit('mem:ended', {
    scores: game.scores,
    winnerId,
    rankings: sorted.map(([id, score], i) => ({ userId: id, score, rank: i + 1 })),
  });

  if (winnerId) {
    try {
      const roomResult = await query('SELECT stake_kobo, max_players FROM game_rooms WHERE id = $1', [roomId]);
      const room = roomResult.rows[0];
      if (room && room.stake_kobo > 0) {
        const prize = Math.round(room.stake_kobo * room.max_players * 0.9);
        await query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [prize, winnerId]);
        await query(
          `INSERT INTO transactions (user_id, type, amount, currency, status, description)
           VALUES ($1, 'win', $2, 'NGN', 'completed', 'Won Memory Match game')`,
          [winnerId, prize]
        );
      }
    } catch (err) { console.error('[Mem] prize error:', err); }
  }

  memoryRooms.delete(roomId);
};

module.exports = { setupMemoryGame };
