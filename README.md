# LeetCoach

An AI coaching sidebar for LeetCode, powered by Claude. Get hints, code feedback, and algorithm guidance without leaving the problem page — no copy-pasting, no context switching.

![LeetCoach sidebar](docs/preview.png)

---

## What it does

LeetCoach adds a sidebar directly to LeetCode problem pages. Instead of Googling hints or pasting your code into ChatGPT, you get a coaching assistant that already knows the problem you're on, the code you've written, and (when you've submitted) what went wrong.

**Hint** — progressive hints that reveal only as much as you need. Level 1 nudges you in the right direction. Level 2 names the category. Level 3 names the exact data structure. No spoilers unless you ask. In Interview mode, instead of a hint, the AI will ask you a clarifying question about your approach.

**Analyze Code** — reviews your current code in three dimensions: correctness (and why a failed submission failed), time/space complexity, and edge cases. In Interview mode, it will challenge your choices and ask you to justify your trade-offs.

**DSA Tips** — identifies the algorithmic pattern and optimal data structure for the problem in 1-3 lines. Useful when you're not sure where to start. In Interview mode, it will also ask you to explain why this choice is optimal.

**Chat** — freeform coaching. Ask follow-up questions, talk through your approach, or ask why your logic is wrong. In Interview mode, the AI acts as a senior technical interviewer, challenging your logic and logic and using Socratic questioning.

---

## Modes

LeetCoach has three coaching modes, toggled via the icon in the header:

- **🎓 Learn** (Default) — Educational and encouraging. Explains concepts, names algorithms, and teaches syntax.
- **📝 Practice** — Minimal nudges. No names, no syntax, no explanations. Just directional hints.
- **👔 Interview** — Mock interview. The AI acts as a professional interviewer, asking clarifying questions, challenging trade-offs, and focusing on your communication skills.

---

## Install

**Chrome Web Store** — search "LeetCoach"

**Developer mode:**
1. Clone this repo
2. Go to `chrome://extensions` → enable Developer Mode
3. Click **Load Unpacked** → select the `extension/` folder
4. Open any LeetCode problem — the sidebar opens automatically

**Keyboard shortcut:** `Ctrl+Shift+L` / `Cmd+Shift+L` to reopen the sidebar

---

## Usage limits

LeetCoach is free. Each LeetCode account gets **100 requests per week**, resetting every Monday. The usage indicator in the top-right corner of the sidebar shows how many prompts you have left.

---

## Architecture

```
Chrome Extension (Manifest V3)
        │
        │  HTTPS (streamed)
        ▼
AWS Lambda (Python 3.11)
  ├── Amazon Bedrock  ──►  Claude Haiku 4.5   (hint, DSA)
  │                   ──►  Claude Sonnet 4.6  (analyze, chat)
  └── DynamoDB  ──►  leetcoach-users  (weekly usage tracking)
```

### Extension

| File | Role |
|---|---|
| `manifest.json` | Permissions, content scripts, side panel config, keyboard shortcut |
| `background.js` | Side panel enable/disable logic, keyboard shortcut handler |
| `content.js` | Reads LeetCode DOM — problem title, difficulty, tags, description, language, username |
| `sidepanel.html` | Sidebar UI markup and CSS |
| `sidepanel.js` | Chat logic, Monaco code reading (MAIN world), submission result scraping, Lambda fetch, usage tracking |

User code is read via `chrome.scripting.executeScript` in the MAIN world — the extension's isolated content script cannot access the editor internals directly. The implementation tries Monaco first (first non-empty model), then CodeMirror 6 (via the internal `EditorView` key on `.cm-editor`), then falls back to reading `.cm-line` DOM elements. LeetCode migrated from Monaco to CM6, so most users hit the CM6 path.

### Backend

Single Lambda function (`backend/lambda_function.py`) with a Function URL. The request `mode` field routes to the appropriate prompt and model:

| Mode | Model | Max tokens |
|---|---|---|
| `hint` | Claude Haiku 4.5 | 64 |
| `dsa` | Claude Haiku 4.5 | 128 |
| `analyze` | Claude Sonnet 4.6 | 256 |
| `chat` | Claude Sonnet 4.6 | 256 |

Responses are streamed via chunked transfer encoding posted directly to the Lambda Runtime API (`/2018-06-01/runtime/invocation/{id}/response`). Bootstrap's duplicate buffered post is suppressed by monkey-patching `runtime_client.post_invocation_result` (the C extension module).

### DynamoDB

Table: `leetcoach-users` — partition key `userId` (LeetCode username).

Tracks `weeklyRequests`, `totalRequests`, `weekStartDate`, `firstSeen`, `lastSeen`, `tier`. Weekly counter resets when `weekStartDate` diverges from the current Monday. All DynamoDB errors fail open — a user is never blocked due to a tracking failure.

### Security

- API key is a SAM parameter — never hardcoded in `template.yaml`; `samconfig.toml` is gitignored
- Billing kill switch: AWS Budgets Action attaches a Deny IAM policy at $10/month, cutting off all Bedrock calls

---

## Deploying the backend

Requires AWS CLI, SAM CLI, and Bedrock model access for `claude-haiku-4-5` and `claude-sonnet-4-6` in `us-east-1`.

```bash
sam build --use-container
sam deploy
```

On first deploy, SAM will prompt for the `ApiKey` parameter. Mirror the same value in `extension/sidepanel.js`.

---

## Tech stack

- **Frontend:** Chrome Extension (Manifest V3, vanilla JS)
- **Backend:** AWS Lambda (Python 3.11), AWS SAM
- **AI:** Amazon Bedrock — Claude Haiku 4.5, Claude Sonnet 4.6
- **Database:** Amazon DynamoDB (on-demand)
- **Infra:** AWS IAM, AWS Budgets, Amazon CloudWatch
