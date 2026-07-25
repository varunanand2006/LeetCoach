// ui.js - DOM manipulation and UI updates

import {
  WEEKLY_LIMIT, weeklyRequestsUsed, getTimeUntilResetStr, activeTabId, getTabState,
  coachingMode, diagramArmed, DIAGRAM_COST,
} from './state.js';

export let chatEl, inputEl, problemNameEl, usageIndicatorEl;
export let modeBtnHint, modeBtnAnalyze, modeBtnThird, hintLevelBadgeEl;
export let coachingToggleEl, diagramToggleEl;
let usageRingFillEl;

const RING_CIRCUMFERENCE = 2 * Math.PI * 9; // r=9 in sidepanel.html

/** Third mode button config, keyed by coaching mode. */
const THIRD_BUTTON = {
  learn: {
    mode: 'dsa',
    label: 'DSA Tips',
    title: 'Data structure & algorithm tips',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v4M6 21v-4M18 21v-4M6 17h12M12 7v10"/><rect x="9" y="1" width="6" height="4" rx="1"/></svg>',
  },
  practice: {
    mode: 'optimize',
    label: 'Optimize',
    title: 'Review runtime, memory, and Big-O complexity',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19a9 9 0 1 1 16 0"/><path d="M12 15l4-5"/></svg>',
  },
  interview: {
    mode: 'feedback',
    label: 'Feedback',
    title: 'Get end-of-interview feedback on your code and approach',
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
  coachingToggleEl = document.getElementById('coaching-toggle');
  diagramToggleEl  = document.getElementById('diagram-toggle');

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
  usageIndicatorEl.dataset.tooltip = `${remaining} prompts left\nLimit resets in ${resetStr}`;

  if (usageRingFillEl) {
    const used = Math.min(1, Math.max(0, weeklyRequestsUsed / WEEKLY_LIMIT));
    // Ring fills clockwise as prompts are consumed.
    usageRingFillEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - used));
    usageIndicatorEl.classList.toggle('low', remaining <= 10 && remaining > 0);
    usageIndicatorEl.classList.toggle('empty', remaining === 0);
  }

  // Arming may have just become impossible.
  syncDiagramToggle();
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
}

/** Swap the third mode button to match the active coaching mode. */
export function syncThirdButton() {
  if (!modeBtnThird) return;
  const cfg = THIRD_BUTTON[coachingMode] ?? THIRD_BUTTON.learn;
  modeBtnThird.dataset.mode = cfg.mode;
  modeBtnThird.title = cfg.title;
  modeBtnThird.querySelector('.mode-icon').innerHTML = cfg.icon;
  modeBtnThird.querySelector('.mode-label').textContent = cfg.label;
  syncDiagramCostHints();
}

/** Show a `· 2` suffix on the mode buttons while a diagram is armed. */
function syncDiagramCostHints() {
  const suffix = diagramArmed ? ` · ${DIAGRAM_COST}` : '';
  const cfg = THIRD_BUTTON[coachingMode] ?? THIRD_BUTTON.learn;
  const labelEl = modeBtnThird?.querySelector('.mode-label');
  if (labelEl) labelEl.textContent = cfg.label + suffix;
  for (const [btn, base] of [[modeBtnAnalyze, 'Analyze'], [modeBtnHint, 'Hint']]) {
    const span = btn?.querySelector('.mode-label');
    if (span) span.textContent = base + suffix;
  }
}

export function syncDiagramToggle() {
  if (!diagramToggleEl) return;
  const affordable = remainingPrompts() >= DIAGRAM_COST;

  diagramToggleEl.classList.toggle('armed', diagramArmed);
  diagramToggleEl.setAttribute('aria-pressed', String(diagramArmed));
  diagramToggleEl.classList.toggle('unaffordable', !affordable);

  if (!affordable) {
    diagramToggleEl.dataset.tooltip =
      `Needs ${DIAGRAM_COST} prompts\nYou have ${remainingPrompts()} left this week`;
  } else if (diagramArmed) {
    diagramToggleEl.dataset.tooltip =
      `Diagram ON for your next reply\nCosts ${DIAGRAM_COST} prompts instead of 1\nClick to cancel`;
  } else {
    diagramToggleEl.dataset.tooltip =
      `Diagram off\nClick to add a diagram to your next reply\nCosts ${DIAGRAM_COST} prompts instead of 1`;
  }

  if (inputEl) {
    inputEl.placeholder = diagramArmed
      ? `Ask LeetCoach… · diagram on (${DIAGRAM_COST} prompts)`
      : 'Ask LeetCoach...';
  }
  syncDiagramCostHints();
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

  syncThirdButton();
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
