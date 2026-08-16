function computeRiskScore(token) {
  let score = 20;
  const warnings = [];

  if (token.devBalancePct > 0.01) {
    score += 25;
    warnings.push(`Creator still holds ${token.devBalancePct.toFixed(2)}%`);
  }
  if (token.top10HolderPct != null && token.top10HolderPct > 50) {
    score += 15;
    warnings.push(`Top 10 holders ${token.top10HolderPct.toFixed(1)}%`);
  } else if (token.top10HolderPct != null && token.top10HolderPct > 30) {
    score += 8;
  }

  if (token.volatility != null && token.volatility > 8) {
    score += 12;
    warnings.push(`High volatility ${token.volatility.toFixed(2)}`);
  } else if (token.volatility != null && token.volatility > 4) {
    score += 6;
  }

  if (token.tokenAgeMinutes != null && token.tokenAgeMinutes < 180) {
    score += 10;
    warnings.push("Token younger than 3h");
  }

  if (token.rugcheck?.scoreNormalised != null) {
    score += Math.min(25, token.rugcheck.scoreNormalised / 4);
    if (token.rugcheck.scoreNormalised > 30) {
      warnings.push(`RugCheck ${token.rugcheck.scoreNormalised}`);
    }
    if (token.rugcheck.graphInsidersDetected > 0) {
      score += 8;
      warnings.push(`${token.rugcheck.graphInsidersDetected} insider clusters`);
    }
  }

  if (token.organicScore != null && token.organicScore < 50) {
    score += 8;
    warnings.push(`Organic score ${token.organicScore.toFixed(0)}`);
  }

  if (token.kolAvoid.length) {
    score += 18;
    warnings.push(`Avoid KOL: ${token.kolAvoid.map((k) => k.label).join(", ")}`);
  }
  if (token.kolGreen.length) {
    score = Math.max(0, score - 10);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const category = score < 35 ? "LOW" : score < 65 ? "MEDIUM" : "HIGH";
  return { score, category, warnings };
}

module.exports = { computeRiskScore };
