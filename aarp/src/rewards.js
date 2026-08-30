// AARP Rewards — conversational interface (PRD §§23-25). P0 uses mock data behind
// the same interface a real Rewards API integration will implement at pilot (§50).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_PATH = join(HERE, "..", "data", "rewards_mock.json");

const DEFAULT_MOCK = {
  points_balance: 18450,
  expiring: [{ points: 2300, expires_at: "2026-10-01" }],
  redemption_options: [
    { id: "gift-card-25", label: "$25 restaurant gift card", points: 2500 },
    { id: "gift-card-50", label: "$50 retail gift card", points: 5000 },
    { id: "travel-credit-100", label: "$100 travel credit", points: 11000 },
    { id: "movie-tickets", label: "2 movie tickets", points: 1800 },
  ],
  earning_opportunities: [
    { id: "quiz-brain-health", label: "Take the brain-health quiz", points: 150 },
    { id: "walk-challenge", label: "Log a 30-minute walk", points: 100 },
    { id: "newsletter-read", label: "Read this week's member newsletter", points: 50 },
  ],
};

export function getRewards(memberStore, now = new Date().toISOString()) {
  const mock = existsSync(MOCK_PATH) ? JSON.parse(readFileSync(MOCK_PATH, "utf8")) : DEFAULT_MOCK;
  const expiringSoon = mock.expiring.filter((e) => {
    const d = (new Date(e.expires_at) - new Date(now)) / 86400000;
    return d > 0 && d < 60;
  });
  // Rewards memory (§10): learned redemption preference ranks options
  const prefs = memberStore ? memberStore.activeMemories(now)
    .filter((m) => m.key === "rewards_preference").map((m) => String(m.value).toLowerCase()) : [];
  const options = [...mock.redemption_options].sort((a, b) => {
    const ap = prefs.some((p) => a.label.toLowerCase().includes(p)) ? 1 : 0;
    const bp = prefs.some((p) => b.label.toLowerCase().includes(p)) ? 1 : 0;
    return bp - ap;
  });
  return {
    points_balance: mock.points_balance,
    expiring_soon: expiringSoon,
    redemption_options: options.slice(0, 4),
    earning_opportunities: mock.earning_opportunities.slice(0, 3),
    note: "mock data — replace with the Rewards API at pilot (PRD §50)",
  };
}
