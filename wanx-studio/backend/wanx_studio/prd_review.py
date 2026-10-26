"""The initial PRD stays a draft until its current interview is complete."""
from .contracts import digest
def review_missing(p, impact_hash):
    if p['artifacts'] or 'preparation' not in p:
        return []
    x=p['preparation'];s=x['interview'];missing=[]
    if x.get('phase')!='acp':return []
    settled=s.get('state')=='completed' or (s.get('state')=='idle' and bool(s.get('turns')) and all(t.get('state')=='completed' for t in s['turns']))
    if x['phase']!='acp' or not settled or s.get('sync')!='saved':
        missing.append('产品经理正在完善和核对本轮 PRD')
    if any(t.get('state') in {'queued','paused','running'} for t in s.get('turns',[])):
        missing.append('还有用户反馈尚未整理')
    # Already confirmed documents remain usable; unconfirmed drafts need a
    # version-bound AI assessment, including documents made before this protocol.
    if p.get('confirmation',{} ) and p['confirmation'].get('hash')==digest(p['solution']):return missing
    review=s.get('prdReview') or {}
    if review.get('impactHash')!=impact_hash or review.get('contextRevision')!=x.get('contextRevision'):
        missing.append('产品经理尚未完成信息完备性检查')
    return missing
