// ui.js - DOM manipulation and UI updates

import { WEEKLY_LIMIT, weeklyRequestsUsed, getTimeUntilResetStr, activeTabId, getTabState, coachingMode } from './state.js';

export let chatEl, inputEl, problemNameEl, usageIndicatorEl;
export let modeBtnHint, modeBtnAnalyze, modeBtnDsa, hintLevelBadgeEl;
export let coachingToggleEl;

export function initDOMElements() {
  chatEl           = document.getElementById('chat');
  inputEl          = document.getElementById('input');
  problemNameEl    = document.getElementById('problem-name');
  usageIndicatorEl = document.getElementById('usage-indicator');
  modeBtnHint      = document.getElementById('btn-hint');
  modeBtnAnalyze   = document.getElementById('btn-analyze');
  modeBtnDsa       = document.getElementById('btn-dsa');
  hintLevelBadgeEl = document.getElementById('hint-level-badge');
  coachingToggleEl = document.getElementById('coaching-toggle');
}

export function updateUsageIndicator() {
  if (!usageIndicatorEl) return;
  const remaining = Math.max(0, WEEKLY_LIMIT - weeklyRequestsUsed);
  const resetStr = getTimeUntilResetStr();
  usageIndicatorEl.dataset.tooltip = `${remaining} prompts left\nLimit resets in ${resetStr}`;
}

export function updateHeader(context) {
  const number = context?.number ?? '';
  const name = context?.title ?? '';
  problemNameEl.textContent = number ? `${number}. ${name}` : (name || 'LeetCoach');
}

export function scrollToBottom() {
  const appEl = document.getElementById('app');
  if (appEl) {
    appEl.scrollTop = appEl.scrollHeight;
  }
}

export function setInputEnabled(enabled) {
  inputEl.disabled = !enabled;
  modeBtnHint.disabled = !enabled;
  modeBtnAnalyze.disabled = !enabled;
  modeBtnDsa.disabled = !enabled;
}

export function syncHintBadge() {
  hintLevelBadgeEl.textContent = getTabState(activeTabId).hintLevel;
}

export function syncCoachingToggle() {
  if (!coachingToggleEl) return;
  const iconEl = document.getElementById('coaching-icon');
  if (!iconEl) return;

  if (coachingMode === 'learn') {
    iconEl.textContent = '🎓';
    coachingToggleEl.setAttribute('data-tooltip', 'Learn mode\nClick to switch to Practice');
  } else if (coachingMode === 'practice') {
    iconEl.textContent = '📝';
    coachingToggleEl.setAttribute('data-tooltip', 'Practice mode\nClick to switch to Interview');
  } else if (coachingMode === 'interview') {
    iconEl.textContent = '👔';
    coachingToggleEl.setAttribute('data-tooltip', 'Interview mode\nClick to switch to Learn');
  }
}

export function removeEmptyState() {
  document.getElementById('empty-state')?.remove();
}

export function addEmptyState(text) {
  const el = document.createElement('div');
  el.id = 'empty-state';
  el.textContent = text;
  chatEl.appendChild(el);
}

export function createMessageBubble(role) {
  const el = document.createElement('div');
  el.classList.add('message', role);
  return el;
}

export function appendMessage(role, text) {
  const el = createMessageBubble(role);
  el.textContent = text;
  chatEl.appendChild(el);
  scrollToBottom();
}

export function showLimitWarning() {
  const el = document.createElement('div');
  el.classList.add('message', 'warning');
  el.textContent = "You've reached your weekly limit of 100 requests. Your limit resets on Monday!";
  chatEl.appendChild(el);
  scrollToBottom();
}
