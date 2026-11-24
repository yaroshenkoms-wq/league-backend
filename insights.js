// Статистика прогнозов на матч: исходы в процентах и самые частые счета.

// Целые проценты, сумма ровно 100 (метод наибольших остатков). total === 0 — нули
function percentages(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map(c => (c * 100) / total);
  const result = exact.map(Math.floor);
  let left = 100 - result.reduce((a, b) => a + b, 0);
  exact.map((value, i) => [value - Math.floor(value), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, i]) => { if (left > 0) { result[i]++; left--; } });
  return result;
}

// predictions: [{ homeScore, awayScore }] -> { total, outcomes: { home, draw, away }, topScores: [{ score, count }] }
function computeInsights(predictions) {
  const counts = { home: 0, draw: 0, away: 0 };
  const scores = new Map();
  for (const p of predictions) {
    if (!Number.isInteger(p.homeScore) || !Number.isInteger(p.awayScore)) continue;
    counts[p.homeScore > p.awayScore ? 'home' : p.homeScore < p.awayScore ? 'away' : 'draw']++;
    const key = `${p.homeScore}:${p.awayScore}`;
    scores.set(key, (scores.get(key) || 0) + 1);
  }
  const total = counts.home + counts.draw + counts.away;
  const [home, draw, away] = percentages([counts.home, counts.draw, counts.away]);
  const topScores = [...scores.entries()]
    .map(([score, count]) => ({ score, count }))
    .sort((a, b) => b.count - a.count || a.score.localeCompare(b.score))
    .slice(0, 3);
  return { total, outcomes: { home, draw, away }, topScores };
}

module.exports = { computeInsights, percentages };
