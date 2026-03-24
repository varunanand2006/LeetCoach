# Testing Skill

## Loading the Extension
1. Open Chrome → chrome://extensions
2. Enable Developer Mode (top right toggle)
3. Click Load Unpacked → select the extension/ folder
4. Navigate to any leetcode.com/problems/* page
5. Side panel should auto-open

## After Every Extension Code Change
1. Go to chrome://extensions
2. Click the refresh icon on the LeetCoach card
3. Reload the LeetCode tab (Ctrl+R)
4. No need to re-load unpacked unless manifest.json changed

## After manifest.json Changes
1. Go to chrome://extensions
2. Click Remove on LeetCoach
3. Click Load Unpacked again → select extension/ folder

## Debugging the Side Panel
- Right-click inside the side panel → Inspect
- This opens DevTools scoped to the side panel context
- Console.log in sidepanel.js appears here

## Debugging content.js
- Open DevTools on the LeetCode page (F12)
- Console tab — content.js logs appear here
- Can run content.js code directly in console to test selectors

## Debugging background.js
- Go to chrome://extensions
- Click "Service Worker" link under LeetCoach
- This opens DevTools for the background service worker

## Testing Lambda Locally (before deploying)
```bash
# Build first
sam build

# Create a test event file
# test-event.json:
{
  "body": "{\"message\": \"give me a hint\", \"problem\": {\"name\": \"Two Sum\", \"number\": 1, \"difficulty\": \"Easy\", \"tags\": [\"Array\", \"Hash Table\"], \"description\": \"Given an array of integers...\"}, \"code\": \"def twoSum(self, nums, target):\\n    pass\", \"language\": \"Python3\", \"history\": []}"
}

# Invoke locally
sam local invoke ChatFunction --event test-event.json
```

## Deploying Backend
```bash
sam build && sam deploy
```
First deploy use: `sam deploy --guided`

## Common Issues

### Side panel not opening
- Check background.js is loaded: chrome://extensions → Service Worker
- Check manifest has "sidePanel" in permissions
- Check URL matches: must be leetcode.com/problems/* exactly

### content.js not running
- Check matches in manifest content_scripts
- Check for JS errors in page DevTools console
- Monaco selector may need updating — test in console first

### Lambda not responding
- Check CloudWatch logs in AWS Console
- Check CORS headers are present on response
- Check API Gateway URL in sidepanel.js is correct
- Check IAM permissions include AmazonBedrockFullAccess

### Bedrock errors
- Model ID must be exact: anthropic.claude-sonnet-4-6
- Check model access was granted in Bedrock console
- Check region matches (us-east-1)

### Streaming not working
- Check Content-Type is text/event-stream
- Check response.body.getReader() is called before any await
- Check Lambda timeout is 30s not default 3s