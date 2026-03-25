import json
import boto3

bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')


def response_headers():
    return {
        'Content-Type': 'text/plain',
    }


# ---------------------------------------------------------------------------
# Prompt dispatcher
# ---------------------------------------------------------------------------

def build_prompt_for_mode(mode, body):
    """Returns (system_prompt: str, max_tokens: int)."""
    if mode == 'hint':
        return build_hint_prompt(body), 128
    if mode == 'analyze':
        return build_analyze_prompt(body), 512
    if mode == 'dsa':
        return build_dsa_prompt(body), 256
    return build_chat_prompt(body), 384  # 'chat' or unknown


# ---------------------------------------------------------------------------
# Per-mode system prompts
# ---------------------------------------------------------------------------

def build_hint_prompt(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')
    hint_level = body.get('hintLevel', 1)

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
- Name: {problem.get('name', 'Unknown')}
- Number: {problem.get('number', '?')}
- Difficulty: {problem.get('difficulty', 'Unknown')}
- Tags: {', '.join(problem.get('tags', []))}
- Description: {problem.get('description', '')}

User's current code ({language}):
```
{code}
```

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
    failure = body.get('failureInfo', None)

    prompt = f"""You are LeetCoach, an AI coding coach embedded in LeetCode.

Current problem:
- Name: {problem.get('name', 'Unknown')}
- Number: {problem.get('number', '?')}
- Difficulty: {problem.get('difficulty', 'Unknown')}
- Tags: {', '.join(problem.get('tags', []))}
- Description: {problem.get('description', '')}

User's current code ({language}):
```
{code}
```
"""

    if failure:
        prompt += f"""
Last submission result: Wrong Answer
- Input:    {failure.get('input', '')}
- Expected: {failure.get('expected', '')}
- Actual:   {failure.get('actual', '')}
"""

    prompt += """
Your task: Analyze the code. Use short bullet points:
- **Correctness:** is the logic right? If wrong answer, diagnose why in one line.
- **Complexity:** Big-O time and space. Is it optimal?
- **Edge cases:** any obvious gaps (1-2 max).
- **Style:** one line if anything notable.

No rewrites, no full solutions. Skip sections that are fine. Use code fences with language tag if quoting code.
"""
    return prompt


def build_dsa_prompt(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')

    return f"""You are LeetCoach, an AI coding coach embedded in LeetCode.

Current problem:
- Name: {problem.get('name', 'Unknown')}
- Number: {problem.get('number', '?')}
- Difficulty: {problem.get('difficulty', 'Unknown')}
- Tags: {', '.join(problem.get('tags', []))}
- Description: {problem.get('description', '')}

User's current code ({language}):
```
{code}
```

Your task: In 3-4 lines total, state: the algorithmic pattern, the specific data structure variant to use, and the optimal time/space complexity. If the user already has an approach, note whether it's on the right track. No code, no explanation of how to implement — just the tools and why. Bold the algorithm pattern and data structure names (e.g., **sliding window**, **monotonic deque**).
"""


def build_chat_prompt(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')
    failure = body.get('failureInfo', None)

    prompt = f"""You are LeetCoach, an AI coding coach embedded in LeetCode.

Current problem:
- Name: {problem.get('name', 'Unknown')}
- Number: {problem.get('number', '?')}
- Difficulty: {problem.get('difficulty', 'Unknown')}
- Tags: {', '.join(problem.get('tags', []))}
- Description: {problem.get('description', '')}

User's current code ({language}):
```
{code}
```
"""

    if failure:
        prompt += f"""
Last submission result: Wrong Answer
- Input:    {failure.get('input', '')}
- Expected: {failure.get('expected', '')}
- Actual:   {failure.get('actual', '')}
"""

    prompt += """
Rules:
- Answer directly. 1-3 sentences for syntax questions, short paragraphs for approach questions.
- Recommend specific DS/algorithm variants for this problem, not generic advice.
- Never give away the full solution.
- No preamble, no summary.
- Format responses with markdown: use code fences with language tag for any code snippets, **bold** for key terms, and bullet lists for multi-part answers.
"""

    return prompt


# ---------------------------------------------------------------------------
# Message builder
# ---------------------------------------------------------------------------

def build_messages(body):
    mode = body.get('mode', 'chat')
    history = body.get('history', [])

    # For button-triggered modes, synthesize the user turn
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
# Handler
# ---------------------------------------------------------------------------

def handler(event, context):
    try:
        body = json.loads(event.get('body', '{}'))
        mode = body.get('mode', 'chat')

        system_prompt, max_tokens = build_prompt_for_mode(mode, body)
        messages = build_messages(body)

        model_id = 'us.anthropic.claude-haiku-4-5-20251001-v1:0' if mode in ('hint', 'dsa') else 'us.anthropic.claude-sonnet-4-6'

        response = bedrock.invoke_model(
            modelId=model_id,
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': max_tokens,
                'system': system_prompt,
                'messages': messages,
            })
        )

        result = json.loads(response['body'].read())
        text = result['content'][0]['text']

        return {
            'statusCode': 200,
            'headers': response_headers(),
            'body': text,
        }

    except Exception as e:
        print(f"Error: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)}),
        }
