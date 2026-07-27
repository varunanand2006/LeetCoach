import json
import os
import re
import http.client
import urllib.parse
import datetime
import boto3
from botocore.exceptions import ClientError

bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

WEEKLY_LIMIT = 50

# Which balance a request was charged to. Purchased credits live in their own
# attribute rather than offsetting weeklyRequests, because the Monday reset
# overwrites that field outright — credits kept there would be destroyed by the
# first rollover after purchase.
BUCKET_FREE = 'free'
BUCKET_PAID = 'paid'
BUCKET_NONE = 'none'  # allowed without charging (unauthenticated, or failing open)

TABLE_NAME = os.environ.get('TABLE_NAME', 'leetcoach-users')
PROBLEMS_TABLE_NAME = os.environ.get('PROBLEMS_TABLE_NAME', 'leetcoach-problems')

_table = dynamodb.Table(TABLE_NAME)  # cached; Lambda reuses this across warm invocations
_problems_table = dynamodb.Table(PROBLEMS_TABLE_NAME)

# Model IDs — override via Lambda environment variables when Anthropic deprecates a version
HAIKU_MODEL_ID = os.environ.get('HAIKU_MODEL_ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
SONNET_MODEL_ID = os.environ.get('SONNET_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')


# ---------------------------------------------------------------------------
# Stripe Checkout
# ---------------------------------------------------------------------------

STRIPE_SECRET_KEY = os.environ.get('STRIPE_SECRET_KEY', '')

# Whether the purchase flow is live. Deliberately a server-side switch reported
# to the client in the `usage` response, NOT a constant baked into the
# extension — a shipped constant would need a new Chrome Web Store package and
# review to change, which is days of latency on a business decision.
# Requires the key as well as the flag, so a half-configured deploy stays off.
PAYMENTS_ENABLED = (
    os.environ.get('PAYMENTS_ENABLED', '').strip().lower() == 'true'
    and bool(STRIPE_SECRET_KEY)
)
# Pinned so a Stripe-side API upgrade can't silently change the response shape.
STRIPE_API_VERSION = '2024-06-20'

# Where Stripe sends the browser afterwards. The purchase happens in a normal
# tab (MV3's script-src 'self' rules out Stripe.js in the panel), so these have
# to be real pages — the GitHub Pages site already exists, so they live there.
CHECKOUT_SUCCESS_URL = os.environ.get(
    'CHECKOUT_SUCCESS_URL', 'https://varunanand2006.github.io/LeetCoach/payment-success.html')
CHECKOUT_CANCEL_URL = os.environ.get(
    'CHECKOUT_CANCEL_URL', 'https://varunanand2006.github.io/LeetCoach/payment-cancelled.html')

# What each pack costs. **`amountCents` must match PACKS in payments/app.py**,
# which cross-checks it against what Stripe actually collected and refuses to
# grant on a mismatch. That check is the safety net, not a suggestion: if these
# drift, purchases fail loudly rather than granting the wrong number of credits.
# Credit counts deliberately live only in the webhook — it is what moves them.
CHECKOUT_PACKS = {
    'mini': {'amountCents': 99, 'label': '50 prompts'},
    'small': {'amountCents': 499, 'label': '500 prompts'},
    'large': {'amountCents': 999, 'label': '1,500 prompts'},
}


def create_checkout_session(user_id, pack_name):
    """Create a Stripe Checkout Session. Returns its URL, or raises.

    Prices are sent inline as `price_data` rather than referencing pre-created
    Price objects, so there is nothing to configure in the Stripe dashboard and
    no ID to keep in sync with this table.
    """
    pack = CHECKOUT_PACKS[pack_name]
    fields = {
        'mode': 'payment',
        'success_url': CHECKOUT_SUCCESS_URL,
        'cancel_url': CHECKOUT_CANCEL_URL,
        # How the webhook knows who paid. Never taken from the request body —
        # this is the id from the verified Google token.
        'client_reference_id': user_id,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': str(pack['amountCents']),
        'line_items[0][price_data][product_data][name]': f"LeetCoach — {pack['label']}",
        'metadata[pack]': pack_name,
        # Copied onto the PaymentIntent (and so onto the Charge) because refund
        # and dispute events carry a charge, not a session — without this the
        # webhook cannot tell whose credits to claw back.
        'payment_intent_data[metadata][userId]': user_id,
        'payment_intent_data[metadata][pack]': pack_name,
    }

    conn = http.client.HTTPSConnection('api.stripe.com', timeout=10)
    try:
        conn.request(
            'POST', '/v1/checkout/sessions',
            body=urllib.parse.urlencode(fields),
            headers={
                'Authorization': f'Bearer {STRIPE_SECRET_KEY}',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Stripe-Version': STRIPE_API_VERSION,
            },
        )
        response = conn.getresponse()
        payload = json.loads(response.read().decode())
    finally:
        conn.close()

    if response.status != 200 or not payload.get('url'):
        # Log Stripe's message, never return it — it can quote request detail.
        raise RuntimeError(
            f"Stripe returned {response.status}: {(payload.get('error') or {}).get('message')}")
    return payload['url']


def get_problem_details(problem_slug):
    """Retrieve problem metadata from DynamoDB."""
    if not problem_slug:
        return None
    try:
        response = _problems_table.get_item(Key={'problemSlug': problem_slug})
        return response.get('Item')
    except ClientError as e:
        print(f"Error fetching problem details: {e}")
        return None


# Coaching context pulled from the problems table. Deliberately a narrow
# projection: `solutions` on a single item runs to 100KB, and none of the modes
# that read this need it — only the get_solution tool does.
_PROBLEM_CONTEXT_ATTRS = ('hints', 'constraints')


def get_problem_context(problem_slug):
    """Fetch only the coaching-relevant fields for a problem, or None."""
    if not problem_slug:
        return None
    # Projected through ExpressionAttributeNames because several plausible
    # attribute names here collide with DynamoDB reserved words.
    names = {f'#a{i}': attr for i, attr in enumerate(_PROBLEM_CONTEXT_ATTRS)}
    try:
        response = _problems_table.get_item(
            Key={'problemSlug': problem_slug},
            ProjectionExpression=', '.join(names),
            ExpressionAttributeNames=names,
        )
        return response.get('Item')
    except ClientError as e:
        print(f"Error fetching problem context: {e}")
        return None

# Google OAuth Client ID for token verification. Set in template.yaml.
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')


# Input validation limits
VALID_MODES = {'chat', 'hint', 'analyze', 'dsa', 'optimize', 'feedback', 'review', 'usage',
               'create_checkout_session'}
# A diagram request costs 2 prompts against the weekly limit instead of 1.
DIAGRAM_COST = 2
DIAGRAM_TOKEN_BONUS = 350
# A full review report costs 5 and always includes a diagram.
REVIEW_COST = 5
MAX_CODE_BYTES = 10_000
MAX_DESC_BYTES = 5_000
MAX_MSG_BYTES = 2_000
MAX_HISTORY_TURNS = 10
# The review report summarizes the whole session, so it gets a deeper history.
# Kept per-mode rather than raised globally — a 30-turn history on every chat
# turn would inflate input token cost on the most-used path.
MAX_HISTORY_TURNS_REVIEW = 30
# History originates in chrome.storage.local, so its contents are as untrusted
# as any other client field. Capping turn count alone leaves input token cost
# unbounded: 30 turns of arbitrary length is an arbitrary bill.
MAX_HISTORY_CONTENT_BYTES = 4_000
# Modes whose prompts read the problems table. Anything else skips the round trip.
# feedback and review are here because both assert whether the code is optimal, and
# that verdict is arithmetic against the input bounds rather than a judgement call.
# Only the hint builder ever formats the `hints` field, so widening this set cannot
# leak official hints into a mode that shouldn't show them.
PROBLEM_CONTEXT_MODES = {'hint', 'analyze', 'optimize', 'feedback', 'review'}
# Modes routed to Haiku, ordered by what a wrong answer costs the user: hint and dsa only
# point a direction, and feedback is a subjective debrief with no correctness surface.
# analyze (asserts a bug exists), optimize (asserts a Big-O), review (emits a full solution),
# and chat (open-ended + tool use) stay on Sonnet. Declarative so a regression is a one-line
# revert; any request with wantsDiagram still overrides to Sonnet.
HAIKU_MODES = {'hint', 'dsa', 'feedback'}
_USERID_RE = re.compile(r'^[a-zA-Z0-9_\-\.]{1,50}$')
_SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9\-]{0,99}$')

GET_SOLUTION_TOOL = {
    "name": "get_solution",
    "description": (
        "Look up the reference solution for the current problem. "
        "Use this when you are genuinely unsure about the optimal approach, uncertain whether your guidance is correct, "
        "or need to get unblocked before coaching. "
        "Do NOT use if you are already confident in the direction — only reach for this when you actually need it."
    ),
    "input_schema": {"type": "object", "properties": {}, "required": []},
}


# ---------------------------------------------------------------------------
# Streaming bootstrap patch
# ---------------------------------------------------------------------------
# After _stream_to_runtime() posts the response directly to the Lambda Runtime
# API, bootstrap will also call runtime_client.post_invocation_result with a
# buffered "null" response. We patch the runtime_client C extension module
# directly — it's a sys.modules singleton shared by both the bootstrap and our
# code, so the patch is visible to the bootstrap's call.

import runtime_client as _rc

_streaming_done = set()
_orig_rc_post = _rc.post_invocation_result


def _guarded_post(invoke_id, result_data, content_type):
    if invoke_id in _streaming_done:
        _streaming_done.discard(invoke_id)
        return None
    return _orig_rc_post(invoke_id, result_data, content_type)


_rc.post_invocation_result = _guarded_post


# ---------------------------------------------------------------------------
# Streaming helpers
# ---------------------------------------------------------------------------

def _stream_to_runtime(invoke_id, chunks):
    """POST text chunks to the Lambda Runtime API with chunked transfer encoding."""
    conn = http.client.HTTPConnection(os.environ['AWS_LAMBDA_RUNTIME_API'])
    conn.putrequest('POST', f'/2018-06-01/runtime/invocation/{invoke_id}/response')
    conn.putheader('Content-Type', 'text/plain; charset=utf-8')
    conn.putheader('Transfer-Encoding', 'chunked')
    conn.putheader('Lambda-Runtime-Function-Response-Mode', 'streaming')
    conn.endheaders()

    for chunk in chunks:
        if chunk:
            data = chunk.encode('utf-8') if isinstance(chunk, str) else chunk
            conn.send(f'{len(data):x}\r\n'.encode())
            conn.send(data)
            conn.send(b'\r\n')

    conn.send(b'0\r\n\r\n')
    conn.getresponse().read()
    _streaming_done.add(invoke_id)


def _bedrock_text_chunks(stream):
    """Yield text deltas from a Bedrock invoke_model_with_response_stream response."""
    for event in stream:
        chunk = event.get('chunk')
        if not chunk:
            continue
        data = json.loads(chunk['bytes'])
        if data.get('type') == 'content_block_delta':
            text = data.get('delta', {}).get('text', '')
            if text:
                yield text


def _chat_tool_chunks(messages, system_prompt, max_tokens, model_id, slug):
    """Streams chat response, executing get_solution tool use internally (max 1 tool call)."""
    for _ in range(2):  # at most: tool-use turn + final turn
        response = bedrock.invoke_model_with_response_stream(
            modelId=model_id,
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': max_tokens,
                'system': system_prompt,
                'messages': messages,
                'tools': [GET_SOLUTION_TOOL],
                'tool_choice': {'type': 'auto'},
            })
        )

        text_chunks, tool_blocks = [], []
        current_tool, current_json = None, ''

        for event in response['body']:
            chunk = event.get('chunk')
            if not chunk:
                continue
            data = json.loads(chunk['bytes'])
            dtype = data.get('type')

            if dtype == 'content_block_start':
                cb = data.get('content_block', {})
                if cb.get('type') == 'tool_use':
                    current_tool = {'id': cb['id'], 'name': cb['name']}
                    current_json = ''
            elif dtype == 'content_block_delta':
                delta = data.get('delta', {})
                if delta.get('type') == 'text_delta':
                    text = delta.get('text', '')
                    if text:
                        yield text
                        text_chunks.append(text)
                elif delta.get('type') == 'input_json_delta':
                    current_json += delta.get('partial_json', '')
            elif dtype == 'content_block_stop' and current_tool:
                try:
                    current_tool['input'] = json.loads(current_json) if current_json else {}
                except json.JSONDecodeError:
                    current_tool['input'] = {}
                tool_blocks.append(current_tool)
                current_tool, current_json = None, ''

        if not tool_blocks:
            break

        tb = tool_blocks[0]
        problem = get_problem_details(slug) if slug else None
        solution = (problem or {}).get('solutions') or 'No solution available for this problem.'

        assistant_content = []
        if text_chunks:
            assistant_content.append({'type': 'text', 'text': ''.join(text_chunks)})
        assistant_content.append({'type': 'tool_use', 'id': tb['id'], 'name': tb['name'], 'input': tb['input']})

        messages.append({'role': 'assistant', 'content': assistant_content})
        messages.append({'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': tb['id'], 'content': solution}
        ]})


# ---------------------------------------------------------------------------
# Input validation / sanitization
# ---------------------------------------------------------------------------

def _sanitize_history(raw, cap):
    """Drop malformed turns, clip oversized ones, and guarantee the shape Bedrock
    requires: alternating roles, starting with `user`.

    build_messages() appends the current user turn afterwards, so this also
    trims a trailing `user` entry — two user messages in a row is a 400 from
    Bedrock, which would surface to the user as a generic internal error.
    """
    if not isinstance(raw, list):
        return []

    clean = []
    for turn in raw[-cap:]:
        if not isinstance(turn, dict):
            continue
        role, content = turn.get('role'), turn.get('content')
        if role not in ('user', 'assistant') or not isinstance(content, str):
            continue
        content = content.strip()
        if not content:
            continue
        encoded = content.encode('utf-8')
        if len(encoded) > MAX_HISTORY_CONTENT_BYTES:
            content = encoded[:MAX_HISTORY_CONTENT_BYTES].decode('utf-8', errors='ignore')
        # Collapse a repeated role rather than dropping the turn — keeping the
        # newer of the two loses less context than discarding both.
        if clean and clean[-1]['role'] == role:
            clean[-1] = {'role': role, 'content': content}
            continue
        clean.append({'role': role, 'content': content})

    if clean and clean[0]['role'] == 'assistant':
        clean.pop(0)
    if clean and clean[-1]['role'] == 'user':
        clean.pop()
    return clean


def validate_and_sanitize_body(body):
    """Sanitize request body in-place. Truncates oversized fields."""
    code = body.get('code', '')
    if isinstance(code, str):
        encoded = code.encode('utf-8')
        if len(encoded) > MAX_CODE_BYTES:
            body['code'] = encoded[:MAX_CODE_BYTES].decode('utf-8', errors='ignore')

    problem = body.get('problem')
    if isinstance(problem, dict):
        desc = problem.get('description', '')
        if isinstance(desc, str):
            encoded = desc.encode('utf-8')
            if len(encoded) > MAX_DESC_BYTES:
                problem['description'] = encoded[:MAX_DESC_BYTES].decode('utf-8', errors='ignore')
        tags = problem.get('tags', [])
        if isinstance(tags, list):
            problem['tags'] = [t[:100] for t in tags if isinstance(t, str)][:20]

    msg = body.get('message', '')
    if isinstance(msg, str):
        encoded = msg.encode('utf-8')
        if len(encoded) > MAX_MSG_BYTES:
            body['message'] = encoded[:MAX_MSG_BYTES].decode('utf-8', errors='ignore')

    hl = body.get('hintLevel', 1)
    if not isinstance(hl, int) or hl not in (1, 2, 3):
        try:
            body['hintLevel'] = max(1, min(3, int(hl)))
        except (TypeError, ValueError):
            body['hintLevel'] = 1

    cap = MAX_HISTORY_TURNS_REVIEW if body.get('mode') == 'review' else MAX_HISTORY_TURNS
    body['history'] = _sanitize_history(body.get('history'), cap)

    user_id = body.get('userId')
    if user_id is not None and (not isinstance(user_id, str) or not _USERID_RE.match(user_id)):
        body['userId'] = None

    cm = body.get('coachingMode', 'learn')
    body['coachingMode'] = cm if cm in ('learn', 'practice', 'interview') else 'learn'

    body['wantsDiagram'] = body.get('wantsDiagram') is True

    slug = body.get('slug')
    if slug is not None and (not isinstance(slug, str) or not _SLUG_RE.match(slug)):
        body['slug'] = None


# ---------------------------------------------------------------------------
# Per-mode system prompts
# ---------------------------------------------------------------------------

def format_submission_result(result):
    """Return a prompt snippet describing the last submission result, or empty string."""
    if not result:
        return ''
    status = result.get('status', '')
    if status == 'Wrong Answer':
        return (
            f"\nLast submission: Wrong Answer\n"
            f"- Input:    {result.get('input') or '(not captured)'}\n"
            f"- Expected: {result.get('expected') or '(not captured)'}\n"
            f"- Actual:   {result.get('actual') or '(not captured)'}\n"
        )
    if status == 'Runtime Error':
        msg = result.get('message') or '(no message captured)'
        return f"\nLast submission: Runtime Error\n- Error: {msg}\n"
    if status == 'Compile Error':
        msg = result.get('message') or '(no message captured)'
        return f"\nLast submission: Compile Error\n- Error: {msg}\n"
    if status == 'Time Limit Exceeded':
        snippet = f"\nLast submission: Time Limit Exceeded — solution is too slow.\n"
        if result.get('input'):
            snippet += f"- Failing input: {result['input']}\n"
        return snippet
    if status == 'Memory Limit Exceeded':
        return "\nLast submission: Memory Limit Exceeded — solution uses too much memory.\n"
    if status == 'Output Limit Exceeded':
        return "\nLast submission: Output Limit Exceeded — possible infinite loop producing output.\n"
    return f"\nLast submission: {status}\n"


# How much code each coaching mode is allowed to hand over. Appended to every
# mode's system prompt so the policy can't drift between builders.
# Ordering by permissiveness: learn > practice > interview.
CODE_POLICY = {
    'learn': (
        "Code policy: you may show a single line, the one key operation, or a skeleton with "
        "`___` or `# TODO` blanks for the user to fill in. NEVER write a complete or runnable "
        "solution, and never a full function body that solves the problem. The user writes the "
        "solution — you fill gaps in their understanding, not gaps in their editor."
    ),
    'practice': (
        "Code policy: default to no code. A snippet of 3 lines or fewer is allowed only when it "
        "makes an explanation materially clearer than plain words would — not as a shortcut. "
        "Never a full solution, never a complete function body."
    ),
    'interview': (
        "Code policy: write no code at all — not a snippet, not a single line, not pseudocode. "
        "A real interviewer does not type in the candidate's editor. Point at what to reconsider "
        "using words only."
    ),
}

# Caps on injected problem-table content — the table is ours, but a single
# malformed row shouldn't be able to blow out the input token budget.
MAX_REFERENCE_HINTS = 3
MAX_HINT_CHARS = 400
MAX_CONSTRAINT_LINES = 8
MAX_CONSTRAINT_CHARS = 200


def _clip(text, limit):
    """Collapse whitespace and truncate — keeps injected rows to one tidy line."""
    text = ' '.join(str(text).split())
    return text if len(text) <= limit else text[:limit].rstrip() + '…'


def _string_rows(value, max_rows, max_chars):
    if not isinstance(value, list):
        return []
    rows = []
    for item in value:
        if isinstance(item, str) and item.strip():
            rows.append(_clip(item, max_chars))
        if len(rows) >= max_rows:
            break
    return rows


def format_reference_hints(details, hint_level):
    """LeetCode's official hints run least to most specific, which maps directly
    onto the 1-3 hint levels — so level N sees the first N hints and no more."""
    if not details:
        return ''
    level = max(1, min(int(hint_level or 1), MAX_REFERENCE_HINTS))
    rows = _string_rows(details.get('hints'), level, MAX_HINT_CHARS)
    if not rows:
        return ''
    body = '\n'.join(f"- {r}" for r in rows)
    return (
        "\nOfficial hints for this problem, least to most specific. The user has NOT seen these:\n"
        f"{body}\n"
        "Ground truth for which direction is correct — they stop you nudging toward a dead end. "
        "Never quote or dump them: say only what this hint level allows, in your own words.\n"
    )


def format_constraints(details):
    """Authoritative input bounds — turns the complexity verdict from a guess
    into arithmetic (n <= 10^5 means an O(n^2) pass will TLE)."""
    if not details:
        return ''
    rows = _string_rows(details.get('constraints'), MAX_CONSTRAINT_LINES, MAX_CONSTRAINT_CHARS)
    if not rows:
        return ''
    body = '\n'.join(f"- {r}" for r in rows)
    return f"\nProblem constraints (authoritative — do not guess input sizes):\n{body}\n"


# Appended to every mode except review, for the same reason CODE_POLICY is a single
# dict: brevity drifts the moment each builder owns its own copy. Review is exempt —
# it's a deliberate long-form retrospective and "one thing at a time" would gut it.
#
# NOTE: this is what actually shortens replies and cuts cost, because output is billed
# on tokens *generated*, not on max_tokens. Lowering max_tokens alone saves nothing and
# only truncates mid-sentence.
RESPONSE_STYLE = """
How to write:
- Lead with the answer. No preamble, no restating the problem, no filler openers ("Great
  question", "Let's take a look", "I notice that"). No closing summary unless the format
  above explicitly asks for one.
- Guide, don't lecture. Name the one thing to think about next and stop — leave them work to do.
- The ceilings above are not quotas. Lead with what unblocks them and cut the rest.
- Say it once, plainly. No hedging. Don't pad one line into a bullet list.
"""

ALLOWED_DIAGRAM_TYPES = 'flowchart, sequenceDiagram, stateDiagram-v2, classDiagram'

DIAGRAM_DETAIL = {
    'learn': (
        "Label every node and edge fully — this is a teaching diagram, so someone should be able "
        "to follow the idea from the picture alone."
    ),
    'practice': (
        "Label nodes with structure and step names, but leave the reasoning on edges terse. "
        "Show the shape of the approach, not a walkthrough of it."
    ),
    'interview': (
        "Skeleton only — shapes and connections with minimal labels. The candidate should still "
        "have to reason about what each node holds."
    ),
}


def append_diagram_instruction(prompt, coaching_mode):
    """Append the Mermaid diagram request to an already-built system prompt."""
    return prompt + f"""
DIAGRAM (required):
After your normal answer, append exactly one Mermaid diagram in a ```mermaid fenced block that
visualizes the core idea of what you just said.

- Allowed diagram types ONLY: {ALLOWED_DIAGRAM_TYPES}. Never use any other type.
- {DIAGRAM_DETAIL.get(coaching_mode, DIAGRAM_DETAIL['learn'])}
- Keep it under 12 nodes. The panel is only ~400px wide, so prefer `flowchart TD` over `LR`.
- In flowchart nodes ONLY, wrap the label in double quotes — A["left < right"] — because an
  unquoted (), [], {{}}, or : inside a flowchart label breaks the parser. Do NOT add quotes
  anywhere else: `participant Left`, `class Node`, and state names must stay unquoted, or the
  quotes render literally.
- No markdown, backticks, or HTML tags inside any label.
- The diagram obeys the same code policy as the rest of your answer — it must not spell out a
  complete solution the user hasn't reached yet.
- Output the diagram once, at the very end, and write nothing after the closing fence.
"""


def build_prompt_for_mode(mode, body):
    # max_tokens is a truncation guard, NOT a cost lever — output bills on tokens
    # generated. RESPONSE_STYLE and the per-mode line caps are what shorten replies;
    # these ceilings just sit far enough above the intended length to never clip one.
    if mode == 'hint':
        prompt, max_tokens = build_hint_prompt(body), 150
    elif mode == 'analyze':
        prompt, max_tokens = build_analyze_prompt(body), 320
    elif mode == 'dsa':
        # The widest bump of the set: dsa now lists 2-3 ranked approaches where it
        # used to name one, so it's the one mode whose intended output got longer.
        prompt, max_tokens = build_dsa_prompt(body), 300
    elif mode == 'optimize':
        prompt, max_tokens = build_optimize_prompt(body), 300
    elif mode == 'feedback':
        prompt, max_tokens = build_feedback_prompt(body), 320
    elif mode == 'review':
        # Falls through to the diagram augmentation below like every other mode.
        # Previously the instruction was inlined here and the augmentation skipped,
        # which meant no token bonus — the report ran out of budget mid-fence and
        # the panel showed a diagram placeholder that never resolved.
        prompt, max_tokens = build_review_prompt(body), 1100
    else:
        prompt, max_tokens = build_chat_prompt(body), 420  # 'chat' or unknown

    # Review is exempt: it's a deliberate long-form retrospective, and "lead with one
    # thing and drop the rest" would gut a report that's meant to have five sections.
    #
    # CODE_POLICY is appended here rather than inside each builder so it lands *last*,
    # ahead of only the diagram block. It used to sit near the top of every prompt, above
    # format specs that contradicted it — analyze's "use ```lang fences for any code" came
    # after interview's "write no code at all", and the later line wins. feedback pins to
    # interview whatever coachingMode says: it IS the interview debrief, which is what its
    # builder hardcoded before this moved.
    if mode != 'review':
        policy_mode = 'interview' if mode == 'feedback' else body.get('coachingMode', 'learn')
        prompt += RESPONSE_STYLE + '\n' + CODE_POLICY.get(policy_mode, CODE_POLICY['learn']) + '\n'

    if body.get('wantsDiagram'):
        prompt = append_diagram_instruction(prompt, body.get('coachingMode', 'learn'))
        max_tokens += DIAGRAM_TOKEN_BONUS

    return prompt, max_tokens


def _build_preamble(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')
    submission_snippet = format_submission_result(body.get('submissionResult'))
    preamble = (
        f"You are LeetCoach, an AI coding coach embedded in LeetCode.\n\n"
        f"Current problem:\n"
        f"- Difficulty: {problem.get('difficulty', 'Unknown')}\n"
        f"- Tags: {', '.join(problem.get('tags', []))}\n"
        f"- Description: {problem.get('description', '')}\n\n"
        f"User's current code ({language}). To point at a line, quote it verbatim rather than "
        f"numbering it — a quote either matches their editor or visibly doesn't, where a counted "
        f"line number can be wrong in a way the user only discovers by going and looking.\n"
        f"```\n{code}\n```\n"
        f"{submission_snippet}"
    )
    return preamble, language


def build_hint_prompt(body):
    hint_level = body.get('hintLevel', 1)
    preamble, language = _build_preamble(body)

    coaching_mode = body.get('coachingMode', 'learn')
    if coaching_mode == 'learn':
        coaching_rule = (
            "Coaching mode: LEARN. Name the data structure or algorithm and explain in one clause why it fits."
        )
    elif coaching_mode == 'interview':
        coaching_rule = (
            "Coaching mode: INTERVIEW. Don't hint — make them explain their logic or an edge case, "
            "professional and slightly critical."
        )
    else:
        coaching_rule = (
            "Coaching mode: PRACTICE. Minimal directional nudge only — no data structure names, no explanations."
        )

    # Every level is one sentence — the levels change how much is revealed, not how
    # much is written. A level-3 hint is more specific, not longer.
    level_instructions = {
        1: "Nudge toward a property the solution needs — no data structure or algorithm names.",
        2: "Name the data structure or algorithm category. No implementation details.",
        3: "Name the exact structure and what to store in it. No code.",
    }

    instruction = level_instructions.get(hint_level, level_instructions[3])
    if coaching_mode == 'interview':
        instruction = "Ask one question about their approach instead of hinting."

    reference = format_reference_hints(body.get('problemContext'), hint_level)

    return preamble + reference + f"""
Hint level {hint_level}/3
{coaching_rule}

Your task: {instruction}

Rules:
- ONE sentence. Not two, at any level — under 25 words.
- Hint at THEIR code, not the problem in the abstract. Read what they've written, find the specific
  gap between it and a working solution, and point at that. Quote a variable or the line itself when
  it makes the hint land. If the editor is empty or only boilerplate, point at the first step instead.
- Never reveal the complete algorithm.
- Small nudge if they're close, a bigger one if they're stuck.
- Use {language} naming conventions for any data structure references.
"""


def build_analyze_prompt(body):
    preamble, language = _build_preamble(body)

    coaching_mode = body.get('coachingMode', 'learn')
    if coaching_mode == 'learn':
        coaching_rule = (
            "Coaching mode: LEARN. Per issue: why it matters and what direction fixes it (no code)."
        )
    elif coaching_mode == 'interview':
        coaching_rule = (
            "Coaching mode: INTERVIEW. Frame issues as questions: 'How would this handle X?' or 'What's the trade-off here?'"
        )
    else:
        coaching_rule = (
            "Coaching mode: PRACTICE. List issues only — no explanation, no fix hints. Blunt and precise."
        )

    # Applies in all three modes, interview included: an interviewer's question is
    # still an assertion that the flaw is there, so "how would this handle an empty
    # array?" is in; "you might want to consider empty arrays" is not.
    coaching_rule += (
        "\nBe confident in every mode. State each issue as fact — never 'this might', 'you may want "
        "to consider', or 'potentially'. If you aren't sure it's a real bug, leave it out."
    )

    return preamble + format_constraints(body.get('problemContext')) + f"""
{coaching_rule}

Max 3 bullets, one line of 20 words or fewer each. Skip any section with no issue — three is a
ceiling, not a quota, and one real problem beats three padded ones:
- **Correctness:** logic correct? If there's a submission failure, diagnose it. Quote the line.
- **Complexity:** Big-O time and space. Judge "is it optimal?" against the stated constraints, not in the abstract.
- **Edge cases:** any obvious gaps. Only ones the constraints actually permit — never raise a case they rule out.

No rewrites, no full solutions. Use ```{language} fences for any code. {language} only.
"""


def build_dsa_prompt(body):
    """Pattern suggestions. The third button only exposes this in Learn mode, so the
    per-coaching-mode variants were unreachable and are gone. CODE_POLICY still applies —
    build_prompt_for_mode appends it, keyed off coachingMode."""
    preamble, language = _build_preamble(body)

    return preamble + f"""
Name the approach that solves this. If more than one is genuinely viable, list the top 2-3 ordered
easiest to hardest to implement — otherwise give one and stop; padding to three is worse than one.

One line each, 20 words or fewer: **pattern**, the specific data structure variant, its complexity,
and for a harder option what it buys over the one above it. Bold pattern and structure names
(e.g. **sliding window**, **monotonic deque**). No walkthroughs, no code.

{language} naming conventions. If the last submission was TLE or MLE, drop any approach that can't clear it.
"""


def build_optimize_prompt(body):
    """Efficiency review — the third button in Practice mode."""
    preamble, language = _build_preamble(body)

    return preamble + format_constraints(body.get('problemContext')) + f"""
Review the efficiency of the user's current code. 3 lines max, 20 words or fewer each:
- **Now:** Big-O time and space as written, plus what drives each.
- **Best:** the optimal time and space for this problem.
- **Gap:** if not optimal, name the technique that closes it — do NOT implement it.

Ground the verdict in the stated constraints: "O(n^2) with n up to 10^5 is ~10^10 ops, too slow"
beats "this could be faster". If the constraints make the current code fine, say so rather than
chasing a bound it doesn't need.

If it's already optimal, say so in one line and stop.

Specific to their code, no generic advice. If the last submission was TLE or MLE, lead with it.
Use {language} naming conventions.
"""


def build_feedback_prompt(body):
    """End-of-interview debrief — the third button in Interview mode."""
    preamble, _language = _build_preamble(body)

    return preamble + format_constraints(body.get('problemContext')) + f"""
You are a senior engineer delivering end-of-interview feedback. Address the candidate directly and
stay in character — the debrief a real interviewer gives, not a code review document.

4 lines max, 20 words or fewer each:
- **Approach:** was the strategy sound?
- **Code quality:** the one thing that stood out, good or bad.
- **Complexity:** Big-O time and space, and whether it's optimal for the stated constraints.
- **Do differently:** the single most valuable change.

Then a one-line overall read. Nothing after it.

Be honest and specific — vague praise is useless.
"""


def build_review_prompt(body):
    """Full session retrospective. Deliberately exempt from CODE_POLICY — the user
    generates this when they're done, so withholding the solution defeats the point."""
    preamble, language = _build_preamble(body)

    return preamble + format_constraints(body.get('problemContext')) + f"""
You are writing an end-of-session review report for the problem above. The conversation history is
the user's full session — read it as evidence of how they actually worked, not just what they asked.

This report is a RETROSPECTIVE. Unlike every other mode you may show the complete optimal solution —
but only when they still need it. The user has finished; withholding is unhelpful, and so is handing
back a solution they already wrote.

Keep the whole report tight — a user reads this in a 400px panel, so short sentences and no padding.
No preamble before the first heading and no summary after the last. Structure it with these headings
exactly, in this order:

## The problem
One line: what it's really testing.

## How you approached it
2-3 lines. Where they started, what they tried, where they changed direction. Reference what they
actually did — generic praise is worthless here.

## Where you struggled
The 2 biggest sticking points, one line each, naming the underlying gap (a pattern they don't know
yet, an edge case habit, a complexity blind spot). Direct but not harsh.

## The solution
Judge the code they ended with — optimal means optimal for the stated constraints, not in the
abstract — then write EXACTLY ONE of these three, never more:
- **Correct and optimal, or within a constant factor:** no code at all. One line naming their
  approach with its time and space complexity, plus one line on anything that would tidy it.
- **Right approach, wrong details** (off-by-one, wrong initial value, a missed edge case): no full
  solution. List only the lines that change, at most 4, each as the line quoted verbatim from their
  code then what it should become — `while left < right:` → `while left <= right:`. No line numbers.
- **Wrong approach, or no real attempt:** the optimal approach in {language}, complete but lightly
  commented, with its time and space complexity. The code and one line of explanation, no walkthrough.

## What to practice next
2 specific named patterns or problem types. One line each. Not "keep practicing".

Write to the user as "you". Be specific and useful over kind.
"""


def build_chat_prompt(body):
    preamble, language = _build_preamble(body)

    coaching_mode = body.get('coachingMode', 'learn')
    if coaching_mode == 'learn':
        coaching_rule = (
            "Coaching mode: LEARN. Name the algorithm and explain the idea completely but compactly — "
            "complete means nothing important left out, NOT lengthy. The user still writes the solution: "
            "if they ask you to write it, give them the shape of it (a skeleton with blanks, or the one "
            "line they're stuck on) and let them finish."
        )
    elif coaching_mode == 'interview':
        coaching_rule = (
            "Coaching mode: INTERVIEW. You are a senior technical interviewer. Challenge the user's logic, ask for complexity analysis, and use Socratic questions. Stay in character. If they ask you to write code, respond the way an interviewer would — you're here to evaluate, not to implement."
        )
    else:
        coaching_rule = (
            "Coaching mode: PRACTICE. Minimal nudge only — no concept explanations. If they ask something they should know, ask a probing question back. Max 1-2 sentences."
        )

    return preamble + f"""
{coaching_rule}

Rules:
- 1-2 sentences, 3 at the absolute most and only for a genuinely multi-part question.
- Recommend specific DS/algorithm variants, not generic advice.
- {language} only for any code.
- get_solution tool: use only when genuinely unsure about the optimal approach. Never reproduce the full solution.
- Markdown: ```{language} fences for code, **bold** key terms. Bullets only for genuinely multi-part answers.
"""


def build_messages(body):
    mode = body.get('mode', 'chat')
    history = body.get('history', [])

    trigger_by_mode = {
        'hint':     'Please give me a hint.',
        'analyze':  'Please analyze my code.',
        'dsa':      'What data structures and algorithms should I use for this problem?',
        'optimize': 'How efficient is my code, and can it be faster or use less memory?',
        'feedback': 'The interview is over. Give me your feedback on my code and how I approached it.',
        'review':   'Write my review report for this session.',
    }
    message = body.get('message') or trigger_by_mode.get(mode, '')

    history.append({'role': 'user', 'content': message})
    return history


# ---------------------------------------------------------------------------
# Usage tracking
# ---------------------------------------------------------------------------

def get_week_start(d=None):
    if d is None:
        d = datetime.date.today()
    return (d - datetime.timedelta(days=d.weekday())).isoformat()


def _spend_purchased_credits(user_id, cost, today):
    """Atomically draw `cost` from the purchased balance. True if it covered it.

    The condition fails when purchasedCredits is absent, which is exactly right
    for a user who has never bought anything — no backfill needed on existing rows.
    """
    try:
        _table.update_item(
            Key={'userId': user_id},
            UpdateExpression='SET lastSeen = :today ADD purchasedCredits :neg, totalRequests :cost',
            ConditionExpression='purchasedCredits >= :cost',
            ExpressionAttributeValues={':neg': -cost, ':cost': cost, ':today': today},
        )
        return True
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            return False
        raise


def check_and_update_usage(user_id, cost=1):
    """Charge `cost` prompts and report which balance paid for them.

    Returns BUCKET_FREE or BUCKET_PAID when the request is allowed, BUCKET_NONE
    when it is allowed without being charged (unauthenticated, or DynamoDB is
    down and we're failing open), and None when the user is out of prompts.

    The caller must hand the return value back to refund_usage, so a failed
    request is credited to the balance it was actually taken from — refunding a
    purchased credit into the weekly counter would quietly destroy it on Monday.

    The weekly allowance is always spent before purchased credits, so credits
    can't evaporate at the reset while free prompts sat unused. `cost` is how
    many prompts this request consumes (diagrams 2, reviews 5). DynamoDB can't
    do arithmetic inside a ConditionExpression, so the threshold is precomputed
    here: the free bucket covers the request iff weeklyRequests <= LIMIT - cost.
    """
    if not user_id:
        return BUCKET_NONE
    try:
        today_date = datetime.date.today()
        today = today_date.isoformat()
        current_monday = get_week_start(today_date)
        threshold = WEEKLY_LIMIT - cost

        result = _table.get_item(Key={'userId': user_id})
        item = result.get('Item')

        if item is None:
            try:
                _table.put_item(
                    Item={
                        'userId': user_id,
                        'weeklyRequests': cost,
                        'totalRequests': cost,
                        'weekStartDate': current_monday,
                        'firstSeen': today,
                        'lastSeen': today,
                        'tier': 'free',
                    },
                    ConditionExpression='attribute_not_exists(userId)',
                )
                return BUCKET_FREE
            except ClientError as e:
                if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                    raise
                # The row appeared between the read and the write — most likely
                # the payment webhook creating it to grant credits. Re-read and
                # carry on rather than overwriting, or the purchase is erased.
                item = _table.get_item(Key={'userId': user_id}).get('Item') or {}

        if item.get('weekStartDate') != current_monday:
            # New week — reset weekly counter. ConditionExpression prevents a
            # double-reset if two concurrent requests both saw the old weekStartDate.
            # The attribute_not_exists arm covers a row the webhook created, which
            # carries credits but none of the usage fields.
            try:
                _table.update_item(
                    Key={'userId': user_id},
                    UpdateExpression='SET weeklyRequests = :cost, weekStartDate = :monday, lastSeen = :today ADD totalRequests :cost',
                    ConditionExpression='attribute_not_exists(weekStartDate) OR weekStartDate <> :monday',
                    ExpressionAttributeValues={':cost': cost, ':monday': current_monday, ':today': today},
                )
                return BUCKET_FREE
            except ClientError as e:
                if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                    raise
                # Concurrent request already reset this week; fall through to normal increment

        elif item.get('weeklyRequests', 0) > threshold:
            # Weekly allowance is spent — fall back to anything they've bought.
            return BUCKET_PAID if _spend_purchased_credits(user_id, cost, today) else None

        # ConditionExpression makes the limit check and the increment atomic,
        # eliminating the TOCTOU race between the get_item above and this write.
        try:
            _table.update_item(
                Key={'userId': user_id},
                UpdateExpression='SET lastSeen = :today ADD weeklyRequests :cost, totalRequests :cost',
                ConditionExpression='attribute_not_exists(weeklyRequests) OR weeklyRequests <= :threshold',
                ExpressionAttributeValues={':cost': cost, ':today': today, ':threshold': threshold},
            )
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                return BUCKET_PAID if _spend_purchased_credits(user_id, cost, today) else None
            raise
        return BUCKET_FREE

    except Exception as e:
        print(f"DynamoDB error (failing open): {e}")
        return BUCKET_NONE


def refund_usage(user_id, cost, bucket=BUCKET_FREE):
    """Give prompts back for a request that was debited but never answered.

    `bucket` is what check_and_update_usage returned, so the refund lands in the
    balance that was actually charged. Crediting a purchased prompt back to the
    weekly counter would destroy it at the next reset, and crediting a free
    prompt to the purchased balance would hand out paid credit for nothing.
    BUCKET_NONE is a no-op because no charge ever landed.

    Usage is charged before Bedrock runs, so without this a throttle or model
    error silently costs the user — 5 of their 100 for a review. Note this
    cannot cover a function timeout: that kills the process outright, so the
    only defence there is a Timeout with enough headroom for the longest reply.
    The ConditionExpression stops a refund driving a counter negative.
    """
    if not user_id or cost <= 0 or bucket not in (BUCKET_FREE, BUCKET_PAID):
        return
    if bucket == BUCKET_PAID:
        # purchasedCredits is being credited so it can't go negative; totalRequests can.
        update = 'ADD purchasedCredits :cost, totalRequests :neg'
        condition = 'totalRequests >= :cost'
    else:
        update = 'ADD weeklyRequests :neg, totalRequests :neg'
        condition = 'weeklyRequests >= :cost'
    try:
        _table.update_item(
            Key={'userId': user_id},
            UpdateExpression=update,
            ConditionExpression=condition,
            ExpressionAttributeValues={':neg': -cost, ':cost': cost},
        )
    except ClientError as e:
        if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
            print(f"Refund failed for {user_id}: {e}")
    except Exception as e:
        print(f"Refund failed for {user_id}: {e}")


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def _origin_allowed(headers):
    """Reject calls that arrive with a website Origin.

    Lambda Function URL CORS cannot express this: it only accepts http/https
    origins or '*', and rejects `chrome-extension://<id>` at deploy time with
    "isn't a valid origin". So the filter lives here, where the raw header is
    readable.

    The rule is deliberately permissive — block only what is definitely wrong.
    A browser sets Origin itself and page JavaScript cannot forge it, so any
    http(s) Origin means a web page is calling, and no web page should be. The
    extension sends either its own chrome-extension:// origin or none at all,
    and both are allowed, so this cannot break the panel if Chrome changes what
    it sends. Non-browser callers still need a valid Google token.
    """
    origin = (headers or {}).get('origin') or (headers or {}).get('Origin') or ''
    return not origin.strip().lower().startswith(('http://', 'https://'))


def handler(event, context):
    try:
        headers = event.get('headers') or {}

        if not _origin_allowed(headers):
            print(f"Rejected cross-site request from origin: {headers.get('origin')!r}")
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'unauthorized',
                'message': 'This endpoint is only callable from the LeetCoach extension.',
            })]))
            return

        auth_header = headers.get('authorization', headers.get('Authorization', ''))
        if not auth_header.lower().startswith('bearer '):
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'unauthorized',
                'message': 'Missing or invalid Authorization header. Please sign in with Google.',
            })]))
            return

        token = auth_header[7:].strip()
        if not token:
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'unauthorized',
                'message': 'Token missing from Authorization header.',
            })]))
            return

        try:
            import urllib.request
            url = f"https://oauth2.googleapis.com/tokeninfo?access_token={token}"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req) as auth_response:
                token_data = json.loads(auth_response.read().decode())
                
                expected_client_id = GOOGLE_CLIENT_ID.strip()
                if not expected_client_id or token_data.get('aud') != expected_client_id:
                    raise ValueError("Invalid client ID")
                
                secure_user_id = token_data.get('sub')
                if not secure_user_id:
                    raise ValueError("No user ID found")
        except Exception as e:
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'unauthorized',
                'message': 'Invalid Google token.',
            })]))
            return

        body = json.loads(event.get('body', '{}'))
        mode = body.get('mode', 'chat')

        if mode not in VALID_MODES:
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'invalid_request',
                'message': 'Invalid request.',
            })]))
            return

        validate_and_sanitize_body(body)
        user_id = secure_user_id
        body['userId'] = secure_user_id

        if mode == 'usage':
            today = datetime.date.today()
            usage_data = {
                'weeklyRequests': 0,
                'purchasedCredits': 0,
                'weekStartDate': get_week_start(today),
                # Drives whether the extension shows any buy UI at all.
                'paymentsEnabled': PAYMENTS_ENABLED,
            }
            if user_id:
                try:
                    result = _table.get_item(Key={'userId': user_id})
                    item = result.get('Item')
                    if item:
                        usage_data = {
                            'weeklyRequests': int(item.get('weeklyRequests', 0)),
                            'purchasedCredits': int(item.get('purchasedCredits', 0)),
                            'weekStartDate': item.get('weekStartDate', get_week_start(today)),
                            'paymentsEnabled': PAYMENTS_ENABLED,
                        }
                except Exception as e:
                    print(f"DynamoDB error fetching usage: {e}")
            _stream_to_runtime(context.aws_request_id, iter([json.dumps(usage_data)]))
            return

        # Buying prompts must never cost a prompt, so this sits above the usage
        # check alongside `usage` mode. No Bedrock call is involved either.
        if mode == 'create_checkout_session':
            pack_name = body.get('pack')
            if pack_name not in CHECKOUT_PACKS or not user_id:
                _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                    'error': 'invalid_request',
                    'message': 'Unknown prompt pack.',
                })]))
                return
            # Second gate, so the flag alone disables buying even if a client
            # somehow reaches this mode with the UI hidden.
            if not PAYMENTS_ENABLED:
                _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                    'error': 'checkout_unavailable',
                    'message': 'Purchases are not available right now.',
                })]))
                return
            try:
                checkout_url = create_checkout_session(user_id, pack_name)
            except Exception as e:
                print(f"Stripe checkout session failed for {user_id}: {e}")
                _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                    'error': 'checkout_unavailable',
                    'message': "Couldn't reach Stripe. Please try again.",
                })]))
                return
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'checkoutUrl': checkout_url,
            })]))
            return

        wants_diagram = body.get('wantsDiagram', False)
        # Review is a flat 5 whether or not a diagram is attached. The diagram used
        # to be bundled into that price, so charging 5+2 for it would be a rise.
        if mode == 'review':
            cost = REVIEW_COST
        elif wants_diagram:
            cost = DIAGRAM_COST
        else:
            cost = 1

        # The weekly allowance is spent first, then any purchased credits. The
        # bucket that paid has to survive down to the refund path below.
        charged_bucket = check_and_update_usage(user_id, cost)
        if charged_bucket is None:
            if mode == 'review':
                detail = f"A review report costs {REVIEW_COST} prompts and you don't have that many left."
            elif wants_diagram:
                detail = f"A diagram costs {DIAGRAM_COST} prompts and you don't have that many left."
            else:
                detail = f"You've used all {WEEKLY_LIMIT} of your weekly prompts."
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'weekly_limit_reached',
                'message': f"{detail} Your weekly prompts reset on Monday.",
                'limit': WEEKLY_LIMIT,
                'cost': cost,
            })]))
            return

        # Curated hints and constraints from the problems table. Fetched after the
        # usage check so a rejected request never pays for the read.
        if mode in PROBLEM_CONTEXT_MODES:
            body['problemContext'] = get_problem_context(body.get('slug'))

        system_prompt, max_tokens = build_prompt_for_mode(mode, body)
        messages = build_messages(body)

        # Mermaid syntax is unforgiving and a parse error wastes a paid request,
        # so diagram requests always go to the stronger model.
        model_id = (
            HAIKU_MODEL_ID if (mode in HAIKU_MODES and not wants_diagram)
            else SONNET_MODEL_ID
        )

        try:
            if mode == 'chat':
                _stream_to_runtime(
                    context.aws_request_id,
                    _chat_tool_chunks(messages, system_prompt, max_tokens, model_id, body.get('slug'))
                )
            else:
                response = bedrock.invoke_model_with_response_stream(
                    modelId=model_id,
                    body=json.dumps({
                        'anthropic_version': 'bedrock-2023-05-31',
                        'max_tokens': max_tokens,
                        'system': system_prompt,
                        'messages': messages,
                    })
                )
                _stream_to_runtime(context.aws_request_id, _bedrock_text_chunks(response['body']))
        except Exception:
            refund_usage(user_id, cost, charged_bucket)
            raise

    except Exception as e:
        print(f"Unhandled error: {e}")
        try:
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'internal_error',
                'message': 'An internal error occurred.',
            })]))
        except Exception:
            pass
