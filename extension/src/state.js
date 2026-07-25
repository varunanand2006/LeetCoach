// state.js - Centralized state management for the side panel

// Must match WEEKLY_LIMIT in lambda_function.py — the server is authoritative,
// so a mismatch shows the user a balance the backend disagrees with.
export const WEEKLY_LIMIT = 50;
export const API_URL = 'https://5y6thwif3uawisncrkvzphmvie0tanli.lambda-url.us-east-1.on.aws/';
export const CLEAR_PHRASES = new Set(['/clear', '/reset']);

/** Per-tab state: Map<tabId, { history: [], slug: string|null, domSnapshot: DocumentFragment|null, hintLevel: number, baseContext: object|null }> */
const tabHistories = new Map();

export let activeTabId = null;
export function setActiveTabId(id) { activeTabId = id; }

export let coachingMode = 'learn';
export function setCoachingMode(mode) { coachingMode = mode; }

export let weeklyRequestsUsed = 0;
export function setWeeklyRequestsUsed(count) { weeklyRequestsUsed = count; }

/**
 * Prompts bought on top of the weekly allowance. Tracked separately from
 * weeklyRequestsUsed because they don't reset on Monday — mirrors the
 * purchasedCredits attribute in DynamoDB. The server is authoritative; this is
 * the optimistic local copy that keeps the UI honest between refreshes.
 */
export let purchasedCredits = 0;
export function setPurchasedCredits(count) { purchasedCredits = count; }

/**
 * Purchasable packs, for display only. Prices mirror `CHECKOUT_PACKS` in
 * lambda_function.py and credit counts mirror `PACKS` in payments/app.py — the
 * server decides both what to charge and what to grant, so nothing here is
 * trusted. Only `id` is sent.
 */
export const PROMPT_PACKS = [
  { id: 'mini', credits: 50, price: '$0.99' },
  { id: 'small', credits: 500, price: '$4.99' },
  { id: 'large', credits: 1500, price: '$9.99' },
];

/** Cost in prompts of a request that also produces a diagram. Mirrors DIAGRAM_COST in the Lambda. */
export const DIAGRAM_COST = 2;

/** Cost of a full session review report. Mirrors REVIEW_COST in the Lambda. */
export const REVIEW_COST = 5;

/** A retrospective on a near-empty conversation is a guaranteed waste of 5 prompts. */
export const MIN_REVIEW_MESSAGES = 6;

/** History entries retained per problem — deep enough to feed a review report. */
export const MAX_RETAINED_HISTORY = 30;

/** One-shot arm: set by the header toggle, cleared as soon as a request fires. */
export let diagramArmed = false;
export function setDiagramArmed(on) { diagramArmed = on; }

export function getTabState(tabId) {
  if (!tabId) return { history: [], slug: null, domSnapshot: null, hintLevel: 1, baseContext: null };
  if (!tabHistories.has(tabId)) {
    tabHistories.set(tabId, { history: [], slug: null, domSnapshot: null, hintLevel: 1, baseContext: null });
  }
  return tabHistories.get(tabId);
}

export function deleteTabState(tabId) {
  tabHistories.delete(tabId);
}

export function getThisMonday() {
  const d = new Date();
  d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function getTimeUntilResetStr() {
  const now = new Date();
  const nextMonday = new Date(now);
  const daysToAdd = ((7 - now.getDay()) % 7) + 1;
  nextMonday.setDate(now.getDate() + daysToAdd);
  nextMonday.setHours(0, 0, 0, 0);

  const diffMs = nextMonday.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffDays >= 1) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'}`;
  if (diffHrs >= 1) return `${diffHrs} ${diffHrs === 1 ? 'hour' : 'hours'}`;
  return `${Math.max(1, diffMins)} ${Math.max(1, diffMins) === 1 ? 'minute' : 'minutes'}`;
}

export async function saveProblemState(slug, history, hintLevel) {
  if (!slug) return;
  await chrome.storage.local.set({ [`chat_${slug}`]: { history, hintLevel } });
}

export async function loadProblemState(slug) {
  if (!slug) return null;
  const data = await chrome.storage.local.get(`chat_${slug}`);
  return data[`chat_${slug}`] ?? null;
}

export async function clearProblemState(slug) {
  if (!slug) return;
  await chrome.storage.local.remove(`chat_${slug}`);
}
