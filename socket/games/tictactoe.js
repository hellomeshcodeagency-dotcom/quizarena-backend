// ── TIC-TAC-TOE ENGINE ────────────────────────────────────
const { query } = require('../../db');

const tttRooms = new Map(); // roomId -> state

const checkWinner = (board) => {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6],         // diags
  ];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a,b,c] };
    }
  }
  if (board.every(c => c)) return { winner: 'draw', line: [] };
  return null;
};

const setupTicTacToe = (io, socket) => {

  socket.on('ttt:join', async ({ roomId }) => {
    try {
      socket.join(roomId);

      if (!tttRooms.has(roomId)) {
        tttRooms.set(roomId, {
          board: Array(9).fill(null),
          players: [],
          symbols: {},
          currentTurn: null,
          status: 'waiting',
        });
      }

      const game = tttRooms.get(roomId);

      if (!game.players.includes(socket.user.id)) {
        game.players.push(socket.user.id);
        game.symbols[socket.user.id] = game.players.length === 1 ? 'X' : 'O';
      }

      io.to(roomId).emit('ttt:state', {
        board: game.board,
        players: game.players,
        symbols: game.symbols,
        currentTurn: game.currentTurn,
        status: game.status,
      });

      if (game.players.length === 2 && game.status === 'waiting') {
        game.status = 'playing';
        game.currentTurn = game.players[0];
        io.to(roomId).emit('ttt:start', {
          symbols: game.symbols,
          currentTurn: game.currentTurn,
        });
      }
    } catch (err) {
      console.error('[TTT] join error:', err);
    }
  });

  socket.on('ttt:move', async ({ roomId, cellIndex }) => {
    try {
      const game = tttRooms.get(roomId);
      if (!game || game.status !== 'playing') return;
      if (game.currentTurn !== socket.user.id) return;
      if (game.board[cellIndex]) return;

      const symbol = game.symbols[socket.user.id];
      game.board[cellIndex] = symbol;

      const result = checkWinner(game.board);

      if (result) {
        game.status = 'ended';
        const winnerId = result.winner === 'draw'
          ? null
          : game.players.find(id => game.symbols[id] === result.winner);

        io.to(roomId).emit('ttt:move', { board: game.board, cellIndex, symbol, playerId: socket.user.id });
        io.to(roomId).emit('ttt:ended', { result: result.winner, winnerId, line: result.line });

        // Distribute prize
        if (winnerId) {
          const roomResult = await query('SELECT stake_kobo, max_players FROM game_rooms WHERE id = $1', [roomId]);
          const room = roomResult.rows[0];
          if (room) {
            const pot = room.stake_kobo * room.max_players;
            const prize = Math.round(pot * 0.9);
            await query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [prize, winnerId]);
            await query(
              `INSERT INTO transactions (user_id, type, amount, currency, status, description)
               VALUES ($1, 'win', $2, 'NGN', 'completed', 'Won Tic-tac-toe match')`,
              [winnerId, prize]
            );
          }
        }
        tttRooms.delete(roomId);
      } else {
        // Switch turn
        game.currentTurn = game.players.find(id => id !== socket.user.id);
        io.to(roomId).emit('ttt:move', { board: game.board, cellIndex, symbol, playerId: socket.user.id });
        io.to(roomId).emit('ttt:turn', { currentTurn: game.currentTurn });
      }
    } catch (err) {
      console.error('[TTT] move error:', err);
    }
  });

  socket.on('ttt:resign', ({ roomId }) => {
    const game = tttRooms.get(roomId);
    if (!game) return;
    const winnerId = game.players.find(id => id !== socket.user.id);
    io.to(roomId).emit('ttt:ended', { result: 'resign', winnerId, line: [] });
    tttRooms.delete(roomId);
  });
};

module.exports = { setupTicTacToe };
