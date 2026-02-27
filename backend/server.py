"""
Buddy Backend — Zero TensorFlow
Emotion detection via MediaPipe face landmarks (mouth ratio, brow distance, EAR).
Body action via head pose estimation.
Screen analysis via OpenCV histogram/edge detection.
"""
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
import asyncio
import math
import tempfile
import os
from collections import deque

import json
import os

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── MediaPipe Tasks API ──────────────────────────────────────────────────────
MEDIAPIPE_OK = False
face_detector = None
try:
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision
    
    model_path = os.path.join(os.path.dirname(__file__), 'face_landmarker.task')
    if os.path.exists(model_path):
        base_options = python.BaseOptions(model_asset_path=model_path)
        options = vision.FaceLandmarkerOptions(
            base_options=base_options,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
            num_faces=1
        )
        face_detector = vision.FaceLandmarker.create_from_options(options)
        MEDIAPIPE_OK = True
        print("[✓] MediaPipe FaceLandmarker loaded")
    else:
        print("[✗] MediaPipe: face_landmarker.task model missing")
except Exception as e:
    print(f"[✗] MediaPipe: {e}")

# ── Load Calibration ─────────────────────────────────────────────────────────
calib_path = os.path.join(os.path.dirname(__file__), 'calibration.json')
CALIB = {}
if os.path.exists(calib_path):
    try:
        with open(calib_path, "r") as f:
            CALIB = json.load(f)
        print("[✓] Calibration loaded")
    except Exception as e:
        print(f"[WARN] Calibration load failed: {e}")


# ── Haar cascade fallback for face detection ─────────────────────────────────
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

# ── Smoothing state ──────────────────────────────────────────────────────────
prev_emotion = "neutral"
prev_conf = 0.5
head_down_n = 0
eyes_low_n = 0

# Rolling window for gaze (10 readings = ~5 seconds at 2fps)
gaze_history = deque(maxlen=10)
distraction_history = deque(maxlen=10)

# ── Speech Recognition ───────────────────────────────────────────────────────
SR_AVAILABLE = False
try:
    import speech_recognition as sr
    SR_AVAILABLE = True
    print("[✓] SpeechRecognition loaded")
except Exception as e:
    print(f"[✗] SpeechRecognition: {e}")


def decode(data: bytes):
    arr = np.frombuffer(data, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


@app.get("/health")
async def health():
    return {"status": "ok", "mediapipe": MEDIAPIPE_OK, "speech": SR_AVAILABLE}


# ═══════════════════════════════════════════════════════════════════════════════
# AUDIO TRANSCRIPTION (fallback for Electron / mobile Safari)
# ═══════════════════════════════════════════════════════════════════════════════
@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if not SR_AVAILABLE:
        return {"text": "", "error": "SpeechRecognition not installed"}

    raw = await file.read()
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _transcribe, raw, file.filename or "audio.webm")


def _transcribe(raw: bytes, filename: str) -> dict:
    try:
        recognizer = sr.Recognizer()
        recognizer.energy_threshold = 300
        recognizer.dynamic_energy_threshold = True

        # Save to temp file
        ext = os.path.splitext(filename)[1] or ".webm"
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
            f.write(raw)
            tmp_path = f.name

        try:
            # Convert to WAV if needed (pydub handles webm/ogg/mp3)
            wav_path = tmp_path
            if ext != ".wav":
                try:
                    from pydub import AudioSegment
                    audio = AudioSegment.from_file(tmp_path)
                    wav_path = tmp_path + ".wav"
                    audio.export(wav_path, format="wav")
                except Exception:
                    # If pydub fails, try direct
                    wav_path = tmp_path

            with sr.AudioFile(wav_path) as source:
                audio_data = recognizer.record(source)

            # Try Hindi first, then English
            text = ""
            try:
                text = recognizer.recognize_google(audio_data, language="hi-IN")
            except sr.UnknownValueError:
                try:
                    text = recognizer.recognize_google(audio_data, language="en-US")
                except sr.UnknownValueError:
                    text = ""

            print(f"[Transcribe] → '{text}'")
            return {"text": text.strip(), "error": None}

        finally:
            try: os.unlink(tmp_path)
            except: pass
            if wav_path != tmp_path:
                try: os.unlink(wav_path)
                except: pass

    except Exception as e:
        print(f"[Transcribe] error: {e}")
        return {"text": "", "error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# FACE ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════
@app.post("/analyze-face")
async def analyze_face(file: UploadFile = File(...)):
    raw = await file.read()
    return await asyncio.get_event_loop().run_in_executor(None, _face, raw)


def _face(raw: bytes) -> dict:
    global prev_emotion, prev_conf, head_down_n, eyes_low_n

    img = decode(raw)
    if img is None:
        return _default()

    emotion = prev_emotion
    conf = prev_conf
    fatigue = 0.05
    gaze = "CENTER"
    distraction = 5.0
    blink = 0.28
    action = "normal"

    if not MEDIAPIPE_OK or not face_detector:
        # Haar cascade fallback — just detect face presence
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, 1.3, 5)
        if len(faces) == 0:
            action = "no_face"
            distraction = 60.0
        return {
            "fatigue_score": fatigue, "gaze_direction": gaze,
            "distraction_score": distraction, "blink_rate": blink,
            "emotion": emotion, "emotion_confidence": conf,
            "body_action": action,
        }

    # ── MediaPipe analysis ───────────────────────────────────────────────────
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = face_detector.detect(mp_image)

    if not result.face_landmarks:
        head_down_n += 1
        if head_down_n > 5:
            action = "no_face"
            distraction = 50.0
        return {
            "fatigue_score": fatigue, "gaze_direction": "UNKNOWN",
            "distraction_score": distraction, "blink_rate": blink,
            "emotion": emotion, "emotion_confidence": conf,
            "body_action": action,
        }

    lm = result.face_landmarks[0]

    # ── Calculate dynamic feature thresholds from CALIB ──────────────────────
    # Fallback default values
    th_ear = 0.22
    th_nose = 0.65
    th_mouth = 0.08
    th_brow = 0.015

    if "fatigue" in CALIB and "focus" in CALIB:
        f_avg = CALIB["fatigue"]["avg"]
        fc_avg = CALIB["focus"]["avg"]
        th_ear = (f_avg["ear"] + fc_avg["ear"]) / 2.0
        th_nose = (f_avg["nose_pos"] + fc_avg["nose_pos"]) / 2.0
    if "happy" in CALIB:
        th_mouth = CALIB["happy"]["avg"]["mouth_ratio"] * 0.7
    if "sad" in CALIB:
        th_brow = CALIB["sad"]["avg"]["brow_raise"] * 1.2

    # ── EAR (Eye Aspect Ratio) ───────────────────────────────────────────────
    def ear(idx):
        pts = np.array([[lm[i].x, lm[i].y] for i in idx])
        A = np.linalg.norm(pts[1] - pts[5])
        B = np.linalg.norm(pts[2] - pts[4])
        C = np.linalg.norm(pts[0] - pts[3])
        return (A + B) / (2.0 * C) if C > 0 else 0.25

    left_ear = ear([33, 7, 163, 144, 145, 153])
    right_ear = ear([362, 398, 384, 385, 387, 263])
    avg_ear = (left_ear + right_ear) / 2.0
    blink = round(avg_ear, 3)

    # ── Head Pose ────────────────────────────────────────────────────────────
    nose = lm[1]; forehead = lm[10]; chin = lm[152]
    face_h = abs(chin.y - forehead.y)
    nose_pos = (nose.y - forehead.y) / face_h if face_h > 0 else 0.5

    if nose_pos > th_nose:
        head_down_n += 1
        action = "head_down"
    else:
        head_down_n = max(0, head_down_n - 1)

    if nose_pos < (th_nose * 0.6):
        action = "looking_up"

    pitch_f = max(0, min(1, (nose_pos - (th_nose * 0.8)) / 0.2))
    ear_f = max(0, min(1, ((th_ear * 1.2) - avg_ear) / (th_ear * 0.5)))

    if avg_ear < th_ear:
        eyes_low_n += 1
    else:
        eyes_low_n = max(0, eyes_low_n - 1)

    # Roll (head tilt)
    le = lm[33]; re = lm[263]
    roll = math.degrees(math.atan2(re.y - le.y, re.x - le.x))
    roll_f = min(abs(roll) / 18.0, 1.0)
    if abs(roll) > 15:
        action = "head_tilt"

    # Combined fatigue
    fatigue = round(max(0.02, min(0.98,
        0.35 * pitch_f + 0.35 * ear_f + 0.15 * roll_f + 0.15 * min(head_down_n / 5, 1)
    )), 3)

    # Stressed detection
    if fatigue > 0.5 and head_down_n > 3 and emotion in ("sad", "neutral", "fear"):
        action = "stressed"

    # ── Gaze ─────────────────────────────────────────────────────────────────
    nose_x = lm[1].x
    eye_x = (le.x + re.x) / 2
    gaze = "CENTER" if abs(eye_x - nose_x) < 0.03 else ("RIGHT" if eye_x > nose_x else "LEFT")

    # ── Distraction (ROLLING WINDOW — not instant) ─────────────────────────────
    is_off_center = 1 if gaze != "CENTER" else 0
    gaze_history.append(is_off_center)
    off_count = sum(gaze_history) if len(gaze_history) > 0 else 0
    off_ratio = off_count / max(len(gaze_history), 1)

    raw_d = 0.0
    if off_ratio > 0.6:
        raw_d += 40 * off_ratio
    elif off_ratio > 0.3:
        raw_d += 15 * off_ratio

    if abs(roll) > 15 and off_ratio > 0.4:
        raw_d += 10
    if action == "head_down" and head_down_n > 5:
        raw_d += 15

    distraction = round(max(2, min(95, raw_d)), 2)
    distraction_history.append(distraction)
    distraction = round(sum(distraction_history) / max(len(distraction_history), 1), 2)

    # ── Emotion from landmarks ───────────────────────────────────────────────
    mouth_w = abs(lm[291].x - lm[61].x)
    mouth_h = abs(lm[14].y - lm[13].y)
    mouth_open = lm[14].y - lm[13].y
    m_ratio = mouth_h / mouth_w if mouth_w > 0 else 0.0

    left_lip = lm[61]
    right_lip = lm[291]
    lip_stretch = abs(right_lip.x - left_lip.x)

    left_brow = (lm[107].y + lm[66].y) / 2
    right_brow = (lm[336].y + lm[296].y) / 2
    avg_brow = (left_brow + right_brow) / 2
    nose_bridge = lm[6].y
    brow_raise = nose_bridge - avg_brow

    new_emotion = "neutral"
    new_conf = 0.85

    if m_ratio > (th_mouth * 4.0) and brow_raise > (th_brow * 2.5):
        new_emotion = "surprised"
        new_conf = 0.9
    elif m_ratio > th_mouth and lip_stretch > 0.14:
        new_emotion = "happy"
        new_conf = 0.85
    elif avg_ear < th_ear and pitch_f > 0.5:
        new_emotion = "tired"
        new_conf = 0.9
    elif brow_raise < th_brow and m_ratio < (th_mouth * 0.5):
        if avg_ear < th_ear:
            new_emotion = "sad"
            new_conf = 0.75
        else:
            new_emotion = "angry"
            new_conf = 0.7
    elif fatigue > 0.6:
        new_emotion = "tired"
        new_conf = 0.85
    elif eyes_low_n > 4:
        new_emotion = "tired"
        new_conf = 0.8
    else:
        new_emotion = "neutral"
        new_conf = 0.9

    emotion = new_emotion
    conf = new_conf
    prev_emotion = emotion
    prev_conf = conf

    return {
        "fatigue_score": fatigue, "gaze_direction": gaze,
        "distraction_score": distraction, "blink_rate": blink,
        "emotion": emotion, "emotion_confidence": conf,
        "body_action": action,
    }


def _default():
    return {
        "fatigue_score": 0.05, "gaze_direction": "UNKNOWN",
        "distraction_score": 5.0, "blink_rate": 0.3,
        "emotion": prev_emotion, "emotion_confidence": 0.3,
        "body_action": "unknown",
    }


# ═══════════════════════════════════════════════════════════════════════════════
# SCREEN ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════
@app.post("/analyze-screen")
async def analyze_screen(file: UploadFile = File(...)):
    raw = await file.read()
    return await asyncio.get_event_loop().run_in_executor(None, _screen, raw)


def _screen(raw: bytes) -> dict:
    img = decode(raw)
    if img is None:
        return {"activity": "UNKNOWN", "distraction_score": 10.0}

    h, w = img.shape[:2]
    if w > 640:
        img = cv2.resize(img, (640, int(h * 640 / w)))

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    avg_bright = np.mean(gray)
    color_std = np.std(hsv[:, :, 1])
    edges = cv2.Canny(gray, 50, 150)
    edge_d = np.sum(edges > 0) / edges.size
    dark_pix = np.sum(gray < 50) / gray.size
    is_dark = dark_pix > 0.4
    blur = cv2.GaussianBlur(gray, (21, 21), 0)
    uniform = 1.0 - (np.std(blur) / 128.0)

    if is_dark and edge_d > 0.08:
        return {"activity": "CODING", "distraction_score": 3.0}
    if edge_d > 0.12:
        return {"activity": "READING", "distraction_score": 8.0}
    if uniform > 0.85 and color_std > 40:
        return {"activity": "WATCHING", "distraction_score": 45.0}
    if color_std > 50 and edge_d < 0.06:
        return {"activity": "SOCIAL_MEDIA", "distraction_score": 60.0}
    if avg_bright < 30 and edge_d < 0.03:
        return {"activity": "IDLE", "distraction_score": 20.0}
    return {"activity": "BROWSING", "distraction_score": 15.0}
