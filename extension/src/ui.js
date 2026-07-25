// ui.js - DOM manipulation and UI updates

import {
  WEEKLY_LIMIT, weeklyRequestsUsed, getTimeUntilResetStr, activeTabId, getTabState,
  coachingMode, diagramArmed, DIAGRAM_COST, REVIEW_COST, MIN_REVIEW_MESSAGES,
} from './state.js';

export let chatEl, inputEl, problemNameEl, usageIndicatorEl;
export let modeBtnHint, modeBtnAnalyze, modeBtnThird, hintLevelBadgeEl;
export let diagramToggleEl, overflowToggleEl, overflowMenuEl;
export let menuReviewEl, menuClearEl, menuResetHintEl;
export let segButtons = [];
let usageRingFillEl, menuUsageEl;

const RING_CIRCUMFERENCE = 2 * Math.PI * 9; // r=9 in sidepanel.html

/** Third mode button config, keyed by coaching mode. */
const THIRD_BUTTON = {
  learn: {
    mode: 'dsa',
    label: 'DSA Tips',
    title: 'Patterns & structures',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v4M6 21v-4M18 21v-4M6 17h12M12 7v10"/><rect x="9" y="1" width="6" height="4" rx="1"/></svg>',
  },
  practice: {
    mode: 'optimize',
    label: 'Optimize',
    title: 'Runtime analysis',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19a9 9 0 1 1 16 0"/><path d="M12 15l4-5"/></svg>',
  },
  interview: {
    mode: 'feedback',
    label: 'Feedback',
    title: 'Interview debrief',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 14l2 2 4-4"/></svg>',
  },
};

export function initDOMElements() {
  chatEl           = document.getElementById('chat');
  inputEl          = document.getElementById('input');
  problemNameEl    = document.getElementById('problem-name');
  usageIndicatorEl = document.getElementById('usage-indicator');
  usageRingFillEl  = document.getElementById('usage-ring-fill');
  modeBtnHint      = document.getElementById('btn-hint');
  modeBtnAnalyze   = document.getElementById('btn-analyze');
  modeBtnThird     = document.getElementById('btn-third');
  hintLevelBadgeEl = document.getElementById('hint-level-badge');
  diagramToggleEl  = document.getElementById('diagram-toggle');
  overflowToggleEl = document.getElementById('overflow-toggle');
  overflowMenuEl   = document.getElementById('overflow-menu');
  menuReviewEl     = document.getElementById('menu-review');
  menuClearEl      = document.getElementById('menu-clear');
  menuResetHintEl  = document.getElementById('menu-reset-hint');
  menuUsageEl      = document.getElementById('menu-usage');
  segButtons       = [...document.querySelectorAll('.seg-btn')];

  if (usageRingFillEl) {
    usageRingFillEl.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  }
}

export function remainingPrompts() {
  return Math.max(0, WEEKLY_LIMIT - weeklyRequestsUsed);
}

export function updateUsageIndicator() {
  if (!usageIndicatorEl) return;
  const remaining = remainingPrompts();
  const resetStr = getTimeUntilResetStr();
  usageIndicatorEl.dataset.tooltip = `${weeklyRequestsUsed} / ${WEEKLY_LIMIT} · resets in ${resetStr}`;
  if (menuUsageEl) {
    menuUsageEl.textContent = `${remaining} of ${WEEKLY_LIMIT} prompts left · resets in ${resetStr}`;
  }

  if (usageRingFillEl) {
    const used = Math.min(1, Math.max(0, weeklyRequestsUsed / WEEKLY_LIMIT));
    // Ring fills clockwise as prompts are consumed.
    usageRingFillEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - used));
    usageIndicatorEl.classList.toggle('low', remaining <= 10 && remaining > 0);
    usageIndicatorEl.classList.toggle('empty', remaining === 0);
  }

  // Spending may have just made arming or a review unaffordable.
  syncDiagramToggle();
  syncMenuItems();
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
  modeBtnThird.disabled = !enabled;
  if (diagramToggleEl) diagramToggleEl.disabled = !enabled;
  for (const btn of segButtons) btn.disabled = !enabled;
  if (menuReviewEl) {
    if (!enabled) menuReviewEl.disabled = true;
    else syncMenuItems();
  }
}

/** Swap the third mode button to match the active coaching mode. */
export function syncThirdButton() {
  if (!modeBtnThird) return;
  const cfg = THIRD_BUTTON[coachingMode] ?? THIRD_BUTTON.learn;
  modeBtnThird.dataset.mode = cfg.mode;
  modeBtnThird.title = cfg.title;
  modeBtnThird.querySelector('.mode-icon').innerHTML = cfg.icon;
  modeBtnThird.querySelector('.mode-label').textContent = cfg.label;
}

export function syncDiagramToggle() {
  if (!diagramToggleEl) return;
  const affordable = remainingPrompts() >= DIAGRAM_COST;

  diagramToggleEl.classList.toggle('armed', diagramArmed);
  diagramToggleEl.setAttribute('aria-pressed', String(diagramArmed));
  diagramToggleEl.classList.toggle('unaffordable', !affordable);

  // The armed state is already carried by the lit star and the placeholder;
  // a third marker on every mode button was just squeezing the labels.
  diagramToggleEl.dataset.tooltip = !affordable
    ? `Needs ${DIAGRAM_COST} · ${remainingPrompts()} left`
    : diagramArmed
      ? `Diagram on · click to cancel`
      : `Visualize · ${DIAGRAM_COST} prompts`;

  if (inputEl) {
    inputEl.placeholder = diagramArmed
      ? `Ask LeetCoach… · diagram on (${DIAGRAM_COST} prompts)`
      : 'Ask LeetCoach...';
  }
}

export function syncHintBadge() {
  hintLevelBadgeEl.textContent = getTabState(activeTabId).hintLevel;
}

export function syncCoachingToggle() {
  for (const btn of segButtons) {
    const active = btn.dataset.coaching === coachingMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  syncThirdButton();
}

/** Open/close the ⋯ menu, refreshing the state of its items. */
export function setOverflowOpen(open) {
  if (!overflowMenuEl) return;
  overflowMenuEl.hidden = !open;
  overflowToggleEl?.setAttribute('aria-expanded', String(open));
  overflowToggleEl?.classList.toggle('active', open);
  if (open) syncMenuItems();
}

export function isOverflowOpen() {
  return overflowMenuEl && !overflowMenuEl.hidden;
}

/**
 * A review report is only worth 5 prompts once there's a session to review,
 * so it stays disabled until the conversation has some substance.
 */
export function syncMenuItems() {
  if (!menuReviewEl) return;
  const turns = getTabState(activeTabId).history.length;
  const affordable = remainingPrompts() >= REVIEW_COST;
  const enough = turns >= MIN_REVIEW_MESSAGES;

  menuReviewEl.disabled = !affordable || !enough;
  menuReviewEl.title = !enough
    ? `Needs at least ${MIN_REVIEW_MESSAGES} messages to review`
    : !affordable
      ? `Needs ${REVIEW_COST} · ${remainingPrompts()} left`
      : 'Full session retrospective';

  if (menuResetHintEl) {
    menuResetHintEl.disabled = getTabState(activeTabId).hintLevel <= 1;
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

export function showLimitWarning(message) {
  const el = document.createElement('div');
  el.classList.add('message', 'warning');
  el.textContent = message
    || `You've reached your weekly limit of ${WEEKLY_LIMIT} requests. Your limit resets on Monday!`;
  chatEl.appendChild(el);
  scrollToBottom();
}
