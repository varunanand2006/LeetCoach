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
- `backend/` — chat Lambda (`CodeUri`) and its tests
- `payments/` — Stripe webhook Lambda (`CodeUri`) and its tests
- `scripts/` — dev-only tooling (`upload_problems.py` + the 20MB dataset)
- `template.yaml` — SAM infrastructure definition
- `docs/` — GitHub Pages site (landing page, privacy policy, demo video)

**Nothing that isn't Lambda code belongs under `backend/` or `payments/`** — they are `CodeUri` roots, so every file in them ships in that function's deployment package. `scripts/` used to live at `backend/scripts/` and was putting a 20MB JSON dataset into every deploy. **SAM has no `.samignore`** (confirmed absent from SAM CLI 1.156.0 — the feature was requested for years and never shipped), so keeping files out of the tree is the only way to keep them out of the package.

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
- `src/api.js` — Lambda fetch, streaming, Google auth token, usage increment, error/retry handling
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
- Header buttons carry a subtle `1px #333` outline; the hamburger turns brand orange (`#ffa116`) on hover and while open. Costs are deliberately NOT shown as badges in the menu
- Tooltips are noun phrases, not sentences — "Runtime analysis", not "Review runtime, memory, and Big-O complexity". Note that `syncThirdButton` overwrites the third button's `title` from the `THIRD_BUTTON` table, so editing the HTML `title` alone has no effect
- `/clear` and `/reset` still work as typed commands; the menu's Clear this chat calls the same `clearChat()`
- An earlier iteration used a segmented Learn/Practice/Interview row and a header ✨ — both were reverted in favour of the icon-only cycle button and moving the diagram toggle into the menu

## Review Report
- 5 prompts (`REVIEW_COST`), triggered only from the ☰ settings menu — the menu placement is itself the friction, so there's deliberately no confirm dialog
- Disabled below `MIN_REVIEW_MESSAGES` (6) history entries — a retrospective on a near-empty conversation is a guaranteed waste of 5 prompts
- The only button mode that sends `history`; needs up to 30 entries, so `MAX_RETAINED_HISTORY` (30) governs frontend retention and `MAX_HISTORY_TURNS_REVIEW` (30) the backend cap. Chat stays at 10 — a 30-turn history on every chat turn would inflate input token cost on the most-used path
- **Deliberately exempt from `CODE_POLICY`** — it's a retrospective, so it may show the complete optimal solution regardless of coaching mode. The prompt is identical in all three modes
- Diagram is optional and off by default — arm it from the menu like any other mode. Cost stays a flat 5 either way: the diagram used to be bundled into that price, so charging 5+2 would be a rise
- The diagram was originally inlined in the review prompt with the augmentation skipped, so it got no token bonus. The report exhausted its budget mid-fence and the panel showed a 'Drawing diagram…' placeholder that never resolved. Review now falls through the normal `wantsDiagram` path
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
- Rendering happens only after the stream closes (partial Mermaid never parses). An unterminated fence shows a "Drawing diagram…" placeholder mid-stream; if it is still unterminated when the stream ends, it resolves to "Diagram was cut off." rather than spinning forever
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
  - `slug`: sent by chat (for the `get_solution` tool) and by hint/analyze/optimize (for the problems-table lookup). Validated against `^[a-z0-9][a-z0-9\-]{0,99}$`
- Returns: streamed plain text via chunked transfer encoding to Lambda Runtime API
- Model routing: `HAIKU_MODES` (hint, dsa, feedback) → `us.anthropic.claude-haiku-4-5-20251001-v1:0`; everything else → `us.anthropic.claude-sonnet-4-6` (the `us.` prefix enables cross-region inference routing). Any request with `wantsDiagram` overrides to Sonnet. The set is declarative so moving a mode between models is a one-line change
- **What stays on Sonnet, and why**: ordered by what a wrong answer costs the user. `analyze` asserts a bug exists and `optimize` asserts a Big-O — both are wrong-answer-visible. `review` emits a complete solution. `chat` is open-ended and drives the `get_solution` tool loop. `feedback` moved to Haiku because it's a subjective debrief with no correctness surface. **`optimize` is the next candidate** now that constraints are injected (the bound is derivable, not guessed) — try it before anything else on this list
- Model IDs overridable via `HAIKU_MODEL_ID` / `SONNET_MODEL_ID` Lambda env vars — update these when Anthropic deprecates a version, no code change needed
- Token budgets: hint 110, dsa 180, optimize 220, analyze 240, feedback 260, chat 320, review 750; `+300` when `wantsDiagram` (review included)
- **`max_tokens` is a truncation guard, not a cost lever** — output bills on tokens *generated*. Lowering it saves nothing and only clips replies mid-sentence; `RESPONSE_STYLE` and the per-mode line caps are what actually shorten output. The inverse holds too: raising `max_tokens` alone will not make replies longer. Prompts cap line counts explicitly (optimize 3 lines, feedback 4, analyze 3 bullets)
- `RESPONSE_STYLE`: one shared voice block appended in `build_prompt_for_mode` to every mode **except review** — same rationale as `CODE_POLICY` being a single dict, brevity drifts the moment each builder owns a copy. Review is exempt because "lead with one thing and cut the rest" would gut a five-section retrospective. Costs ~140 input tokens per request; that is a net loss on `hint` alone (its ceiling only fell 18 tokens) and a win everywhere else — kept because filler openers are exactly what bloats a one-sentence hint
- Per-mode prompts no longer repeat "no preamble" / "be confident" / "be concise" — `RESPONSE_STYLE` owns those. Re-adding them to a builder reintroduces the drift the block exists to prevent
- `usage` mode: reads DynamoDB, streams `{weeklyRequests, purchasedCredits, weekStartDate}` as JSON — does NOT count against limit
- `check_and_update_usage(user_id, cost=1)`: called before every Bedrock call; `cost` is 2 for diagram requests. **Returns which balance was charged**, not a bool: `BUCKET_FREE` / `BUCKET_PAID` when allowed, `BUCKET_NONE` when allowed without charging (unauthenticated, or failing open on a DynamoDB error), `None` when out of prompts. The caller must pass that value to `refund_usage`. The free bucket covers the request iff `weeklyRequests <= WEEKLY_LIMIT - cost` — the threshold is precomputed in Python because DynamoDB can't do arithmetic inside a `ConditionExpression`. Always fails open on DynamoDB errors; resets weekly counter when weekStartDate != current Monday; the `ConditionExpression` makes the limit check + increment atomic (eliminates TOCTOU race on concurrent requests)
- `WEEKLY_LIMIT = 50` (named constant). **Mirrored in `src/state.js`** — a mismatch shows the user a balance the server disagrees with. `backend/tests/test_usage_buckets.py` derives every threshold from it, so the suite still means something after a change; verified passing at 25/50/200. Also hardcoded as placeholder text in `sidepanel.html` and stated in `docs/privacy.html`
- `refund_usage(user_id, cost, bucket)`: usage is debited *before* Bedrock runs, so any failure after that point would silently cost the user (5 of 100 for a review). The Bedrock call is wrapped and refunds on exception. `bucket` decides which balance is credited — refunding a purchased credit into `weeklyRequests` would destroy it at the next reset, and refunding a free prompt into `purchasedCredits` would hand out paid credit for nothing. `BUCKET_NONE` is a no-op because no charge landed. A `ConditionExpression` stops either counter going negative. **It cannot cover a Lambda timeout** — that kills the process outright, which is why `Timeout` is 60s (a review is 1200 max_tokens on Sonnet) rather than the original 30s

## Prompt Packs
| Pack | Price | Prompts | $/prompt | Stripe fee | Net | Bedrock cost | Profit |
|---|---|---|---|---|---|---|---|
| `mini` | $0.99 | 50 | $0.0198 | $0.33 (33%) | $0.66 | $0.19 | $0.47 |
| `small` | $4.99 | 500 | $0.0100 | $0.44 (9%) | $4.55 | $1.90 | $2.65 |
| `large` | $9.99 | 1500 | $0.0067 | $0.59 (6%) | $9.40 | $5.70 | $3.70 |

- Defined in **three** places that must agree: `CHECKOUT_PACKS` (price, chat Lambda), `PACKS` (price + credits, webhook), `PROMPT_PACKS` (display, `src/state.js`). The webhook cross-checks the collected amount, so price drift fails purchases loudly instead of granting wrong
- `backend/tests/test_checkout.py` iterates the tables rather than hardcoding, so **a new pack automatically gets** the cross-package price check and an end-to-end grant/refund round-trip
- **`mini` is priced for conversion, not margin.** Stripe's $0.30 fixed fee takes a third of it. It exists to make the first purchase trivial and to anchor `small` as visibly better value. The risk is cannibalisation: a buyer moving from `small` to `mini` costs $2.16 of profit, so it needs ~4.5 incremental buyers per switcher to pay off

## Purchased Prompts (two-balance spend)
- Free weekly allowance and purchased credits are **separate DynamoDB attributes** (`weeklyRequests` and `purchasedCredits`). This is not a style choice: `check_and_update_usage` resets `weeklyRequests` outright on a Monday rollover, so credits kept in that field would be destroyed by the first reset after purchase
- **Free is always spent before paid**, so credits can't evaporate at the reset while free prompts sat unused
- A request charges **one bucket for its whole cost, never split across both** — a 5-prompt review with 2 free prompts left takes 5 credits and leaves the 2. Splitting would need a transaction for no real benefit, and the frontend mirrors the same rule in `incrementUsage`
- DynamoDB can't express "free OR paid" usefully in one `ConditionExpression`, so it's two sequential conditional writes: try the free increment, and on `ConditionalCheckFailedException` fall through to `_spend_purchased_credits`. Each write is individually atomic, so the TOCTOU guarantee holds. The common path is still a single write — the second only fires once the weekly allowance is gone
- `purchasedCredits >= :cost` fails when the attribute is absent, which is correct for a user who never bought anything — **no backfill needed on existing rows**
- The new-user `put_item` is guarded by `attribute_not_exists(userId)` and re-reads on conflict, because an unguarded write racing the payment webhook would overwrite a row that already holds credits
- The reset and increment conditions carry an `attribute_not_exists(...)` arm so a row created by the payment webhook — credits but no usage fields — still charges the free bucket first instead of falling straight through to credits
- Frontend: `remainingPrompts()` in `src/ui.js` sums free + purchased, so the diagram toggle and review button stay usable for a paying user whose weekly allowance is spent. `remainingFreePrompts()` is the weekly-only figure. The usage ring stays a meter for the *weekly* allowance and fills on that alone; the `low`/`empty` classes key off the spendable total so a full ring doesn't read as "out" to someone holding credits
- `loadUsageCount()` restores credits **outside** the Monday-rollover branch — inside it, a new week would zero them locally
- `validate_and_sanitize_body()`: called on every request before processing; truncates oversized fields (code: 10KB, description: 5KB, message: 2KB), clamps hintLevel to 1–3, coerces `wantsDiagram` to a strict bool, validates userId against `^[a-zA-Z0-9_\-\.]{1,50}$` (sets to null if invalid)
- `_sanitize_history()`: history originates in `chrome.storage.local`, so it's as untrusted as any other client field. Drops non-dict entries, bad roles, and non-string content; clips each turn to `MAX_HISTORY_CONTENT_BYTES` (4KB) — capping turn *count* alone leaves input token cost unbounded. It also **guarantees the shape Bedrock requires**: alternating roles, starting `user`, and never ending `user` (because `build_messages` appends the current user turn — two user messages in a row is a 400 that surfaces as a generic internal error)

## Problems Table (`leetcoach-problems`)
- Populated by `scripts/upload_problems.py` from a LeetCode dataset. Per item: `problemSlug` (key), `problemId`, `title`, `difficulty`, `topicTags`, `description`, `solutions`, `hints`, `examples`, `constraints`, `codeSnippets`
- Two distinct readers, deliberately kept separate:
  - `get_solution` **tool** (`GET_SOLUTION_TOOL`) — chat mode only, wired through `_chat_tool_chunks`, max 1 tool call per turn. Reads `solutions` via `get_problem_details()`. The model decides when to reach for it
  - `get_problem_context()` — a plain lookup for hint/analyze/optimize (`PROBLEM_CONTEXT_MODES`), no model turn involved. Uses a **narrow `ProjectionExpression`** (`hints`, `constraints`) because `solutions` on one item can run to 100KB and none of these modes need it. Projected through `ExpressionAttributeNames` since attribute names here collide with DynamoDB reserved words
- Fetched *after* the usage check, so a rejected request never pays for the read
- **Hints are level-gated**: LeetCode's official hints run least to most specific, which maps directly onto hint levels 1–3, so level N injects the first N hints and no more. The prompt tells the model to treat them as ground truth for direction but not to quote or dump them
- **Constraints feed analyze and optimize**: they turn the complexity verdict from a guess into arithmetic ("O(n²) with n up to 10^5 is ~10^10 ops"). Analyze also uses them to avoid raising edge cases the constraints rule out
- All of this degrades silently — every formatter returns `''` when the problem isn't in the table, so prompts are unchanged for problems that aren't covered

## Frontend Error Handling and Auth (`src/api.js`)
- A streaming Lambda can't set a status code, so **every** backend error arrives as a JSON body with HTTP 200. `parseErrorPayload()` checks the completed response for an `error` key; `streamResponse` bails on any of them, not just `weekly_limit_reached`
- This matters beyond cosmetics: before the fix, a non-limit error (`unauthorized`, `invalid_request`, `internal_error`) fell through the limit check and was rendered as raw JSON, **charged the local usage ring** for a request that never reached the model, and was written into `state.history` — where it would be replayed as context on every later turn and into the review report
- `runRequest()` is one attempt; `streamResponse()` owns retry, error display, and the charge/persist path. Only a clean response reaches `renderDiagramsIn` → `incrementUsage` → `onSuccess`
- **Stale-token retry**: `chrome.identity.getAuthToken` returns cached tokens without knowing they've been revoked or expired, and there is no other way to clear one — so an `unauthorized` response triggers `removeCachedAuthToken` + one retry with a fresh token. Without it the user fails every request until they clear extension data. Auth is rejected before usage is charged, so the retry is free. `fetchUsageFromServer` drops a rejected token too, so a stale one doesn't also break the user's first real request
- Failures render as an inline `.message.warning` bubble via `showErrorMessage()` (which `showLimitWarning` now delegates to), not as text inside the assistant bubble

## Coaching Modes and Code Disclosure
- `CODE_POLICY` in lambda_function.py is a single dict appended to **every** mode's system prompt, so the policy can't drift between prompt builders. Ordered by permissiveness: learn > practice > interview
  - **learn** — may show a single line, the one key operation, or a skeleton with `___` / `# TODO` blanks. Never a complete or runnable solution
  - **practice** — defaults to no code; a snippet of ≤3 lines is allowed only when it genuinely clarifies
  - **interview** — no code at all, not even pseudocode. Words only
- The third mode button swaps with the coaching mode (`THIRD_BUTTON` in `src/ui.js`, `data-mode` on `#btn-third`):
  - learn → **DSA Tips** (`dsa`)
  - practice → **Optimize** (`optimize`) — Big-O time/space of the current code, the optimal bound, and the technique that closes the gap (without implementing it)
  - interview → **Feedback** (`feedback`) — in-character end-of-interview debrief covering approach, code quality, complexity, and the one thing to do differently

## Payments Feature Flag
- **`PAYMENTS_ENABLED` is a server-side switch, never a shipped constant.** An extension constant would need a new Chrome Web Store package and review to change — days of latency on a business decision. As a Lambda env var it is one `sam deploy`
- Resolved as `PAYMENTS_ENABLED == 'true'` **and** `STRIPE_SECRET_KEY` non-empty, so a half-configured deploy stays off rather than showing a buy button that 500s
- Reported to the extension as `paymentsEnabled` in the `usage` response. `setPaymentsEnabled` + `syncPaymentsUI` show/hide the ☰ Buy row; `showLimitWarning` checks it before offering the pack picker
- **`#menu-buy` carries `hidden` in `sidepanel.html`** and the frontend default is `false`, so a failed usage call leaves the buy UI off. Fails closed, deliberately
- `create_checkout_session` re-checks the flag server-side, so the mode is dead even if a client reaches it with the UI hidden

## Stripe Checkout (`create_checkout_session` mode)
- Sits **above the usage check** alongside `usage` mode — buying prompts must never cost a prompt, and no Bedrock call is involved
- Body is `{mode: 'create_checkout_session', pack: 'mini'|'small'|'large'}`. `client_reference_id` is set from the **verified Google token**, never from the body
- Prices are sent inline as `price_data`, not as pre-created Price IDs — nothing to configure in the Stripe dashboard and no ID to keep in sync
- `payment_intent_data[metadata]` carries `userId` and `pack` onto the Charge. **Refund and dispute events carry a charge, not a session**, so without this the webhook cannot work out whose credits to claw back
- **`CHECKOUT_PACKS[*]['amountCents']` here must equal `PACKS[*]['amountCents']` in `payments/app.py`.** They're in separate deployment packages and can't import each other; the webhook cross-checks the collected amount and refuses to grant on a mismatch, so drift fails purchases loudly rather than granting wrong. `backend/tests/test_checkout.py` asserts the two tables agree and round-trips a created session through `handle_grant`
- Credit *counts* live only in the webhook — it's what moves them, so it decides how many
- Stripe's error text is logged, never returned: it can quote request detail back
- Frontend: `createCheckoutSession()` in `src/api.js` **regex-checks the returned URL is a Stripe host** before it reaches `chrome.tabs.create` — the response decides where a tab opens
- Opens in a new tab, not a redirect, so the side panel stays open and the new balance is visible on return. Stripe lands on `docs/payment-success.html` / `docs/payment-cancelled.html`
- The pack picker (`showBuyCard` in `src/ui.js`) renders inline in the chat, reached from the ☰ menu **and** automatically from `showLimitWarning` — running out is when buying is actually relevant. `ui.js` holds the handler via `setBuyHandler()` rather than importing from `api.js`, because `api.js` already imports `ui.js` and the cycle would break on load order

## Stripe Webhook (`payments/app.py`)
- **A separate Lambda with `InvokeMode: BUFFERED`, and it must stay separate.** Stripe decides whether to retry purely from the HTTP status (2xx = delivered, anything else = retry with backoff for ~3 days). The chat function's URL is `RESPONSE_STREAM` and *cannot set a status code* — served from there, a failed credit grant would look like success, Stripe would never retry, and the user would have paid for nothing
- Status codes are load-bearing: **200** processed / duplicate / event we don't act on · **400** bad signature or malformed (retrying can't help) · **500** transient failure *and* unknown pack (see below)
- **No Stripe SDK** — signature verification is HMAC-SHA256 and nothing else needs the client, so the package is stdlib + boto3
- `verify_signature()` is the only thing authenticating the URL, which is necessarily `AuthType: NONE`. Verifies over the **raw body bytes** (base64-decoded when `isBase64Encoded`) — never re-serialise, `json.dumps(json.loads(body))` reorders keys and breaks the signature. Enforces a 300s timestamp tolerance against replay, accepts any of several `v1` entries (secret rotation), and uses `hmac.compare_digest`
- Idempotency: the ledger `Put` (`attribute_not_exists(eventId)`) and the balance `Update` go in **one `TransactWriteItems`**, because Stripe does not promise exactly-once delivery. A plain check-then-credit leaves a window where a retry arriving mid-flight credits twice
- `PACKS` lives in the **webhook**, not in the event metadata — the webhook is what moves credits, so it decides how many, and a bug in checkout can't over-grant. `amount_total` and currency are cross-checked against the pack
- **Unknown pack returns 500 on purpose.** The user has already paid, so a silent 200 strands them; a 5xx keeps the event visibly failing in the Stripe dashboard and redeliverable once `PACKS` is fixed
- Grants on both `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and only when `payment_status == 'paid'` — delayed payment methods complete the session before money moves
- Revokes on `charge.refunded` and `charge.dispute.created`, pro-rata for partial refunds. DynamoDB can't express `max(0, balance - n)` in one update, so it tries the full deduction and falls back to zeroing when the user already spent part of the pack. `userId`/`pack` reach the charge via `payment_intent_data.metadata` set at session creation
- **Its role has no Bedrock access, deliberately.** The billing kill switch attaches a Deny to `ChatFunctionExecutionRole` only, so payments keep recording correctly even while the AI is shut off
- IAM for transactions: `TransactWriteItems` authorises against the **item-level** actions in the transaction, not a `TransactWriteItems` action. Verified live with `aws iam simulate-principal-policy` — `PutItem`/`UpdateItem`/`GetItem` are `allowed` on both table ARNs. **`dynamodb:ConditionCheckItem` is `implicitDeny`**: nothing uses a `ConditionCheck` operation today, but adding one to a transaction would fail at runtime against a policy that looks complete. Add the action to `PaymentDynamoDBAccess` if that ever changes
- Tests: `python payments/tests/test_webhook.py` (42 cases, no AWS needed — fakes DynamoDB transaction semantics including per-item `CancellationReasons`)

## DynamoDB
- Table: `leetcoach-payments`, partition key: `eventId` (String), PAY_PER_REQUEST, TTL on `expiresAt` — idempotency ledger, 400-day retention (outlives the ~120-day dispute window; Stripe stops retrying after ~3 days)
- Table: `leetcoach-users`, partition key: `userId` (String), PAY_PER_REQUEST
- Item schema: `userId`, `weeklyRequests`, `purchasedCredits` (optional; absent until they buy), `totalRequests`, `weekStartDate` (YYYY-MM-DD of Monday), `firstSeen`, `lastSeen`, `tier` (free)
- `purchasedCredits` is the only attribute the Monday reset must never touch — see the Purchased Prompts section above
- Table: `leetcoach-problems`, partition key: `problemSlug` (String), PAY_PER_REQUEST — see the Problems Table section above
- IAM: Lambda role has scoped `GetItem`/`PutItem`/`UpdateItem`/`Query` on both table ARNs (not `AmazonDynamoDBFullAccess`); deploying user (`leetcoach-dev`) needs `AmazonDynamoDBFullAccess`

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
- IAM — Lambda execution role with inline scoped policies (see `template.yaml`): `bedrock:InvokeModelWithResponseStream` on the Claude inference profiles, and DynamoDB item actions on the two table ARNs. Not the AWS-managed FullAccess policies

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

## Stripe Account Configuration
- Endpoint: the `PaymentWebhookUrl` stack output, registered in Stripe → Developers → Webhooks
- Destination type **Webhook endpoint**, scope **Your account** (no Connect), payload style **snapshot events**
- **Snapshot, not thin events.** Thin events omit the full object, so `data.object` would not carry `client_reference_id`, `amount_total` or `metadata` — every handler in `payments/app.py` reads from it and would break
- Exactly four events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`
- **Do not use `stripe listen --forward-to`.** It exists for local development where Stripe cannot reach the endpoint, and it mints its **own** signing secret that differs from the registered endpoint's. The Lambda Function URL is publicly reachable, so Stripe POSTs to it directly and the endpoint's own `whsec_` is the only correct value for `StripeWebhookSecret`
- Test a purchase from the extension itself with card `4242 4242 4242 4242`, then refund it in the dashboard to exercise `charge.refunded` and prove the `payment_intent_data[metadata]` plumbing reached the Charge
- A 500 in Stripe's delivery log means IAM; the webhook's CloudWatch log names the missing action

## Going Live
Test and live mode are **entirely separate accounts** inside Stripe — separate keys, separate webhook endpoints, separate `whsec_`, separate payment history. Nothing configured in test mode carries over, so every step below is a fresh setup, not a toggle.

1. Complete Stripe's business verification (bank details, identity). Live keys don't exist until this is done
2. Register the **same** `PaymentWebhookUrl` again, this time with the dashboard in **live** mode, subscribed to the same four events. It gets a *different* `whsec_`
3. Redeploy with both live values: `sam deploy --parameter-overrides "StripeSecretKey=sk_live_... StripeWebhookSecret=whsec_<live one> MonthlyBudgetUsd=50"`
4. Buy one small pack with a **real card** and refund it. Test-mode success does not prove live wiring
5. Only then bump `manifest.json` and publish the extension

**Ordering matters in one direction.** Deploying live keys before the extension update is harmless. Publishing the extension while the Lambda still holds `sk_test_` is not — users get checkout pages that look completely real and take no money.

## Budgets (three exist; only one can stop production)
| Budget | Limit | Action |
|---|---|---|
| `LeetCoach-Bedrock-leetcoach` | $50 | Kill switch → live role. **The only one that can stop production** |
| `LeetCoach-Monthly` | $10 | Email only (`Actions: []`). Deliberate early-warning tripwire, not a cutoff |
| `LeetCoach-Bedrock-leet-coach` | — | **Deleted 2026-07-25** with the orphan stack |

## Duplicate `leet-coach` Stack (resolved 2026-07-25)
- A second CloudFormation stack, `leet-coach`, existed from 2026-04-11 to 2026-07-25 with nothing pointing at it. Deleted
- It ran a public Function URL on `python3.11` with Bedrock invoke permissions, its own $10 budget + kill switch, and `leet-coach-users` — a *different* table from `leetcoach-users`, holding one stale row from before Google-sub IDs. The differing table names are why deleting it was safe
- **The lasting lesson**: `aws lambda list-functions` returned functions from both stacks, and `[0]` in a JMESPath query silently grabbed the orphan — which is how a correctly deployed `python3.14` function was first misread as still being on `python3.11`. Filter on the full function name, never positionally

## Environment Notes (this machine)
- Shell is PowerShell: no `\` line continuations (use a backtick), no `cut`/`head`/`tail`, no `&&`
- **TLS interception is active**: `aws` needs `--no-verify-ssl`, `curl` needs `-k`

## Tests
- `python backend/tests/test_usage_buckets.py` — 36 cases, two-balance charge/refund
- `python backend/tests/test_checkout.py` — 29 cases, checkout session + the cross-package price contract
- `python payments/tests/test_webhook.py` — 42 cases, signature verification, idempotency, refunds
- All three fake DynamoDB and the Lambda runtime; no AWS credentials or network needed
- **`node --check` silently false-passes on these `.js` files** (returns 0 even on deliberately broken syntax). Copy to `.mjs` first — that catches errors properly. Verified on Node v24.13.0

## Development Commands
- Deploy backend: `sam build --use-container && sam deploy`
- Load extension: chrome://extensions → Developer Mode → Load Unpacked → `extension/`
- After Lambda changes: `sam build --use-container && sam deploy`
- After extension changes: refresh extension in chrome://extensions, reload LeetCode tab
- New extension version: bump `version` in `manifest.json`, zip `extension/` contents (**not** the folder itself — a nested `extension/` prefix is rejected) using `Compress-Archive -Path extension\* -DestinationPath leetcoach-x.x.x.zip` in PowerShell, upload to Chrome Web Store
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
- [x] Backend errors no longer render as raw JSON, charge usage, or poison history; stale-token retry
- [x] Prompt refund when Bedrock fails after usage was debited; Lambda timeout 30s → 60s
- [x] Server-side history validation (shape, alternation, per-turn size cap)
- [x] Official hints injected into hint mode (level-gated) and constraints into analyze/optimize
- [x] Two-balance spend logic: `purchasedCredits` alongside `weeklyRequests`, free-first, bucket-aware refunds (`backend/tests/test_usage_buckets.py`)
- [x] Stripe webhook: BUFFERED Lambda, signature verification, transactional idempotency, refunds/disputes (`payments/`)
- [x] `scripts/` moved out of `backend/` — a 20MB dataset was shipping in every Lambda deploy
- [x] Stripe checkout: `create_checkout_session` mode, inline pack picker, success/cancel pages
- [x] Lambda runtime bumped `python3.11` → `python3.14` (3.11 creation was disabled 2026-07-31)
- [x] Budget cap parameterised as `MonthlyBudgetUsd`, default raised $10 → $50
- [x] Deployed to stack `leetcoach`: both functions on `python3.14`, `leetcoach-payments` ACTIVE with TTL, real `whsec_` in place, Stripe key in **test mode**, kill-switch budget $50
- [x] Webhook verified live — unsigned and forged-signature requests both rejected with HTTP 400
- [x] Webhook role verified for `TransactWriteItems` via `iam simulate-principal-policy`
- [x] **Test-mode purchases verified live (2026-07-25)** — two `checkout.session.completed` grants credited 500 each and independently; one `charge.refunded` revoked exactly 500, leaving 500. The revoke proves `payment_intent_data[metadata]` reached the Charge, which is the only way a refund can identify the user. `runtime_client` streaming confirmed working on Python 3.14
- [x] Orphan `leet-coach` stack deleted; `leetcoach` and `aws-sam-cli-managed-default` are the only stacks left
- [x] v1.3.0 packaged for the Chrome Web Store (`leetcoach-1.3.0.zip`): CORS scoped to the extension id, payments feature-flagged off, weekly limit 50
- [ ] **Stripe deferred** — business verification needs US bank access. Turning it on later is `sam deploy --parameter-overrides "PaymentsEnabled=true StripeSecretKey=sk_live_... StripeWebhookSecret=whsec_..."`, then restore the pricing CTAs on the landing page and the Payments section of `docs/privacy.html`. **No Chrome Web Store resubmission needed**
- [ ] Deploy the CORS change, then **verify a live request from the extension before submitting**
- [ ] Raise the $10 budget cap before taking any payment — the kill switch can Deny Bedrock for a paying customer
- [ ] Deploy v1.2.0 backend (`sam build --use-container && sam deploy`) and publish the extension update
## Security Findings

### CORS (resolved)
- `AllowOrigins` is now `chrome-extension://mphhiilfiepjpipajkgoehmoncilcmfj`, not `'*'`
- The id is **deterministic** because `manifest.json` pins a `key` — derived as base16→a-p of `sha256(DER(key))[:16]`, verified to match the store listing, and stable across updates and reinstalls
- `host_permissions` does **not** cover the Lambda URL, so side-panel calls are genuine cross-origin requests and this header is what the browser enforces. **Any change here must be verified with a live request before publishing** — if the origin doesn't match, every request fails with an opaque CORS error
