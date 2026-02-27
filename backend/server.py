from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
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
    from deepface import DeepFace
    DEEPFACE_AVAILABLE = True
    print("[✓] DeepFace loaded — real emotion detection active")
except Exception as e:
    print(f"[✗] DeepFace not available: {e}")

# ── Try MediaPipe for fatigue / gaze / body actions ──────────────────────────
MEDIAPIPE_AVAILABLE = False
FACE_MESH = None

try:
    import mediapipe as mp
    try:
        import mediapipe.python.solutions.face_mesh as mp_face_mesh
        FACE_MESH = mp_face_mesh.FaceMesh(
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        MEDIAPIPE_AVAILABLE = True
        print("[✓] MediaPipe FaceMesh loaded")
    except ImportError:
        if hasattr(mp, "solutions"):
            FACE_MESH = mp.solutions.face_mesh.FaceMesh(
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            MEDIAPIPE_AVAILABLE = True
            print("[✓] MediaPipe FaceMesh loaded (standard path)")
except Exception as e:
    print(f"[✗] MediaPipe not available: {e}")

# ── State tracking for smoothing ─────────────────────────────────────────────
import math

last_known_emotion = "neutral"
last_known_emotion_conf = 0.5
consecutive_head_down = 0
consecutive_eyes_low = 0

# ── Haarcascade for face detection fallback ──────────────────────────────────
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")


def decode_image(data: bytes):
    try:
        arr = np.frombuffer(data, np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception as e:
        print(f"[WARN] decode_image: {e}")
        return None


# ── Health check ─────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "deepface": DEEPFACE_AVAILABLE,
        "mediapipe": MEDIAPIPE_AVAILABLE,
    }


# ── Face Analysis ────────────────────────────────────────────────────────────
@app.post("/analyze-face")
async def analyze_face(file: UploadFile = File(...)):
    raw = await file.read()
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _analyze_face_sync, raw)
    return result


def _analyze_face_sync(raw: bytes) -> dict:
    global last_known_emotion, last_known_emotion_conf
    global consecutive_head_down, consecutive_eyes_low

    img = decode_image(raw)
    if img is None:
        return {
            "fatigue_score": 0.1,
            "gaze_direction": "UNKNOWN",
            "distraction_score": 5.0,
            "blink_rate": 0.3,
            "emotion": last_known_emotion,
            "emotion_confidence": 0.3,
            "body_action": "unknown",
        }

    # Base values
    emotion = last_known_emotion
    emotion_conf = last_known_emotion_conf
    fatigue = 0.1
    gaze = "CENTER"
    distraction = 5.0
    blink_rate = 0.28
    body_action = "normal"  # normal, head_down, looking_up, head_tilt, stressed

    # ── Emotion via DeepFace ─────────────────────────────────────────────────
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
            detected_emotion = analysis.get("dominant_emotion", "neutral").lower()
            emotions_dict = analysis.get("emotion", {})
            detected_conf = round(emotions_dict.get(detected_emotion, 50) / 100, 2)

            # Only update if confidence is decent
            if detected_conf > 0.3:
                emotion = detected_emotion
                emotion_conf = detected_conf
                last_known_emotion = emotion
                last_known_emotion_conf = emotion_conf
        except Exception as e:
            # Keep last known emotion
            pass

    # ── Fatigue / Gaze / Body Actions via MediaPipe ──────────────────────────
    if MEDIAPIPE_AVAILABLE and FACE_MESH:
        try:
            img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            mesh = FACE_MESH.process(img_rgb)

            if mesh.multi_face_landmarks:
                lm = mesh.multi_face_landmarks[0].landmark

                # ── Eye Aspect Ratio (EAR) ───────────────────────────────────
                def ear(indices):
                    pts = np.array([[lm[i].x, lm[i].y] for i in indices])
                    A = np.linalg.norm(pts[1] - pts[5])
                    B = np.linalg.norm(pts[2] - pts[4])
                    C = np.linalg.norm(pts[0] - pts[3])
                    return (A + B) / (2.0 * C) if C > 0 else 0.25

                left_ear = ear([33, 7, 163, 144, 145, 153])
                right_ear = ear([362, 398, 384, 385, 387, 263])
                avg_ear = (left_ear + right_ear) / 2.0
                blink_rate = round(avg_ear, 3)

                # ── Head Pitch (Looking Down / Up) ───────────────────────────
                nose = lm[1]
                forehead = lm[10]
                chin = lm[152]
                face_h = abs(chin.y - forehead.y)
                nose_pos = (nose.y - forehead.y) / face_h if face_h > 0 else 0.5

                # Looking down: nose_pos > 0.62
                if nose_pos > 0.65:
                    consecutive_head_down += 1
                    body_action = "head_down"
                else:
                    consecutive_head_down = max(0, consecutive_head_down - 1)

                # Looking up: nose_pos < 0.42
                if nose_pos < 0.40:
                    body_action = "looking_up"

                pitch_fatigue = max(0, min(1, (nose_pos - 0.55) / 0.2))

                # ── EAR Fatigue ──────────────────────────────────────────────
                EAR_THRESH = 0.26
                ear_fatigue = max(0, min(1, (EAR_THRESH - avg_ear) / 0.1))

                if avg_ear < 0.22:
                    consecutive_eyes_low += 1
                else:
                    consecutive_eyes_low = max(0, consecutive_eyes_low - 1)

                # ── Roll/Tilt (Head Tilt = possible stress/fatigue) ──────────
                le = lm[33]
                re = lm[263]
                roll = math.degrees(math.atan2(re.y - le.y, re.x - le.x))
                roll_fatigue = min(abs(roll) / 18.0, 1.0)

                if abs(roll) > 15:
                    body_action = "head_tilt"

                # ── Combined Fatigue Score ───────────────────────────────────
                raw_fatigue = (
                    0.35 * pitch_fatigue
                    + 0.35 * ear_fatigue
                    + 0.15 * roll_fatigue
                    + 0.15 * min(consecutive_head_down / 5.0, 1.0)
                )
                fatigue = round(max(0.02, min(0.98, raw_fatigue)), 3)

                # ── Stressed Detection ───────────────────────────────────────
                # If fatigue is high AND head is down repeatedly → stressed
                if (
                    fatigue > 0.5
                    and consecutive_head_down > 3
                    and emotion in ["sad", "neutral", "fear"]
                ):
                    body_action = "stressed"

                # ── Emotion Fallback (if DeepFace failed) ────────────────────
                if not DEEPFACE_AVAILABLE:
                    mouth_w = abs(lm[291].x - lm[61].x)
                    mouth_h = abs(lm[14].y - lm[13].y)
                    m_ratio = mouth_h / mouth_w if mouth_w > 0 else 0

                    brow_y = (lm[107].y + lm[336].y) / 2
                    nose_bridge_y = lm[6].y
                    brow_dist = nose_bridge_y - brow_y

                    if m_ratio > 0.25:
                        emotion = "surprised"
                        emotion_conf = 0.8
                    elif m_ratio > 0.08 and mouth_w > 0.15:
                        emotion = "happy"
                        emotion_conf = 0.7
                    elif avg_ear < 0.22 or pitch_fatigue > 0.6:
                        emotion = "tired"
                        emotion_conf = 0.85
                    elif brow_dist < 0.02:
                        emotion = "sad"
                        emotion_conf = 0.6
                    else:
                        emotion = "neutral"
                        emotion_conf = 0.9

                    last_known_emotion = emotion
                    last_known_emotion_conf = emotion_conf

                # ── Gaze ─────────────────────────────────────────────────────
                nose_x = lm[1].x
                eye_x = (le.x + re.x) / 2
                if abs(eye_x - nose_x) < 0.03:
                    gaze = "CENTER"
                elif eye_x > nose_x:
                    gaze = "RIGHT"
                else:
                    gaze = "LEFT"

                # ── Distraction Score ────────────────────────────────────────
                raw_distraction = 0.0
                if gaze != "CENTER":
                    raw_distraction += 40.0
                if pitch_fatigue > 0.5:
                    raw_distraction += 20.0
                if abs(roll) > 12:
                    raw_distraction += 15.0
                if body_action == "head_down" and consecutive_head_down > 3:
                    raw_distraction += 10.0

                distraction = round(max(2.0, min(95.0, raw_distraction)), 2)

        except Exception as e:
            print(f"[WARN] MediaPipe analysis error: {e}")

    return {
        "fatigue_score": fatigue,
        "gaze_direction": gaze,
        "distraction_score": distraction,
        "blink_rate": blink_rate,
        "emotion": emotion,
        "emotion_confidence": emotion_conf,
        "body_action": body_action,
    }


# ── Screen Analysis (Real CV-based) ─────────────────────────────────────────
@app.post("/analyze-screen")
async def analyze_screen(file: UploadFile = File(...)):
    raw = await file.read()
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _analyze_screen_sync, raw)
    return result


def _analyze_screen_sync(raw: bytes) -> dict:
    img = decode_image(raw)
    if img is None:
        return {"activity": "UNKNOWN", "distraction_score": 10.0}

    # Resize for faster processing
    h, w = img.shape[:2]
    if w > 640:
        scale = 640 / w
        img = cv2.resize(img, (640, int(h * scale)))

    # ── Color Analysis ───────────────────────────────────────────────────────
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Average brightness
    avg_brightness = np.mean(gray)

    # Color variance (high = colorful content like videos/social media)
    color_std = np.std(hsv[:, :, 1])  # saturation variance

    # ── Edge Density (text indicator) ────────────────────────────────────────
    edges = cv2.Canny(gray, 50, 150)
    edge_density = np.sum(edges > 0) / edges.size

    # ── Dark Background Detection (IDE/code editor) ──────────────────────────
    dark_pixels = np.sum(gray < 50) / gray.size
    is_dark_bg = dark_pixels > 0.4

    # ── Large Uniform Regions (video player) ─────────────────────────────────
    blur = cv2.GaussianBlur(gray, (21, 21), 0)
    uniform_score = 1.0 - (np.std(blur) / 128.0)

    # ── Classification Logic ─────────────────────────────────────────────────
    activity = "BROWSING"
    distraction = 15.0

    if is_dark_bg and edge_density > 0.08:
        activity = "CODING"
        distraction = 3.0
    elif edge_density > 0.12:
        activity = "READING"
        distraction = 8.0
    elif uniform_score > 0.85 and color_std > 40:
        activity = "WATCHING"
        distraction = 45.0
    elif color_std > 50 and edge_density < 0.06:
        activity = "SOCIAL_MEDIA"
        distraction = 60.0
    elif avg_brightness < 30 and edge_density < 0.03:
        activity = "IDLE"
        distraction = 20.0

    return {
        "activity": activity,
        "distraction_score": round(distraction, 2),
    }
