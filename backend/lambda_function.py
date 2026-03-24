import json
import boto3

bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')


def cors_headers():
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
    }


def build_system_prompt(body):
    problem = body.get('problem', {})
    code = body.get('code', '')
    language = body.get('language', 'Python')
    failure = body.get('failureInfo', None)

    prompt = f"""You are LeetCoach, an AI coding coach embedded directly in LeetCode.

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
Last submission failed:
- Input: {failure.get('input', '')}
- Expected: {failure.get('expected', '')}
- Actual: {failure.get('actual', '')}
"""

    prompt += """
Rules:
- Never give away the full solution
- Be progressive with hints — start vague, get specific only if pushed
- Keep responses concise — this is a sidebar chat
- If asked about syntax, answer briefly and directly
- If asked about data structures, recommend specific variants relevant to this problem
- Be encouraging but honest about bugs and inefficiencies
- Always use the problem context when giving advice
"""
    return prompt


def build_messages(body):
    history = body.get('history', [])
    message = body.get('message', '')
    messages = history[-10:]
    messages.append({'role': 'user', 'content': message})
    return messages


def handler(event, context):
    # Handle CORS preflight
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': cors_headers(),
            'body': '',
        }

    try:
        body = json.loads(event.get('body', '{}'))
        messages = build_messages(body)
        system_prompt = build_system_prompt(body)

        response = bedrock.invoke_model_with_response_stream(
            modelId='anthropic.claude-sonnet-4-6',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 1024,
                'system': system_prompt,
                'messages': messages,
            })
        )

        def generate():
            for event_chunk in response['body']:
                chunk = json.loads(event_chunk['chunk']['bytes'])
                if chunk.get('type') == 'content_block_delta':
                    text = chunk.get('delta', {}).get('text', '')
                    if text:
                        yield text.encode('utf-8')

        return {
            'statusCode': 200,
            'headers': cors_headers(),
            'body': generate(),
        }

    except Exception as e:
        print(f"Error: {e}")
        return {
            'statusCode': 500,
            'headers': {**cors_headers(), 'Content-Type': 'application/json'},
            'body': json.dumps({'error': str(e)}),
        }
