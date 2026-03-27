import json
import os
import http.client
import datetime
import boto3

bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

WEEKLY_LIMIT = 100
TABLE_NAME = os.environ.get('TABLE_NAME', 'leetcoach-users')


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


# ---------------------------------------------------------------------------
# Prompt dispatcher
# ---------------------------------------------------------------------------

def build_prompt_for_mode(mode, body):
    """Returns (system_prompt: str, max_tokens: int)."""
    if mode == 'hint':
        return build_hint_prompt(body), 64
    if mode == 'analyze':
        return build_analyze_prompt(body), 256
    if mode == 'dsa':
        return build_dsa_prompt(body), 128
    return build_chat_prompt(body), 256  # 'chat' or unknown


# ---------------------------------------------------------------------------
# Submission result formatter
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


# ---------------------------------------------------------------------------
# Per-mode system prompts
# ---------------------------------------------------------------------------

def build_hint_prompt(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')
    hint_level = body.get('hintLevel', 1)
    submission_snippet = format_submission_result(body.get('submissionResult'))

    level_instructions = {
        1: (
            "One sentence only. Give a directional nudge without naming any data structure "
            "or algorithm — point toward a property the solution needs."
        ),
        2: (
            "1-2 sentences. Name the data structure or algorithm category. "
            "Do NOT explain how to implement it."
        ),
        3: (
            "2 sentences max. Name the exact structure and what to store in it. "
            "Do NOT write code."
        ),
    }

    instruction = level_instructions.get(hint_level, level_instructions[3])

    return f"""You are LeetCoach, an AI coding coach embedded in LeetCode.

Current problem:
- Difficulty: {problem.get('difficulty', 'Unknown')}
- Tags: {', '.join(problem.get('tags', []))}
- Description: {problem.get('description', '')}

User's current code ({language}):
```
{code}
```
{submission_snippet}
Hint level requested: {hint_level} of 3

Your task: {instruction}

Rules:
- Never write actual code or pseudocode
- Never reveal the complete algorithm
- Be encouraging — the user is working through this themselves
- No preamble or summary — just the hint
"""


def build_analyze_prompt(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')
    submission_snippet = format_submission_result(body.get('submissionResult'))

    return f"""You are LeetCoach, an AI coding coach embedded in LeetCode.

Current problem:
- Difficulty: {problem.get('difficulty', 'Unknown')}
- Tags: {', '.join(problem.get('tags', []))}
- Description: {problem.get('description', '')}

User's current code ({language}):
```
{code}
```
{submission_snippet}
Your task: Analyze the code. 3 bullets max, one line each. Skip any section that has no issue:
- **Correctness:** is the logic right? If there's a submission failure, diagnose why.
- **Complexity:** Big-O time and space. Is it optimal?
- **Edge cases:** any obvious gaps.

No rewrites, no full solutions. Be concise — stop as soon as the point is made. Use code fences with language tag if quoting code.
"""


def build_dsa_prompt(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')
    submission_snippet = format_submission_result(body.get('submissionResult'))

    return f"""You are LeetCoach, an AI coding coach embedded in LeetCode.

Current problem:
- Difficulty: {problem.get('difficulty', 'Unknown')}
- Tags: {', '.join(problem.get('tags', []))}
- Description: {problem.get('description', '')}

User's current code ({language}):
```
{code}
```
{submission_snippet}
Your task: 1-3 lines total. State the algorithmic pattern, the specific data structure variant, and optimal complexity. No code, no explanation — just the tools. Bold pattern and structure names (e.g., **sliding window**, **monotonic deque**).
"""


def build_chat_prompt(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')
    submission_snippet = format_submission_result(body.get('submissionResult'))

    return f"""You are LeetCoach, an AI coding coach embedded in LeetCode.

Current problem:
- Difficulty: {problem.get('difficulty', 'Unknown')}
- Tags: {', '.join(problem.get('tags', []))}
- Description: {problem.get('description', '')}

User's current code ({language}):
```
{code}
```
{submission_snippet}
Rules:
- Be terse. 1-2 sentences max unless the question genuinely requires more. Stop as soon as the point is made.
- Recommend specific DS/algorithm variants for this problem, not generic advice.
- Never give away the full solution.
- No preamble, no summary.
- Format responses with markdown: use code fences with language tag for any code snippets, **bold** for key terms, and bullet lists for multi-part answers.
"""


# ---------------------------------------------------------------------------
# Message builder
# ---------------------------------------------------------------------------

def build_messages(body):
    mode = body.get('mode', 'chat')
    history = body.get('history', [])

    trigger_by_mode = {
        'hint':    'Please give me a hint.',
        'analyze': 'Please analyze my code.',
        'dsa':     'What data structures and algorithms should I use for this problem?',
    }
    message = body.get('message') or trigger_by_mode.get(mode, '')

    messages = list(history[-10:])
    messages.append({'role': 'user', 'content': message})
    return messages


# ---------------------------------------------------------------------------
# Usage tracking
# ---------------------------------------------------------------------------

def get_week_start():
    today = datetime.date.today()
    monday = today - datetime.timedelta(days=today.weekday())
    return monday.isoformat()


def check_and_update_usage(user_id):
    """Returns True if the request is allowed, False if weekly limit exceeded."""
    if not user_id:
        return True
    try:
        table = dynamodb.Table(TABLE_NAME)
        today = datetime.date.today().isoformat()
        current_monday = get_week_start()

        result = table.get_item(Key={'userId': user_id})
        item = result.get('Item')

        if item is None:
            table.put_item(Item={
                'userId': user_id,
                'weeklyRequests': 1,
                'totalRequests': 1,
                'weekStartDate': current_monday,
                'firstSeen': today,
                'lastSeen': today,
                'tier': 'free',
            })
            return True

        if item.get('weekStartDate') != current_monday:
            # New week — reset weekly counter
            table.update_item(
                Key={'userId': user_id},
                UpdateExpression='SET weeklyRequests = :one, weekStartDate = :monday, lastSeen = :today ADD totalRequests :one2',
                ExpressionAttributeValues={
                    ':one': 1,
                    ':one2': 1,
                    ':monday': current_monday,
                    ':today': today,
                },
            )
            return True

        if item.get('weeklyRequests', 0) >= WEEKLY_LIMIT:
            return False

        table.update_item(
            Key={'userId': user_id},
            UpdateExpression='SET lastSeen = :today ADD weeklyRequests :one, totalRequests :one',
            ExpressionAttributeValues={':one': 1, ':today': today},
        )
        return True

    except Exception as e:
        print(f"DynamoDB error (failing open): {e}")
        return True


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def handler(event, context):
    try:
        body = json.loads(event.get('body', '{}'))
        mode = body.get('mode', 'chat')

        user_id = body.get('userId', None)

        if mode == 'usage':
            usage_data = {'weeklyRequests': 0, 'weekStartDate': get_week_start()}
            if user_id:
                try:
                    table = dynamodb.Table(TABLE_NAME)
                    result = table.get_item(Key={'userId': user_id})
                    item = result.get('Item')
                    if item:
                        usage_data = {
                            'weeklyRequests': int(item.get('weeklyRequests', 0)),
                            'weekStartDate': item.get('weekStartDate', get_week_start()),
                        }
                except Exception as e:
                    print(f"DynamoDB error fetching usage: {e}")
            _stream_to_runtime(context.aws_request_id, iter([json.dumps(usage_data)]))
            return

        if not check_and_update_usage(user_id):
            _stream_to_runtime(context.aws_request_id, iter([json.dumps({
                'error': 'weekly_limit_reached',
                'message': "You've reached your weekly limit of 100 requests. Your limit resets on Monday.",
                'limit': 100,
            })]))
            return

        system_prompt, max_tokens = build_prompt_for_mode(mode, body)
        messages = build_messages(body)

        model_id = (
            'us.anthropic.claude-haiku-4-5-20251001-v1:0'
            if mode in ('hint', 'dsa')
            else 'us.anthropic.claude-sonnet-4-6'
        )

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
        print(f"Error: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)}),
        }
