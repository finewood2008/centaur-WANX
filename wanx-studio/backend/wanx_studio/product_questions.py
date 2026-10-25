"""Initial discovery questions; the direct-edit coordinator keeps its own flow."""
import re
from uuid import uuid4
from .contracts import StudioError


def add_question(project, args):
    if (set(args) != {'text','why','options'} or
        not isinstance(args['text'],str) or not args['text'].strip() or
        not isinstance(args['why'],str) or
        not isinstance(args['options'],list) or not 2 <= len(args['options']) <= 4 or
        any(not isinstance(o,str) or not o.strip() for o in args['options'])):
        raise StudioError('QUESTION_INVALID')
    state=project['preparation']['interview']
    if project['artifacts']:
        state['question']={'focus':'context',**args}
        return
    options=[]
    for option in args['options']:
        title,separator,detail=option.partition('｜')
        recommended=bool(re.search(r'[（(]推荐[）)]\s*$',title))
        title=re.sub(r'[（(]推荐[）)]\s*$','',title).strip()
        options.append((title,separator+detail,recommended))
    preferred=next((i for i,item in enumerate(options) if item[2]),0)
    options.insert(0,options.pop(preferred))
    values=[title+('（推荐）' if i==0 else '')+detail for i,(title,detail,_) in enumerate(options)]
    questions=state.setdefault('questions',[])
    existing=next((q for q in questions if q['text']==args['text']),None)
    if existing:
        existing.update(why=args['why'],options=values)
    elif len(questions)>=3:
        raise StudioError('QUESTION_BATCH_FULL',409)
    else:
        questions.append({'id':uuid4().hex,'focus':'context','text':args['text'],'why':args['why'],'options':values})
    # Old clients can still render the first question.
    state['question']={k:v for k,v in questions[0].items() if k!='id'}


def pending_choices(project):
    if project['artifacts']:
        return False
    last=project['messages'][-1] if project['messages'] else {}
    return last.get('role')=='assistant' and bool(last.get('questions'))
