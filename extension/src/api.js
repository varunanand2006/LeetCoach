// api.js - Network requests and API communication

import { API_URL, getThisMonday, setWeeklyRequestsUsed, weeklyRequestsUsed } from './state.js';
import { updateUsageIndicator, showLimitWarning, scrollToBottom } from './ui.js';
import { renderMarkdown } from './markdown.js';

function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(token);
      }
    });
  });
}

export async function fetchUsageFromServer(userId) {
  try {
    const token = await getAuthToken();
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
    const data = JSON.parse(await response.text());
    if (typeof data.weeklyRequests === 'number') {
      const currentMonday = getThisMonday();
      const count = data.weekStartDate === currentMonday ? data.weeklyRequests : 0;
      setWeeklyRequestsUsed(count);
      await chrome.storage.local.set({ weeklyRequests: count, weekStartDate: currentMonday });
      updateUsageIndicator();
    }
  } catch (_e) { /* fail silently — local count remains */ }
}

export async function incrementUsage() {
  const newCount = weeklyRequestsUsed + 1;
  setWeeklyRequestsUsed(newCount);
  await chrome.storage.local.set({ weeklyRequests: newCount });
  updateUsageIndicator();
}

export async function streamResponse(body, assistantBubble, onSuccess) {
  let assistantText = '';
  try {
    const token = await getAuthToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
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
    assistantBubble.innerHTML = renderMarkdown(assistantText);
    scrollToBottom();

    // Check for rate limit error streamed as JSON
    try {
      const parsed = JSON.parse(assistantText);
      if (parsed.error === 'weekly_limit_reached') {
        assistantBubble.remove();
        showLimitWarning();
        return;
      }
    } catch (_e) { /* normal text response */ }

    incrementUsage();
    onSuccess(assistantText);
  } catch (err) {
    assistantBubble.textContent = `Error: ${err.message || 'Failed to generate response. Please sign in.'}`;
    scrollToBottom();
  }
}
