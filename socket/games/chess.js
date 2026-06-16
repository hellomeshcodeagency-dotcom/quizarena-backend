// ── CHESS ENGINE ───────────────────────────────────────────
// Simplified chess with legal move validation
const { query } = require('../../db');

const chessRooms = new Map();

const INITIAL_BOARD = [
  ['r','n','b','q','k','b','n','r'],
  ['p','p','p','p','p','p','p','p'],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  ['P','P','P','P','P','P','P','P'],
  ['R','N','B','Q','K','B','N','R'],
];

const isWhite = (piece) => piece && piece === piece.toUpperCase();
const isBlack = (piece) => piece && piece === piece.toLowerCase();
const isOpponent = (piece, white) => white ? isBlack(piece) : isWhite(piece);
const isEmpty = (board, r, c) => r >= 0 && r < 8 && c >= 0 && c < 8 && !board[r][c];
const inBounds = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

const getLegalMoves = (board, row, col, enPassant = null) => {
  const piece = board[row][col];
  if (!piece) return [];
  const white = isWhite(piece);
  const type = piece.toLowerCase();
  const moves = [];

  const addMove = (r, c) => {
    if (!inBounds(r, c)) return false;
    if (!board[r][c]) { moves.push([r, c]); return true; }
    if (isOpponent(board[r][c], white)) { moves.push([r, c]); return false; }
    return false;
  };

  switch (type) {
    case 'p': {
      const dir = white ? -1 : 1;
      const start = white ? 6 : 1;
      if (isEmpty(board, row + dir, col)) {
        moves.push([row + dir, col]);
        if (row === start && isEmpty(board, row + dir * 2, col)) moves.push([row + dir * 2, col]);
      }
      for (const dc of [-1, 1]) {
        if (inBounds(row + dir, col + dc) && isOpponent(board[row + dir][col + dc], white)) {
          moves.push([row + dir, col + dc]);
        }
      }
      break;
    }
    case 'r':
      for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        for (let i = 1; i < 8; i++) { if (!addMove(row + dr * i, col + dc * i)) break; }
      }
      break;
    case 'n':
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        addMove(row + dr, col + dc);
      }
      break;
    case 'b':
      for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
        for (let i = 1; i < 8; i++) { if (!addMove(row + dr * i, col + dc * i)) break; }
      }
      break;
    case 'q':
      for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0],[-1,-1],[-1,1],[1,-1],[1,1]]) {
        for (let i = 1; i < 8; i++) { if (!addMove(row + dr * i, col + dc * i)) break; }
      }
      break;
    case 'k':
      for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0],[-1,-1],[-1,1],[1,-1],[1,1]]) {
        addMove(row + dr, col + dc);
      }
      break;
  }
  return moves;
};

const applyMove = (board, from, to) => {
  const newBoard = board.map(r => [...r]);
  newBoard[to[0]][to[1]] = newBoard[from[0]][from[1]];
  newBoard[from[0]][from[1]] = null;

  // Pawn promotion
  const piece = newBoard[to[0]][to[1]];
  if (piece === 'P' && to[0] === 0) newBoard[to[0]][to[1]] = 'Q';
  if (piece === 'p' && to[0] === 7) newBoard[to[0]][to[1]] = 'q';

  return newBoard;
};

const findKing = (board, white) => {
  const king = white ? 'K' : 'k';
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] === king) return [r, c];
  return null;
};

const isInCheck = (board, white) => {
  const [kr, kc] = findKing(board, white) || [-1, -1];
  if (kr === -1) return false;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] && isOpponent(board[r][c], !white))
        if (getLegalMoves(board, r, c).some(([mr, mc]) => mr === kr && mc === kc))
          return true;
  return false;
};

const setupChess = (io, socket) => {

  socket.on('chess:join', async ({ roomId }) => {
    try {
      socket.join(roomId);

      if (!chessRooms.has(roomId)) {
        chessRooms.set(roomId, {
          board: INITIAL_BOARD.map(r => [...r]),
          players: [],
          colors: {},
          currentTurn: 'white',
          status: 'waiting',
          moveHistory: [],
          timers: { white: 600, black: 600 }, // 10 min each
          timerInterval: null,
        });
      }

      const game = chessRooms.get(roomId);
      if (!game.players.includes(socket.user.id)) {
        game.players.push(socket.user.id);
        game.colors[socket.user.id] = game.players.length === 1 ? 'white' : 'black';
      }

      socket.emit('chess:state', {
        board: game.board,
        colors: game.colors,
        currentTurn: game.currentTurn,
        timers: game.timers,
        status: game.status,
        moveHistory: game.moveHistory,
      });

      if (game.players.length === 2 && game.status === 'waiting') {
        game.status = 'playing';
        io.to(roomId).emit('chess:start', {
          colors: game.colors,
          currentTurn: game.currentTurn,
        });
        startChessTimer(io, roomId);
      }
    } catch (err) {
      console.error('[Chess] join error:', err);
    }
  });

  socket.on('chess:move', ({ roomId, from, to }) => {
    try {
      const game = chessRooms.get(roomId);
      if (!game || game.status !== 'playing') return;

      const myColor = game.colors[socket.user.id];
      if (myColor !== game.currentTurn) return;

      const piece = game.board[from[0]][from[1]];
      if (!piece) return;
      if (myColor === 'white' && !isWhite(piece)) return;
      if (myColor === 'black' && !isBlack(piece)) return;

      const legalMoves = getLegalMoves(game.board, from[0], from[1]);
      const isLegal = legalMoves.some(([r, c]) => r === to[0] && c === to[1]);
      if (!isLegal) { socket.emit('chess:illegal', { from, to }); return; }

      const newBoard = applyMove(game.board, from, to);

      // Don't allow moving into check
      if (isInCheck(newBoard, myColor === 'white')) {
        socket.emit('chess:illegal', { from, to });
        return;
      }

      game.board = newBoard;
      game.moveHistory.push({ from, to, piece });
      game.currentTurn = game.currentTurn === 'white' ? 'black' : 'white';

      const capturedKing = !findKing(newBoard, game.currentTurn === 'white');
      const inCheck = isInCheck(newBoard, game.currentTurn === 'white');

      io.to(roomId).emit('chess:moved', {
        board: game.board,
        from, to, piece,
        currentTurn: game.currentTurn,
        inCheck,
        timers: game.timers,
      });

      if (capturedKing) {
        endChessGame(io, roomId, socket.user.id, 'checkmate');
      }
    } catch (err) {
      console.error('[Chess] move error:', err);
    }
  });

  socket.on('chess:resign', ({ roomId }) => {
    const game = chessRooms.get(roomId);
    if (!game) return;
    const winnerId = game.players.find(id => id !== socket.user.id);
    endChessGame(io, roomId, winnerId, 'resign');
  });

  socket.on('chess:draw', ({ roomId }) => {
    const game = chessRooms.get(roomId);
    if (!game) return;
    io.to(roomId).emit('chess:draw_offer', { from: socket.user.id });
  });

  socket.on('chess:draw_accept', ({ roomId }) => {
    endChessGame(io, roomId, null, 'draw');
  });
};

const startChessTimer = (io, roomId) => {
  const game = chessRooms.get(roomId);
  if (!game) return;

  game.timerInterval = setInterval(() => {
    if (game.status !== 'playing') { clearInterval(game.timerInterval); return; }
    game.timers[game.currentTurn]--;
    io.to(roomId).emit('chess:timer', { timers: game.timers });

    if (game.timers[game.currentTurn] <= 0) {
      clearInterval(game.timerInterval);
      const loserId = game.players.find(id => game.colors[id] === game.currentTurn);
      const winnerId = game.players.find(id => id !== loserId);
      endChessGame(io, roomId, winnerId, 'timeout');
    }
  }, 1000);
};

const endChessGame = async (io, roomId, winnerId, reason) => {
  const game = chessRooms.get(roomId);
  if (!game) return;
  clearInterval(game.timerInterval);
  game.status = 'ended';

  io.to(roomId).emit('chess:ended', { winnerId, reason, board: game.board });

  if (winnerId) {
    try {
      const roomResult = await query('SELECT stake_kobo, max_players FROM game_rooms WHERE id = $1', [roomId]);
      const room = roomResult.rows[0];
      if (room && room.stake_kobo > 0) {
        const prize = Math.round(room.stake_kobo * room.max_players * 0.9);
        await query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [prize, winnerId]);
        await query(
          `INSERT INTO transactions (user_id, type, amount, currency, status, description)
           VALUES ($1, 'win', $2, 'NGN', 'completed', $3)`,
          [winnerId, prize, `Won Chess game by ${reason}`]
        );
      }
    } catch (err) { console.error('[Chess] prize error:', err); }
  }

  chessRooms.delete(roomId);
};

module.exports = { setupChess };
