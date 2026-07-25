"""Stripe webhook — grants and revokes purchased prompt credits.

This is a SEPARATE Lambda from the chat function, and it must stay that way.
The chat function's URL is InvokeMode: RESPONSE_STREAM, which cannot return an
HTTP status code — every error it produces is a 200 carrying a JSON body. Stripe's
delivery contract is entirely status-code driven: 2xx means delivered, anything
else means retry with backoff for up to ~3 days. Served from a streaming URL, a
failed credit grant would look like success, Stripe would never retry, and the
user would have paid for nothing. Hence InvokeMode: BUFFERED here.

Status codes are therefore load-bearing:
  200 — processed, already processed, or an event type we don't act on
  400 — bad signature or malformed payload; retrying cannot help, so don't ask
  500 — transient failure (DynamoDB down, unknown pack); Stripe should retry

The Stripe SDK is deliberately not used. Signature verification is HMAC-SHA256
and nothing else here needs the client, so the package stays dependency-free.
"""

import base64
import datetime
import hashlib
import hmac
import json
import os
import time

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get('TABLE_NAME', 'leetcoach-users')
PAYMENTS_TABLE_NAME = os.environ.get('PAYMENTS_TABLE_NAME', 'leetcoach-payments')
STRIPE_WEBHOOK_SECRET = os.environ.get('STRIPE_WEBHOOK_SECRET', '')

# Reject signatures older than this. Stripe's own libraries default to 300s.
# Without it, a captured request could be replayed verbatim forever.
SIGNATURE_TOLERANCE_SECONDS = 300

# Ledger rows outlive the dispute window (chargebacks can arrive ~120 days
# later) so a late event can still be traced. Stripe itself gives up retrying
# after ~3 days, so this is far longer than idempotency alone requires.
LEDGER_TTL_DAYS = 400

# What each pack grants, keyed by the `pack` we set in session metadata.
# Deliberately defined HERE rather than read from the event: the webhook is the
# thing that moves credits, so it should decide how many, and a bug in checkout
# then cannot over-grant. amountCents is cross-checked against what Stripe
# actually collected.
PACKS = {
    'small': {'credits': 500, 'amountCents': 499, 'currency': 'usd'},
    'large': {'credits': 1500, 'amountCents': 999, 'currency': 'usd'},
}

_ddb = boto3.client('dynamodb', region_name='us-east-1')

# Granting on both events covers delayed payment methods, where the session
# completes unpaid and settles minutes or days later.
GRANT_EVENTS = ('checkout.session.completed', 'checkout.session.async_payment_succeeded')
REVOKE_EVENTS = ('charge.refunded', 'charge.dispute.created')


# ---------------------------------------------------------------------------
# Signature verification
# ---------------------------------------------------------------------------

def _raw_body(event):
    """The exact bytes Stripe signed.

    Signature verification is over the raw payload, so this must never be
    parsed and re-serialised — `json.dumps(json.loads(body))` reorders keys and
    changes whitespace, and the signature stops matching.
    """
    body = event.get('body') or ''
    if event.get('isBase64Encoded'):
        return base64.b64decode(body)
    return body.encode('utf-8')


def verify_signature(payload, header, secret, now=None):
    """True if `header` is a valid Stripe-Signature for `payload`.

    Header looks like: t=1614556800,v1=5257a8...,v1=<rotated secret's sig>
    Multiple v1 entries appear while a signing secret is being rotated, so any
    one matching is enough.
    """
    if not secret or not header:
        return False

    timestamp = None
    signatures = []
    for part in header.split(','):
        key, _, value = part.strip().partition('=')
        if key == 't':
            timestamp = value
        elif key == 'v1':
            signatures.append(value)

    if timestamp is None or not signatures:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False

    now = int(time.time()) if now is None else now
    if abs(now - ts) > SIGNATURE_TOLERANCE_SECONDS:
        return False

    signed = timestamp.encode('utf-8') + b'.' + payload
    expected = hmac.new(secret.encode('utf-8'), signed, hashlib.sha256).hexdigest()
    # compare_digest, not ==, so a wrong signature can't be recovered by timing.
    return any(hmac.compare_digest(expected, sig) for sig in signatures)


# ---------------------------------------------------------------------------
# Credit movement
# ---------------------------------------------------------------------------

def _ttl_epoch():
    return int(time.time()) + LEDGER_TTL_DAYS * 86400


def _ledger_item(event_id, kind, user_id, credits, extra=None):
    item = {
        'eventId': {'S': event_id},
        'kind': {'S': kind},
        'userId': {'S': user_id},
        'credits': {'N': str(credits)},
        # Not utcnow(): deprecated since 3.12 and naive, so it silently loses
        # the offset. This is what an auditor reads during a dispute.
        'processedAt': {'S': datetime.datetime.now(datetime.timezone.utc).isoformat()},
        'expiresAt': {'N': str(_ttl_epoch())},
    }
    item.update(extra or {})
    return item


def _cancelled_on(err, index):
    """True if a TransactionCanceledException was caused by item `index`'s condition."""
    reasons = err.response.get('CancellationReasons') or []
    return (
        len(reasons) > index
        and reasons[index].get('Code') == 'ConditionalCheckFailed'
    )


def grant_credits(event_id, user_id, credits, ledger_extra):
    """Add credits, exactly once. Returns True if granted, False if a duplicate.

    The ledger write and the balance change go in a single transaction because
    Stripe does not promise exactly-once delivery. A plain "check then credit"
    leaves a window where a retry arriving mid-flight credits the user twice;
    a transaction makes the claim and the grant succeed or fail together.
    """
    try:
        _ddb.transact_write_items(TransactItems=[
            {'Put': {
                'TableName': PAYMENTS_TABLE_NAME,
                'Item': _ledger_item(event_id, 'grant', user_id, credits, ledger_extra),
                'ConditionExpression': 'attribute_not_exists(eventId)',
            }},
            {'Update': {
                'TableName': TABLE_NAME,
                'Key': {'userId': {'S': user_id}},
                'UpdateExpression': 'SET lastPurchaseAt = :now ADD purchasedCredits :credits',
                'ExpressionAttributeValues': {
                    ':credits': {'N': str(credits)},
                    ':now': {'S': datetime.date.today().isoformat()},
                },
            }},
        ])
        return True
    except ClientError as e:
        if e.response['Error']['Code'] == 'TransactionCanceledException' and _cancelled_on(e, 0):
            return False  # already processed — Stripe is retrying a delivery we handled
        raise


def revoke_credits(event_id, user_id, credits, ledger_extra):
    """Claw back credits after a refund or dispute, without going negative.

    DynamoDB can't express max(0, balance - n) in one update, so this tries the
    full deduction and falls back to zeroing the balance when the user has
    already spent part of what they bought. Both attempts carry the same ledger
    claim, so the operation stays exactly-once either way.
    """
    ledger = {'Put': {
        'TableName': PAYMENTS_TABLE_NAME,
        'Item': _ledger_item(event_id, 'revoke', user_id, credits, ledger_extra),
        'ConditionExpression': 'attribute_not_exists(eventId)',
    }}
    try:
        _ddb.transact_write_items(TransactItems=[ledger, {'Update': {
            'TableName': TABLE_NAME,
            'Key': {'userId': {'S': user_id}},
            'UpdateExpression': 'ADD purchasedCredits :neg',
            'ConditionExpression': 'purchasedCredits >= :credits',
            'ExpressionAttributeValues': {
                ':neg': {'N': str(-credits)},
                ':credits': {'N': str(credits)},
            },
        }}])
        return True
    except ClientError as e:
        if e.response['Error']['Code'] != 'TransactionCanceledException':
            raise
        if _cancelled_on(e, 0):
            return False  # duplicate delivery
        if not _cancelled_on(e, 1):
            raise
        # Balance is short of the refund — they spent some of it. Take the rest.
        try:
            _ddb.transact_write_items(TransactItems=[ledger, {'Update': {
                'TableName': TABLE_NAME,
                'Key': {'userId': {'S': user_id}},
                'UpdateExpression': 'SET purchasedCredits = :zero',
                'ExpressionAttributeValues': {':zero': {'N': '0'}},
            }}])
            return True
        except ClientError as e2:
            if (e2.response['Error']['Code'] == 'TransactionCanceledException'
                    and _cancelled_on(e2, 0)):
                return False
            raise


# ---------------------------------------------------------------------------
# Event handling
# ---------------------------------------------------------------------------

def _valid_user_id(value):
    """Same shape the chat Lambda enforces. Google's `sub` is a short numeric string."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= 50
        and all(c.isalnum() or c in '_-.' for c in value)
    )


def _resolve_pack(pack_name, amount_total, currency):
    """Credits for a pack, or None if it doesn't check out.

    The amount comparison is belt-and-braces — we create the session ourselves —
    but it means a misconfigured Stripe Price can't quietly grant the big pack
    for the small pack's money.
    """
    pack = PACKS.get(pack_name)
    if pack is None:
        print(f"Unknown pack {pack_name!r} — cannot determine credits")
        return None
    if amount_total is not None and amount_total != pack['amountCents']:
        print(f"Amount mismatch for pack {pack_name!r}: "
              f"collected {amount_total}, expected {pack['amountCents']}")
        return None
    if currency and currency.lower() != pack['currency']:
        print(f"Currency mismatch for pack {pack_name!r}: got {currency}")
        return None
    return pack['credits']


def handle_grant(event_id, obj):
    session_id = obj.get('id', '')
    user_id = obj.get('client_reference_id')
    metadata = obj.get('metadata') or {}

    # A session can complete before money moves (delayed payment methods). The
    # async_payment_succeeded delivery is what grants in that case.
    if obj.get('payment_status') != 'paid':
        print(f"Session {session_id} completed unpaid ({obj.get('payment_status')}) — not granting")
        return 200, 'ignored: not paid'

    if not _valid_user_id(user_id):
        # Nothing to retry: the session was created without a usable identity.
        print(f"Session {session_id} has no valid client_reference_id: {user_id!r}")
        return 400, 'missing client_reference_id'

    credits = _resolve_pack(metadata.get('pack'), obj.get('amount_total'), obj.get('currency'))
    if credits is None:
        # 500 on purpose. The user has paid, so silently returning 200 would
        # strand them; a 5xx keeps the event failing visibly in the Stripe
        # dashboard and redeliverable once the pack table is fixed.
        return 500, 'unrecognised pack'

    granted = grant_credits(event_id, user_id, credits, {
        'sessionId': {'S': session_id},
        'pack': {'S': str(metadata.get('pack'))},
        'amountCents': {'N': str(obj.get('amount_total') or 0)},
    })
    print(f"{'Granted' if granted else 'Duplicate, skipped'} {credits} credits to {user_id}"
          f" for session {session_id}")
    return 200, 'granted' if granted else 'duplicate'


def handle_revoke(event_id, event_type, obj):
    """Charges carry userId/credits via payment_intent_data.metadata set at checkout."""
    metadata = obj.get('metadata') or {}
    user_id = metadata.get('userId')
    if not _valid_user_id(user_id):
        print(f"{event_type} for charge {obj.get('id')} has no usable userId — ignoring")
        return 200, 'ignored: no userId'

    credits = _resolve_pack(metadata.get('pack'), None, None)
    if credits is None:
        return 500, 'unrecognised pack'

    # A partial refund should only claw back the share actually refunded.
    amount = obj.get('amount') or 0
    refunded = obj.get('amount_refunded')
    if refunded and amount and refunded < amount:
        credits = int(credits * refunded / amount)

    revoked = revoke_credits(event_id, user_id, credits, {
        'chargeId': {'S': str(obj.get('id', ''))},
        'eventType': {'S': event_type},
    })
    print(f"{'Revoked' if revoked else 'Duplicate, skipped'} {credits} credits from {user_id}")
    return 200, 'revoked' if revoked else 'duplicate'


def handler(event, context):
    # Function URL lowercases header names.
    headers = {k.lower(): v for k, v in (event.get('headers') or {}).items()}
    payload = _raw_body(event)

    if not verify_signature(payload, headers.get('stripe-signature'), STRIPE_WEBHOOK_SECRET):
        # This URL is necessarily unauthenticated, so the signature is the only
        # thing standing between a stranger and an unlimited credit grant.
        print("Rejected: bad or missing Stripe signature")
        return {'statusCode': 400, 'body': 'invalid signature'}

    try:
        stripe_event = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return {'statusCode': 400, 'body': 'malformed payload'}

    event_id = stripe_event.get('id')
    event_type = stripe_event.get('type')
    obj = (stripe_event.get('data') or {}).get('object') or {}
    if not event_id or not event_type:
        return {'statusCode': 400, 'body': 'missing event id or type'}

    try:
        if event_type in GRANT_EVENTS:
            status, message = handle_grant(event_id, obj)
        elif event_type in REVOKE_EVENTS:
            status, message = handle_revoke(event_id, event_type, obj)
        else:
            status, message = 200, f'ignored: {event_type}'
    except Exception as e:
        # 500 so Stripe retries — a transient DynamoDB failure must not be
        # mistaken for a delivered event, or the credits are lost for good.
        print(f"Error handling {event_type} ({event_id}): {e}")
        return {'statusCode': 500, 'body': 'internal error'}

    return {'statusCode': status, 'body': message}
