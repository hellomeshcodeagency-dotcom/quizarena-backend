const express = require('express');
const { auth, optionalAuth } = require('../middleware/auth');
const { register, login, me, forgotPassword, resetPassword, changePassword } = require('../controllers/authController');
const { getWallet, getTransactions, initializeDeposit, verifyDeposit, withdraw, buyCoins } = require('../controllers/walletController');
const { findMatch, getRoom, getLeaderboard, getUserStats, getCategories } = require('../controllers/gameController');
const { listTournaments, registerTournament } = require('../controllers/tournamentController');
const { query } = require('../db');

const router = express.Router();

// ── HEALTH ─────────────────────────────────────────────────
router.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── AUTH ───────────────────────────────────────────────────
router.post('/auth/register', register);
router.post('/auth/login',    login);
router.get('/auth/me',        auth, me);
router.post('/auth/forgot-password', forgotPassword);
router.post('/auth/reset-password',  resetPassword);
router.post('/auth/change-password', auth, changePassword);

// ── WALLET ─────────────────────────────────────────────────
router.get('/wallet',                     auth, getWallet);
router.get('/wallet/transactions',        auth, getTransactions);
router.post('/wallet/deposit/init',       auth, initializeDeposit);
router.get('/wallet/deposit/verify/:reference', auth, verifyDeposit);
router.post('/wallet/withdraw',           auth, withdraw);
router.post('/wallet/coins/buy',          auth, buyCoins);

// ── GAME ───────────────────────────────────────────────────
router.post('/game/match',               auth, findMatch);
router.get('/game/room/:roomId',         auth, getRoom);
router.get('/game/categories',           getCategories);
router.get('/game/leaderboard',          optionalAuth, getLeaderboard);
router.get('/game/stats',                auth, getUserStats);

// ── TOURNAMENTS ────────────────────────────────────────────
router.get('/tournaments',               optionalAuth, listTournaments);
router.post('/tournaments/:tournamentId/register', auth, registerTournament);

// ── ADS ────────────────────────────────────────────────────
router.get('/ads', async (req, res, next) => {
  try {
    const { placement } = req.query;
    const result = await query(
      'SELECT * FROM ads WHERE is_active = TRUE AND ($1::text IS NULL OR placement = $1) ORDER BY RANDOM() LIMIT 3',
      [placement || null]
    );
    res.json({ ads: result.rows });
  } catch (err) { next(err); }
});

// ── REFERRALS ──────────────────────────────────────────────
router.get('/referrals', auth, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT r.*, u.username as referred_username, r.status, r.coins_awarded
       FROM referrals r
       JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json({ referrals: result.rows });
  } catch (err) { next(err); }
});

// ── VIP SUBSCRIPTION ───────────────────────────────────────
router.post('/vip/subscribe', auth, async (req, res, next) => {
  const { plan } = req.body;
  const PLANS = {
    weekly:  { price: 50000,   days: 7,   coins: 50  },
    monthly: { price: 150000,  days: 30,  coins: 200 },
    annual:  { price: 1200000, days: 365, coins: 2400 },
  };
  const selected = PLANS[plan];
  if (!selected) return res.status(400).json({ error: 'Invalid plan' });

  const { getClient } = require('../db');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const wallet = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (wallet.rows[0].balance < selected.price) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + selected.days);

    await client.query(
      'UPDATE wallets SET balance = balance - $1, coins = coins + $2 WHERE user_id = $3',
      [selected.price, selected.coins, req.user.id]
    );
    await client.query(
      'UPDATE users SET is_vip = TRUE, vip_expires_at = $1 WHERE id = $2',
      [expiresAt, req.user.id]
    );
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, currency, status, description)
       VALUES ($1, 'vip', $2, 'NGN', 'completed', $3)`,
      [req.user.id, selected.price, `VIP ${plan} subscription`]
    );
    await client.query('COMMIT');
    res.json({ message: 'VIP activated', expiresAt });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
