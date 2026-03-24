# Project Conventions

## Code Style
- JavaScript: vanilla ES6+, no frameworks, no TypeScript
- Python: simple and readable, minimal dependencies
- Prefer clarity over cleverness — this is a portfolio project
- Always add null checks in DOM selectors

## Project Name
LeetCoach

## Extension ↔ Backend Communication
- Single endpoint: POST /chat
- Request body: { message, problem, code, language, difficulty, history, failureInfo }
- Response: streaming text (text/event-stream)
- History: last 10 messages max — always trim before sending
- failureInfo: optional, only present after a wrong answer submission

## Context Collected on Every Message
- Problem: name, number, description, difficulty, tags, slug
- Code: current Monaco editor contents
- Language: selected language from dropdown
- History: last 10 conversation turns
- failureInfo: if available from last submission

## File Responsibilities
- manifest.json — permissions, routes, shortcut definition
- background.js — side panel lifecycle only, no DOM access
- content.js — DOM reading only, no UI rendering
- sidepanel.html — UI structure only, minimal inline JS
- sidepanel.js — all chat logic, fetch calls, history management
- lambda_function.py — Bedrock calls, prompt construction, streaming
- template.yaml — all AWS infrastructure

## Error Handling
- Extension: always show error message in chat UI, never fail silently
- Lambda: always return CORS headers even on errors, always log to CloudWatch
- DOM selectors: always use optional chaining (?.) and fallbacks

## Git
- Commit after each working feature
- Never commit .env or AWS credentials
- Commit message format: "feat: add X" / "fix: Y" / "chore: Z"

## Deployment
- Backend: sam build && sam deploy
- Test locally first: sam local invoke ChatFunction --event test-event.json
- After deploy: check Outputs in terminal for API URL
- Update API_URL constant in sidepanel.js after first deploy

## API_URL Management
- Store API_URL as a constant at top of sidepanel.js
- Comment clearly: // Update this after sam deploy
- Never hardcode in multiple places

## .gitignore
- __pycache__/
- .aws-sam/
- .env
- *.pyc
- node_modules/
- .DS_Store
- *.zip
- test-event.json