import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { authenticate, parseBody, signToken } from '../../http/access.js';
import { ApiError, conflict, unauthorized } from '../../http/errors.js';

const PALETTE = ['#b5482f', '#2f6f8f', '#7a5c99', '#3f7d5a', '#a8742a', '#a33f6b', '#3d6fb5', '#5f7a2e'];

const RegisterBody = z.object({
  email: z.email().max(200),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
});
const LoginBody = z.object({ email: z.string().max(200), password: z.string().max(200) });

function serializeUser(row) {
  return { id: row.id, email: row.email, name: row.name, color: row.color };
}

// A real hash to compare against when the email is unknown, so response timing
// doesn't reveal which addresses have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const authRoutes = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.')),
});

authRoutes.post('/register', limiter, async (req, res) => {
  const body = parseBody(RegisterBody, req);
  const hash = await bcrypt.hash(body.password, 10);
  const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, password_hash, color) VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, color`,
      [body.email.toLowerCase(), body.name, hash, color],
    );
    res.status(201).json({ token: signToken(rows[0]), user: serializeUser(rows[0]) });
  } catch (err) {
    if (err.constraint === 'users_email_key') throw conflict('EMAIL_TAKEN', 'That email is already registered');
    throw err;
  }
});

authRoutes.post('/login', limiter, async (req, res) => {
  const body = parseBody(LoginBody, req);
  const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [body.email]);
  const valid = await bcrypt.compare(body.password, rows[0]?.password_hash ?? DUMMY_HASH);
  if (!rows[0] || !valid) throw unauthorized('Incorrect email or password');
  res.json({ token: signToken(rows[0]), user: serializeUser(rows[0]) });
});

authRoutes.get('/me', authenticate, async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, color FROM users WHERE id = $1', [req.userId]);
  if (!rows[0]) throw unauthorized();
  res.json({ user: serializeUser(rows[0]) });
});
