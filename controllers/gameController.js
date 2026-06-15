const { query, getClient } = require('../db');
const { v4: uuidv4 } = require('uuid');

const PLATFORM_CUT = parseFloat(process.env.PLATFORM_CUT_PCT || '10') / 100;

// ── GET QUESTIONS FOR A GAME ───────────────────────────────
const getQuestions = async (category, count = 10) => {
  const result = await query(
    `SELECT id, question, option_a, option_b, option_c, option_d, correct
     FROM questions
     WHERE category = $1 AND is_active = TRUE
     ORDER BY RANDOM()
     LIMIT $2`,
    [category, count]
  );
  return result.rows;
};

// ── FIND OR CREATE ROOM (matchmaking) ─────────────────────
const findMatch = async (req, res, next) => {
  const client = await getClient();
  try {
    const { category, stakeNaira, playerCount = 2 } = req.body;
    if (!category || stakeNaira === undefined) {
      return res.status(400).json({ error: 'Category and stake are required' });
    }

    const stakeKobo = Math.round(stakeNaira * 100);

    // Check user balance
    const walletResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (!walletResult.rows[0] || walletResult.rows[0].balance < stakeKobo) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await client.query('BEGIN');

    // Look for a waiting room matching criteria
    const existingRoom = await client.query(
      `SELECT gr.id, gr.room_code, COUNT(gp.id) as current_players
       FROM game_rooms gr
       LEFT JOIN game_players gp ON gp.room_id = gr.id
       WHERE gr.status = 'waiting'
         AND gr.category = $1
         AND gr.stake_kobo = $2
         AND gr.max_players = $3
         AND gr.mode = $4
       GROUP BY gr.id
       HAVING COUNT(gp.id) < $3
       ORDER BY gr.created_at ASC
       LIMIT 1`,
      [category, stakeKobo, playerCount, playerCount === 2 ? '1v1' : 'group']
    );

    let roomId, roomCode, isNew = false;

    if (existingRoom.rows[0]) {
      // Join existing room
      roomId = existingRoom.rows[0].id;
      roomCode = existingRoom.rows[0].room_code;
    } else {
      // Create a new room
      roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const questions = await getQuestions(category, 10);
      const questionIds = questions.map(q => q.id);

      const roomResult = await client.query(
        `INSERT INTO game_rooms (room_code, mode, category, stake_kobo, max_players, question_ids)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          roomCode,
          playerCount === 2 ? '1v1' : 'group',
          category,
          stakeKobo,
          playerCount,
          questionIds,
        ]
      );
      roomId = roomResult.rows[0].id;
      isNew = true;
    }

    // Add player to room
    await client.query(
      'INSERT INTO game_players (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [roomId, req.user.id]
    );

    // Deduct stake from wallet
    await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
      [stakeKobo, req.user.id]
    );
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, currency, status, description, metadata)
       VALUES ($1, 'loss', $2, 'NGN', 'pending', $3, $4)`,
      [req.user.id, stakeKobo, `Entered ${category} match`, JSON.stringify({ roomId })]
    );

    await client.query('COMMIT');

    res.json({ roomId, roomCode, isNew });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── GET ROOM STATE ─────────────────────────────────────────
const getRoom = async (req, res, next) => {
  try {
    const { roomId } = req.params;
    const roomResult = await query(
      `SELECT gr.*, 
         json_agg(json_build_object(
           'userId', gp.user_id,
           'username', u.username,
           'score', gp.score,
           'rank', gp.rank
         )) as players
       FROM game_rooms gr
       LEFT JOIN game_players gp ON gp.room_id = gr.id
       LEFT JOIN users u ON u.id = gp.user_id
       WHERE gr.id = $1
       GROUP BY gr.id`,
      [roomId]
    );
    if (!roomResult.rows[0]) return res.status(404).json({ error: 'Room not found' });
    res.json({ room: roomResult.rows[0] });
  } catch (err) { next(err); }
};

// ── LEADERBOARD ────────────────────────────────────────────
const getLeaderboard = async (req, res, next) => {
  try {
    const { period = 'weekly', category, limit = 50 } = req.query;
    const dateFilter = period === 'weekly' ? "AND t.created_at > NOW() - INTERVAL '7 days'" : '';

    const result = await query(
      `SELECT 
         u.id, u.username, u.avatar_initials,
         SUM(t.amount) as total_earned_kobo,
         s.total_wins, s.accuracy_pct,
         ROW_NUMBER() OVER (ORDER BY SUM(t.amount) DESC) as rank
       FROM users u
       JOIN transactions t ON t.user_id = u.id AND t.type = 'win' AND t.status = 'completed' ${dateFilter}
       JOIN user_stats s ON s.user_id = u.id
       GROUP BY u.id, u.username, u.avatar_initials, s.total_wins, s.accuracy_pct
       ORDER BY total_earned_kobo DESC
       LIMIT $1`,
      [parseInt(limit)]
    );

    // Get current user's rank
    let userRank = null;
    if (req.user) {
      const userRankResult = await query(
        `SELECT rank FROM (
           SELECT u.id, ROW_NUMBER() OVER (ORDER BY SUM(t.amount) DESC) as rank
           FROM users u
           JOIN transactions t ON t.user_id = u.id AND t.type = 'win' AND t.status = 'completed' ${dateFilter}
           GROUP BY u.id
         ) ranked WHERE id = $1`,
        [req.user.id]
      );
      userRank = userRankResult.rows[0]?.rank;
    }

    res.json({ leaderboard: result.rows, userRank });
  } catch (err) { next(err); }
};

// ── USER STATS ─────────────────────────────────────────────
const getUserStats = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.*, w.balance, w.coins
       FROM user_stats s
       JOIN wallets w ON w.user_id = s.user_id
       WHERE s.user_id = $1`,
      [req.user.id]
    );
    res.json({ stats: result.rows[0] });
  } catch (err) { next(err); }
};

// ── CATEGORIES ─────────────────────────────────────────────
const getCategories = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT category, COUNT(*) as question_count
       FROM questions WHERE is_active = TRUE
       GROUP BY category ORDER BY category`
    );
    res.json({ categories: result.rows });
  } catch (err) { next(err); }
};

module.exports = { findMatch, getRoom, getLeaderboard, getUserStats, getCategories };
