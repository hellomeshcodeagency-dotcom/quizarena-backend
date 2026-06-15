const { query, getClient } = require('../db');

// ── LIST TOURNAMENTS ───────────────────────────────────────
const listTournaments = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT t.*,
         COUNT(tr.id) as registered_count,
         (SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id = t.id AND user_id = $1) as user_registered
       FROM tournaments t
       LEFT JOIN tournament_registrations tr ON tr.tournament_id = t.id
       WHERE t.status IN ('upcoming','registering')
       GROUP BY t.id
       ORDER BY t.starts_at ASC`,
      [req.user?.id || null]
    );
    res.json({ tournaments: result.rows });
  } catch (err) { next(err); }
};

// ── REGISTER FOR TOURNAMENT ────────────────────────────────
const registerTournament = async (req, res, next) => {
  const client = await getClient();
  try {
    const { tournamentId } = req.params;

    const tournResult = await client.query(
      'SELECT * FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    const tournament = tournResult.rows[0];
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    if (tournament.status !== 'registering' && tournament.status !== 'upcoming') {
      return res.status(400).json({ error: 'Tournament is not open for registration' });
    }
    if (tournament.is_vip_only) {
      const userResult = await client.query('SELECT is_vip FROM users WHERE id = $1', [req.user.id]);
      if (!userResult.rows[0]?.is_vip) {
        return res.status(403).json({ error: 'This tournament is VIP only' });
      }
    }

    // Check spots
    const countResult = await client.query(
      'SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id = $1',
      [tournamentId]
    );
    if (parseInt(countResult.rows[0].count) >= tournament.max_players) {
      return res.status(400).json({ error: 'Tournament is full' });
    }

    await client.query('BEGIN');

    // Deduct entry fee
    if (tournament.entry_fee_kobo > 0) {
      const walletResult = await client.query(
        'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
        [req.user.id]
      );
      if (walletResult.rows[0].balance < tournament.entry_fee_kobo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient balance for entry fee' });
      }
      await client.query(
        'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
        [tournament.entry_fee_kobo, req.user.id]
      );
    }

    await client.query(
      'INSERT INTO tournament_registrations (tournament_id, user_id) VALUES ($1, $2)',
      [tournamentId, req.user.id]
    );

    // Update prize pool
    const platformCut = Math.round(tournament.entry_fee_kobo * (tournament.platform_cut_pct / 100));
    const playerContribution = tournament.entry_fee_kobo - platformCut;
    await client.query(
      'UPDATE tournaments SET prize_pool_kobo = prize_pool_kobo + $1 WHERE id = $2',
      [playerContribution, tournamentId]
    );

    await client.query('COMMIT');
    res.json({ message: 'Successfully registered for tournament' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Already registered for this tournament' });
    next(err);
  } finally {
    client.release();
  }
};

module.exports = { listTournaments, registerTournament };
