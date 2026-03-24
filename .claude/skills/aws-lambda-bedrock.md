# AWS Lambda + Bedrock Skill

## Model ID
anthropic.claude-sonnet-4-6

## Lambda Handler Pattern (Python 3.11)
```python
import json
import boto3

bedrock = boto3.client('bedrock-runtime', region_name='us-east-1')

def handler(event, context):
    # Handle CORS preflight
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return cors_response(200, '')
    
    try:
        body = json.loads(event.get('body', '{}'))
        # process request
    except Exception as e:
        return cors_response(500, json.dumps({'error': str(e)}))

def cors_response(status_code, body):
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        'body': body
    }
```

## Bedrock Streaming
```python
response = bedrock.invoke_model_with_response_stream(
    modelId='anthropic.claude-sonnet-4-6',
    body=json.dumps({
        'anthropic_version': 'bedrock-2023-05-31',
        'max_tokens': 1024,
        'system': system_prompt,
        'messages': messages
    })
)

for event in response['body']:
    chunk = json.loads(event['chunk']['bytes'])
    if chunk['type'] == 'content_block_delta':
        text = chunk['delta'].get('text', '')
        # yield or write text
```

## SAM Template
```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Timeout: 30
    MemorySize: 256
    Runtime: python3.11

Resources:
  ChatFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: backend/
      Handler: lambda_function.handler
      Policies:
        - AmazonBedrockFullAccess
      Events:
        ChatApi:
          Type: HttpApi
          Properties:
            Path: /chat
            Method: post
        OptionsApi:
          Type: HttpApi
          Properties:
            Path: /chat
            Method: options

Outputs:
  ApiUrl:
    Value: !Sub 'https://${ServerlessHttpApi}.execute-api.${AWS::Region}.amazonaws.com/chat'
```

## Request Body Shape
```json
{
  "message": "why is my code wrong?",
  "problem": {
    "name": "Two Sum",
    "number": 1,
    "description": "...",
    "difficulty": "Easy",
    "tags": ["Array", "Hash Table"]
  },
  "code": "def twoSum(self, nums, target):\n    pass",
  "language": "Python3",
  "history": [
    { "role": "user", "content": "give me a hint" },
    { "role": "assistant", "content": "think about lookups..." }
  ],
  "failureInfo": {
    "input": "[2,7,11,15], 9",
    "expected": "[0,1]",
    "actual": "[]"
  }
}
```

## Common Pitfalls
- Always handle OPTIONS preflight requests for CORS
- Always parse event['body'] as JSON — arrives as string
- API Gateway HTTP API has 29s hard timeout
- History must be trimmed to last 10 messages
- failureInfo is optional — always use .get() with defaults
- Model ID is case sensitive: anthropic.claude-sonnet-4-6
- Always log errors to CloudWatch: print(f"Error: {e}")