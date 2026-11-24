// Очки за прогноз: общие правила, джокер (двойные очки) и правила частной лиги.

// Правила по умолчанию: точный счёт / верный победитель и разница голов / верный исход
const DEFAULT_SCORING = Object.freeze({ exact: 3, diff: 2, outcome: 1 });

const SCORING_MAX = 10;

function outcomeOf(home, away) {
  return home > away ? 'home' : home < away ? 'away' : 'draw';
}

// Очки без джокера по правилам rules. Разница голов считается только для побед (ничья — просто исход)
function calculatePoints(predictedHome, predictedAway, actualHome, actualAway, rules = DEFAULT_SCORING) {
  if (predictedHome === actualHome && predictedAway === actualAway) return rules.exact;
  if (outcomeOf(predictedHome, predictedAway) !== outcomeOf(actualHome, actualAway)) return 0;
  if (actualHome === actualAway) return rules.outcome;
  return Math.abs(predictedHome - predictedAway) === Math.abs(actualHome - actualAway) ? rules.diff : rules.outcome;
}

// Единственное место, где очки прогноза считаются с джокером: джокер удваивает очки
function scorePrediction(predictedHome, predictedAway, actualHome, actualAway, joker = false, rules = DEFAULT_SCORING) {
  const points = calculatePoints(predictedHome, predictedAway, actualHome, actualAway, rules);
  return joker === true ? points * 2 : points;
}

// Правила из запроса: три целых 0..10, exact >= diff >= outcome, exact >= 1. Иначе null
function validateScoring(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { exact, diff, outcome } = raw;
  const ok = [exact, diff, outcome].every(v => Number.isInteger(v) && v >= 0 && v <= SCORING_MAX);
  if (!ok || exact < 1 || exact < diff || diff < outcome) return null;
  return { exact, diff, outcome };
}

function isDefaultScoring(rules) {
  return !rules || (rules.exact === DEFAULT_SCORING.exact && rules.diff === DEFAULT_SCORING.diff && rules.outcome === DEFAULT_SCORING.outcome);
}

// Правила группы из документа (у старых лиг поля нет — по умолчанию)
function groupScoring(data) {
  return validateScoring(data && data.scoring) || { ...DEFAULT_SCORING };
}

// Очки каждого участника по правилам лиги из его обработанных прогнозов (у них записан итоговый счёт матча)
// predictions: [{ userId, homeScore, awayScore, actualHomeScore, actualAwayScore, joker, processed }]
function pointsByUser(predictions, rules) {
  const totals = {};
  for (const p of predictions) {
    if (p.processed !== true || !Number.isInteger(p.actualHomeScore) || !Number.isInteger(p.actualAwayScore)) continue;
    totals[p.userId] = (totals[p.userId] || 0)
      + scorePrediction(p.homeScore, p.awayScore, p.actualHomeScore, p.actualAwayScore, p.joker === true, rules);
  }
  return totals;
}

// "Round 12" -> 12; не удалось — null
function roundNumber(round) {
  const m = /\d+/.exec(String(round || ''));
  return m ? Number(m[0]) : null;
}

module.exports = {
  DEFAULT_SCORING, calculatePoints, scorePrediction, validateScoring, isDefaultScoring, groupScoring, pointsByUser, roundNumber,
};
