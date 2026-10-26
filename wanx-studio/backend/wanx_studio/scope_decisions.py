"""Record accepted scope changes without deleting the original requirements."""
from copy import deepcopy
import time

from .contracts import StudioError, digest


def scope_state(p):
    prep = p['preparation']
    return {
        'dependencies': [{**d, 'decision': p['decisions'].get(d['id'])}
                         for d in p['solution']['dependencies']],
        'capabilityGaps': [{'id': digest(g), 'requirement': g,
                            'decision': prep.get('gapDecisions', {}).get(digest(g))}
                           for g in prep.get('gaps', [])],
    }


def apply_scope_decisions(p, decisions):
    """Validate the whole batch before changing either gate; never confirms a PRD."""
    if not isinstance(decisions, list) or len(decisions) > 100:
        raise StudioError('SCOPE_DECISION_INVALID')
    prep = p['preparation']
    pending = {t['operationId'] for t in prep['interview'].get('turns', [])
               if t['state'] in {'queued', 'paused'}}
    users = {m['id']: m for m in p['messages'] + prep.get('messages', [])
             if m['role'] == 'user' and m.get('text', '').strip()
             and m.get('operationId') not in pending}
    targets = {
        'dependency': {d['id']: d['requirement'] for d in p['solution']['dependencies']},
        'capability': {digest(g): g for g in prep.get('gaps', [])},
    }
    batch = []
    seen = set()
    for item in decisions:
        if not isinstance(item, dict) or set(item) != {'kind', 'id', 'choice', 'detail', 'sourceMessageId'}:
            raise StudioError('SCOPE_DECISION_INVALID')
        if not all(isinstance(v, str) and v.strip() for v in item.values()):
            raise StudioError('SCOPE_DECISION_INVALID')
        kind, key = item['kind'], item['id']
        if kind not in targets or key not in targets[kind] or (kind, key) in seen:
            raise StudioError('SCOPE_DECISION_INVALID')
        if item['choice'] not in {'manual', 'defer'} or len(item['detail']) > 4000:
            raise StudioError('SCOPE_DECISION_INVALID')
        if item['sourceMessageId'] not in users:
            raise StudioError('SCOPE_USER_DECISION_REQUIRED', 409)
        seen.add((kind, key))
        value = {k: item[k] for k in ('choice', 'detail', 'sourceMessageId')}
        value.update(source='user-message', solutionHash=digest(p['solution']))
        if kind == 'capability':
            value['requirement'] = targets[kind][key]
        old = p['decisions'].get(key) if kind == 'dependency' else prep.get('gapDecisions', {}).get(key)
        if old and all(old.get(k) == v for k, v in value.items()):
            continue
        batch.append((kind, key, value))
    for kind, key, value in batch:
        target = p['decisions'] if kind == 'dependency' else prep.setdefault('gapDecisions', {})
        target[key] = {**deepcopy(value), 'at': time.time()}
    if any(kind == 'capability' for kind, _, _ in batch):
        # Match the explicit capability-decision route: recheck supported
        # connections after a scope change; do not manufacture a passed report.
        prep['revision'] += 1
        prep['report'] = None
    return len(batch)
