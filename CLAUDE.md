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
- `sidepanel.html` — side panel UI markup (header, settings menu, chat area, mode bar)
- `styles.css` — all CSS (dark theme, mode buttons, spinner, markdown, usage ring, diagrams)
- `src/index.js` — entry point and orchestrator: event wiring, per-tab state, navigation detection, request building
- `src/state.js` — centralized state (per-tab history, coaching mode, usage count, diagram arm flag, storage helpers)
- `src/ui.js` — DOM refs and rendering (usage ring, coaching cycle button, settings menu, swappable third mode button)
- `src/api.js` — Lambda fetch, streaming, Google auth token, usage increment
- `src/markdown.js` — markdown → HTML with Prism highlighting; turns ```mermaid fences into placeholder divs
- `src/diagram.js` — lazy Mermaid import and SVG rendering, click-to-expand overlay, failure fallback
- `src/scraper.js` — Monaco/CM6 code reading and submission result reading (MAIN world)
- `vendor/prism.js` / `vendor/prism-theme.css` — bundled Prism.js + dark theme matching the sidebar palette
- `vendor/mermaid/` — 35-file traced subset of mermaid@11 ESM (~1MB)

## Side Panel Layout
- Header: problem name, coaching-mode emoji (🎓 Learn / 📝 Practice / 👔 Interview — a cycle button, icon only, mode named in the tooltip), then the ☰ settings hamburger. The hamburger glows yellow on hover and while open
- Everything else lives in `#settings-menu`, one `[icon] [one-liner] [cost]` row per line: diagram toggle, Review this session, Reset hint level, Clear this chat, and a usage row using the ring icon
- **`#settings-menu` must be `position: fixed`**, not absolute: `#app` is the scroll container, so an absolutely positioned menu scrolls away from the button that opened it
- The diagram row keeps its checked state visible after the menu closes via the input placeholder — the menu row alone isn't enough. Clicking it does NOT close the menu (`stopPropagation`), so the check is visible before dismissing
- Tooltips are noun phrases, not sentences — "Runtime analysis", not "Review runtime, memory, and Big-O complexity". Note that `syncThirdButton` overwrites the third button's `title` from the `THIRD_BUTTON` table, so editing the HTML `title` alone has no effect
- `/clear` and `/reset` still work as typed commands; the menu's Clear this chat calls the same `clearChat()`
- An earlier iteration used a segmented Learn/Practice/Interview row and a header ✨ — both were reverted in favour of the icon-only cycle button and moving the diagram toggle into the menu

## Review Report
- 5 prompts (`REVIEW_COST`), triggered only from the ☰ settings menu — the menu placement is itself the friction, so there's deliberately no confirm dialog
- Disabled below `MIN_REVIEW_MESSAGES` (6) history entries — a retrospective on a near-empty conversation is a guaranteed waste of 5 prompts
- The only button mode that sends `history`; needs up to 30 entries, so `MAX_RETAINED_HISTORY` (30) governs frontend retention and `MAX_HISTORY_TURNS_REVIEW` (30) the backend cap. Chat stays at 10 — a 30-turn history on every chat turn would inflate input token cost on the most-used path
- **Deliberately exempt from `CODE_POLICY`** — it's a retrospective, so it may show the complete optimal solution regardless of coaching mode. The prompt is identical in all three modes
- Always includes a diagram (built into the prompt, not the menu arm). An armed toggle is ignored for review so the cost stays a flat 5 and the diagram instruction isn't duplicated
- Renders as a normal inline assistant bubble, so history persistence and diagram redraw work for free

## Diagrams
- Opt-in per request: the diagram row in the ☰ settings menu **arms** a diagram for the next request, then disarms itself (one-shot, deliberately not persisted so a reload can't silently double-charge)
- Costs 2 prompts instead of 1 (`DIAGRAM_COST`, mirrored in `state.js` and `lambda_function.py`)
- Sent as a `wantsDiagram` boolean on the body, NOT a separate mode — it composes with chat/hint/analyze/dsa/optimize/feedback
- Armed state shows as a checked/highlighted menu row plus a changed input placeholder (needed because the menu closes)
- Toggle greys out and refuses to arm when fewer than 2 prompts remain
- Backend appends a diagram section to whichever system prompt was built and adds `DIAGRAM_TOKEN_BONUS` (300) tokens
- Diagram requests always route to Sonnet, even for hint/dsa — Mermaid syntax errors waste a paid request
- Detail is tuned by coaching mode: fully labeled in Learn, sparse in Practice, skeletal in Interview
- **Only four diagram types are vendored**: flowchart, sequenceDiagram, stateDiagram-v2, classDiagram. mindmap/architecture were excluded on purpose — they pull in cytoscape, which needs `eval` and would violate the MV3 CSP (`script-src 'self'`). `diagram.js` rejects unsupported types before calling mermaid
- Rendering happens only after the stream closes (partial Mermaid never parses). An unterminated fence shows a "Drawing diagram…" placeholder
- Render failures degrade to the raw source as a code block, never retried — a retry would silently charge another 2 prompts
- Mermaid source is stored in history, so diagrams redraw on reload/tab switch
- To re-vendor after a mermaid upgrade: `npm pack mermaid@11`, then walk the ESM graph from `mermaid.esm.min.mjs` following all static imports plus dynamic imports matching the four allowed types, and copy only the reachable files

## Backend
- Single handler in lambda_function.py
- Receives: `{ mode, message, problem, code, language, history, hintLevel, submissionResult, userId, coachingMode, slug, wantsDiagram }`
  - `mode`: `"chat"` | `"hint"` | `"analyze"` | `"dsa"` | `"optimize"` | `"feedback"` | `"review"` | `"usage"`
  - `problem`: `{ difficulty, tags, description }` (name/number/slug intentionally omitted)
  - `hintLevel`: 1–3 (hint mode only)
  - `submissionResult`: `{ status, input, expected, actual, message }` or null
  - `history`: last 10 turns for chat, last 30 for review; the other button modes send none
  - `userId`: overwritten server-side from the verified Google token; never trusted from the body
  - `coachingMode`: `"learn"` | `"practice"` | `"interview"`
  - `wantsDiagram`: bool — costs 2 prompts and appends a Mermaid diagram request
- Returns: streamed plain text via chunked transfer encoding to Lambda Runtime API
- Model routing: hint + dsa → `us.anthropic.claude-haiku-4-5-20251001-v1:0`; everything else → `us.anthropic.claude-sonnet-4-6` (the `us.` prefix enables cross-region inference routing). Any request with `wantsDiagram` overrides to Sonnet
- Model IDs overridable via `HAIKU_MODEL_ID` / `SONNET_MODEL_ID` Lambda env vars — update these when Anthropic deprecates a version, no code change needed
- Token budgets: hint 128, dsa 256, optimize 300, analyze 320, feedback 360, chat 400, review 900; `+300` when `wantsDiagram` (review is exempt — its diagram is already in the prompt).
- Budgets were deliberately trimmed once: long replies were overwhelming to read in a 400px panel. Prompts also cap line counts explicitly (optimize 4 lines, feedback 5, analyze 3 bullets) — raising `max_tokens` alone will not make replies longer
- `usage` mode: reads DynamoDB, streams `{weeklyRequests, weekStartDate}` as JSON — does NOT count against limit
- `check_and_update_usage(user_id, cost=1)`: called before every Bedrock call; `cost` is 2 for diagram requests. Allows the request iff `weeklyRequests <= WEEKLY_LIMIT - cost` — the threshold is precomputed in Python because DynamoDB can't do arithmetic inside a `ConditionExpression`. Always fails open on DynamoDB errors; resets weekly counter when weekStartDate != current Monday; the `ConditionExpression` makes the limit check + increment atomic (eliminates TOCTOU race on concurrent requests)
- `WEEKLY_LIMIT = 100` (named constant, easy to change)
- `validate_and_sanitize_body()`: called on every request before processing; truncates oversized fields (code: 10KB, description: 5KB, message: 2KB), limits history to last 10 turns, clamps hintLevel to 1–3, coerces `wantsDiagram` to a strict bool, validates userId against `^[a-zA-Z0-9_\-\.]{1,50}$` (sets to null if invalid)

## Coaching Modes and Code Disclosure
- `CODE_POLICY` in lambda_function.py is a single dict appended to **every** mode's system prompt, so the policy can't drift between prompt builders. Ordered by permissiveness: learn > practice > interview
  - **learn** — may show a single line, the one key operation, or a skeleton with `___` / `# TODO` blanks. Never a complete or runnable solution
  - **practice** — defaults to no code; a snippet of ≤3 lines is allowed only when it genuinely clarifies
  - **interview** — no code at all, not even pseudocode. Words only
- The third mode button swaps with the coaching mode (`THIRD_BUTTON` in `src/ui.js`, `data-mode` on `#btn-third`):
  - learn → **DSA Tips** (`dsa`)
  - practice → **Optimize** (`optimize`) — Big-O time/space of the current code, the optimal bound, and the technique that closes the gap (without implementing it)
  - interview → **Feedback** (`feedback`) — in-character end-of-interview debrief covering approach, code quality, complexity, and the one thing to do differently

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
- Reset usage for a user (PowerShell — escape inner quotes with backslash):
  ```
  aws dynamodb update-item --table-name leetcoach-users --region us-east-1 --no-verify-ssl --key '{\"userId\": {\"S\": \"<userId>\"}}' --update-expression "SET weeklyRequests = :zero" --expression-attribute-values '{\":zero\": {\"N\": \"0\"}}'
  ```
  Owner's userId: `118260042345896138064`

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
- [x] Mermaid diagrams, opt-in via header toggle at 2 prompts each (v1.2.0)
- [x] Usage indicator changed from ✨ to a circular meter ring; ✨ reused for the diagram toggle
- [x] `optimize` and `feedback` modes replacing DSA Tips in Practice/Interview (v1.2.0)
- [x] `CODE_POLICY` tightening code disclosure across all modes (v1.2.0)
- [x] ☰ settings menu (diagram, review, reset hint, clear, usage); coaching emoji back in header; concise tooltips (v1.2.0)
- [x] Review report mode (5 prompts, 30-turn history, full disclosure) (v1.2.0)
- [ ] Deploy v1.2.0 backend (`sam build --use-container && sam deploy`) and publish the extension update
## Security Findings

### Over-privileged CORS Configuration
- **Risk**: The Lambda Function URL currently allows AllowOrigins: '*'. While protected by Google OAuth, this allows any website to make requests to the backend, potentially burning a user's prompt quota.
- **Mitigation**: Restrict AllowOrigins to chrome-extension:// in 	emplate.yaml once the Extension ID is finalized.
