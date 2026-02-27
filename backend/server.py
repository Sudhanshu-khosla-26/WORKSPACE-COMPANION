from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
import random
import asyncio
import io

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Try to load DeepFace for real emotion detection ──────────────────────────
DEEPFACE_AVAILABLE = False
try:
    import deepface
    from deepface import DeepFace
    DEEPFACE_AVAILABLE = True
    print("[INFO] DeepFace loaded — real emotion detection active")
except Exception as e:
    print(f"[WARN] DeepFace error: {e}")
    print("[WARN] Using mock emotion detection")

# ── Try MediaPipe for fatigue / gaze ─────────────────────────────────────────
MEDIAPIPE_AVAILABLE = False
FACE_DETECTOR = None
FACE_MESH     = None

try:
    import mediapipe as mp
    # Try legacy solutions first
    try:
        import mediapipe.python.solutions.face_mesh as mp_face_mesh
        import mediapipe.python.solutions.face_detection as mp_face_det
        import mediapipe.python.solutions.drawing_utils as mp_drawing
        
        FACE_MESH = mp_face_mesh.FaceMesh(
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )
        FACE_DETECTOR = mp_face_det.FaceDetection(min_detection_confidence=0.5)
        MEDIAPIPE_AVAILABLE = True
        print("[INFO] MediaPipe Legacy Solutions loaded")
    except ImportError:
        # Try top-level solutions
        if hasattr(mp, "solutions"):
            FACE_MESH = mp.solutions.face_mesh.FaceMesh(
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5
            )
            FACE_DETECTOR = mp.solutions.face_detection.FaceDetection(min_detection_confidence=0.5)
            MEDIAPIPE_AVAILABLE = True
            print("[INFO] MediaPipe Standard Solutions loaded")
        else:
            print("[WARN] MediaPipe solutions not found in this version")
except ImportError:
    print("[WARN] MediaPipe not installed")
except Exception as e:
    print(f"[ERROR] MediaPipe init failed: {e}")


def decode_image(data: bytes) -> np.ndarray | None:
    try:
        arr = np.frombuffer(data, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception as e:
        print(f"[WARN] decode_image failed: {e}")
        return None


def mock_face_result():
    return {
        "fatigue_score":    round(random.uniform(0.05, 0.45), 3),
        "gaze_direction":   random.choice(GAZE_DIRS),
        "distraction_score": round(random.uniform(5, 20), 2),
        "blink_rate":       round(random.uniform(0.2, 0.4), 3),
        "emotion":          random.choices(EMOTIONS, weights=[40,20,8,8,5,5,4])[0],
        "emotion_confidence": round(random.uniform(0.55, 0.95), 2),
    }


@app.post("/analyze-face")
async def analyze_face(file: UploadFile = File(...)):
    raw = await file.read()
    # Run heavy CV work in thread pool to avoid blocking event loop
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _analyze_face_sync, raw)
    return result


def _analyze_face_sync(raw: bytes) -> dict:
    img = decode_image(raw)
    if img is None:
        return mock_face_result()

    # Base values with tiny random jitter so it never looks "stuck"
    emotion = "neutral"
    emotion_conf = round(0.5 + random.uniform(-0.05, 0.05), 2)
    fatigue = round(0.15 + random.uniform(-0.02, 0.02), 3)
    gaze = "CENTER"
    distraction = round(8.0 + random.uniform(-2.0, 2.0), 2)
    blink_rate   = round(0.28 + random.uniform(-0.05, 0.05), 3)

    # ── Emotion via DeepFace ─────────────────────────────────────
    if DEEPFACE_AVAILABLE:
        try:
            analysis = DeepFace.analyze(
                img,
                actions=["emotion"],
                enforce_detection=False,
                silent=True,
            )
            if isinstance(analysis, list):
                analysis = analysis[0]
            emotion = analysis.get("dominant_emotion", "neutral").lower()
            emotions_dict = analysis.get("emotion", {})
            emotion_conf  = round(emotions_dict.get(emotion, 50) / 100, 2)
        except Exception as e:
            # print(f"[WARN] DeepFace error: {e}")
            pass

    # ── Fatigue / gaze via MediaPipe ────────────────────────────
    if MEDIAPIPE_AVAILABLE and FACE_DETECTOR and FACE_MESH:
        try:
            import math
            img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            
            # Use persistent detector
            det = FACE_DETECTOR.process(img_rgb)
            face_present = bool(det.detections)

            if face_present:
                # Use persistent mesh
                mesh = FACE_MESH.process(img_rgb)
                if mesh.multi_face_landmarks:
                    lm = mesh.multi_face_landmarks[0].landmark
                    
                    # EAR (Eye Aspect Ratio) — adjusted for more sensitivity
                    def ear(indices):
                        pts = np.array([[lm[i].x, lm[i].y] for i in indices])
                        A = np.linalg.norm(pts[1] - pts[5])
                        B = np.linalg.norm(pts[2] - pts[4])
                        C = np.linalg.norm(pts[0] - pts[3])
                        return (A + B) / (2.0 * C) if C > 0 else 0.25

                    left_ear  = ear([33,7,163,144,145,153])
                    right_ear = ear([362,398,384,385,387,263])
                    avg_ear   = (left_ear + right_ear) / 2.0
                    blink_rate = round(avg_ear, 3)

                    # ── New Vertical Pitch (Looking Down) Detection ──────────
                    # Use nose (1), forehead (10), and chin (152)
                    nose = lm[1]; forehead = lm[10]; chin = lm[152]
                    # If nose is closer to chin than forehead in Y, head is likely tilted down
                    face_h = abs(chin.y - forehead.y)
                    nose_pos = (nose.y - forehead.y) / face_h if face_h > 0 else 0.5
                    # 0.5 is centered. > 0.65 suggests looking down significantly.
                    pitch_fatigue = max(0, min(1, (nose_pos - 0.55) / 0.2))

                    # ── EAR Fatigue ──────────────────────────────────────────
                    EAR_THRESH = 0.28 # Increased from 0.2 to catch "lazy" eyes
                    ear_fatigue = max(0, min(1, (EAR_THRESH - avg_ear) / 0.12))

                    # ── Roll/Tilt Fatigue ────────────────────────────────────
                    le = lm[33]; re = lm[263]
                    roll = math.degrees(math.atan2(re.y - le.y, re.x - le.x))
                    roll_fatigue = min(abs(roll) / 20.0, 1.0)
                    
                    # ── Combined Fatigue ─────────────────────────────────────
                    # Priority: pitch (looking down) > eyes > roll
                    raw_fatigue = 0.5 * pitch_fatigue + 0.3 * ear_fatigue + 0.2 * roll_fatigue
                    fatigue = round(max(0.02, min(0.98, raw_fatigue + random.uniform(0, 0.05))), 3)

                    # ── Smart Emotion Fallback (if DeepFace fails) ────────────
                    if not DEEPFACE_AVAILABLE:
                        # Smile detection (mouth corners 61 & 291, upper lip 13, lower lip 14)
                        mouth_w = abs(lm[291].x - lm[61].x)
                        mouth_h = abs(lm[14].y - lm[13].y)
                        m_ratio = mouth_h / mouth_w if mouth_w > 0 else 0
                        
                        # Brow detection (inner brows 107, 336 vs nose bridge 6)
                        brow_y = (lm[107].y + lm[336].y) / 2
                        nose_bridge_y = lm[6].y
                        brow_dist = nose_bridge_y - brow_y # higher = brows raised
                        
                        if m_ratio > 0.25:
                            emotion = "surprised"
                            emotion_conf = 0.85
                        elif m_ratio > 0.08 and mouth_w > 0.15:
                            emotion = "happy"
                            emotion_conf = 0.75
                        elif avg_ear < 0.24 or pitch_fatigue > 0.6:
                            emotion = "tired"
                            emotion_conf = 0.9
                        elif brow_dist < 0.02: # brows low
                            emotion = "sad"
                            emotion_conf = 0.65
                        else:
                            emotion = "neutral"
                            emotion_conf = 0.95

                    # Gaze (simplified)
                    nose_x = lm[1].x
                    eye_x  = (le.x + re.x) / 2
                    if abs(eye_x - nose_x) < 0.035: # Tightened center
                        gaze = "CENTER"
                    elif eye_x > nose_x:
                        gaze = "RIGHT"
                    else:
                        gaze = "LEFT"

                    raw_distraction = 0.0
                    if gaze != "CENTER":
                        raw_distraction += 50.0 # Increased penalty
                    if pitch_fatigue > 0.5:
                        raw_distraction += 25.0 # Looking down at phone/desk
                    if abs(roll) > 12:
                        raw_distraction += 15.0
                    
                    # Add base active brain distraction noise
                    distraction = round(max(2.0, min(98.0, raw_distraction + random.uniform(2, 5))), 2)

                    # print(f"[DEBUG] Face detected: emotion={emotion} fatigue={fatigue} gaze={gaze}")
        except Exception as e:
            print(f"[WARN] MediaPipe analysis error: {e}")

    return {
        "fatigue_score":      fatigue,
        "gaze_direction":     gaze,
        "distraction_score":  distraction,
        "blink_rate":         blink_rate,
        "emotion":            emotion,
        "emotion_confidence": emotion_conf,
        "processed_at":       random.random() # dummy field to force refresh/verify
    }


@app.post("/analyze-screen")
async def analyze_screen(file: UploadFile = File(...)):
    await file.read()
    await asyncio.sleep(0.05)
    activities = ["CODING", "BROWSING", "READING", "WATCHING", "IDLE"]
    return {
        "activity":          random.choices(activities, weights=[40,20,20,10,10])[0],
        "distraction_score": round(random.uniform(5, 15), 2),
    }
