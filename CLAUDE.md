# LeetCoach

## Project Overview
A Chrome extension that adds an AI coaching sidebar to LeetCode problem pages. 
The sidebar auto-opens on problem pages and provides a Claude-powered chat 
interface for code feedback, hints, and DSA guidance.

## Architecture
- **Frontend**: Chrome Extension (Manifest V3, vanilla JavaScript)
- **Backend**: Single AWS Lambda function (Python 3.11)
- **AI**: Claude Sonnet via Amazon Bedrock
- **Database**: DynamoDB (deferred — not in v1)
- **Infrastructure**: AWS SAM

## Project Structure
- `extension/` — Chrome extension files
- `backend/` — Lambda function and dependencies
- `template.yaml` — SAM infrastructure definition
- `.claude/skills/` — Claude Code skill files

## Key Decisions
- Single Lambda function, mode determined by request body
- Vanilla JS for extension (no React)
- Read problem context from LeetCode DOM
- Session-only chat memory (no persistence in v1)
- Claude Sonnet for all requests
- Side panel auto-opens on leetcode.com/problems/* pages
- Keyboard shortcut Cmd+Shift+L / Ctrl+Shift+L to reopen

## Extension Files and Their Roles
- `manifest.json` — permissions, content scripts, side panel config, keyboard shortcut
- `background.js` — side panel enable/disable logic, keyboard shortcut handler
- `content.js` — reads LeetCode DOM (problem, code, language, difficulty, failure output)
- `sidepanel.html` — side panel UI markup
- `sidepanel.js` — chat logic, calls Lambda, renders streaming response

## Backend
- Single handler in lambda_function.py
- Receives: { message, problem, code, language, difficulty, history }
- Returns: streaming text response from Claude Sonnet via Bedrock

## What the Extension Can Read from LeetCode DOM
- Problem name and number
- Problem description
- Difficulty (Easy/Medium/Hard)
- Topic tags
- Current user code (from Monaco editor)
- Selected language
- Public test cases
- Failure test case input/expected/actual output (after wrong answer)
- User username (from nav bar)

## AWS Services
- Bedrock (Claude Sonnet) — AI responses
- Lambda — backend compute
- API Gateway (HTTP API) — single POST /chat endpoint
- CloudWatch — logging
- IAM — Lambda execution role scoped to Bedrock + CloudWatch

## Development Commands
- Deploy backend: sam build && sam deploy
- Load extension: chrome://extensions → Developer Mode → Load Unpacked → extension/
- After Lambda changes: sam build && sam deploy
- After extension changes: refresh extension in chrome://extensions, reload LeetCode tab

## Current Status
- [x] Project structure created
- [x] manifest.json written
- [x] AWS CLI configured (us-east-1, leetcoach-dev user)
- [x] SAM CLI installed
- [x] Bedrock model access enabled (claude-sonnet-4-6)
- [ ] background.js
- [ ] content.js
- [ ] sidepanel.html
- [ ] sidepanel.js
- [ ] lambda_function.py
- [ ] template.yaml
- [ ] First deployment
- [ ] End to end test