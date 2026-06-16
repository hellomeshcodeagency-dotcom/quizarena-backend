const nodemailer = require('nodemailer')

const BASE_URL = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '')
const APP_NAME = 'BrainBattle'
const SUPPORT  = process.env.EMAIL_USER || 'support@brainbattle.com'

const getTransporter = () => nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
})

const sendMail = async ({ to, subject, html }) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[Email] EMAIL_USER or EMAIL_PASS not set - skipping:', subject)
    return
  }
  try {
    const transporter = getTransporter()
    await transporter.sendMail({
      from: `"${APP_NAME}" <${process.env.EMAIL_USER}>`,
      to, subject, html,
    })
    console.log(`[Email] Sent "${subject}" to ${to}`)
  } catch (err) {
    console.error('[Email] Failed:', err.message)
  }
}

const layout = (content) => `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
  body{margin:0;padding:0;background:#0A0A0F;font-family:'Helvetica Neue',Arial,sans-serif;color:#F0F0FF}
  .w{max-width:560px;margin:0 auto;padding:40px 20px}
  .card{background:#13131A;border:1px solid #2A2A50;border-radius:16px;padding:36px}
  .logo{font-size:26px;font-weight:900;letter-spacing:-0.5px;color:#fff;margin-bottom:28px;text-align:center}
  .logo em{color:#6C63FF;font-style:normal}
  h1{font-size:22px;font-weight:800;margin:0 0 12px;color:#F0F0FF}
  p{font-size:14px;line-height:1.7;color:#A0A0CC;margin:0 0 16px}
  .btn{display:inline-block;background:linear-gradient(135deg,#6C63FF,#8B85FF);color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;margin:8px 0 20px}
  hr{border:none;border-top:1px solid #2A2A50;margin:24px 0}
  .footer{text-align:center;font-size:12px;color:#5A5A8A;margin-top:24px}
  .stat{display:inline-block;background:#1E1E38;border:1px solid #2A2A50;border-radius:10px;padding:12px 20px;margin:6px;text-align:center}
  .sv{font-size:22px;font-weight:800;display:block}
  .sl{font-size:11px;color:#5A5A8A;text-transform:uppercase;letter-spacing:.06em}
  .gold{color:#FFB800}.teal{color:#00D4AA}.ref{background:#1E1E38;border:1px dashed #6C63FF;border-radius:10px;padding:16px;text-align:center;margin:12px 0 20px}
</style>
</head>
<body>
<div class="w"><div class="card">
<div class="logo">Brain<em>Battle</em></div>
${content}
</div>
<div class="footer">&copy; ${new Date().getFullYear()} BrainBattle &middot; Nigeria's real-money puzzle platform<br>
Questions? <a href="mailto:${SUPPORT}" style="color:#6C63FF">${SUPPORT}</a></div>
</div></body></html>`

const sendWelcome = async ({ to, username, referralCode, coins }) => {
  await sendMail({
    to,
    subject: `Welcome to BrainBattle, ${username}! 🎮`,
    html: layout(`
      <h1>Welcome, ${username}! 🎉</h1>
      <p>You've joined Nigeria's most exciting real-money puzzle and quiz platform. Your account is ready to go.</p>
      <div style="text-align:center;margin:20px 0">
        <div class="stat"><span class="sv gold">${coins}</span><span class="sl">Free coins</span></div>
        <div class="stat"><span class="sv teal">5</span><span class="sl">Free practices/day</span></div>
      </div>
      <p><strong style="color:#F0F0FF">Your referral code:</strong></p>
      <div class="ref">
        <span style="font-family:monospace;font-size:24px;font-weight:800;color:#FFB800;letter-spacing:4px">${referralCode}</span>
        <p style="margin:8px 0 0;font-size:12px;color:#5A5A8A">Share this — earn 100 coins for every friend who deposits</p>
      </div>
      <p><strong style="color:#F0F0FF">How to start winning:</strong><br>
      1. Deposit funds into your wallet<br>
      2. Pick a game — Quiz, Chess, Word Scramble and more<br>
      3. Stake ₦, beat your opponent, withdraw instantly</p>
      <div style="text-align:center"><a href="${BASE_URL}/dashboard" class="btn">Start Playing →</a></div>
      <hr>
      <p style="font-size:12px;color:#5A5A8A">No cash bonuses. No hidden fees. Platform takes 10% on every match only.</p>
    `),
  })
}

const sendResetPassword = async ({ to, username, resetToken }) => {
  const resetUrl = `${BASE_URL}/reset-password?token=${resetToken}`
  await sendMail({
    to,
    subject: 'Reset your BrainBattle password',
    html: layout(`
      <h1>Reset your password</h1>
      <p>Hi ${username}, we received a request to reset your BrainBattle password.</p>
      <p>This link expires in <strong style="color:#FFB800">1 hour</strong>. If you didn't request this, ignore this email.</p>
      <div style="text-align:center"><a href="${resetUrl}" class="btn">Reset Password →</a></div>
      <hr>
      <p style="font-size:12px;word-break:break-all;color:#5A5A8A">Or copy this link:<br>${resetUrl}</p>
    `),
  })
}

module.exports = { sendWelcome, sendResetPassword }
