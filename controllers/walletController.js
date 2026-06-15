const axios = require('axios');
const { query, getClient } = require('../db');

const PLATFORM_CUT = parseInt(process.env.PLATFORM_CUT_PCT || '10') / 100;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const REFERRAL_COINS = parseInt(process.env.REFERRAL_COINS || '100');

// ── GET WALLET ─────────────────────────────────────────────
const getWallet = async (req, res, next) => {
  try {
    const result = await query(
      'SELECT balance, coins FROM wallets WHERE user_id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Wallet not found' });
    res.json({ wallet: result.rows[0] });
  } catch (err) { next(err); }
};

// ── GET TRANSACTIONS ───────────────────────────────────────
const getTransactions = async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const result = await query(
      `SELECT id, type, amount, currency, status, description, created_at
       FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, parseInt(limit), parseInt(offset)]
    );
    res.json({ transactions: result.rows });
  } catch (err) { next(err); }
};

// ── INITIALIZE DEPOSIT (Paystack) ──────────────────────────
const initializeDeposit = async (req, res, next) => {
  try {
    const { amount } = req.body; // amount in Naira
    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Minimum deposit is ₦100' });
    }

    const amountKobo = Math.round(amount * 100);
    const userResult = await query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const email = userResult.rows[0]?.email;

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amountKobo,
        metadata: {
          user_id: req.user.id,
          type: 'deposit',
        },
        callback_url: `${process.env.CLIENT_URL}/wallet?deposit=success`,
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const { reference, authorization_url } = response.data.data;

    // Create pending transaction
    await query(
      `INSERT INTO transactions (user_id, type, amount, currency, reference, status, description)
       VALUES ($1, 'deposit', $2, 'NGN', $3, 'pending', $4)`,
      [req.user.id, amountKobo, reference, `Deposit ₦${amount.toLocaleString()}`]
    );

    res.json({ authorization_url, reference });
  } catch (err) { next(err); }
};

// ── VERIFY DEPOSIT (Paystack webhook / manual verify) ─────
const verifyDeposit = async (req, res, next) => {
  const client = await getClient();
  try {
    const { reference } = req.params;

    // Verify with Paystack
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const { status, amount, metadata } = response.data.data;
    if (status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful' });
    }

    const userId = metadata?.user_id || req.user.id;

    // Check not already processed
    const existing = await query(
      "SELECT status FROM transactions WHERE reference = $1",
      [reference]
    );
    if (existing.rows[0]?.status === 'completed') {
      return res.json({ message: 'Already processed' });
    }

    await client.query('BEGIN');

    // Calculate deposit bonus (10% if >= ₦5,000)
    const bonus = amount >= 500000 ? Math.round(amount * 0.1) : 0;
    const totalCredit = amount + bonus;
    const bonusCoins = 50; // coins on every deposit

    // Credit wallet
    await client.query(
      'UPDATE wallets SET balance = balance + $1, coins = coins + $2, updated_at = NOW() WHERE user_id = $3',
      [totalCredit, bonusCoins, userId]
    );

    // Mark transaction complete
    await client.query(
      "UPDATE transactions SET status = 'completed' WHERE reference = $1",
      [reference]
    );

    // If there's a bonus, record it
    if (bonus > 0) {
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, currency, status, description)
         VALUES ($1, 'deposit', $2, 'NGN', 'completed', 'Deposit bonus 10%')`,
        [userId, bonus]
      );
    }

    // Check if this user was referred — if so, award referrer coins
    const refResult = await client.query(
      "SELECT * FROM referrals WHERE referred_id = $1 AND status = 'pending'",
      [userId]
    );
    if (refResult.rows[0]) {
      const referral = refResult.rows[0];
      // Award referrer coins
      await client.query(
        'UPDATE wallets SET coins = coins + $1 WHERE user_id = $2',
        [REFERRAL_COINS, referral.referrer_id]
      );
      // Award referred user coins too
      await client.query(
        'UPDATE wallets SET coins = coins + 50 WHERE user_id = $1',
        [userId]
      );
      // Mark referral complete
      await client.query(
        "UPDATE referrals SET status = 'completed', coins_awarded = $1, completed_at = NOW() WHERE id = $2",
        [REFERRAL_COINS, referral.id]
      );
      // Log coin transactions
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, currency, status, description)
         VALUES ($1, 'referral_coin', $2, 'COINS', 'completed', 'Referral reward — friend deposited')`,
        [referral.referrer_id, REFERRAL_COINS]
      );
    }

    await client.query('COMMIT');

    const walletResult = await query('SELECT balance, coins FROM wallets WHERE user_id = $1', [userId]);
    res.json({
      message: 'Deposit successful',
      wallet: walletResult.rows[0],
      bonus,
      bonusCoins,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── WITHDRAW ───────────────────────────────────────────────
const withdraw = async (req, res, next) => {
  const client = await getClient();
  try {
    const { amount, bankCode, accountNumber, accountName } = req.body;
    if (!amount || amount < 1000) return res.status(400).json({ error: 'Minimum withdrawal is ₦1,000' });
    if (!bankCode || !accountNumber) return res.status(400).json({ error: 'Bank details are required' });

    const amountKobo = Math.round(amount * 100);

    await client.query('BEGIN');

    const walletResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (!walletResult.rows[0] || walletResult.rows[0].balance < amountKobo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct balance
    await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
      [amountKobo, req.user.id]
    );

    // Record withdrawal transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, currency, status, description, metadata)
       VALUES ($1, 'withdrawal', $2, 'NGN', 'pending', $3, $4)`,
      [
        req.user.id,
        amountKobo,
        `Withdrawal to ${accountName || accountNumber}`,
        JSON.stringify({ bankCode, accountNumber, accountName }),
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Withdrawal request submitted. Processing within 24 hours.' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── BUY COINS ──────────────────────────────────────────────
const buyCoins = async (req, res, next) => {
  const COIN_PACKS = { 100: 200, 300: 500, 700: 1000, 2000: 2500 };
  const client = await getClient();
  try {
    const { coins } = req.body;
    const priceNaira = COIN_PACKS[coins];
    if (!priceNaira) return res.status(400).json({ error: 'Invalid coin pack' });

    const priceKobo = priceNaira * 100;

    await client.query('BEGIN');
    const walletResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (walletResult.rows[0].balance < priceKobo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    await client.query(
      'UPDATE wallets SET balance = balance - $1, coins = coins + $2, updated_at = NOW() WHERE user_id = $3',
      [priceKobo, coins, req.user.id]
    );
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, currency, status, description)
       VALUES ($1, 'coin_purchase', $2, 'COINS', 'completed', $3)`,
      [req.user.id, coins, `Purchased ${coins} coins for ₦${priceNaira}`]
    );

    await client.query('COMMIT');
    const updated = await query('SELECT balance, coins FROM wallets WHERE user_id = $1', [req.user.id]);
    res.json({ message: `${coins} coins added`, wallet: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

module.exports = { getWallet, getTransactions, initializeDeposit, verifyDeposit, withdraw, buyCoins };
