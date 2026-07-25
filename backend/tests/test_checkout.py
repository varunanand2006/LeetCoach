"""Checkout session creation, and the contract between the two Lambdas.

The chat function decides what Stripe charges; the webhook decides how many
credits that buys and refuses to grant if the amount doesn't match its own
table. Those tables live in separate deployment packages and cannot import each
other, so this is where the drift gets caught.

Run from anywhere:  python backend/tests/test_checkout.py
"""
import json
import os
import sys
import types
import urllib.parse

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, os.path.join(_ROOT, 'backend'))
sys.path.insert(0, os.path.join(_ROOT, 'payments'))

_rc = types.ModuleType('runtime_client')
_rc.post_invocation_result = lambda *a, **k: None
sys.modules['runtime_client'] = _rc

os.environ['STRIPE_WEBHOOK_SECRET'] = 'whsec_test'

import lambda_function as chat  # noqa: E402
import app as webhook           # noqa: E402

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(f"PASS  {name}" if ok else f"FAIL  {name}\n        got={got!r} want={want!r}")


# ---------------------------------------------------------------------------
# The cross-package contract
# ---------------------------------------------------------------------------

check('both packages define the same pack ids',
      sorted(chat.CHECKOUT_PACKS), sorted(webhook.PACKS))

for pack_id in sorted(chat.CHECKOUT_PACKS):
    check(f'{pack_id}: price charged == price the webhook expects',
          chat.CHECKOUT_PACKS[pack_id]['amountCents'],
          webhook.PACKS[pack_id]['amountCents'])

for pack_id, cfg in webhook.PACKS.items():
    check(f'{pack_id}: grants a positive number of credits', cfg['credits'] > 0, True)


# ---------------------------------------------------------------------------
# Capture what we actually send to Stripe
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload


class FakeConn:
    """Stands in for http.client.HTTPSConnection and records the request."""
    last = None

    def __init__(self, host, timeout=None):
        FakeConn.last = self
        self.host = host
        self.sent = None
        self.closed = False
        self.status = 200
        self.payload = {'url': 'https://checkout.stripe.com/c/pay/cs_test_123'}

    def request(self, method, path, body=None, headers=None):
        self.sent = {'method': method, 'path': path,
                     'fields': dict(urllib.parse.parse_qsl(body or '')),
                     'headers': headers or {}}

    def getresponse(self):
        return FakeResponse(self.status, self.payload)

    def close(self):
        self.closed = True


chat.http.client.HTTPSConnection = FakeConn
chat.STRIPE_SECRET_KEY = 'sk_test_key'

USER = '118260042345896138064'
url = chat.create_checkout_session(USER, 'small')
sent = FakeConn.last.sent
fields = sent['fields']

check('returns the Stripe-hosted URL', url, 'https://checkout.stripe.com/c/pay/cs_test_123')
check('posts to the sessions endpoint', (sent['method'], sent['path']),
      ('POST', '/v1/checkout/sessions'))
check('talks to api.stripe.com', FakeConn.last.host, 'api.stripe.com')
check('connection is closed', FakeConn.last.closed, True)
check('form-encoded, not JSON', sent['headers']['Content-Type'],
      'application/x-www-form-urlencoded')
check('authenticates with the secret key', sent['headers']['Authorization'], 'Bearer sk_test_key')
check('pins the API version', sent['headers']['Stripe-Version'], chat.STRIPE_API_VERSION)

check('one-time payment, not a subscription', fields['mode'], 'payment')
check('client_reference_id carries the user', fields['client_reference_id'], USER)
check('charges the pack price',
      fields['line_items[0][price_data][unit_amount]'],
      str(chat.CHECKOUT_PACKS['small']['amountCents']))
check('quantity is 1', fields['line_items[0][quantity]'], '1')
check('session metadata names the pack', fields['metadata[pack]'], 'small')

# Refund and dispute events carry a charge, not a session — without metadata on
# the PaymentIntent the webhook cannot work out whose credits to claw back.
check('payment_intent metadata carries userId',
      fields['payment_intent_data[metadata][userId]'], USER)
check('payment_intent metadata carries pack',
      fields['payment_intent_data[metadata][pack]'], 'small')

check('success and cancel URLs are https',
      fields['success_url'].startswith('https://') and fields['cancel_url'].startswith('https://'),
      True)

chat.create_checkout_session(USER, 'large')
check('large pack charges the large price',
      FakeConn.last.sent['fields']['line_items[0][price_data][unit_amount]'],
      str(chat.CHECKOUT_PACKS['large']['amountCents']))

# Stripe errors must surface as a raised RuntimeError, never as a returned URL.
class ErrConn(FakeConn):
    def __init__(self, host, timeout=None):
        super().__init__(host, timeout)
        self.status = 402
        self.payload = {'error': {'message': 'Your card was declined.'}}


chat.http.client.HTTPSConnection = ErrConn
try:
    chat.create_checkout_session(USER, 'small')
    check('non-200 from Stripe raises', False, True)
except RuntimeError:
    check('non-200 from Stripe raises', True, True)


class NoUrlConn(FakeConn):
    def __init__(self, host, timeout=None):
        super().__init__(host, timeout)
        self.payload = {'id': 'cs_test_1'}  # 200 but no url


chat.http.client.HTTPSConnection = NoUrlConn
try:
    chat.create_checkout_session(USER, 'small')
    check('200 without a url raises', False, True)
except RuntimeError:
    check('200 without a url raises', True, True)

chat.http.client.HTTPSConnection = FakeConn


# ---------------------------------------------------------------------------
# End to end: does a session we create survive the webhook's checks?
# ---------------------------------------------------------------------------

class FakeDDB:
    def __init__(self):
        self.users = {}
        self.ledger = {}

    def transact_write_items(self, TransactItems):
        for op in TransactItems:
            if 'Put' in op:
                self.ledger[op['Put']['Item']['eventId']['S']] = op['Put']['Item']
            elif 'Update' in op:
                key = op['Update']['Key']['userId']['S']
                vals = op['Update']['ExpressionAttributeValues']
                row = self.users.setdefault(key, 0)
                if ':credits' in vals:
                    self.users[key] = row + int(vals[':credits']['N'])


for pack_id in sorted(chat.CHECKOUT_PACKS):
    chat.create_checkout_session(USER, pack_id)
    f = FakeConn.last.sent['fields']

    # Rebuild the checkout.session.completed object Stripe would send back for
    # exactly the session we just asked for.
    session_obj = {
        'id': 'cs_test_e2e',
        'client_reference_id': f['client_reference_id'],
        'payment_status': 'paid',
        'amount_total': int(f['line_items[0][price_data][unit_amount]']),
        'currency': f['line_items[0][price_data][currency]'],
        'metadata': {'pack': f['metadata[pack]']},
    }

    ddb = FakeDDB()
    webhook._ddb = ddb
    status, message = webhook.handle_grant(f'evt_{pack_id}', session_obj)

    check(f'{pack_id}: webhook accepts a session this Lambda created', status, 200)
    check(f'{pack_id}: grants the advertised credits',
          ddb.users.get(USER), webhook.PACKS[pack_id]['credits'])

    # And the refund path can find the user from the charge metadata.
    charge_obj = {
        'id': 'ch_e2e',
        'amount': int(f['line_items[0][price_data][unit_amount]']),
        'amount_refunded': int(f['line_items[0][price_data][unit_amount]']),
        'metadata': {'userId': f['payment_intent_data[metadata][userId]'],
                     'pack': f['payment_intent_data[metadata][pack]']},
    }
    status, _ = webhook.handle_revoke(f'evt_ref_{pack_id}', 'charge.refunded', charge_obj)
    check(f'{pack_id}: refund path resolves the user from charge metadata', status, 200)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
