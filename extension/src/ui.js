// ui.js - DOM manipulation and UI updates

import {
  WEEKLY_LIMIT, weeklyRequestsUsed, purchasedCredits, getTimeUntilResetStr,
  activeTabId, getTabState, coachingMode, diagramArmed,
  DIAGRAM_COST, REVIEW_COST, MIN_REVIEW_MESSAGES, PROMPT_PACKS,
} from './state.js';

export let chatEl, inputEl, problemNameEl, usageIndicatorEl;
export let modeBtnHint, modeBtnAnalyze, modeBtnThird, hintLevelBadgeEl;
export let coachingToggleEl, settingsToggleEl, settingsMenuEl;
export let menuDiagramEl, menuReviewEl, menuClearEl, menuResetHintEl, menuBuyEl;
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
  coachingToggleEl = document.getElementById('coaching-toggle');
  settingsToggleEl = document.getElementById('settings-toggle');
  settingsMenuEl   = document.getElementById('settings-menu');
  menuDiagramEl    = document.getElementById('menu-diagram');
  menuReviewEl     = document.getElementById('menu-review');
  menuClearEl      = document.getElementById('menu-clear');
  menuResetHintEl  = document.getElementById('menu-reset-hint');
  menuBuyEl        = document.getElementById('menu-buy');
  menuUsageEl      = document.getElementById('menu-usage');

  if (usageRingFillEl) {
    usageRingFillEl.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  }
}

/** Prompts left in the weekly allowance alone, ignoring anything purchased. */
export function remainingFreePrompts() {
  return Math.max(0, WEEKLY_LIMIT - weeklyRequestsUsed);
}

/**
 * Everything the user can actually spend. Purchased credits count here, so the
 * diagram toggle and review button stay usable once the weekly allowance is
 * gone — gating on the weekly number alone would lock out a paying user.
 */
export function remainingPrompts() {
  return remainingFreePrompts() + Math.max(0, purchasedCredits);
}

export function updateUsageIndicator() {
  if (!usageIndicatorEl) return;
  const remaining = remainingPrompts();
  const credits = Math.max(0, purchasedCredits);
  const resetStr = getTimeUntilResetStr();
  const creditSuffix = credits > 0 ? ` · ${credits} purchased` : '';

  usageIndicatorEl.dataset.tooltip =
    `${weeklyRequestsUsed} / ${WEEKLY_LIMIT} weekly${creditSuffix} · resets in ${resetStr}`;
  if (menuUsageEl) {
    menuUsageEl.textContent =
      `${remainingFreePrompts()} of ${WEEKLY_LIMIT} prompts left${creditSuffix} · resets in ${resetStr}`;
  }

  if (usageRingFillEl) {
    // The ring is a meter for the weekly allowance specifically, so it fills on
    // the weekly count even when credits remain. The low/empty states below key
    // off the spendable total instead — a full ring shouldn't read as "out" to
    // someone who still has credits to spend.
    const used = Math.min(1, Math.max(0, weeklyRequestsUsed / WEEKLY_LIMIT));
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
  if (coachingToggleEl) coachingToggleEl.disabled = !enabled;
  if (!enabled) {
    if (menuReviewEl) menuReviewEl.disabled = true;
    if (menuDiagramEl) menuDiagramEl.disabled = true;
  } else {
    syncMenuItems();
    syncDiagramToggle();
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
  if (!menuDiagramEl) return;
  const affordable = remainingPrompts() >= DIAGRAM_COST;

  menuDiagramEl.classList.toggle('checked', diagramArmed);
  menuDiagramEl.setAttribute('aria-checked', String(diagramArmed));
  menuDiagramEl.disabled = !diagramArmed && !affordable;
  menuDiagramEl.title = 'Adds diagram';

  // The armed state has to stay visible after the menu closes, so it also
  // shows in the placeholder — the menu row alone isn't enough.
  if (inputEl) {
    inputEl.placeholder = diagramArmed
      ? `Ask LeetCoach… · diagram on (${DIAGRAM_COST} prompts)`
      : 'Ask LeetCoach...';
  }
}

export function syncHintBadge() {
  hintLevelBadgeEl.textContent = getTabState(activeTabId).hintLevel;
}

const COACHING_ICON = {
  learn:     { icon: '🎓', tooltip: 'Learn mode\nClick to switch to Practice' },
  practice:  { icon: '📝', tooltip: 'Practice mode\nClick to switch to Interview' },
  interview: { icon: '👔', tooltip: 'Interview mode\nClick to switch to Learn' },
};

export function syncCoachingToggle() {
  const iconEl = document.getElementById('coaching-icon');
  if (coachingToggleEl && iconEl) {
    const cfg = COACHING_ICON[coachingMode] ?? COACHING_ICON.learn;
    iconEl.textContent = cfg.icon;
    coachingToggleEl.dataset.tooltip = cfg.tooltip;
  }
  syncThirdButton();
}

/** Open/close the settings menu, refreshing the state of its items. */
export function setOverflowOpen(open) {
  if (!settingsMenuEl) return;
  settingsMenuEl.hidden = !open;
  settingsToggleEl?.setAttribute('aria-expanded', String(open));
  settingsToggleEl?.classList.toggle('active', open);
  if (open) syncMenuItems();
}

export function isOverflowOpen() {
  return settingsMenuEl && !settingsMenuEl.hidden;
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
      ? `Not enough prompts left`
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

/** Inline notice in the chat flow — used for both quota and failure messages. */
export function showErrorMessage(message) {
  const el = document.createElement('div');
  el.classList.add('message', 'warning');
  el.textContent = message;
  chatEl.appendChild(el);
  scrollToBottom();
}

/**
 * Inline pack picker. `onPick(packId, buttonEl)` runs on click; the button is
 * passed back so the caller can show progress on the one that was pressed
 * rather than blanking the whole card.
 */
export function showBuyCard(onPick) {
  // Only one at a time, or repeated menu clicks stack identical cards.
  chatEl.querySelector('.message.buy-card')?.remove();

  const card = createMessageBubble('buy-card');
  const title = document.createElement('div');
  title.className = 'buy-card-title';
  title.textContent = 'Buy more prompts';
  const sub = document.createElement('div');
  sub.className = 'buy-card-sub';
  sub.textContent = 'Purchased prompts never expire and are used only once your '
    + 'weekly allowance runs out.';
  card.append(title, sub);

  for (const pack of PROMPT_PACKS) {
    const btn = document.createElement('button');
    btn.className = 'buy-pack';
    btn.type = 'button';

    const amount = document.createElement('span');
    amount.className = 'pack-amount';
    amount.textContent = `${pack.credits.toLocaleString()} prompts`;
    const price = document.createElement('span');
    price.className = 'pack-price';
    price.textContent = pack.price;

    btn.append(amount, price);
    btn.addEventListener('click', () => onPick(pack.id, btn));
    card.appendChild(btn);
  }

  const note = document.createElement('div');
  note.className = 'buy-card-note';
  note.textContent = 'Opens Stripe in a new tab. Payment details are handled '
    + 'entirely by Stripe and never touch this extension.';
  card.appendChild(note);

  chatEl.appendChild(card);
  scrollToBottom();
  return card;
}

/**
 * Registered once by index.js. Held here rather than imported so ui.js never
 * has to reach into api.js — api.js already imports from this module, and the
 * cycle that would create is exactly the kind that breaks on load order.
 */
let buyHandler = null;
export function setBuyHandler(fn) { buyHandler = fn; }

export function showLimitWarning(message) {
  showErrorMessage(
    message
    || `You've reached your weekly limit of ${WEEKLY_LIMIT} requests. Your limit resets on Monday!`
  );
  // Running out is the moment buying is actually relevant, so offer it here
  // instead of making them go hunting through the menu.
  if (buyHandler) showBuyCard(buyHandler);
}
