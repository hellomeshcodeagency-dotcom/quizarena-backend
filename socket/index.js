const { setupSocket } = require('./gameEngine');
const { setupTicTacToe } = require('./games/tictactoe');
const { setupWordGame } = require('./games/wordscramble');
const { setupMemoryGame } = require('./games/memory');
const { setupSpeedMath } = require('./games/speedmath');
const { setupChess } = require('./games/chess');
const jwt = require('jsonwebtoken');
const { query } = require('../db');

const setupAllSockets = (io) => {
  // Auth middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const result = await query('SELECT id, username FROM users WHERE id = $1 AND is_active = TRUE', [decoded.userId]);
      if (!result.rows[0]) return next(new Error('User not found'));
      socket.user = result.rows[0];
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] ${socket.user.username} connected`);

    // Quiz game (existing)
    setupSocket._setupHandlers(io, socket);

    // New games
    setupTicTacToe(io, socket);
    setupWordGame(io, socket);
    setupMemoryGame(io, socket);
    setupSpeedMath(io, socket);
    setupChess(io, socket);

    socket.on('disconnect', () => {
      console.log(`[Socket] ${socket.user.username} disconnected`);
    });
  });
};

module.exports = { setupAllSockets };
