import { type Request, type Response, Router } from 'express';
import { db } from '../db';
import type { DbSession } from '../types';

export const playRouter = Router();

/**
 * Public, unauthenticated: lets the join screen populate a language selector
 * before the player has joined the socket session. Never distinguishes a bad
 * PIN from a quiz with no translations — both just return an empty list, and
 * `player:join` already owns PIN-validity error UX.
 */
playRouter.get('/sessions/:pin/locales', async (req: Request, res: Response) => {
  const session = await db.get<DbSession & { language: string }>(
    'SELECT s.quiz_id, q.language FROM sessions s JOIN quizzes q ON q.id = s.quiz_id WHERE s.pin = ?',
    [req.params.pin],
  );
  if (!session) return res.json({ baseLocale: null, locales: [] });
  const rows = await db.all<Array<{ locale: string }>>(
    'SELECT DISTINCT locale FROM question_translations WHERE quiz_id = ?',
    session.quiz_id,
  );
  res.json({ baseLocale: session.language, locales: rows.map((r) => r.locale) });
});
