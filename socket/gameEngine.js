const { query, getClient } = require('../db');
const jwt = require('jsonwebtoken');

const PLATFORM_CUT = parseFloat(process.env.PLATFORM_CUT_PCT || '10') / 100;
const QUESTION_TIME = 15; // seconds per question
const BETWEEN_Q_TIME = 1500; // ms between questions

// Active game state stored in memory
const activeGames = new Map(); // roomId -> gameState

const setupSocket = (io) => {

  // ── AUTH MIDDLEWARE FOR SOCKET ──────────────────────────
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

    // ── JOIN ROOM ─────────────────────────────────────────
    socket.on('join_room', async ({ roomId }) => {
      try {
        const roomResult = await query(
          `SELECT gr.*, 
             ARRAY_AGG(json_build_object('userId', gp.user_id, 'username', u.username)) as players
           FROM game_rooms gr
           JOIN game_players gp ON gp.room_id = gr.id
           JOIN users u ON u.id = gp.user_id
           WHERE gr.id = $1
           GROUP BY gr.id`,
          [roomId]
        );

        const room = roomResult.rows[0];
        if (!room) return socket.emit('error', { message: 'Room not found' });

        socket.join(roomId);
        socket.roomId = roomId;

        // Notify everyone in room
        io.to(roomId).emit('player_joined', {
          userId: socket.user.id,
          username: socket.user.username,
          players: room.players,
        });

        // If room is full, start the game
        if (room.players.length >= room.max_players) {
          await startGame(io, roomId, room);
        }

      } catch (err) {
        console.error('[Socket] join_room error:', err);
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    // ── SUBMIT ANSWER ─────────────────────────────────────
    socket.on('submit_answer', async ({ roomId, questionIndex, answer, responseTimeMs }) => {
      try {
        const game = activeGames.get(roomId);
        if (!game || game.currentQuestionIndex !== questionIndex) return;
        if (game.answers[questionIndex]?.[socket.user.id]) return; // already answered

        const question = game.questions[questionIndex];
        const isCorrect = answer === question.correct;
        const timeBonus = Math.max(0, Math.round((QUESTION_TIME * 1000 - responseTimeMs) / 1000 * 85));
        const points = isCorrect ? 100 + timeBonus : 0;

        // Store answer
        if (!game.answers[questionIndex]) game.answers[questionIndex] = {};
        game.answers[questionIndex][socket.user.id] = { answer, isCorrect, points };

        // Update player score
        if (!game.scores[socket.user.id]) game.scores[socket.user.id] = 0;
        game.scores[socket.user.id] += points;

        // Emit answer result to the player who answered
        socket.emit('answer_result', {
          questionIndex,
          isCorrect,
          correctAnswer: question.correct,
          points,
          totalScore: game.scores[socket.user.id],
        });

        // Broadcast score update to room
        io.to(roomId).emit('score_update', {
          userId: socket.user.id,
          username: socket.user.username,
          score: game.scores[socket.user.id],
        });

        // Check if all players answered
        const answeredCount = Object.keys(game.answers[questionIndex] || {}).length;
        if (answeredCount >= game.playerCount) {
          clearTimeout(game.questionTimer);
          setTimeout(() => advanceQuestion(io, roomId), 800);
        }
      } catch (err) {
        console.error('[Socket] submit_answer error:', err);
      }
    });

    // ── DISCONNECT ────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Socket] ${socket.user.username} disconnected`);
      if (socket.roomId) {
        io.to(socket.roomId).emit('player_disconnected', {
          userId: socket.user.id,
          username: socket.user.username,
        });
      }
    });
  });
};

// ── START GAME ────────────────────────────────────────────
const startGame = async (io, roomId, room) => {
  const client = await getClient();
  try {
    // Load questions
    const questionsResult = await query(
      `SELECT id, question, option_a, option_b, option_c, option_d, correct
       FROM questions WHERE id = ANY($1::uuid[])`,
      [room.question_ids]
    );

    const questions = questionsResult.rows;
    const playerIds = room.players.map(p => p.userId);

    const gameState = {
      roomId,
      questions,
      currentQuestionIndex: 0,
      scores: {},
      answers: {},
      playerCount: room.players.length,
      playerIds,
      stakeKobo: room.stake_kobo,
      questionTimer: null,
    };

    activeGames.set(roomId, gameState);

    // Mark room as active
    await client.query(
      "UPDATE game_rooms SET status = 'active', started_at = NOW() WHERE id = $1",
      [roomId]
    );

    // Countdown then first question
    io.to(roomId).emit('game_starting', { countdown: 3 });
    setTimeout(() => sendQuestion(io, roomId), 3000);
  } catch (err) {
    console.error('[Socket] startGame error:', err);
  } finally {
    client.release();
  }
};

// ── SEND QUESTION ─────────────────────────────────────────
const sendQuestion = (io, roomId) => {
  const game = activeGames.get(roomId);
  if (!game) return;

  const q = game.questions[game.currentQuestionIndex];
  if (!q) { endGame(io, roomId); return; }

  // Strip correct answer before sending to clients
  io.to(roomId).emit('question', {
    index: game.currentQuestionIndex,
    total: game.questions.length,
    question: q.question,
    options: { a: q.option_a, b: q.option_b, c: q.option_c, d: q.option_d },
    timeLimit: QUESTION_TIME,
  });

  // Auto-advance after time limit
  game.questionTimer = setTimeout(() => {
    advanceQuestion(io, roomId);
  }, QUESTION_TIME * 1000 + 500);
};

// ── ADVANCE TO NEXT QUESTION ──────────────────────────────
const advanceQuestion = (io, roomId) => {
  const game = activeGames.get(roomId);
  if (!game) return;

  clearTimeout(game.questionTimer);

  // Reveal correct answer
  const q = game.questions[game.currentQuestionIndex];
  io.to(roomId).emit('question_ended', {
    index: game.currentQuestionIndex,
    correctAnswer: q.correct,
    scores: game.scores,
  });

  game.currentQuestionIndex++;
  if (game.currentQuestionIndex >= game.questions.length) {
    setTimeout(() => endGame(io, roomId), BETWEEN_Q_TIME);
  } else {
    setTimeout(() => sendQuestion(io, roomId), BETWEEN_Q_TIME);
  }
};

// ── END GAME ──────────────────────────────────────────────
const endGame = async (io, roomId) => {
  const client = await getClient();
  try {
    const game = activeGames.get(roomId);
    if (!game) return;

    // Determine winner (highest score)
    const sortedPlayers = Object.entries(game.scores)
      .sort(([, a], [, b]) => b - a);

    const winnerId = sortedPlayers[0]?.[0];
    const totalPot = game.stakeKobo * game.playerCount;
    const platformFee = Math.round(totalPot * PLATFORM_CUT);
    const prize = totalPot - platformFee;

    await client.query('BEGIN');

    // Credit winner
    if (winnerId && prize > 0) {
      await client.query(
        'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
        [prize, winnerId]
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, currency, status, description, metadata)
         VALUES ($1, 'win', $2, 'NGN', 'completed', $3, $4)`,
        [winnerId, prize, `Won ${game.playerCount === 2 ? '1v1' : 'group'} match`, JSON.stringify({ roomId })]
      );
    }

    // Update room
    await client.query(
      "UPDATE game_rooms SET status = 'completed', ended_at = NOW(), winner_id = $1, prize_kobo = $2, platform_cut_kobo = $3 WHERE id = $4",
      [winnerId, prize, platformFee, roomId]
    );

    // Update player stats
    for (let i = 0; i < sortedPlayers.length; i++) {
      const [userId, score] = sortedPlayers[i];
      const isWinner = userId === winnerId;
      const correctAnswers = Object.values(game.answers)
        .filter(a => a[userId]?.isCorrect).length;

      await client.query(
        `UPDATE user_stats SET
           total_games = total_games + 1,
           total_wins = total_wins + $1,
           total_losses = total_losses + $2,
           total_earned_kobo = total_earned_kobo + $3,
           win_streak = CASE WHEN $1 = 1 THEN win_streak + 1 ELSE 0 END,
           best_streak = GREATEST(best_streak, CASE WHEN $1 = 1 THEN win_streak + 1 ELSE 0 END),
           updated_at = NOW()
         WHERE user_id = $4`,
        [isWinner ? 1 : 0, isWinner ? 0 : 1, isWinner ? prize : 0, userId]
      );

      await client.query(
        'UPDATE game_players SET score = $1, rank = $2 WHERE room_id = $3 AND user_id = $4',
        [score, i + 1, roomId, userId]
      );
    }

    await client.query('COMMIT');

    // Notify players
    io.to(roomId).emit('game_ended', {
      winnerId,
      winnerUsername: null, // client can look this up
      scores: game.scores,
      prize,
      platformFee,
      rankings: sortedPlayers.map(([userId, score], i) => ({ userId, score, rank: i + 1 })),
    });

    // Cashback for losers (10% of stake)
    if (game.playerCount === 2 && winnerId) {
      const loserId = game.playerIds.find(id => id !== winnerId);
      if (loserId) {
        const cashback = Math.round(game.stakeKobo * 0.1);
        await query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [cashback, loserId]);
        await query(
          `INSERT INTO transactions (user_id, type, amount, currency, status, description)
           VALUES ($1, 'cashback', $2, 'NGN', 'completed', '10% cashback on loss')`,
          [loserId, cashback]
        );
      }
    }

    // Cleanup
    activeGames.delete(roomId);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Socket] endGame error:', err);
  } finally {
    client.release();
  }
};

module.exports = { setupSocket };
