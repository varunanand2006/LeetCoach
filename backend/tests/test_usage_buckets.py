"""Exercises the two-bucket spend logic against a fake table that actually
evaluates the ConditionExpressions the real code relies on.

Run from anywhere:  python backend/tests/test_usage_buckets.py
No AWS credentials or network needed — DynamoDB and the Lambda runtime are faked.
"""
import sys, os, re, datetime, types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# runtime_client is the Lambda runtime's C extension — absent off-Lambda.
_rc = types.ModuleType('runtime_client')
_rc.post_invocation_result = lambda *a, **k: None
sys.modules['runtime_client'] = _rc


class CCF(Exception):
    def __init__(self):
        self.response = {'Error': {'Code': 'ConditionalCheckFailedException'}}


class FakeTable:
    """Enough DynamoDB to be honest about conditions and ADD/SET semantics."""

    def __init__(self, item=None):
        self.item = dict(item) if item else None
        self.writes = 0

    def get_item(self, Key):
        return {'Item': dict(self.item)} if self.item is not None else {}

    def _cond(self, expr, item, vals):
        if not expr:
            return True
        for clause in expr.split(' OR '):
            c = clause.strip()
            m = re.fullmatch(r'attribute_not_exists\((\w+)\)', c)
            if m:
                if item is None or m.group(1) not in item:
                    return True
                continue
            m = re.fullmatch(r'(\w+) (<=|>=|<>) (:\w+)', c)
            if m:
                attr, op, ref = m.groups()
                if item is None or attr not in item:
                    continue  # comparison on a missing attribute is false in DDB
                a, b = item[attr], vals[ref]
                if (op == '<=' and a <= b) or (op == '>=' and a >= b) or (op == '<>' and a != b):
                    return True
                continue
            raise AssertionError(f'unparsed condition clause: {c!r}')
        return False

    def put_item(self, Item, ConditionExpression=None):
        if not self._cond(ConditionExpression, self.item, {}):
            raise CCF()
        self.item = dict(Item)
        self.writes += 1

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues,
                    ConditionExpression=None):
        vals = ExpressionAttributeValues
        if not self._cond(ConditionExpression, self.item, vals):
            raise CCF()
        item = self.item if self.item is not None else {}
        set_part = re.search(r'SET (.*?)(?: ADD |$)', UpdateExpression)
        add_part = re.search(r'ADD (.*)$', UpdateExpression)
        if set_part:
            for a in set_part.group(1).split(','):
                k, v = a.split('=')
                item[k.strip()] = vals[v.strip()]
        if add_part:
            for a in add_part.group(1).split(','):
                k, v = a.strip().split(' ')
                item[k] = item.get(k, 0) + vals[v]
        self.item = item
        self.writes += 1


import lambda_function as L
L.ClientError = CCF

FREE, PAID, NONE = L.BUCKET_FREE, L.BUCKET_PAID, L.BUCKET_NONE
MON = L.get_week_start()
results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}\n        got={got!r} want={want!r}" if not ok
          else f"PASS  {name}")


def row(**kw):
    base = {'userId': 'u', 'weeklyRequests': 0, 'totalRequests': 0, 'weekStartDate': MON}
    base.update(kw)
    return base


def with_table(item):
    t = FakeTable(item)
    L._table = t
    return t


# 1. Plain free-tier spend
t = with_table(row(weeklyRequests=10))
check('free spend returns FREE', L.check_and_update_usage('u', 1), FREE)
check('  weekly incremented', t.item['weeklyRequests'], 11)
check('  credits untouched', 'purchasedCredits' in t.item, False)

# 2. Free exhausted, no credits -> denied
t = with_table(row(weeklyRequests=100))
check('exhausted + no credits -> None', L.check_and_update_usage('u', 1), None)

# 3. Free exhausted, credits available -> PAID
t = with_table(row(weeklyRequests=100, purchasedCredits=50))
check('exhausted + credits -> PAID', L.check_and_update_usage('u', 1), PAID)
check('  credit debited', t.item['purchasedCredits'], 49)
check('  weekly NOT incremented', t.item['weeklyRequests'], 100)

# 4. Free tier is spent before credits even when credits exist
t = with_table(row(weeklyRequests=10, purchasedCredits=50))
check('free spent before credits', L.check_and_update_usage('u', 1), FREE)
check('  credits still 50', t.item['purchasedCredits'], 50)

# 5. Review (cost 5) that does not fit the weekly remainder falls to credits whole
t = with_table(row(weeklyRequests=98, purchasedCredits=50))
check('cost 5 over remainder -> PAID', L.check_and_update_usage('u', 5), PAID)
check('  credits -5', t.item['purchasedCredits'], 45)
check('  weekly unchanged (no split)', t.item['weeklyRequests'], 98)

# 6. Cost 5 with only 4 credits -> denied, nothing moves
t = with_table(row(weeklyRequests=100, purchasedCredits=4))
check('cost 5 vs 4 credits -> None', L.check_and_update_usage('u', 5), None)
check('  credits untouched', t.item['purchasedCredits'], 4)

# 7. Diagram (cost 2) exactly covered by 2 credits
t = with_table(row(weeklyRequests=100, purchasedCredits=2))
check('cost 2 vs exactly 2 credits -> PAID', L.check_and_update_usage('u', 2), PAID)
check('  credits now 0', t.item['purchasedCredits'], 0)

# 8. THE REGRESSION THIS WHOLE DESIGN EXISTS FOR:
#    Monday rollover must not destroy purchased credits.
t = with_table(row(weeklyRequests=100, purchasedCredits=40, weekStartDate='2000-01-03'))
check('new week -> FREE', L.check_and_update_usage('u', 1), FREE)
check('  weekly reset to cost', t.item['weeklyRequests'], 1)
check('  CREDITS SURVIVED RESET', t.item['purchasedCredits'], 40)

# 9. Brand-new user
t = with_table(None)
check('new user -> FREE', L.check_and_update_usage('u', 1), FREE)
check('  row created', t.item['weeklyRequests'], 1)

# 10. Row created by the webhook (credits only, no usage fields)
t = with_table({'userId': 'u', 'purchasedCredits': 100})
check('webhook-created row -> FREE', L.check_and_update_usage('u', 1), FREE)
check('  free charged not credits', t.item['purchasedCredits'], 100)
check('  weekly seeded', t.item['weeklyRequests'], 1)

# 11. Unauthenticated / fail-open charge nothing
t = with_table(row())
check('no user -> NONE', L.check_and_update_usage(None, 1), NONE)


class Boom(FakeTable):
    def get_item(self, Key):
        raise RuntimeError('dynamo down')


L._table = Boom(row())
check('dynamo down -> NONE (fails open)', L.check_and_update_usage('u', 1), NONE)

# --- Refunds land in the bucket that was charged ---------------------------

t = with_table(row(weeklyRequests=10, totalRequests=10, purchasedCredits=50))
L.refund_usage('u', 5, FREE)
check('FREE refund -> weekly back', t.item['weeklyRequests'], 5)
check('  credits untouched by free refund', t.item['purchasedCredits'], 50)

t = with_table(row(weeklyRequests=100, totalRequests=100, purchasedCredits=45))
L.refund_usage('u', 5, PAID)
check('PAID refund -> credits back', t.item['purchasedCredits'], 50)
check('  weekly untouched by paid refund', t.item['weeklyRequests'], 100)
check('  totalRequests decremented', t.item['totalRequests'], 95)

t = with_table(row(weeklyRequests=10, totalRequests=10, purchasedCredits=50))
L.refund_usage('u', 5, NONE)
check('NONE refund is a no-op (weekly)', t.item['weeklyRequests'], 10)
check('NONE refund is a no-op (credits)', t.item['purchasedCredits'], 50)

t = with_table(row(weeklyRequests=2, totalRequests=2))
L.refund_usage('u', 5, FREE)
check('refund cannot drive weekly negative', t.item['weeklyRequests'], 2)

# Round trip: charge then refund restores the exact starting state
for label, start, cost in [
    ('free', row(weeklyRequests=10, totalRequests=10, purchasedCredits=7), 2),
    ('paid', row(weeklyRequests=100, totalRequests=100, purchasedCredits=7), 5),
]:
    t = with_table(start)
    before = dict(t.item)
    bucket = L.check_and_update_usage('u', cost)
    L.refund_usage('u', cost, bucket)
    after = {k: t.item[k] for k in before if k != 'lastSeen'}
    check(f'{label} charge+refund round-trips ({bucket})',
          after, {k: v for k, v in before.items() if k != 'lastSeen'})

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
