// api.js - Network requests and API communication

import {
  API_URL, getThisMonday, setWeeklyRequestsUsed, weeklyRequestsUsed,
  setPurchasedCredits, purchasedCredits, setPaymentsEnabled,
  WEEKLY_LIMIT, DIAGRAM_COST, REVIEW_COST,
} from './state.js';
import {
  updateUsageIndicator, showLimitWarning, showErrorMessage, scrollToBottom, syncPaymentsUI,
} from './ui.js';
import { renderMarkdown } from './markdown.js';
import { renderDiagramsIn } from './diagram.js';

function getAuthToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(token);
      }
    });
  });
}

/**
 * Chrome caches OAuth tokens and hands back stale ones without knowing they've
 * been revoked or expired. Dropping the cached copy is the only way to get a
 * fresh one — without this the user is stuck failing every request until they
 * clear the extension's data.
 */
function removeCachedToken(token) {
  return new Promise((resolve) => {
    if (!token) { resolve(); return; }
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

/**
 * The backend streams its errors as a JSON body with a 200 status — a streaming
 * Lambda can't set a status code. So an error is only detectable by parsing the
 * completed response.
 */
function parseErrorPayload(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed.error === 'string' ? parsed : null;
  } catch (_e) {
    return null;
  }
}

const ERROR_FALLBACKS = {
  unauthorized: 'Could not verify your Google sign-in. Please try again.',
  invalid_request: 'That request was rejected. Try reloading the LeetCode tab.',
  internal_error: 'Something went wrong on our end. Please try again.',
};

export async function fetchUsageFromServer(userId) {
  try {
    // Fail silently if they aren't logged in yet (don't pop up a window on load)
    const token = await getAuthToken(false);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ mode: 'usage' }), // Backend now infers user from token
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) return;
    const text = await response.text();

    // Drop a rejected token now so the next interactive call fetches a fresh
    // one, rather than failing the user's first real request too.
    if (parseErrorPayload(text)?.error === 'unauthorized') {
      await removeCachedToken(token);
      return;
    }

    const data = JSON.parse(text);
    // Read before the balance check — the flag is independent of usage numbers.
    setPaymentsEnabled(data.paymentsEnabled === true);
    syncPaymentsUI();

    if (typeof data.weeklyRequests === 'number') {
      const currentMonday = getThisMonday();
      const count = data.weekStartDate === currentMonday ? data.weeklyRequests : 0;
      // Purchased credits never reset, so unlike the weekly count they are taken
      // at face value regardless of which week the stored row belongs to.
      const credits = Math.max(0, data.purchasedCredits ?? 0);
      setWeeklyRequestsUsed(count);
      setPurchasedCredits(credits);
      await chrome.storage.local.set({
        weeklyRequests: count,
        weekStartDate: currentMonday,
        purchasedCredits: credits,
      });
      updateUsageIndicator();
    }
  } catch (_e) { /* fail silently — local count remains */ }
}

/**
 * Mirror the server's charge locally. The Lambda spends the weekly allowance
 * before touching purchased credits, and this has to match — drawing from the
 * wrong balance here shows the user a number the next usage refresh contradicts.
 */
export async function incrementUsage(cost = 1) {
  const freeLeft = Math.max(0, WEEKLY_LIMIT - weeklyRequestsUsed);
  // The server charges one bucket or the other for the whole request, never
  // splits across both, so a cost that doesn't fit the remainder goes to credits.
  const fromFree = cost <= freeLeft ? cost : 0;
  const newCount = weeklyRequestsUsed + fromFree;
  const newCredits = Math.max(0, purchasedCredits - (cost - fromFree));

  setWeeklyRequestsUsed(newCount);
  setPurchasedCredits(newCredits);
  await chrome.storage.local.set({ weeklyRequests: newCount, purchasedCredits: newCredits });
  updateUsageIndicator();
}

/**
 * Ask the backend for a Stripe Checkout URL. Returns the URL, or throws.
 *
 * The panel can't host the payment itself — MV3's `script-src 'self'` blocks
 * Stripe.js, and it can't be vendored the way mermaid was because Stripe
 * requires it live from their domain. So checkout happens in a normal tab and
 * the card details never touch this extension.
 */
export async function createCheckoutSession(pack) {
  const token = await getAuthToken(true);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ mode: 'create_checkout_session', pack }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const text = await response.text();
  const errorPayload = parseErrorPayload(text);
  if (errorPayload) {
    throw new Error(errorPayload.message || ERROR_FALLBACKS[errorPayload.error]
      || 'Could not start checkout.');
  }
  const { checkoutUrl } = JSON.parse(text);
  // Only ever hand chrome.tabs.create a Stripe URL — this response decides
  // where a new tab opens, so a malformed one shouldn't be followed blindly.
  if (!/^https:\/\/(checkout\.stripe\.com|[a-z0-9-]+\.stripe\.com)\//.test(checkoutUrl ?? '')) {
    throw new Error('Could not start checkout.');
  }
  return checkoutUrl;
}

/** One attempt at the request. Streams into the bubble; returns the raw text. */
async function runRequest(body, assistantBubble, token) {
  assistantBubble.innerHTML = '<i class="gg-spinner"></i>';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let assistantText = '';
  let rafPending = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    assistantText += decoder.decode(value, { stream: true });
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        assistantBubble.innerHTML = renderMarkdown(assistantText);
        scrollToBottom();
        rafPending = false;
      });
    }
  }

  const tail = decoder.decode();
  if (tail) assistantText += tail;
  return assistantText;
}

export async function streamResponse(body, assistantBubble, onSuccess) {
  try {
    // Prompt the user to log in if they haven't already when they explicitly ask for help
    let token = await getAuthToken(true);
    let assistantText = await runRequest(body, assistantBubble, token);
    let errorPayload = parseErrorPayload(assistantText);

    // A stale cached token is the one failure worth retrying automatically.
    // Auth is rejected before any usage is charged, so the retry is free.
    if (errorPayload?.error === 'unauthorized') {
      await removeCachedToken(token);
      token = await getAuthToken(true);
      assistantText = await runRequest(body, assistantBubble, token);
      errorPayload = parseErrorPayload(assistantText);
    }

    // Errors must never reach the render/charge/persist path below: doing so
    // shows the user raw JSON, ticks the usage ring for a request that never
    // reached the model, and writes the error blob into the conversation
    // history, where it would be replayed as context on every later turn.
    if (errorPayload) {
      assistantBubble.remove();
      if (errorPayload.error === 'weekly_limit_reached') {
        showLimitWarning(errorPayload.message);
      } else {
        showErrorMessage(errorPayload.message || ERROR_FALLBACKS[errorPayload.error]
          || 'Something went wrong. Please try again.');
      }
      return;
    }

    assistantBubble.innerHTML = renderMarkdown(assistantText);
    scrollToBottom();

    // Diagrams can only be drawn now — partial mermaid syntax never parses.
    // A render failure degrades to a code block and must not fail the request,
    // which the user has already been charged for.
    try {
      await renderDiagramsIn(assistantBubble);
      scrollToBottom();
    } catch (e) {
      console.warn('[LeetCoach] diagram pass failed:', e);
    }

    // Mirrors the Lambda's cost table: a review is a flat 5 whether or not a
    // diagram is attached, so an armed toggle must not stack on top of it.
    incrementUsage(
      body.mode === 'review' ? REVIEW_COST : body.wantsDiagram ? DIAGRAM_COST : 1
    );
    onSuccess(assistantText);
  } catch (err) {
    assistantBubble.remove();
    showErrorMessage(
      err?.name === 'AbortError'
        ? 'That request timed out. Please try again.'
        : `Couldn't reach LeetCoach. ${err?.message ?? ''}`.trim()
    );
  }
}
