-- ============================================================
-- QUIZARENA DATABASE SCHEMA
-- PostgreSQL
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      VARCHAR(30) UNIQUE NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  phone         VARCHAR(20) UNIQUE,
  password_hash TEXT NOT NULL,
  avatar_initials VARCHAR(3) NOT NULL DEFAULT 'QA',
  is_vip        BOOLEAN DEFAULT FALSE,
  vip_expires_at TIMESTAMPTZ,
  referral_code VARCHAR(20) UNIQUE NOT NULL,
  referred_by   UUID REFERENCES users(id),
  kyc_verified  BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── WALLETS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance     BIGINT NOT NULL DEFAULT 0,   -- stored in kobo (₦1 = 100 kobo)
  coins       INTEGER NOT NULL DEFAULT 20, -- 20 free coins on signup
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── TRANSACTIONS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id),
  type          VARCHAR(20) NOT NULL, -- deposit | withdrawal | win | loss | cashback | coin_purchase | referral_coin | vip
  amount        BIGINT NOT NULL,      -- in kobo for naira, integer for coins
  currency      VARCHAR(10) NOT NULL DEFAULT 'NGN', -- NGN or COINS
  reference     VARCHAR(100) UNIQUE,  -- paystack reference
  status        VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | completed | failed
  description   TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── QUESTIONS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category    VARCHAR(50) NOT NULL,
  difficulty  VARCHAR(10) NOT NULL DEFAULT 'medium', -- easy | medium | hard
  question    TEXT NOT NULL,
  option_a    TEXT NOT NULL,
  option_b    TEXT NOT NULL,
  option_c    TEXT NOT NULL,
  option_d    TEXT NOT NULL,
  correct     CHAR(1) NOT NULL CHECK (correct IN ('a','b','c','d')),
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── GAME ROOMS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_rooms (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_code       VARCHAR(10) UNIQUE NOT NULL,
  mode            VARCHAR(20) NOT NULL, -- 1v1 | group | tournament_match | practice
  category        VARCHAR(50) NOT NULL,
  stake_kobo      BIGINT NOT NULL DEFAULT 0, -- entry fee per player in kobo
  max_players     INTEGER NOT NULL DEFAULT 2,
  status          VARCHAR(20) NOT NULL DEFAULT 'waiting', -- waiting | active | completed | cancelled
  tournament_id   UUID,  -- set if part of a tournament
  winner_id       UUID REFERENCES users(id),
  prize_kobo      BIGINT DEFAULT 0,  -- total prize (after platform cut)
  platform_cut_kobo BIGINT DEFAULT 0,
  question_ids    UUID[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ
);

-- ── GAME PLAYERS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_players (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id     UUID NOT NULL REFERENCES game_rooms(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  score       INTEGER NOT NULL DEFAULT 0,
  correct     INTEGER NOT NULL DEFAULT 0,
  wrong       INTEGER NOT NULL DEFAULT 0,
  rank        INTEGER,
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(room_id, user_id)
);

-- ── TOURNAMENTS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournaments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(100) NOT NULL,
  category        VARCHAR(50) NOT NULL,
  entry_fee_kobo  BIGINT NOT NULL DEFAULT 0,
  max_players     INTEGER NOT NULL,
  prize_pool_kobo BIGINT NOT NULL DEFAULT 0,
  platform_cut_pct INTEGER NOT NULL DEFAULT 20, -- percentage
  status          VARCHAR(20) NOT NULL DEFAULT 'upcoming', -- upcoming | registering | active | completed
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ,
  sponsor_name    VARCHAR(100),
  is_vip_only     BOOLEAN DEFAULT FALSE,
  winner_id       UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── TOURNAMENT REGISTRATIONS ───────────────────────────────
CREATE TABLE IF NOT EXISTS tournament_registrations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id   UUID NOT NULL REFERENCES tournaments(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  registered_at   TIMESTAMPTZ DEFAULT NOW(),
  final_rank      INTEGER,
  prize_won_kobo  BIGINT DEFAULT 0,
  UNIQUE(tournament_id, user_id)
);

-- ── USER STATS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_stats (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID UNIQUE NOT NULL REFERENCES users(id),
  total_games     INTEGER DEFAULT 0,
  total_wins      INTEGER DEFAULT 0,
  total_losses    INTEGER DEFAULT 0,
  total_earned_kobo BIGINT DEFAULT 0,
  win_streak      INTEGER DEFAULT 0,
  best_streak     INTEGER DEFAULT 0,
  accuracy_pct    NUMERIC(5,2) DEFAULT 0,
  global_rank     INTEGER,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── REFERRALS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id     UUID NOT NULL REFERENCES users(id),
  referred_id     UUID NOT NULL REFERENCES users(id),
  status          VARCHAR(20) DEFAULT 'pending', -- pending | completed
  coins_awarded   INTEGER DEFAULT 0,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_id)
);

-- ── ADS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title       VARCHAR(200) NOT NULL,
  body        TEXT,
  cta_text    VARCHAR(50),
  cta_url     VARCHAR(500),
  sponsor     VARCHAR(100),
  placement   VARCHAR(50) NOT NULL, -- banner | interstitial | leaderboard
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── SESSIONS (for auth) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ════════════════════════════════════════════════
-- INDEXES
-- ════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_transactions_user    ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status  ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_game_players_room    ON game_players(room_id);
CREATE INDEX IF NOT EXISTS idx_game_players_user    ON game_players(user_id);
CREATE INDEX IF NOT EXISTS idx_game_rooms_status    ON game_rooms(status);
CREATE INDEX IF NOT EXISTS idx_questions_category   ON questions(category);
CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer   ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_tourn_reg_user       ON tournament_registrations(user_id);

-- ════════════════════════════════════════════════
-- SEED: QUESTION BANK
-- ════════════════════════════════════════════════
INSERT INTO questions (category, difficulty, question, option_a, option_b, option_c, option_d, correct) VALUES
-- SPORTS
('Sports','easy','Which Nigerian footballer is nicknamed Jay-Jay?','Nwankwo Kanu','Jay-Jay Okocha','Rashidi Yekini','Sunday Oliseh','b'),
('Sports','easy','In what year did Nigeria first qualify for the FIFA World Cup?','1990','1994','1998','2002','b'),
('Sports','medium','How many times has Nigeria won the Africa Cup of Nations (AFCON)?','2','3','4','5','b'),
('Sports','medium','Who scored Nigeria''s first ever World Cup goal in 1994?','Rashidi Yekini','Sunday Oliseh','Emmanuel Amuneke','Daniel Amokachi','a'),
('Sports','easy','Nigeria won Olympic football gold in which year?','1992','1996','2000','2004','b'),
('Sports','medium','Which Nigerian club won the CAF Champions League in 2003 and 2004?','Rangers International','Shooting Stars','Enyimba FC','Heartland FC','c'),
('Sports','hard','Which Nigerian won the Premier League Invincibles season with Arsenal?','Nwankwo Kanu','Jay-Jay Okocha','Emmanuel Amuneke','Celestine Babayaro','a'),
('Sports','medium','The Moshood Abiola National Stadium is located in which city?','Lagos','Kano','Abuja','Port Harcourt','c'),
('Sports','hard','Which club did Victor Osimhen join after his record season at Napoli?','Chelsea','Arsenal','Galatasaray','PSG','c'),
('Sports','easy','What is the nickname of the Nigerian national football team?','Golden Lions','Super Eagles','Green Panthers','Flying Eagles','b'),
-- SCIENCE
('Science','easy','What is the chemical symbol for Gold?','Go','Gd','Au','Ag','c'),
('Science','easy','How many bones are in the adult human body?','196','206','216','226','b'),
('Science','easy','Which planet is known as the Red Planet?','Venus','Jupiter','Saturn','Mars','d'),
('Science','medium','What is the approximate speed of light in vacuum?','200,000 km/s','300,000 km/s','400,000 km/s','500,000 km/s','b'),
('Science','easy','What is the powerhouse of the cell?','Nucleus','Ribosome','Mitochondria','Chloroplast','c'),
('Science','easy','What gas do plants absorb during photosynthesis?','Oxygen','Nitrogen','Carbon Dioxide','Hydrogen','c'),
('Science','medium','What is the atomic number of Carbon?','4','6','8','12','b'),
('Science','medium','Who discovered Penicillin?','Louis Pasteur','Alexander Fleming','Marie Curie','Isaac Newton','b'),
('Science','hard','What is the hardest natural substance on Earth?','Gold','Iron','Diamond','Titanium','c'),
('Science','medium','How many chromosomes does a normal human cell have?','23','44','46','48','c'),
-- GEOGRAPHY
('Geography','easy','What is the capital of Nigeria?','Lagos','Kano','Ibadan','Abuja','d'),
('Geography','medium','Which is the largest country in Africa by area?','Nigeria','Sudan','Algeria','DRC','c'),
('Geography','easy','Which river is the longest in Africa?','Congo','Nile','Niger','Zambezi','b'),
('Geography','hard','What is the smallest country in the world by area?','Monaco','Liechtenstein','Vatican City','San Marino','c'),
('Geography','easy','Which ocean is the largest?','Atlantic','Indian','Arctic','Pacific','d'),
('Geography','medium','Mount Kilimanjaro is in which country?','Kenya','Ethiopia','Tanzania','Uganda','c'),
('Geography','easy','How many states does Nigeria have?','34','36','38','40','b'),
('Geography','easy','What is the currency of South Africa?','Shilling','Rand','Cedi','Franc','b'),
('Geography','medium','The Amazon rainforest is primarily in which country?','Colombia','Venezuela','Peru','Brazil','d'),
('Geography','medium','Which African city has the largest population?','Nairobi','Cairo','Lagos','Kinshasa','c'),
-- GENERAL KNOWLEDGE
('General Knowledge','easy','What is the largest planet in our solar system?','Saturn','Neptune','Jupiter','Uranus','c'),
('General Knowledge','easy','Who painted the Mona Lisa?','Michelangelo','Raphael','Leonardo da Vinci','Caravaggio','c'),
('General Knowledge','easy','How many sides does a hexagon have?','5','6','7','8','b'),
('General Knowledge','easy','What is the capital of France?','Berlin','Madrid','Rome','Paris','d'),
('General Knowledge','medium','In which year did the first iPhone launch?','2005','2006','2007','2008','c'),
('General Knowledge','easy','What is the square root of 144?','11','12','13','14','b'),
('General Knowledge','easy','Which company created the Android operating system?','Apple','Microsoft','Google','Samsung','c'),
('General Knowledge','easy','How many continents are there on Earth?','5','6','7','8','c'),
('General Knowledge','easy','What is the chemical formula for water?','HO','H2O','H3O','OH2','b'),
('General Knowledge','medium','Who wrote Things Fall Apart?','Wole Soyinka','Chinua Achebe','Chimamanda Adichie','Ben Okri','b'),
-- NOLLYWOOD
('Nollywood','easy','Which Nollywood actress is known as Mama G?','Genevieve Nnaji','Rita Dominic','Patience Ozokwo','Omotola Jalade','c'),
('Nollywood','easy','Which movie is often credited as the film that launched modern Nollywood?','Glamour Girls','Living in Bondage','Emotional Crack','True Confession','b'),
('Nollywood','medium','Which Nigerian actor starred in the Hollywood film Beast of No Nation?','Ramsey Nouah','Olu Jacobs','Abraham Attah','Richard Mofe-Damijo','c'),
('Nollywood','medium','What year was the first Nollywood movie Living in Bondage released?','1989','1990','1992','1995','c'),
('Nollywood','easy','Which Nollywood star is known as Genevieve?','Genevieve Nnaji','Genevieve Okonkwo','Genevieve Amadi','Genevieve Bello','a'),
('Nollywood','hard','Who directed the award-winning Nigerian film Lionheart?','Kemi Adetiba','Genevieve Nnaji','Kunle Afolayan','EbonyLife Films','b'),
('Nollywood','medium','Which Nigerian film was submitted for the Academy Awards in 2020?','The Wedding Party','King of Boys','Lionheart','October 1','c'),
('Nollywood','easy','RMD is the acronym for which popular Nollywood actor?','Ramsey Moussa Dominic','Richard Mofe-Damijo','Robert Musa David','Raymond Mathew Douglas','b'),
('Nollywood','medium','Which Nollywood actress is also known as Omosexy?','Ini Edo','Tonto Dikeh','Omotola Jalade-Ekeinde','Mercy Johnson','c'),
('Nollywood','easy','The Nollywood industry is based primarily in which Nigerian city?','Abuja','Port Harcourt','Enugu','Lagos','d'),
-- TECHNOLOGY
('Technology','easy','What does CPU stand for?','Central Processing Unit','Computer Processing Unit','Central Program Utility','Core Processing Unit','a'),
('Technology','easy','Which company created the iPhone?','Samsung','Google','Apple','Microsoft','c'),
('Technology','medium','What does HTML stand for?','Hyper Text Markup Language','High Text Machine Language','Hyper Transfer Markup Language','High Transfer Machine Logic','a'),
('Technology','easy','What is the most widely used programming language in web development?','Python','Java','JavaScript','Ruby','c'),
('Technology','easy','What does URL stand for?','Uniform Resource Locator','Universal Resource Link','Unified Remote Locator','Universal Response Locator','a'),
('Technology','medium','Which Nigerian payment company processes most online payments in Nigeria?','Flutterwave','Paystack','Interswitch','Quickteller','c'),
('Technology','hard','What year was the first commercial internet service launched in Nigeria?','1992','1994','1996','1998','c'),
('Technology','medium','What does AI stand for in technology?','Automated Intelligence','Artificial Intelligence','Automated Interface','Artificial Interface','b'),
('Technology','easy','Which social media platform has the most users globally?','Instagram','Twitter','Facebook','TikTok','c'),
('Technology','medium','What does API stand for?','Application Programming Interface','Automated Process Integration','Application Process Interaction','Automated Programming Interface','a')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════
-- SEED: SAMPLE ADS
-- ════════════════════════════════════════════════
INSERT INTO ads (title, body, cta_text, cta_url, sponsor, placement) VALUES
('PalmPay — Zero transfer fees this weekend', 'Send and receive money instantly with PalmPay. Zero fees every weekend.', 'Open PalmPay', 'https://palmpay.com', 'PalmPay', 'banner'),
('Paystack — Accept payments easily', 'Start accepting online payments in minutes. Trusted by 60,000+ Nigerian businesses.', 'Get Started', 'https://paystack.com', 'Paystack', 'banner'),
('Opay — Your everyday finance app', 'Transfer, save, and invest with Opay. Over 35 million users trust us.', 'Download Opay', 'https://opayweb.com', 'Opay', 'leaderboard')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════
-- SEED: SAMPLE TOURNAMENTS
-- ════════════════════════════════════════════════
INSERT INTO tournaments (name, category, entry_fee_kobo, max_players, prize_pool_kobo, status, starts_at, sponsor_name) VALUES
('Grand Saturday Showdown', 'General Knowledge', 100000, 3000, 50000000, 'registering', NOW() + INTERVAL '6 hours', NULL),
('Nollywood Legends Cup', 'Nollywood', 50000, 50, 5000000, 'registering', NOW() + INTERVAL '2 hours', NULL),
('Sports Champions Cup', 'Sports', 200000, 100, 20000000, 'registering', NOW() + INTERVAL '12 hours', 'BetNaija'),
('Weekly Free Trivia', 'General Knowledge', 0, 200, 1000000, 'registering', NOW() + INTERVAL '1 hour', NULL),
('Tech Gurus Battle', 'Technology', 150000, 30, 7500000, 'registering', NOW() + INTERVAL '18 hours', 'Paystack')
ON CONFLICT DO NOTHING;
