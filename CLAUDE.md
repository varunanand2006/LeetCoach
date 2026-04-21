# LeetCoach

## Project Overview
A Chrome extension that adds an AI coaching sidebar to LeetCode problem pages. 
The sidebar auto-opens on problem pages and provides a Claude-powered chat 
interface for code feedback, hints, and DSA guidance.

## Architecture
- **Frontend**: Chrome Extension (Manifest V3, vanilla JavaScript)
- **Backend**: Single AWS Lambda function (Python 3.11)
- **AI**: Claude Haiku (hint/dsa) + Claude Sonnet (analyze/chat) via Amazon Bedrock
- **Database**: DynamoDB (`leetcoach-users` table, PAY_PER_REQUEST)
- **Infrastructure**: AWS SAM

## Project Structure
- `extension/` — Chrome extension files
- `backend/` — Lambda function and dependencies
- `template.yaml` — SAM infrastructure definition
- `docs/` — GitHub Pages site (landing page, privacy policy, demo video)

## Key Decisions
- Single Lambda function, mode determined by request body (`mode` field)
- Vanilla JS for extension (no React)
- Read problem context from LeetCode DOM
- Session-only chat memory (no persistence in v1)
- Haiku for hint/dsa (cheap, short responses); Sonnet for analyze/chat (code review, freeform)
- Three coaching modes: Learn (educational), Practice (minimal nudges), Interview (Socratic questioning/mock interview)
- Monaco code must be read via `chrome.scripting.executeScript` in MAIN world from sidepanel.js — content.js cannot access `window.monaco` (isolated world)
- LeetCode migrated from Monaco to CodeMirror 6 (CM6); `getMonacoCode` tries Monaco first, then CM6 via the internal EditorView key on `.cm-editor` (`Object.keys(el).find(k => el[k]?.state?.doc)`), then falls back to reading `.cm-line` DOM elements
- Side panel enabled only on leetcode.com/problems/* tabs; auto-opens on icon click
- Keyboard shortcut Cmd+Shift+L / Ctrl+Shift+L to reopen
- Lambda response is streamed — `InvokeMode: RESPONSE_STREAM` in template.yaml; chunks posted directly to Lambda Runtime API via chunked HTTP; bootstrap's duplicate buffered post is intercepted by monkey-patching `runtime_client.post_invocation_result` (the C extension module, not the Python class — the Python class varies between bundled and system awslambdaric versions)
- RESPONSE_STREAM Lambdas do NOT propagate `statusCode` from a returned dict — all non-AI responses (errors, usage JSON) must also use `_stream_to_runtime`, never return a dict
- Weekly limit errors are streamed as JSON `{"error": "weekly_limit_reached", ...}`; the frontend detects them by attempting `JSON.parse` on the full response after streaming completes
- userId is read from LeetCode nav by parsing the href of `a[href*="/u/"]` links (not innerText — LeetCode is a React SPA and the text may not be present in the isolated content script world)

## Extension Files and Their Roles
- `manifest.json` — permissions, content scripts, side panel config, keyboard shortcut
- `background.js` — side panel enable/disable logic, keyboard shortcut handler
- `content.js` — reads LeetCode DOM (title, number, difficulty, tags, description, language); does NOT read Monaco code
- `sidepanel.html` — side panel UI markup + all CSS (dark theme, mode buttons, spinner, markdown styles)
- `sidepanel.js` — chat logic, per-tab state, Monaco code reading (MAIN world), submission result reading, Lambda fetch, markdown rendering, usage tracking (local via `chrome.storage.local` + server sync via `usage` mode on init); typing `clear`, `reset`, `clear chat`, or `start over` clears the chat; usage tooltip shows prompts remaining + time until Monday reset
- `prism.js` — bundled Prism.js for syntax highlighting in code fences
- `prism-theme.css` — dark Prism theme matching the sidebar palette

## Backend
- Single handler in lambda_function.py
- Receives: `{ mode, message, problem, code, language, history, hintLevel, submissionResult, userId }`
  - `mode`: `"chat"` | `"hint"` | `"analyze"` | `"dsa"` | `"usage"`
  - `problem`: `{ difficulty, tags, description }` (name/number/slug intentionally omitted)
  - `hintLevel`: 1–3 (hint mode only)
  - `submissionResult`: `{ status, input, expected, actual, message }` or null
  - `history`: last 10 turns (chat only — analyze/hint/dsa send no history)
  - `userId`: LeetCode username (may be null — always fail open if missing)
- Returns: streamed plain text via chunked transfer encoding to Lambda Runtime API
- Model routing: hint + dsa → `us.anthropic.claude-haiku-4-5-20251001-v1:0`; analyze + chat → `us.anthropic.claude-sonnet-4-6` (the `us.` prefix enables cross-region inference routing)
- Model IDs overridable via `HAIKU_MODEL_ID` / `SONNET_MODEL_ID` Lambda env vars — update these when Anthropic deprecates a version, no code change needed
- Token budgets: hint 64, dsa 128, analyze 256, chat 256
- `usage` mode: reads DynamoDB, streams `{weeklyRequests, weekStartDate}` as JSON — does NOT count against limit
- `check_and_update_usage(user_id)`: called before every Bedrock call; returns False if weeklyRequests >= WEEKLY_LIMIT; always fails open on DynamoDB errors; resets weekly counter when weekStartDate != current Monday; uses `ConditionExpression` to make the limit check + increment atomic (eliminates TOCTOU race on concurrent requests)
- `WEEKLY_LIMIT = 100` (named constant, easy to change)
- `validate_and_sanitize_body()`: called on every request before processing; truncates oversized fields (code: 10KB, description: 5KB, message: 2KB), limits history to last 10 turns, clamps hintLevel to 1–3, validates userId against `^[a-zA-Z0-9_\-\.]{1,50}$` (sets to null if invalid)

## DynamoDB
- Table: `leetcoach-users`, partition key: `userId` (String), PAY_PER_REQUEST
- Item schema: `userId`, `weeklyRequests`, `totalRequests`, `weekStartDate` (YYYY-MM-DD of Monday), `firstSeen`, `lastSeen`, `tier` (free)
- IAM: Lambda role has `AmazonDynamoDBFullAccess`; deploying user (`leetcoach-dev`) also needs `AmazonDynamoDBFullAccess`

## What the Extension Can Read from LeetCode DOM
- Problem name and number
- Problem description
- Difficulty (Easy/Medium/Hard)
- Topic tags
- Selected language
- Current user code (via `chrome.scripting.executeScript` MAIN world in sidepanel.js)
- Submission failure details: Wrong Answer (input/expected/actual), Runtime Error, Compile Error, TLE, MLE, OLE (via MAIN world in sidepanel.js)

- LeetCode username (`userId`): parsed from `a[href*="/u/"]` href, not innerText

## AWS Services
- Bedrock (Claude Haiku + Sonnet) — AI responses
- Lambda — backend compute with Function URL (no API Gateway)
- CloudWatch — logging
- DynamoDB — `leetcoach-users` usage tracking table
- IAM — Lambda execution role with `AmazonBedrockFullAccess` + `AmazonDynamoDBFullAccess`

## Security
- API key is a SAM parameter (`ApiKey`) — never hardcoded in template.yaml
- `samconfig.toml` is gitignored — contains the API key value locally
- API key is hardcoded in `sidepanel.js` — unavoidable for a Chrome extension (ships in the .crx)
- Billing kill switch: AWS Budgets Action attaches a Deny IAM policy at $10/month spend, shutting down all Bedrock calls. Re-enable by detaching `leetcoach-bedrock-killswitch` policy from `ChatFunctionExecutionRole` in IAM console.
- deploying user (`leetcoach-dev`) needs `budgets:*` permission in addition to IAM and DynamoDB

## Landing Page (docs/)
- Hosted on GitHub Pages at `https://varunanand2006.github.io/LeetCoach/`
- `docs/index.html` — marketing landing page (Tailwind CSS via CDN, Inter font, dark theme with orange/amber primary)
- `docs/privacy.html` — privacy policy
- `docs/demo.mp4` — screen recording of the sidebar in action
- Built with Google Stitch + Antigravity (Gemini); no build tools, single HTML file
- To update: edit `docs/index.html`, commit and push to master — GitHub Pages auto-deploys from `/docs` on master branch
- After pushing, hard refresh with `Ctrl+Shift+R` to bust browser cache

## Development Commands
- Deploy backend: `sam build --use-container && sam deploy`
- Load extension: chrome://extensions → Developer Mode → Load Unpacked → `extension/`
- After Lambda changes: `sam build --use-container && sam deploy`
- After extension changes: refresh extension in chrome://extensions, reload LeetCode tab
- New extension version: bump `version` in `manifest.json`, zip `extension/` contents (not the folder itself) using `Compress-Archive -Path extension\* -DestinationPath leetcoach-x.x.x.zip` in PowerShell, upload to Chrome Web Store

## Current Status
- [x] Project structure created
- [x] manifest.json written
- [x] AWS CLI configured (us-east-1, leetcoach-dev user)
- [x] SAM CLI installed
- [x] Bedrock model access enabled (claude-sonnet-4-6)
- [x] background.js
- [x] content.js
- [x] sidepanel.html
- [x] sidepanel.js
- [x] lambda_function.py
- [x] template.yaml
- [x] First deployment
- [x] End to end test
- [x] DynamoDB weekly usage tracking (100 req/week, fails open)
- [x] Hourglass usage indicator in header (top right, hover tooltip)
- [x] Billing kill switch ($10 cutoff, $7 warning email)
- [x] API key parameterized (out of source control)
- [x] Privacy policy (docs/privacy.html, GitHub Pages)
- [x] Submitted to Chrome Web Store
- [x] Extension update published (v1.1.0)
- [x] Landing page (docs/index.html, GitHub Pages)
- [x] Demo video (docs/demo.mp4)