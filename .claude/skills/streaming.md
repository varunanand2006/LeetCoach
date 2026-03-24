# Streaming Skill

## Overview
LeetCoach uses streaming responses so Claude's reply appears word by word
rather than all at once after a delay. This requires:
1. Lambda configured for response streaming
2. API Gateway HTTP API (supports streaming, lower latency than REST)
3. Extension using fetch() with a ReadableStream reader

## Lambda Streaming Handler (Python)
```python
import json
import boto3
from awslambdaric.bootstrap import lambda_handler

bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')

def build_messages(body):
    history = body.get('history', [])
    message = body.get('message', '')
    messages = history[-10:]  # last 10 messages max
    messages.append({'role': 'user', 'content': message})
    return messages

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
"""
    return prompt

def handler(event, context):
    body = json.loads(event.get('body', '{}'))
    
    response = bedrock.invoke_model_with_response_stream(
        modelId='anthropic.claude-sonnet-4-6',
        body=json.dumps({
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 1024,
            'system': build_system_prompt(body),
            'messages': build_messages(body)
        })
    )
    
    def generate():
        for event in response['body']:
            chunk = json.loads(event['chunk']['bytes'])
            if chunk['type'] == 'content_block_delta':
                yield chunk['delta'].get('text', '')
    
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'text/event-stream',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        'body': generate()
    }
```

## SAM Template for Streaming
```yaml
ChatFunction:
  Type: AWS::Serverless::Function
  Properties:
    CodeUri: backend/
    Handler: lambda_function.handler
    Runtime: python3.11
    Timeout: 30
    MemorySize: 256
    FunctionUrlConfig:
      AuthType: NONE
      InvokeMode: RESPONSE_STREAM
    Policies:
      - AmazonBedrockFullAccess
    Events:
      ChatApi:
        Type: HttpApi
        Properties:
          Path: /chat
          Method: post
```

## Extension Fetch with Streaming
```javascript
// sidepanel.js
async function sendMessage(message, context) {
  const API_URL = 'https://your-api-gateway-url/chat';
  
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      ...context,
      history: conversationHistory
    })
  });

  if (!response.ok) throw new Error('Request failed');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let assistantMessage = '';

  // Create message bubble before streaming starts
  const bubble = createMessageBubble('assistant');

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    assistantMessage += chunk;
    bubble.textContent = assistantMessage;
    scrollToBottom();
  }

  // Add to history when complete
  conversationHistory.push(
    { role: 'user', content: message },
    { role: 'assistant', content: assistantMessage }
  );
}
```

## Common Pitfalls
- Always set CORS headers on every Lambda response including errors
- API Gateway HTTP API has a 29s hard timeout — keep Lambda under 25s
- Trim history to last 10 messages to avoid inflating input tokens
- Always decode stream chunks with { stream: true } for proper UTF-8 handling
- Handle fetch errors gracefully — show error message in chat UI
- OPTIONS preflight requests need to return 200 with CORS headers