import json
import boto3
import os
from decimal import Decimal

# Configuration
TABLE_NAME = 'leetcoach-problems'
REGION = 'us-east-1' # Adjust if your stack is elsewhere

def upload_to_dynamodb(json_file_path):
    """
    Uploads LeetCode problems from a JSON file to DynamoDB.
    """
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(TABLE_NAME)

    try:
        with open(json_file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            problems = data.get('questions', []) # neenza dataset structure
    except FileNotFoundError:
        print(f"Error: {json_file_path} not found.")
        return

    print(f"Starting upload of {len(problems)} problems to {TABLE_NAME}...")

    with table.batch_writer() as batch:
        for i, problem in enumerate(problems):
            # Mapping neenza dataset keys
            item = {
                'problemSlug': problem.get('problem_slug'),
                'problemId': int(problem.get('frontend_id') or problem.get('problem_id', 0)),
                'title': problem.get('title'),
                'difficulty': problem.get('difficulty'),
                'topicTags': problem.get('topics', []),
                'description': problem.get('description'),
                'solutions': problem.get('solution'), # String/Markdown
                'hints': problem.get('hints', []),
                'examples': problem.get('examples', []),
                'constraints': problem.get('constraints', []),
                'codeSnippets': problem.get('code_snippets', {})
            }

            # Filter out None values
            clean_item = {k: v for k, v in item.items() if v is not None}
            
            # Handle Decimals for DynamoDB
            clean_item = json.loads(json.dumps(clean_item), parse_float=Decimal)

            # Safety check: DynamoDB has a 400KB limit per item.
            # We'll calculate a rough size and truncate if necessary.
            item_json = json.dumps(clean_item)
            if len(item_json.encode('utf-8')) > 400000:
                print(f"Warning: Problem {clean_item['problemSlug']} exceeds 400KB. Truncating solutions/description.")
                if 'solutions' in clean_item:
                    clean_item['solutions'] = clean_item['solutions'][:100000] + "... (truncated)"
                if len(json.dumps(clean_item).encode('utf-8')) > 400000:
                    clean_item['description'] = clean_item['description'][:100000] + "... (truncated)"

            batch.put_item(Item=clean_item)
            
            if (i + 1) % 100 == 0:
                print(f"Uploaded {i + 1} problems...")

    print("Upload complete!")

if __name__ == "__main__":
    # Instructions: 
    # 1. Ensure you have the dataset at the path below.
    # 2. Run: python backend/scripts/upload_problems.py
    
    # Path is relative to the project root if running from there
    script_dir = os.path.dirname(os.path.realpath(__file__))
    DATASET_PATH = os.path.join(script_dir, 'leetcode_dataset.json') 
    
    if os.path.exists(DATASET_PATH):
        upload_to_dynamodb(DATASET_PATH)
    else:
        print(f"Skipping upload. Dataset not found at {DATASET_PATH}")
