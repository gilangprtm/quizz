import { db } from '../db';
import type { DbQuestion, TranslationRow } from '../types';

/** locale → order_index → translation row */
export type TranslationsByLocale = Map<string, Map<number, TranslationRow>>;

/** Load and group every uploaded translation for a quiz, one query. */
export async function loadQuizTranslations(quizId: number): Promise<TranslationsByLocale> {
  const rows = await db.all<TranslationRow[]>(
    'SELECT * FROM question_translations WHERE quiz_id = ?',
    quizId,
  );
  const byLocale: TranslationsByLocale = new Map();
  for (const row of rows) {
    let byIndex = byLocale.get(row.locale);
    if (!byIndex) {
      byIndex = new Map();
      byLocale.set(row.locale, byIndex);
    }
    byIndex.set(row.order_index, row);
  }
  return byLocale;
}

/**
 * Return a localized clone of `q` for `locale`, falling back to the base
 * question untouched when there's no translation for this exact question
 * (missing row, or the base question's type has drifted since the
 * translation was uploaded — see question_translations.question_type).
 * Callers can feed the result straight into the existing payload builders,
 * which already key off `text`/`options`/`matches`/`explanation`.
 */
export function localizeDbQuestion(
  q: DbQuestion,
  orderIndex: number,
  locale: string | undefined,
  translations: TranslationsByLocale,
): DbQuestion {
  if (!locale || locale === 'base') return q;
  const row = translations.get(locale)?.get(orderIndex);
  if (!row || row.question_type !== q.question_type) return q;
  return {
    ...q,
    text: row.text,
    options: row.options,
    matches: row.matches ?? q.matches,
    explanation: row.explanation ?? q.explanation,
  };
}
