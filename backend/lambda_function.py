import json
import os
import re
import http.client
import datetime
import boto3
from botocore.exceptions import ClientError

bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

WEEKLY_LIMIT = 100
TABLE_NAME = os.environ.get('TABLE_NAME', 'leetcoach-users')
PROBLEMS_TABLE_NAME = os.environ.get('PROBLEMS_TABLE_NAME', 'leetcoach-problems')

_table = dynamodb.Table(TABLE_NAME)  # cached; Lambda reuses this across warm invocations
_problems_table = dynamodb.Table(PROBLEMS_TABLE_NAME)

# Model IDs — override via Lambda environment variables when Anthropic deprecates a version
HAIKU_MODEL_ID = os.environ.get('HAIKU_MODEL_ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')
SONNET_MODEL_ID = os.environ.get('SONNET_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')


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

# Google OAuth Client ID for token verification. Set in template.yaml.
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')


# Input validation limits
VALID_MODES = {'chat', 'hint', 'analyze', 'dsa', 'optimize', 'feedback', 'review', 'usage'}
# A diagram request costs 2 prompts against the weekly limit instead of 1.
DIAGRAM_COST = 2
DIAGRAM_TOKEN_BONUS = 300
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

    history = body.get('history', [])
    if isinstance(history, list):
        cap = MAX_HISTORY_TURNS_REVIEW if body.get('mode') == 'review' else MAX_HISTORY_TURNS
        body['history'] = history[-cap:]
    else:
        body['history'] = []

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
    if mode == 'hint':
        prompt, max_tokens = build_hint_prompt(body), 128
    elif mode == 'analyze':
        prompt, max_tokens = build_analyze_prompt(body), 320
    elif mode == 'dsa':
        prompt, max_tokens = build_dsa_prompt(body), 256
    elif mode == 'optimize':
        prompt, max_tokens = build_optimize_prompt(body), 300
    elif mode == 'feedback':
        prompt, max_tokens = build_feedback_prompt(body), 360
    elif mode == 'review':
        # The diagram is already part of the review prompt, so skip the augmentation
        # below — otherwise the instruction is duplicated and double-charged.
        return build_review_prompt(body), 900
    else:
        prompt, max_tokens = build_chat_prompt(body), 400  # 'chat' or unknown

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
        f"User's current code ({language}):\n"
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
            "Coaching mode: INTERVIEW. Don't give a hint — ask the user to explain their current logic or how they'd handle a specific edge case, and nudge towards the right direction like an interviewer would. Be professional and slightly critical."
        )
    else:
        coaching_rule = (
            "Coaching mode: PRACTICE. Minimal directional nudge only — no data structure names, no explanations."
        )

    coaching_rule += "\n" + CODE_POLICY[coaching_mode]

    level_instructions = {
        1: "One sentence only. Nudge toward a property the solution needs — no data structure or algorithm names.",
        2: "1-2 sentences. Name the data structure or algorithm category. No implementation details.",
        3: "2 sentences max. Name the exact structure and what to store in it. No code.",
    }

    instruction = level_instructions.get(hint_level, level_instructions[3])
    if coaching_mode == 'interview':
        instruction = "Ask a clarifying question about their approach instead of giving a hint."

    return preamble + f"""
Hint level {hint_level}/3
{coaching_rule}

Your task: {instruction}

Rules:
- No preamble or summary.
- Get straight to the point in a simple, easily understandable way
- Never reveal the complete algorithm.
- Be confident — state it once and stop. No second-guessing or mid-response revisions.
- Give small tips if the user is close to a solution, larger tips if the user is stuck
- Use {language} naming conventions for any data structure references.
"""


def build_analyze_prompt(body):
    preamble, language = _build_preamble(body)

    coaching_mode = body.get('coachingMode', 'learn')
    if coaching_mode == 'learn':
        coaching_rule = (
            "Coaching mode: LEARN. For each issue, very briefly explain why it matters and what direction to consider for a fix (no code). One very short bullet per issue"
        )
    elif coaching_mode == 'interview':
        coaching_rule = (
            "Coaching mode: INTERVIEW. Frame issues as questions: 'How would this handle X?' or 'What's the trade-off here?'"
        )
    else:
        coaching_rule = (
            "Coaching mode: PRACTICE. List issues only — minimal explanation, no fix hints. Blunt and precise. One very short bullet per issue"
        )

    coaching_rule += "\n" + CODE_POLICY[coaching_mode]

    return preamble + f"""
{coaching_rule}

3 bullets max, one short line each. Skip any section with no issue:
- **Correctness:** logic correct? If there's a submission failure, diagnose it. Include line numbers where possible.
- **Complexity:** Big-O time and space. Is it optimal?
- **Edge cases:** any obvious gaps.

No rewrites, no full solutions. Be confident — state each point once and stop. Use ```{language} fences for any code. {language} only.
"""


def build_dsa_prompt(body):
    preamble, language = _build_preamble(body)

    coaching_mode = body.get('coachingMode', 'learn')
    if coaching_mode == 'learn':
        coaching_rule = (
            f"Coaching mode: LEARN. Explain why this pattern fits, and include a one-line {language} syntax example for the key operation."
        )
    elif coaching_mode == 'interview':
        coaching_rule = (
            "Coaching mode: INTERVIEW. State the pattern and structure briefly, then ask the user to explain the time-space trade-off vs. a naive approach."
        )
    else:
        coaching_rule = (
            "Coaching mode: PRACTICE. Pattern and structure name only. Zero explanation."
        )

    coaching_rule += "\n" + CODE_POLICY[coaching_mode]

    return preamble + f"""
{coaching_rule}

1-3 lines total. State: algorithmic pattern, specific data structure variant, optimal complexity. Bold pattern/structure names (e.g., **sliding window**, **monotonic deque**). No extra explanation. {language} naming conventions. If the last submission is TLE/MLE, factor that into your complexity recommendation.
"""


def build_optimize_prompt(body):
    """Efficiency review — replaces the DSA Tips button in Practice mode."""
    preamble, language = _build_preamble(body)
    coaching_mode = body.get('coachingMode', 'learn')

    return preamble + f"""
{CODE_POLICY[coaching_mode]}

Review the efficiency of the user's current code. 4 short lines max, one line each:
- **Now:** Big-O time and space as written, plus what drives each.
- **Best:** the optimal time and space for this problem.
- **Gap:** if not optimal, name the technique that closes it — do NOT implement it.

If it's already optimal, say so in one line and stop.

Be direct and specific to their code — no generic advice. No preamble. Short sentences.
If the last submission was TLE or MLE, treat that as the primary signal and lead with it.
Use {language} naming conventions.
"""


def build_feedback_prompt(body):
    """End-of-interview debrief — replaces the DSA Tips button in Interview mode."""
    preamble, _language = _build_preamble(body)

    return preamble + f"""
{CODE_POLICY['interview']}

You are a senior engineer delivering end-of-interview feedback. Address the candidate directly and
stay in character — this is the debrief a real interviewer gives, not a code review document.

5 short lines max, one line each:
- **Approach:** was the strategy sound?
- **Code quality:** the one thing that stood out, good or bad.
- **Complexity:** Big-O time and space, and whether it's optimal.
- **Do differently:** the single most valuable change.

Close with a one-line overall read.

Be honest and specific — vague praise is useless. Keep every line short.
"""


def build_review_prompt(body):
    """Full session retrospective. Deliberately exempt from CODE_POLICY — the user
    generates this when they're done, so withholding the solution defeats the point."""
    preamble, language = _build_preamble(body)

    return preamble + f"""
You are writing a end-of-session review report for the problem above. The conversation history is
the user's full session — read it as evidence of how they actually worked, not just what they asked.

This report is a RETROSPECTIVE. Unlike every other mode, you may show the complete optimal solution
and explain it in full. The user has finished; withholding now would be unhelpful.

Keep the whole report tight — a user reads this in a 400px panel, so short sentences and no padding.
Structure it with these headings exactly, in this order:

## The problem
One line: what it's really testing.

## How you approached it
2-3 lines. Where they started, what they tried, where they changed direction. Reference what they
actually did — generic praise is worthless here.

## Where you struggled
The 2 biggest sticking points, one line each, naming the underlying gap (a pattern they don't know
yet, an edge case habit, a complexity blind spot). Direct but not harsh.

## The solution
The optimal approach in {language}, complete but lightly commented, with its time and space complexity.
No walkthrough — the code and one line of explanation.

## What to practice next
2 specific named patterns or problem types. One line each. Not "keep practicing".

Then append exactly one Mermaid diagram in a ```mermaid fenced block visualizing the solution's core
mechanic. Allowed types ONLY: {ALLOWED_DIAGRAM_TYPES}. Under 12 nodes, `flowchart TD` preferred.
In flowchart nodes only, wrap labels in double quotes — A["left < right"] — since unquoted (), [],
{{}}, or : breaks the parser. Do not quote participant, class, or state names. No markdown or HTML
inside labels. Nothing after the closing fence.

Write to the user as "you". Be specific and useful over kind.
"""


def build_chat_prompt(body):
    preamble, language = _build_preamble(body)

    coaching_mode = body.get('coachingMode', 'learn')
    if coaching_mode == 'learn':
        coaching_rule = (
            "Coaching mode: LEARN. Teach the concept and name the algorithm. Explain the idea in full — "
            "but the user still writes the solution. If they ask you to write it for them, give them the "
            "shape of it (a skeleton with blanks, or the one line they're stuck on) and let them finish."
        )
    elif coaching_mode == 'interview':
        coaching_rule = (
            "Coaching mode: INTERVIEW. You are a senior technical interviewer. Challenge the user's logic, ask for complexity analysis, and use Socratic questions. Stay in character. If they ask you to write code, respond the way an interviewer would — you're here to evaluate, not to implement."
        )
    else:
        coaching_rule = (
            "Coaching mode: PRACTICE. Minimal nudge only — no concept explanations. If they ask something they should know, ask a probing question back. Max 1-2 sentences."
        )

    coaching_rule += "\n" + CODE_POLICY[coaching_mode]

    return preamble + f"""
{coaching_rule}

Rules:
- Be concise. 1-2 sentences unless the question genuinely requires more.
- Be confident — state your answer once and stop. Never second-guess or revise mid-response.
- Recommend specific DS/algorithm variants, not generic advice.
- No preamble, no summary.
- {language} only for any code.
- get_solution tool: use only when genuinely unsure about the optimal approach. Never reproduce the full solution.
- Markdown: ```{language} fences for code, **bold** key terms, bullets for multi-part answers.
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


def check_and_update_usage(user_id, cost=1):
    """Returns True if the request is allowed, False if weekly limit exceeded.

    `cost` is how many prompts this request consumes (diagram requests cost 2).
    DynamoDB can't do arithmetic inside a ConditionExpression, so the threshold
    is precomputed here: a request is allowed iff weeklyRequests <= LIMIT - cost.
    """
    if not user_id:
        return True
    try:
        today_date = datetime.date.today()
        today = today_date.isoformat()
        current_monday = get_week_start(today_date)
        threshold = WEEKLY_LIMIT - cost

        result = _table.get_item(Key={'userId': user_id})
        item = result.get('Item')

        if item is None:
            _table.put_item(Item={
                'userId': user_id,
                'weeklyRequests': cost,
                'totalRequests': cost,
                'weekStartDate': current_monday,
                'firstSeen': today,
                'lastSeen': today,
                'tier': 'free',
            })
            return True

        if item.get('weekStartDate') != current_monday:
            # New week — reset weekly counter. ConditionExpression prevents a
            # double-reset if two concurrent requests both saw the old weekStartDate.
            try:
                _table.update_item(
                    Key={'userId': user_id},
                    UpdateExpression='SET weeklyRequests = :cost, weekStartDate = :monday, lastSeen = :today ADD totalRequests :cost',
                    ConditionExpression='weekStartDate <> :monday',
                    ExpressionAttributeValues={':cost': cost, ':monday': current_monday, ':today': today},
                )
                return True
            except ClientError as e:
                if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                    raise
                # Concurrent request already reset this week; fall through to normal increment

        elif item.get('weeklyRequests', 0) > threshold:
            return False

        # ConditionExpression makes the limit check and the increment atomic,
        # eliminating the TOCTOU race between the get_item above and this write.
        try:
            _table.update_item(
                Key={'userId': user_id},
                UpdateExpression='SET lastSeen = :today ADD weeklyRequests :cost, totalRequests :cost',
                ConditionExpression='weeklyRequests <= :threshold',
                ExpressionAttributeValues={':cost': cost, ':today': today, ':threshold': threshold},
            )
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                return False
            raise
        return True

    except Exception as e:
        print(f"DynamoDB error (failing open): {e}")
        return True


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def handler(event, context):
    try:
        headers = event.get('headers') or {}
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
            usage_data = {'weeklyRequests': 0, 'weekStartDate': get_week_start(today)}
            if user_id:
                try:
                    result = _table.get_item(Key={'userId': user_id})
                    item = result.get('Item')
                    if item:
                        usage_data = {
                            'weeklyRequests': int(item.get('weeklyRequests', 0)),
                            'weekStartDate': item.get('weekStartDate', get_week_start(today)),
                        }
                except Exception as e:
                    print(f"DynamoDB error fetching usage: {e}")
            _stream_to_runtime(context.aws_request_id, iter([json.dumps(usage_data)]))
            return

        # Review already includes a diagram in its prompt, so an armed toggle
        # must not stack another cost on top of the flat 5.
        wants_diagram = body.get('wantsDiagram', False) and mode != 'review'
        if mode == 'review':
            cost = REVIEW_COST
        elif wants_diagram:
            cost = DIAGRAM_COST
        else:
            cost = 1

        if not check_and_update_usage(user_id, cost):
            if mode == 'review':
                detail = f"A review report costs {REVIEW_COST} prompts and you don't have enough left this week."
            elif wants_diagram:
                detail = f"A diagram costs {DIAGRAM_COST} prompts and you don't have enough left this week."
            else:
                detail = f"You've reached your weekly limit of {WEEKLY_LIMIT} requests."
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'weekly_limit_reached',
                'message': f"{detail} Your limit resets on Monday.",
                'limit': WEEKLY_LIMIT,
                'cost': cost,
            })]))
            return

        system_prompt, max_tokens = build_prompt_for_mode(mode, body)
        messages = build_messages(body)

        # Mermaid syntax is unforgiving and a parse error wastes a paid request,
        # so diagram requests always go to the stronger model.
        model_id = (
            SONNET_MODEL_ID if (wants_diagram or mode not in ('hint', 'dsa'))
            else HAIKU_MODEL_ID
        )

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

    except Exception as e:
        print(f"Unhandled error: {e}")
        try:
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'internal_error',
                'message': 'An internal error occurred.',
            })]))
        except Exception:
            pass
