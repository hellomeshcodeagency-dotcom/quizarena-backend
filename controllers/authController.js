const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, getClient } = require('../db');

// Generate a referral code
const generateReferralCode = (username) => {
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${username.substring(0, 4).toUpperCase()}-${suffix}`;
};

// Sign a JWT
const signToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// ── REGISTER ───────────────────────────────────────────────
const register = async (req, res, next) => {
  const client = await getClient();
  try {
    const { username, email, phone, password, referralCode } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3–30 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
    }

    await client.query('BEGIN');

    const passwordHash = await bcrypt.hash(password, 12);
    const myReferralCode = generateReferralCode(username);
    const initials = username.substring(0, 2).toUpperCase();

    // Check if a referrer exists
    let referrerId = null;
    if (referralCode) {
      const refResult = await client.query(
        'SELECT id FROM users WHERE referral_code = $1',
        [referralCode.toUpperCase()]
      );
      if (refResult.rows[0]) referrerId = refResult.rows[0].id;
    }

    // Create user
    const userResult = await client.query(
      `INSERT INTO users (username, email, phone, password_hash, avatar_initials, referral_code, referred_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, username, email, referral_code`,
      [username, email.toLowerCase(), phone || null, passwordHash, initials, myReferralCode, referrerId]
    );
    const user = userResult.rows[0];

    // Create wallet with 20 free signup coins
    const signupCoins = parseInt(process.env.SIGNUP_COINS) || 20;
    await client.query(
      'INSERT INTO wallets (user_id, balance, coins) VALUES ($1, 0, $2)',
      [user.id, signupCoins]
    );

    // Create user stats
    await client.query(
      'INSERT INTO user_stats (user_id) VALUES ($1)',
      [user.id]
    );

    // If referred, record referral (coins awarded when they first deposit)
    if (referrerId) {
      await client.query(
        'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)',
        [referrerId, user.id]
      );
    }

    // Log signup coin transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, currency, status, description)
       VALUES ($1, 'coin_purchase', $2, 'COINS', 'completed', 'Signup bonus coins')`,
      [user.id, signupCoins]
    );

    await client.query('COMMIT');

    const token = signToken(user.id);
    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        referralCode: user.referral_code,
        coins: signupCoins,
        balance: 0,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── LOGIN ──────────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { identifier, password } = req.body; // identifier = email or phone

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email/phone and password are required' });
    }

    const result = await query(
      `SELECT u.*, w.balance, w.coins
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.email = $1 OR u.phone = $1`,
      [identifier.toLowerCase()]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated' });

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user.id);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatarInitials: user.avatar_initials,
        isVip: user.is_vip,
        referralCode: user.referral_code,
        balance: user.balance || 0,
        coins: user.coins || 0,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── ME (get current user) ──────────────────────────────────
const me = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.email, u.phone, u.avatar_initials, u.is_vip,
              u.vip_expires_at, u.referral_code, u.kyc_verified, u.created_at,
              w.balance, w.coins,
              s.total_games, s.total_wins, s.total_losses, s.total_earned_kobo,
              s.win_streak, s.best_streak, s.accuracy_pct, s.global_rank
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN user_stats s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, me };
