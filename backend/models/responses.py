from enum import Enum
from pydantic import BaseModel

class GazeDirection(str, Enum):
    UNKNOWN = "UNKNOWN"
    CENTER = "CENTER"
    LEFT = "LEFT"
    RIGHT = "RIGHT"

class ContentType(str, Enum):
    UNKNOWN = "UNKNOWN"
    CODING = "CODING"
    EDUCATIONAL = "EDUCATIONAL"
    ENTERTAINMENT = "ENTERTAINMENT"
    DOCUMENTATION = "DOCUMENTATION"

class FaceAnalysisResponse(BaseModel):
    face_present: bool
    blink_rate: float
    gaze_direction: GazeDirection
    head_tilt: float
    fatigue_score: float
    processing_time_ms: float = 0.0

class ScreenAnalysisResponse(BaseModel):
    content_type: ContentType
    text_density: float
    has_code: bool
    has_social_indicator: bool
    distraction_score: float
    processing_time_ms: float = 0.0
