const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const crypto  = require('crypto')
const { query, getClient } = require('../db')
const { sendWelcome, sendResetPassword } = require('../config/email')

const generateReferralCode = async (client, username) => {
  let code, exists
  do {
    const suffix = Math.random().toString(36).substring(2, 7).toUpperCase()
    code = `${username.substring(0, 4).toUpperCase()}-${suffix}`
    const check = await client.query('SELECT id FROM users WHERE referral_code = $1', [code])
    exists = check.rows.length > 0
  } while (exists)
  return code
}

const signToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  })

// ── REGISTER ───────────────────────────────────────────────
const register = async (req, res, next) => {
  const client = await getClient()
  try {
    const { username, email, phone, password, referralCode } = req.body

    if (!username || !email || !password)
      return res.status(400).json({ error: 'Username, email and password are required' })
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    if (username.length < 3 || username.length > 30)
      return res.status(400).json({ error: 'Username must be 3–30 characters' })
    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' })

    const dupCheck = await query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)',
      [email, username]
    )
    if (dupCheck.rows.length > 0)
      return res.status(409).json({ error: 'Email or username already taken' })

    await client.query('BEGIN')

    const passwordHash   = await bcrypt.hash(password, 12)
    const myReferralCode = await generateReferralCode(client, username)
    const initials       = username.substring(0, 2).toUpperCase()
    const signupCoins    = parseInt(process.env.SIGNUP_COINS) || 20

    let referrerId = null
    if (referralCode && referralCode.trim()) {
      const refResult = await client.query(
        'SELECT id FROM users WHERE referral_code = $1',
        [referralCode.trim().toUpperCase()]
      )
      if (refResult.rows[0]) referrerId = refResult.rows[0].id
    }

    const userResult = await client.query(
      `INSERT INTO users (username, email, phone, password_hash, avatar_initials, referral_code, referred_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, email, referral_code`,
      [username, email.toLowerCase(), phone || null, passwordHash, initials, myReferralCode, referrerId]
    )
    const user = userResult.rows[0]

    await client.query('INSERT INTO wallets (user_id, balance, coins) VALUES ($1, 0, $2)', [user.id, signupCoins])
    await client.query('INSERT INTO user_stats (user_id) VALUES ($1)', [user.id])

    if (referrerId) {
      await client.query('INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)', [referrerId, user.id])
    }

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, currency, status, description)
       VALUES ($1, 'coin_purchase', $2, 'COINS', 'completed', 'Signup bonus coins')`,
      [user.id, signupCoins]
    )

    await client.query('COMMIT')

    // Send welcome email (non-blocking)
    sendWelcome({
      to:           email.toLowerCase(),
      username,
      referralCode: myReferralCode,
      coins:        signupCoins,
    }).catch(err => console.error('[Welcome email]', err.message))

    const token = signToken(user.id)
    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id:             user.id,
        username:       user.username,
        email:          user.email,
        referralCode:   user.referral_code,
        avatarInitials: initials,
        coins:          signupCoins,
        balance:        0,
        isVip:          false,
      },
    })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.code === '23505') return res.status(409).json({ error: 'Email or username already taken' })
    next(err)
  } finally {
    client.release()
  }
}

// ── LOGIN ──────────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const { identifier, password } = req.body
    if (!identifier || !password)
      return res.status(400).json({ error: 'Email/phone and password are required' })

    const result = await query(
      `SELECT u.*, w.balance, w.coins
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE LOWER(u.email) = LOWER($1) OR u.phone = $1`,
      [identifier.trim()]
    )
    const user = result.rows[0]
    if (!user)           return res.status(401).json({ error: 'Invalid credentials' })
    if (!user.is_active) return res.status(403).json({ error: 'Account is deactivated' })

    const match = await bcrypt.compare(password, user.password_hash)
    if (!match) return res.status(401).json({ error: 'Invalid credentials' })

    const token = signToken(user.id)
    res.json({
      token,
      user: {
        id:             user.id,
        username:       user.username,
        email:          user.email,
        avatarInitials: user.avatar_initials,
        isVip:          user.is_vip,
        referralCode:   user.referral_code,
        balance:        user.balance || 0,
        coins:          user.coins   || 0,
      },
    })
  } catch (err) { next(err) }
}

// ── ME ─────────────────────────────────────────────────────
const me = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.email, u.phone, u.avatar_initials,
              u.is_vip, u.vip_expires_at, u.referral_code,
              u.kyc_verified, u.created_at,
              w.balance, w.coins,
              s.total_games, s.total_wins, s.total_losses,
              s.total_earned_kobo, s.win_streak, s.best_streak,
              s.accuracy_pct, s.global_rank
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN user_stats s ON s.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    )
    const u = result.rows[0]
    if (!u) return res.status(404).json({ error: 'User not found' })
    res.json({
      user: {
        id:             u.id,
        username:       u.username,
        email:          u.email,
        phone:          u.phone,
        avatarInitials: u.avatar_initials,
        isVip:          u.is_vip,
        vipExpiresAt:   u.vip_expires_at,
        referralCode:   u.referral_code,
        kycVerified:    u.kyc_verified,
        createdAt:      u.created_at,
        balance:        u.balance           || 0,
        coins:          u.coins             || 0,
        totalGames:     u.total_games       || 0,
        totalWins:      u.total_wins        || 0,
        totalLosses:    u.total_losses      || 0,
        totalEarned:    u.total_earned_kobo || 0,
        winStreak:      u.win_streak        || 0,
        bestStreak:     u.best_streak       || 0,
        accuracyPct:    u.accuracy_pct      || 0,
        globalRank:     u.global_rank,
      },
    })
  } catch (err) { next(err) }
}

// ── FORGOT PASSWORD ────────────────────────────────────────
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    const result = await query(
      'SELECT id, username, email FROM users WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    )

    // Always return success even if email not found (security)
    if (!result.rows[0]) {
      return res.json({ message: 'If that email exists, a reset link has been sent.' })
    }

    const user = result.rows[0]

    // Generate secure token
    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

    // Delete old tokens for this user
    await query('DELETE FROM password_resets WHERE user_id = $1', [user.id])

    // Save token hash
    await query(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    )

    // Send email (non-blocking)
    sendResetPassword({
      to:         user.email,
      username:   user.username,
      resetToken: rawToken,
    }).catch(err => console.error('[Reset email]', err.message))

    res.json({ message: 'If that email exists, a reset link has been sent.' })
  } catch (err) { next(err) }
}

// ── RESET PASSWORD ─────────────────────────────────────────
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body
    if (!token || !newPassword)
      return res.status(400).json({ error: 'Token and new password are required' })
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' })

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

    const result = await query(
      `SELECT pr.*, u.username, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash = $1 AND pr.used = FALSE AND pr.expires_at > NOW()`,
      [tokenHash]
    )

    if (!result.rows[0])
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' })

    const reset = result.rows[0]
    const passwordHash = await bcrypt.hash(newPassword, 12)

    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, reset.user_id])
    await query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id])

    res.json({ message: 'Password reset successfully. You can now log in.' })
  } catch (err) { next(err) }
}

// ── CHANGE PASSWORD (authenticated) ───────────────────────
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Current and new password are required' })
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' })
    if (currentPassword === newPassword)
      return res.status(400).json({ error: 'New password must be different from current' })

    const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])
    const match  = await bcrypt.compare(currentPassword, result.rows[0].password_hash)
    if (!match) return res.status(400).json({ error: 'Current password is incorrect' })

    const hash = await bcrypt.hash(newPassword, 12)
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id])

    res.json({ message: 'Password changed successfully' })
  } catch (err) { next(err) }
}

module.exports = { register, login, me, forgotPassword, resetPassword, changePassword }
