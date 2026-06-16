// ── SPEED MATH ENGINE ─────────────────────────────────────
const { query } = require('../../db');

const mathRooms = new Map();

const generateQuestion = (round) => {
  const difficulty = Math.min(round, 5);
  const ops = difficulty <= 2 ? ['+', '-'] : difficulty <= 4 ? ['+', '-', '×'] : ['+', '-', '×', '÷'];
  const op = ops[Math.floor(Math.random() * ops.length)];

  let a, b, answer;
  switch (op) {
    case '+':
      a = Math.floor(Math.random() * (10 * difficulty)) + 1;
      b = Math.floor(Math.random() * (10 * difficulty)) + 1;
      answer = a + b;
      break;
    case '-':
      a = Math.floor(Math.random() * (10 * difficulty)) + 10;
      b = Math.floor(Math.random() * a) + 1;
      answer = a - b;
      break;
    case '×':
      a = Math.floor(Math.random() * (3 * difficulty)) + 2;
      b = Math.floor(Math.random() * 12) + 2;
      answer = a * b;
      break;
    case '÷':
      b = Math.floor(Math.random() * 11) + 2;
      answer = Math.floor(Math.random() * 10) + 2;
      a = b * answer;
      break;
  }

  // Generate wrong options
  const options = new Set([answer]);
  while (options.size < 4) {
    const wrong = answer + (Math.floor(Math.random() * 10) - 5);
    if (wrong !== answer && wrong > 0) options.add(wrong);
  }

  const shuffled = [...options].sort(() => Math.random() - 0.5);

  return {
    question: `${a} ${op} ${b} = ?`,
    answer,
    options: shuffled,
  };
};

const setupSpeedMath = (io, socket) => {

  socket.on('math:join', async ({ roomId }) => {
    try {
      socket.join(roomId);

      if (!mathRooms.has(roomId)) {
        mathRooms.set(roomId, {
          players: [],
          scores: {},
          round: 0,
          totalRounds: 15,
          currentQ: null,
          status: 'waiting',
          answered: {},
          timer: null,
        });
      }

      const game = mathRooms.get(roomId);
      if (!game.players.includes(socket.user.id)) {
        game.players.push(socket.user.id);
        game.scores[socket.user.id] = 0;
      }

      io.to(roomId).emit('math:joined', { players: game.players, scores: game.scores });

      if (game.players.length >= 2 && game.status === 'waiting') {
        game.status = 'countdown';
        io.to(roomId).emit('math:countdown', { seconds: 3 });
        setTimeout(() => sendMathQuestion(io, roomId), 3000);
      }
    } catch (err) {
      console.error('[Math] join error:', err);
    }
  });

  socket.on('math:answer', ({ roomId, answer }) => {
    try {
      const game = mathRooms.get(roomId);
      if (!game || game.status !== 'playing') return;
      if (game.answered[socket.user.id]) return; // already answered

      const isCorrect = answer === game.currentQ.answer;
      game.answered[socket.user.id] = true;

      if (isCorrect) {
        // First correct answer gets more points
        const firstCorrect = Object.values(game.answered).filter(Boolean).length === 1;
        const pts = firstCorrect ? 150 : 75;
        game.scores[socket.user.id] = (game.scores[socket.user.id] || 0) + pts;

        socket.emit('math:result', { correct: true, answer: game.currentQ.answer, points: pts, totalScore: game.scores[socket.user.id] });
        io.to(roomId).emit('math:scores', { scores: game.scores });

        // If all players answered or first correct — move on
        const allAnswered = game.players.every(id => game.answered[id]);
        if (allAnswered || firstCorrect) {
          clearTimeout(game.timer);
          setTimeout(() => {
            game.round++;
            if (game.round >= game.totalRounds) {
              endMathGame(io, roomId);
            } else {
              sendMathQuestion(io, roomId);
            }
          }, 1000);
        }
      } else {
        socket.emit('math:result', { correct: false, answer: game.currentQ.answer, points: 0, totalScore: game.scores[socket.user.id] });
      }
    } catch (err) {
      console.error('[Math] answer error:', err);
    }
  });
};

const sendMathQuestion = (io, roomId) => {
  const game = mathRooms.get(roomId);
  if (!game) return;

  game.status = 'playing';
  game.answered = {};
  game.currentQ = generateQuestion(game.round + 1);

  io.to(roomId).emit('math:question', {
    round: game.round + 1,
    total: game.totalRounds,
    question: game.currentQ.question,
    options: game.currentQ.options,
    timeLimit: 10,
  });

  game.timer = setTimeout(() => {
    io.to(roomId).emit('math:timeout', { answer: game.currentQ.answer });
    game.round++;
    if (game.round >= game.totalRounds) {
      endMathGame(io, roomId);
    } else {
      setTimeout(() => sendMathQuestion(io, roomId), 1000);
    }
  }, 10000);
};

const endMathGame = async (io, roomId) => {
  const game = mathRooms.get(roomId);
  if (!game) return;
  clearTimeout(game.timer);

  const sorted = Object.entries(game.scores).sort(([,a],[,b]) => b - a);
  const winnerId = sorted[0][1] > (sorted[1]?.[1] || -1) ? sorted[0][0] : null;

  io.to(roomId).emit('math:ended', {
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
           VALUES ($1, 'win', $2, 'NGN', 'completed', 'Won Speed Math game')`,
          [winnerId, prize]
        );
      }
    } catch (err) { console.error('[Math] prize error:', err); }
  }

  mathRooms.delete(roomId);
};

module.exports = { setupSpeedMath };
