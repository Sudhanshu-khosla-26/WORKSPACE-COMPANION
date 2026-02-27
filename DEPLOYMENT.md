# Buddy AI Companion: Deployment Guide

This guide explains how to deploy the Buddy AI Companion, focusing on the Python FastAPI backend and the Electron frontend.

---

## 1. Backend Deployment (FastAPI)

### Option A: Cloud Hosting (Recommended for remote access)
You can host the backend on services like **Railway**, **Render**, or **DigitalOcean**.

1. **Requirements**: Ensure your `requirements.txt` is up to date.
2. **Platform Setup**:
   - Create a new Web Service and link your GitHub repository.
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `python -m uvicorn server:app --host 0.0.0.0 --port $PORT`
3. **Environment Variables**: Add any necessary keys (though the backend currently handles local analysis).

> [!IMPORTANT]
> Since the backend uses MediaPipe/OpenCV, the cloud environment must support these libraries (usually via standard Ubuntu/Debian buildpacks).

### Option B: Local Executable (For sharing as a standalone app)
You can turn the Python backend into an `.exe` so others don't need Python installed.

1. **Install PyInstaller**:
   ```bash
   pip install pyinstaller
   ```
2. **Build**:
   ```bash
   pyinstaller --onefile --noconsole server.py
   ```
3. This will create a `dist/server.exe` that you can distribute.

---

## 2. Frontend Deployment (Electron)

To package the desktop app into a single installer:

1. **Update package.json**: (Already done) Added `"build:electron": "next build && electron-builder"`
2. **Run Build**:
   ```bash
   npm run build:electron
   ```
3. **Output**: Look in the `dist/` folder for the `.exe` installer.

---

## 3. JEE Student Setup (Quick Start)

If you are moving this to a new study machine:

1. **Install Python 3.9+** and **Node.js**.
2. **Clone Repo**: `git clone <your-repo>`
3. **Setup Backend**:
   ```bash
   cd backend
   python -m venv venv
   .\venv\Scripts\activate
   pip install -r requirements.txt
   ```
4. **Setup Frontend**:
   ```bash
   npm install
   ```
5. **Run**:
   Start the backend (`uvicorn server:app`) and then run `npm run dev`.
