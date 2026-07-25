// api.js - Network requests and API communication

import { API_URL, getThisMonday, setWeeklyRequestsUsed, weeklyRequestsUsed, DIAGRAM_COST, REVIEW_COST } from './state.js';
import { updateUsageIndicator, showLimitWarning, showErrorMessage, scrollToBottom } from './ui.js';
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
    if (typeof data.weeklyRequests === 'number') {
      const currentMonday = getThisMonday();
      const count = data.weekStartDate === currentMonday ? data.weeklyRequests : 0;
      setWeeklyRequestsUsed(count);
      await chrome.storage.local.set({ weeklyRequests: count, weekStartDate: currentMonday });
      updateUsageIndicator();
    }
  } catch (_e) { /* fail silently — local count remains */ }
}

export async function incrementUsage(cost = 1) {
  const newCount = weeklyRequestsUsed + cost;
  setWeeklyRequestsUsed(newCount);
  await chrome.storage.local.set({ weeklyRequests: newCount });
  updateUsageIndicator();
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
