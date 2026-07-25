"""Tests for the Stripe webhook: signature verification, idempotency, status codes.

Run from anywhere:  python payments/tests/test_webhook.py
No AWS credentials or network needed — DynamoDB transactions are faked.
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SECRET = 'whsec_test_secret'
os.environ['STRIPE_WEBHOOK_SECRET'] = SECRET

import app  # noqa: E402

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(f"PASS  {name}" if ok else f"FAIL  {name}\n        got={got!r} want={want!r}")


# ---------------------------------------------------------------------------
# Fake DynamoDB with real transaction semantics
# ---------------------------------------------------------------------------

class TxnCancelled(Exception):
    def __init__(self, reasons):
        self.response = {
            'Error': {'Code': 'TransactionCanceledException'},
            'CancellationReasons': reasons,
        }


class FakeDDB:
    def __init__(self, users=None):
        self.ledger = {}
        self.users = dict(users or {})
        self.transactions = 0

    def _num(self, table, key, attr):
        row = self.users.get(key) if table == app.TABLE_NAME else self.ledger.get(key)
        if not row or attr not in row:
            return None
        return int(row[attr]['N'])

    def transact_write_items(self, TransactItems):
        self.transactions += 1
        reasons = [{'Code': 'None'} for _ in TransactItems]
        failed = False

        # Phase 1: evaluate every condition against pre-transaction state.
        for i, op in enumerate(TransactItems):
            if 'Put' in op:
                item = op['Put']['Item']
                if (op['Put'].get('ConditionExpression') == 'attribute_not_exists(eventId)'
                        and item['eventId']['S'] in self.ledger):
                    reasons[i] = {'Code': 'ConditionalCheckFailed'}
                    failed = True
            elif 'Update' in op:
                cond = op['Update'].get('ConditionExpression')
                if cond == 'purchasedCredits >= :credits':
                    have = self._num(app.TABLE_NAME, op['Update']['Key']['userId']['S'],
                                     'purchasedCredits') or 0
                    need = int(op['Update']['ExpressionAttributeValues'][':credits']['N'])
                    if have < need:
                        reasons[i] = {'Code': 'ConditionalCheckFailed'}
                        failed = True
                elif cond:
                    raise AssertionError(f'unhandled condition: {cond}')

        if failed:
            raise TxnCancelled(reasons)

        # Phase 2: all-or-nothing apply.
        for op in TransactItems:
            if 'Put' in op:
                item = op['Put']['Item']
                self.ledger[item['eventId']['S']] = item
            elif 'Update' in op:
                key = op['Update']['Key']['userId']['S']
                row = self.users.setdefault(key, {})
                vals = op['Update']['ExpressionAttributeValues']
                expr = op['Update']['UpdateExpression']
                if 'ADD purchasedCredits :credits' in expr:
                    row['purchasedCredits'] = {
                        'N': str(int(row.get('purchasedCredits', {'N': '0'})['N'])
                                 + int(vals[':credits']['N']))}
                if 'ADD purchasedCredits :neg' in expr:
                    row['purchasedCredits'] = {
                        'N': str(int(row.get('purchasedCredits', {'N': '0'})['N'])
                                 + int(vals[':neg']['N']))}
                if 'SET purchasedCredits = :zero' in expr:
                    row['purchasedCredits'] = {'N': '0'}


def use_ddb(users=None):
    fake = FakeDDB(users)
    app._ddb = fake
    app.ClientError = TxnCancelled
    return fake


# ---------------------------------------------------------------------------
# Request builders
# ---------------------------------------------------------------------------

def sign(payload_bytes, secret=SECRET, ts=None):
    ts = ts or int(time.time())
    mac = hmac.new(secret.encode(), f'{ts}'.encode() + b'.' + payload_bytes,
                   hashlib.sha256).hexdigest()
    return f't={ts},v1={mac}'


def make_event(body_obj, secret=SECRET, ts=None, b64=False, sig=None, tamper=False):
    payload = json.dumps(body_obj).encode()
    header = sig if sig is not None else sign(payload, secret, ts)
    if tamper:
        body_obj = dict(body_obj)
        body_obj['tampered'] = True
        payload = json.dumps(body_obj).encode()
    body = base64.b64encode(payload).decode() if b64 else payload.decode()
    return {'headers': {'Stripe-Signature': header}, 'body': body, 'isBase64Encoded': b64}


def session_event(event_id='evt_1', user='118260042345896138064', pack='small',
                  amount=499, status='paid', etype='checkout.session.completed'):
    return {
        'id': event_id, 'type': etype,
        'data': {'object': {
            'id': 'cs_test_1', 'client_reference_id': user, 'payment_status': status,
            'amount_total': amount, 'currency': 'usd', 'metadata': {'pack': pack},
        }},
    }


def charge_event(event_id='evt_r1', user='118260042345896138064', pack='small',
                 etype='charge.refunded', amount=499, refunded=499):
    return {
        'id': event_id, 'type': etype,
        'data': {'object': {
            'id': 'ch_1', 'amount': amount, 'amount_refunded': refunded,
            'metadata': {'userId': user, 'pack': pack},
        }},
    }


def credits_of(ddb, user='118260042345896138064'):
    return int(ddb.users.get(user, {}).get('purchasedCredits', {'N': '0'})['N'])


# ---------------------------------------------------------------------------
# Signature verification
# ---------------------------------------------------------------------------

d = use_ddb()
check('valid signature -> 200', app.handler(make_event(session_event()), None)['statusCode'], 200)

d = use_ddb()
check('wrong secret -> 400',
      app.handler(make_event(session_event(), secret='whsec_wrong'), None)['statusCode'], 400)
check('  nothing credited', credits_of(d), 0)

d = use_ddb()
check('missing signature header -> 400',
      app.handler({'headers': {}, 'body': json.dumps(session_event())}, None)['statusCode'], 400)

d = use_ddb()
check('body tampered after signing -> 400',
      app.handler(make_event(session_event(), tamper=True), None)['statusCode'], 400)

d = use_ddb()
check('replayed old timestamp -> 400',
      app.handler(make_event(session_event(), ts=int(time.time()) - 3600), None)['statusCode'], 400)

d = use_ddb()
check('future timestamp beyond tolerance -> 400',
      app.handler(make_event(session_event(), ts=int(time.time()) + 3600), None)['statusCode'], 400)

d = use_ddb()
check('base64 body verifies', app.handler(make_event(session_event(), b64=True), None)['statusCode'], 200)
check('  credited', credits_of(d), 500)

d = use_ddb()
check('malformed signature header -> 400',
      app.handler(make_event(session_event(), sig='garbage'), None)['statusCode'], 400)

d = use_ddb()
check('signature with no v1 -> 400',
      app.handler(make_event(session_event(), sig='t=123'), None)['statusCode'], 400)

# Rotation: several v1 entries, only the second valid.
payload = json.dumps(session_event()).encode()
ts = int(time.time())
good = sign(payload, SECRET, ts).split('v1=')[1]
d = use_ddb()
check('rotating secrets (2nd v1 matches) -> 200',
      app.handler(make_event(session_event(), sig=f't={ts},v1=deadbeef,v1={good}'),
                  None)['statusCode'], 200)

# Empty configured secret must never accept anything.
_saved, app.STRIPE_WEBHOOK_SECRET = app.STRIPE_WEBHOOK_SECRET, ''
d = use_ddb()
check('unset webhook secret rejects everything -> 400',
      app.handler(make_event(session_event(), secret=''), None)['statusCode'], 400)
app.STRIPE_WEBHOOK_SECRET = _saved

# ---------------------------------------------------------------------------
# Granting
# ---------------------------------------------------------------------------

d = use_ddb()
app.handler(make_event(session_event(pack='small', amount=499)), None)
check('small pack grants 500', credits_of(d), 500)

d = use_ddb()
app.handler(make_event(session_event(pack='large', amount=999)), None)
check('large pack grants 1500', credits_of(d), 1500)

d = use_ddb()
r = app.handler(make_event(session_event(pack='large', amount=499)), None)
check('amount/pack mismatch -> 500 (loud)', r['statusCode'], 500)
check('  nothing credited', credits_of(d), 0)

d = use_ddb()
r = app.handler(make_event(session_event(pack='enormous', amount=499)), None)
check('unknown pack -> 500 (loud, retryable)', r['statusCode'], 500)
check('  nothing credited', credits_of(d), 0)

d = use_ddb()
r = app.handler(make_event(session_event(status='unpaid')), None)
check('unpaid session -> 200 but no grant', r['statusCode'], 200)
check('  nothing credited', credits_of(d), 0)

d = use_ddb()
app.handler(make_event(session_event(status='unpaid')), None)
app.handler(make_event(session_event(event_id='evt_async', status='paid',
                                     etype='checkout.session.async_payment_succeeded')), None)
check('delayed payment settles later -> credited', credits_of(d), 500)

d = use_ddb()
r = app.handler(make_event(session_event(user=None)), None)
check('no client_reference_id -> 400 (unretryable)', r['statusCode'], 400)

d = use_ddb()
r = app.handler(make_event(session_event(user='../../etc/passwd')), None)
check('malformed userId rejected -> 400', r['statusCode'], 400)

d = use_ddb()
r = app.handler(make_event({'id': 'evt_x', 'type': 'invoice.paid', 'data': {'object': {}}}), None)
check('unhandled event type -> 200', r['statusCode'], 200)
check('  nothing credited', credits_of(d), 0)

# ---------------------------------------------------------------------------
# Idempotency — the reason the ledger exists
# ---------------------------------------------------------------------------

d = use_ddb()
first = app.handler(make_event(session_event(event_id='evt_dup')), None)
second = app.handler(make_event(session_event(event_id='evt_dup')), None)
check('redelivery -> 200 both times', (first['statusCode'], second['statusCode']), (200, 200))
check('  credited exactly once', credits_of(d), 500)
check('  second reports duplicate', second['body'], 'duplicate')

d = use_ddb()
for i in range(5):
    app.handler(make_event(session_event(event_id='evt_storm')), None)
check('5 redeliveries still credit once', credits_of(d), 500)

d = use_ddb()
app.handler(make_event(session_event(event_id='evt_a')), None)
app.handler(make_event(session_event(event_id='evt_b')), None)
check('distinct events both credit', credits_of(d), 1000)

# ---------------------------------------------------------------------------
# Refunds and disputes
# ---------------------------------------------------------------------------

d = use_ddb()
app.handler(make_event(session_event(event_id='evt_g')), None)
app.handler(make_event(charge_event(event_id='evt_r')), None)
check('full refund claws back all credits', credits_of(d), 0)

d = use_ddb()
app.handler(make_event(session_event(event_id='evt_g')), None)
r1 = app.handler(make_event(charge_event(event_id='evt_r')), None)
r2 = app.handler(make_event(charge_event(event_id='evt_r')), None)
check('refund redelivery -> 200 both', (r1['statusCode'], r2['statusCode']), (200, 200))
check('  revoked exactly once', credits_of(d), 0)

d = use_ddb()
app.handler(make_event(session_event(event_id='evt_g')), None)
app.handler(make_event(charge_event(event_id='evt_r', amount=499, refunded=250)), None)
check('partial refund claws back pro-rata', credits_of(d), 500 - int(500 * 250 / 499))

# User already spent most of the pack before refunding.
d = use_ddb()
app.handler(make_event(session_event(event_id='evt_g')), None)
d.users['118260042345896138064']['purchasedCredits'] = {'N': '3'}
r = app.handler(make_event(charge_event(event_id='evt_r')), None)
check('refund exceeding balance -> 200', r['statusCode'], 200)
check('  balance floors at 0, never negative', credits_of(d), 0)

d = use_ddb()
app.handler(make_event(session_event(event_id='evt_g')), None)
app.handler(make_event(charge_event(event_id='evt_d', etype='charge.dispute.created')), None)
check('dispute claws back credits', credits_of(d), 0)

d = use_ddb()
r = app.handler(make_event(charge_event(event_id='evt_r', user=None)), None)
check('refund without userId metadata -> 200 ignored', r['statusCode'], 200)

# ---------------------------------------------------------------------------
# Transient failures must be retryable
# ---------------------------------------------------------------------------

class Broken:
    def transact_write_items(self, TransactItems):
        raise RuntimeError('dynamodb unavailable')


app._ddb = Broken()
r = app.handler(make_event(session_event()), None)
check('DynamoDB down -> 500 so Stripe retries', r['statusCode'], 500)

use_ddb()
r = app.handler({'headers': {'Stripe-Signature': sign(b'not json')}, 'body': 'not json'}, None)
check('unparseable body -> 400', r['statusCode'], 400)

r = app.handler(make_event({'data': {'object': {}}}), None)
check('event missing id/type -> 400', r['statusCode'], 400)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
