import json
import boto3

bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')


def response_headers():
    return {
        'Content-Type': 'text/plain',
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
    try:
        body = json.loads(event.get('body', '{}'))
        messages = build_messages(body)
        system_prompt = build_system_prompt(body)

        response = bedrock.invoke_model(
            modelId='us.anthropic.claude-sonnet-4-6',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 1024,
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
