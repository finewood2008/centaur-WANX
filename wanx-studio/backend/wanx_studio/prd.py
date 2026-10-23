"""Versioned, non-executable product requirements shared by interview and build."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

class PrdInput(BaseModel):
    model_config=ConfigDict(extra='forbid')

class Scenario(PrdInput):
    title: str = Field(min_length=1,max_length=160)
    actor: str = Field(default='',max_length=300)
    trigger: str = Field(default='',max_length=600)
    steps: list[str] = Field(default_factory=list)
    outcome: str = Field(default='',max_length=600)

class Feature(PrdInput):
    title: str = Field(min_length=1,max_length=160)
    description: str = Field(default='',max_length=1000)
    priority: Literal['must','later'] = 'must'

class PageBlock(PrdInput):
    title: str = Field(min_length=1,max_length=160)
    kind: Literal['list','form','summary','detail','actions']
    fields: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)

class PagePlan(PrdInput):
    name: str = Field(min_length=1,max_length=160)
    purpose: str = Field(default='',max_length=600)
    blocks: list[PageBlock] = Field(default_factory=list)

class DataField(PrdInput):
    name: str = Field(min_length=1,max_length=160)
    type: Literal['text','longText','number','date','status','boolean'] = 'text'
    required: bool = False
    description: str = Field(default='',max_length=600)
    example: str = Field(default='',max_length=300)

class AcceptanceCase(PrdInput):
    title: str = Field(min_length=1,max_length=160)
    given: str = Field(default='',max_length=600)
    when: str = Field(default='',max_length=600)
    then: str = Field(default='',max_length=600)

class ProductRequirement(PrdInput):
    version: Literal[1] = 1
    problem: str = Field(default='',max_length=2000)
    currentApproach: str = Field(default='',max_length=2000)
    successOutcome: str = Field(default='',max_length=2000)
    scenarios: list[Scenario] = Field(default_factory=list)
    features: list[Feature] = Field(default_factory=list)
    pages: list[PagePlan] = Field(default_factory=list)
    dataFields: list[DataField] = Field(default_factory=list)
    rules: list[str] = Field(default_factory=list)
    exceptions: list[str] = Field(default_factory=list)
    tests: list[AcceptanceCase] = Field(default_factory=list)
    outOfScope: list[str] = Field(default_factory=list)
    openQuestions: list[str] = Field(default_factory=list)

PRD_REVIEW_SECTIONS=['goal','flow','scope','pages','data','rules','acceptance']

def prd_missing(solution):
    prd=solution.get('prd')
    if prd is None:return []
    missing=[]
    for key in ('problem','currentApproach','successOutcome'):
        if not prd.get(key,'').strip():missing.append('prd.'+key)
    if not prd.get('scenarios') or any(not s.get('trigger','').strip() or not s.get('steps') or not s.get('outcome','').strip() for s in prd['scenarios']):missing.append('prd.scenarios')
    if not prd.get('features') or not any(f.get('priority')=='must' for f in prd['features']):missing.append('prd.features')
    if not prd.get('pages') or any(not page.get('blocks') for page in prd['pages']):missing.append('prd.pages')
    if set(solution['fields'])!={f['name'] for f in prd.get('dataFields',[])}:missing.append('prd.dataFields')
    if not prd.get('rules'):missing.append('prd.rules')
    if not prd.get('exceptions'):missing.append('prd.exceptions')
    if not prd.get('tests') or any(not all(t.get(k,'').strip() for k in ('given','when','then')) for t in prd['tests']):missing.append('prd.tests')
    if prd.get('openQuestions'):missing.append('prd.openQuestions')
    return missing
