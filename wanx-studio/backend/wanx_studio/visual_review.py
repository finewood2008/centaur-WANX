"""Bounded, version-bound visual instructions for a UI-only build."""
import base64
import binascii
import struct

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .contracts import StudioError, digest
from .versions import source_artifact, state, verify


class Region(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(ge=.01, le=1)
    height: float = Field(ge=.01, le=1)

    @model_validator(mode='after')
    def bounded(self):
        if self.x+self.width>1.000001 or self.y+self.height>1.000001:
            raise ValueError('region outside screenshot')
        return self


class Viewport(BaseModel):
    model_config = ConfigDict(extra='forbid')
    width: int = Field(ge=20, le=16384)
    height: int = Field(ge=20, le=16384)


class VisualReview(BaseModel):
    model_config = ConfigDict(extra='forbid')
    baseHash: str = Field(pattern=r'^[a-f0-9]{64}$')
    expectedRevision: int = Field(ge=0)
    image: str = Field(max_length=1400000)
    viewport: Viewport
    regions: list[Region] = Field(min_length=1, max_length=6)

    @model_validator(mode='after')
    def png(self):
        try:
            if not self.image.startswith('data:image/png;base64,'):raise ValueError()
            data=base64.b64decode(self.image[22:], validate=True)
            if len(data)>1024*1024 or len(data)<33 or data[:8]!=b'\x89PNG\r\n\x1a\n' or data[12:16]!=b'IHDR':raise ValueError()
            w,h=struct.unpack('>II',data[16:24])
            if not (20<=w<=1600 and 20<=h<=1600):raise ValueError()
        except (ValueError,binascii.Error,struct.error):
            raise ValueError('invalid preview PNG') from None
        return self


def authorize_visual(p, value):
    try:review=VisualReview.model_validate(value).model_dump()
    except ValueError:raise StudioError('VISUAL_REVIEW_INVALID',422) from None
    from .iterative import baseline
    base=source_artifact(p,review['baseHash']);verify(base)
    if review['expectedRevision']!=state(p)['revision'] or not baseline(p) or baseline(p)['hash']!=base['hash'] or digest(p['solution'])!=base['solutionHash']:
        raise StudioError('VISUAL_REVIEW_STALE',409)
    return review
