# LeetCoach

## One-Liner
A Chrome extension that embeds an AI coaching sidebar directly into LeetCode problem pages, giving users on-demand hints, code analysis, and DSA guidance without leaving the browser tab.

## Tags
chrome-extension, serverless, aws, fullstack, ai, backend, cloud, security

## Tech Stack
- **Chrome Extension (Manifest V3, vanilla JS)** — side panel UI, per-tab chat state management, markdown rendering with Prism.js syntax highlighting
- **background.js (service worker)** — enables/disables the side panel per-tab based on URL pattern matching; handles keyboard shortcut (Ctrl+Shift+L / Cmd+Shift+L)
- **content.js (isolated world content script)** — reads LeetCode DOM at document_idle: problem title, number, difficulty, topic tags, description, selected language, and username (parsed from nav href, not innerText, due to React SPA hydration constraints)
- **sidepanel.js (MAIN world via `chrome.scripting.executeScript`)** — reads user code from the LeetCode editor (Monaco first, then CodeMirror 6 via internal EditorView key, then DOM fallback) and scrapes submission failure details (Wrong Answer, Runtime Error, TLE, MLE, etc.)
- **AWS Lambda (Python 3.11, 256 MB, 30s timeout)** — single function handling all 5 modes behind a Function URL with `InvokeMode: RESPONSE_STREAM`; streams AI responses directly to the browser via chunked HTTP to the Lambda Runtime API
- **Amazon Bedrock** — routes `hint` and `dsa` modes to Claude Haiku (fast, cheap); `analyze` and `chat` modes to Claude Sonnet (deeper reasoning); uses `us.` cross-region inference profiles for higher availability
- **DynamoDB (PAY_PER_REQUEST)** — `leetcoach-users` table tracking `weeklyRequests`, `totalRequests`, `weekStartDate`, `firstSeen`, `lastSeen`, `tier` per LeetCode username; weekly counter resets atomically using `ConditionExpression`
- **AWS SAM (template.yaml)** — defines all infrastructure as code: Lambda function, DynamoDB table, IAM roles, Function URL, and the billing kill switch
- **AWS Budgets + IAM policy action** — automatically attaches a Deny IAM policy to the Lambda execution role when monthly Bedrock spend hits $10, instantly shutting down all AI calls; email warning fires at $7
- **GitHub Pages (docs/)** — landing page and privacy policy, built with Tailwind CSS via CDN; auto-deploys from `/docs` on master push

## Architecture
The extension is split into three execution contexts: `content.js` runs in Chrome's isolated world and reads static DOM data (problem metadata, username); `sidepanel.js` runs in the extension's side panel and uses `chrome.scripting.executeScript` with `world: 'MAIN'` to access the page's JavaScript objects (Monaco/CM6 editor, submission result DOM); `background.js` acts as a URL-aware gatekeeper that scopes the side panel to `leetcode.com/problems/*` only. When a user sends a request, the side panel POSTs to a Lambda Function URL, which streams the Claude response back over chunked transfer encoding — the Lambda bypasses the normal `return dict` handler path entirely and posts directly to the Lambda Runtime API to achieve true streaming, then monkey-patches the C extension module (`runtime_client`) to suppress the bootstrap's duplicate buffered response. Model selection is determined by mode: Haiku handles quick, constrained outputs (hints, DSA tips) while Sonnet handles free-form chat and code analysis, keeping inference costs low while preserving quality where it matters.

## Technical Challenges

- **Lambda response streaming without API Gateway:** AWS RESPONSE_STREAM Lambdas do not propagate `statusCode` from a returned dict, and the bootstrap double-posts a buffered response after the handler returns. Solution: all responses (AI and error) post directly to the Lambda Runtime API over raw HTTP using `http.client`, then the C extension module `runtime_client.post_invocation_result` is monkey-patched at import time to swallow the bootstrap's duplicate post for that invocation ID.

- **Reading code from LeetCode's editor:** `content.js` runs in Chrome's isolated world and cannot access `window.monaco`. Solution: `sidepanel.js` injects a function into the `MAIN` world via `chrome.scripting.executeScript`, which first tries the Monaco API, then falls back to CodeMirror 6 by finding the internal `EditorView` key on `.cm-editor` (via `Object.keys` + duck-typing `state.doc`), then falls back to reading `.cm-line` DOM elements directly. This chain handles LeetCode's mid-2024 editor migration from Monaco to CM6.

- **TOCTOU race on weekly usage limits:** A simple read-then-write to DynamoDB would allow two concurrent requests to both pass the limit check and both increment past 100. Solution: the increment uses a `ConditionExpression: 'weeklyRequests < :limit'` to make the check and write atomic. The weekly reset uses a separate `ConditionExpression: 'weekStartDate <> :monday'` to prevent double-resets when concurrent requests both see a stale week start date.

- **LeetCode SPA username extraction:** LeetCode renders in React and the username text node may not be present in the isolated content script world at injection time. Solution: parse the `href` attribute of `a[href*="/u/"]` nav links instead of reading `innerText`, since the href is set by React before paint and is reliably present.

- **Billing kill switch without touching application code:** Needed a hard spending cap that activates automatically without a deployment. Solution: a `BedrockKillSwitchPolicy` (Deny all Bedrock calls) is pre-provisioned in SAM but not attached. An AWS Budgets action is configured to automatically attach this policy to the Lambda execution role at $10/month actual spend — no Lambda code change needed; the Deny overrides all Allow policies immediately.

- **Per-tab chat state with zero-copy DOM snapshotting:** Switching tabs in Chrome would normally destroy the side panel's DOM. Solution: on `tabs.onActivated`, the outgoing tab's chat nodes are moved into a `DocumentFragment` (zero serialization overhead), and restored by reinserting the fragment on tab focus — preserving rendered markdown, code highlighting, and scroll position per tab.

- **Streaming error detection:** Lambda RESPONSE_STREAM cannot send HTTP error codes mid-stream. Solution: rate limit and auth errors are streamed as JSON strings. The frontend buffers the full response and attempts `JSON.parse` after streaming completes — if it parses as `{error: "weekly_limit_reached"}`, the bubble is replaced with a styled limit warning instead of rendered markdown.

## Quantifiable Details

- **100 requests/week** per user (free tier), enforced atomically in DynamoDB
- **5 operating modes:** `chat`, `hint`, `analyze`, `dsa`, `usage`
- **3 hint levels** — progressive disclosure: directional nudge → algorithm category → exact structure
- **2 AI models:** Claude Haiku (hint/dsa) and Claude Sonnet (chat/analyze) — routed by mode
- **Token budgets per mode:** 64 (hint), 128 (dsa), 256 (analyze), 256 (chat)
- **$10/month** automatic billing kill switch; **$7** warning email threshold
- **10-turn** rolling conversation history sent with chat requests
- **Input size limits:** code 10 KB, problem description 5 KB, message 2 KB
- **10-second** usage sync timeout; **60-second** chat request timeout
- **v1.1.0** published to Chrome Web Store
- **6 submission failure types** captured and sent to AI: Wrong Answer, Runtime Error, Compile Error, TLE, MLE, OLE
- **20+ programming languages** mapped to Prism.js syntax highlighting tokens

## Deployment Status

- **Chrome Web Store:** published as "LeetCoach" at v1.1.0, publicly available
- **Backend:** AWS Lambda (us-east-1) behind a Function URL, deployed via AWS SAM
- **Landing page:** live at `https://varunanand2006.github.io/LeetCoach/` (GitHub Pages, auto-deploys from `/docs` on master)
- **Privacy policy:** `https://varunanand2006.github.io/LeetCoach/privacy.html`
- Source code: `https://github.com/varunanand2006/LeetCoach`

## Pre-Written Resume Bullets

- **Built a serverless AI coaching extension** used on LeetCode problem pages, delivering streamed Claude responses in under 2 seconds by bypassing AWS API Gateway and posting directly to the Lambda Runtime API with chunked transfer encoding.

- **Shipped a published Chrome Web Store extension (v1.1.0)** that auto-opens a Claude-powered sidebar on LeetCode problem pages, supporting 5 interaction modes (hints, code analysis, DSA tips, freeform chat, usage sync) across 20+ programming languages.

- **Solved a Lambda streaming bootstrap conflict** by monkey-patching the `runtime_client` C extension module at import time to suppress the duplicate buffered response the bootstrap posts after the handler returns, enabling true token-by-token streaming without a proxy layer.

- **Eliminated a TOCTOU race condition in rate limiting** by using DynamoDB `ConditionExpression` to make the weekly usage check and increment atomic, preventing concurrent requests from bypassing the 100 req/week cap even under simultaneous load.

- **Engineered a zero-cost billing kill switch** using AWS Budgets + IAM policy actions: a pre-provisioned Deny policy is automatically attached to the Lambda execution role at $10/month actual spend, shutting down all Bedrock calls without any code deployment or manual intervention.

- **Maintained code-reading compatibility through LeetCode's editor migration** from Monaco to CodeMirror 6 by implementing a three-tier fallback in the MAIN world injected script: Monaco API → CM6 internal `EditorView` key (duck-typed via `Object.keys`) → `.cm-line` DOM element scraping.

- **Designed a per-tab chat state system** using `DocumentFragment` DOM snapshots to preserve full conversation history, rendered markdown, and scroll position independently per browser tab with zero serialization overhead.

---

## Additional

### System Prompt Design
Each mode has a carefully constrained system prompt tuned to its token budget. The hint prompt enforces three escalation levels (directional nudge → algorithm name → specific data structure), explicitly prohibiting code or pseudocode at each level. The analyze prompt structures output into exactly three bullet categories (correctness, complexity, edge cases) and requires specific line numbers when diagnosing bugs. The DSA prompt caps output at 1–3 lines and mandates bolding of pattern/structure names. These constraints keep Haiku (64–128 token budget) responses terse and actionable rather than verbose.

### Submission Result Context
When a user clicks Analyze after a failed submission, the extension reads the failure details from the LeetCode result panel in the MAIN world (status, input, expected output, actual output, error messages) and injects them into the system prompt. This lets the AI diagnose the exact failing case rather than giving generic feedback — a meaningful quality jump for Wrong Answer and TLE debugging.

### Infrastructure as Code
The entire AWS deployment (Lambda, DynamoDB, IAM roles, Function URL, Budget, kill switch policy) is defined in a single `template.yaml` SAM file. The API key is a `NoEcho` SAM parameter stored in gitignored `samconfig.toml` locally and injected as a Lambda environment variable at deploy time — it never appears in source control.

### LeetCode DOM Fragility Mitigations
LeetCode frequently changes its React component class names. The extension uses layered selectors: stable `data-cy` and `data-track-load` attributes first, known class names as fallback, and finally structural heuristics (e.g., scanning all `span[class]` elements for text exactly matching "Easy" / "Medium" / "Hard"). This layering means the extension continues working through most LeetCode UI updates without a code change.
