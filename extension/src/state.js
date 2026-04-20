// state.js - Centralized state management for the side panel

export const WEEKLY_LIMIT = 100;
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
