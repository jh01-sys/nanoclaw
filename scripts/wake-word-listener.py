#!/usr/bin/env python3
"""
Wake word detection for NanoClaw — Part 1 + 2
Listens continuously via WSLg PulseAudio for "Hey Jarvis".
On detection: plays beep, records 5s, transcribes with whisper.cpp,
injects transcribed text into DB as Jake's message, plays confirmation beep.
Usage: PULSE_SERVER=unix:/mnt/wslg/runtime-dir/pulse/native python3 scripts/wake-word-listener.py
"""

import json
import os
import sys
import signal
import sqlite3
import time
import wave
import numpy as np
import requests
from datetime import datetime, timezone

# WSLg PulseAudio socket — must be set before importing soundcard
if "PULSE_SERVER" not in os.environ:
    os.environ["PULSE_SERVER"] = "unix:/mnt/wslg/runtime-dir/pulse/native"

# soundcard uses PulseAudio natively (no PortAudio/libportaudio2 needed)
import soundcard as sc
from openwakeword.model import Model

# ── Config ──────────────────────────────────────────────────────────────────
SAMPLE_RATE = 16000          # Hz — openWakeWord requires 16kHz
CHUNK_SAMPLES = 1280         # 80ms chunks at 16kHz
DETECTION_THRESHOLD = 0.5   # Confidence score to trigger (0–1)
CAPTURE_SECONDS = 5          # Max seconds to record after wake word
CAPTURE_CHUNKS = int(CAPTURE_SECONDS * SAMPLE_RATE / CHUNK_SAMPLES) + 1

MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    ".local/lib/python3.12/site-packages/openwakeword/resources/models/hey_jarvis_v0.1.onnx",
)
# Fallback to installed package location
if not os.path.exists(MODEL_PATH):
    import openwakeword
    pkg_dir = os.path.dirname(openwakeword.__file__)
    MODEL_PATH = os.path.join(pkg_dir, "resources", "models", "hey_jarvis_v0.1.onnx")

NANOCLAW_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(NANOCLAW_DIR, "store", "messages.db")
IPC_GROUP_DIR = os.path.join(NANOCLAW_DIR, "data", "ipc", "telegram_main")
IPC_MESSAGES_DIR = os.path.join(IPC_GROUP_DIR, "messages")
WAV_PATH = "/tmp/wake-command.wav"

SONOS_API_URL = os.environ.get("SONOS_API_URL", "http://localhost:5005")
SONOS_ROOM = "Olohuone"
DASHBOARD_URL = "http://127.0.0.1:8080"

CHAT_JID = "tg:8734325292"
JAKE_SENDER = "8734325292"
JAKE_NAME = "J"

BEEP_FREQ = 880      # Hz — detection beep (low)
BEEP2_FREQ = 1320    # Hz — confirmation beep (higher pitch)
BEEP_DURATION = 0.2  # seconds
CHIME_PATH = os.path.join(NANOCLAW_DIR, "sounds", "activate.wav")
CHIME_SAMPLE_RATE = 44100  # Hz — chime is 44.1kHz stereo-safe
SILENCE_THRESHOLD = 0.01   # RMS below this is considered silence
MIN_VOICE_RMS = 0.005      # If peak RMS never exceeds this, recording is probably empty/noise
SILENCE_CHUNKS = 10  # 10 × 80ms = 0.8s of consecutive silence to stop
MIN_CAPTURE_CHUNKS = int(1.5 * SAMPLE_RATE / CHUNK_SAMPLES)  # minimum 1.5s before silence check


def generate_beep(sample_rate: int = SAMPLE_RATE, freq: int = BEEP_FREQ, duration: float = BEEP_DURATION) -> np.ndarray:
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    wave_data = 0.3 * np.sin(2 * np.pi * freq * t)
    # Fade in/out to avoid clicks
    fade = int(sample_rate * 0.01)
    wave_data[:fade] *= np.linspace(0, 1, fade)
    wave_data[-fade:] *= np.linspace(1, 0, fade)
    return wave_data.astype(np.float32).reshape(-1, 1)


def play_beep(speaker, freq: int = BEEP_FREQ) -> None:
    try:
        beep = generate_beep(freq=freq)
        with speaker.player(samplerate=SAMPLE_RATE, channels=1) as p:
            p.play(beep)
    except Exception as e:
        print(f"[beep error: {e}]")


def play_chime(speaker) -> None:
    """Play the activation chime from sounds/activate.wav (fallback: beep)."""
    try:
        if os.path.exists(CHIME_PATH):
            with wave.open(CHIME_PATH, 'rb') as wf:
                n_frames = wf.getnframes()
                raw = wf.readframes(n_frames)
                sr = wf.getframerate()
                ch = wf.getnchannels()
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if ch > 1:
                samples = samples[::ch]  # take first channel
            audio = samples.reshape(-1, 1)
            with speaker.player(samplerate=sr, channels=1) as p:
                p.play(audio)
        else:
            # Fallback if chime file missing
            play_beep(speaker, BEEP_FREQ)
    except Exception as e:
        print(f"[chime error: {e}]")
        play_beep(speaker, BEEP_FREQ)


def save_wav(samples: np.ndarray, path: str, sample_rate: int = SAMPLE_RATE) -> None:
    """Save float32 audio samples as 16-bit mono WAV."""
    int16_samples = (samples * 32767).clip(-32768, 32767).astype(np.int16)
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit = 2 bytes
        wf.setframerate(sample_rate)
        wf.writeframes(int16_samples.tobytes())


def transcribe_with_elevenlabs(wav_path: str) -> str | None:
    """Send wav_path to ElevenLabs Scribe STT (Finnish), return transcript or None."""
    key = os.environ.get('ELEVENLABS_API_KEY', '')
    if not key:
        print("[elevenlabs stt error: ELEVENLABS_API_KEY not set]")
        return None
    url = 'https://api.elevenlabs.io/v1/speech-to-text'
    headers = {'xi-api-key': key}
    try:
        with open(wav_path, 'rb') as f:
            audio_data = f.read()
        print(f"[elevenlabs stt] Sending {len(audio_data)} bytes (fi)...")
        resp = requests.post(
            url,
            headers=headers,
            files={'file': ('command.wav', audio_data, 'audio/wav')},
            data={'model_id': 'scribe_v1', 'language_code': 'fi'},
            timeout=15,
        )
        if resp.status_code == 200:
            result = resp.json()
            text = result.get('text', '').strip()
            lang = result.get('language_code', '?')
            print(f"[elevenlabs stt] lang={lang} | {text!r}")
            return text if text else None
        else:
            print(f"[elevenlabs stt error: HTTP {resp.status_code}] {resp.text[:200]}")
            return None
    except Exception as e:
        print(f"[elevenlabs stt error: {e}]")
        return None


def inject_message(text: str) -> None:
    """Insert transcribed text into the messages DB as Jake's incoming message,
    and write an IPC message file so it appears in Telegram for Jake to see."""
    msg_id = f"wake-{int(datetime.now().timestamp() * 1000)}"
    ts = datetime.now(timezone.utc).isoformat()

    # Insert into DB as Jake's incoming message — triggers Annie to respond
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "INSERT OR REPLACE INTO messages "
            "(id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) "
            "VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
            (msg_id, CHAT_JID, JAKE_SENDER, JAKE_NAME, text, ts),
        )
        conn.commit()
        conn.close()
        print(f"[injected: {text!r}]")
    except Exception as e:
        print(f"[DB error: {e}]")

    # Write IPC message file — orchestrator picks this up and sends it to Telegram
    # so Jake can see what was transcribed in the chat
    try:
        os.makedirs(IPC_MESSAGES_DIR, exist_ok=True)
        ipc_filename = f"wake-{int(datetime.now().timestamp() * 1000)}.json"
        ipc_path = os.path.join(IPC_MESSAGES_DIR, ipc_filename)
        with open(ipc_path, "w") as f:
            json.dump({"type": "message", "chatJid": CHAT_JID, "text": text}, f)
        print(f"[IPC written: {ipc_path}]")
    except Exception as e:
        print(f"[IPC error: {e}]")


def sonos_get_volume() -> int | None:
    """Fetch current Sonos volume. Returns int or None on failure."""
    try:
        r = requests.get(f"{SONOS_API_URL}/{SONOS_ROOM}/state", timeout=2)
        r.raise_for_status()
        vol = r.json().get("volume")
        return int(vol) if vol is not None else None
    except Exception as e:
        print(f"[sonos get_volume warning: {e}]")
        return None


def sonos_set_volume(volume: int) -> None:
    """Set Sonos volume."""
    try:
        requests.get(f"{SONOS_API_URL}/{SONOS_ROOM}/volume/{volume}", timeout=2)
    except Exception as e:
        print(f"[sonos set_volume warning: {e}]")


def tv_send_key(key: str) -> None:
    """Send a key command to Samsung TV via dashboard server (best-effort)."""
    try:
        requests.post(
            f"{DASHBOARD_URL}/api/device/command",
            json={"device": "tv", "action": key},
            timeout=2,
        )
    except Exception as e:
        print(f"[tv key warning: {e}]")


def mute_audio() -> int | None:
    """Mute Sonos and TV. Returns saved Sonos volume or None."""
    saved_volume = sonos_get_volume()
    if saved_volume is not None:
        print(f"[mute] Sonos volume saved: {saved_volume}, muting...")
        sonos_set_volume(0)
    else:
        print("[mute] Could not read Sonos volume, skipping mute")
    tv_send_key("KEY_MUTE")
    time.sleep(0.5)
    return saved_volume


def restore_audio(saved_volume: int | None) -> None:
    """Restore Sonos volume and unmute TV."""
    if saved_volume is not None:
        print(f"[restore] Restoring Sonos volume to {saved_volume}")
        sonos_set_volume(saved_volume)
    tv_send_key("KEY_MUTE")



def main():
    print("=== NanoClaw Wake Word Listener ===")
    print(f"Model: {os.path.basename(MODEL_PATH)}")
    print(f"PULSE_SERVER: {os.environ.get('PULSE_SERVER', '(default)')}")
    print(f"DB: {DB_PATH}")
    el_key_set = bool(os.environ.get('ELEVENLABS_API_KEY'))
    print(f"ElevenLabs Scribe STT ready: key={'set' if el_key_set else 'NOT SET'}")

    # List available devices
    mics = sc.all_microphones(include_loopback=False)
    print(f"Available microphones: {[m.name for m in mics]}")
    mic = sc.default_microphone()
    print(f"Using microphone: {mic.name}")

    speakers = sc.all_speakers()
    print(f"Available speakers: {[s.name for s in speakers]}")
    speaker = sc.default_speaker()
    print(f"Using speaker: {speaker.name}")
    print()

    # Load wake word model
    print(f"Loading model: {MODEL_PATH}")
    oww = Model(wakeword_model_paths=[MODEL_PATH])
    model_name = list(oww.models.keys())[0]
    print(f"Model loaded: {model_name}")
    print(f"Detection threshold: {DETECTION_THRESHOLD}")
    print()
    print("Listening... (Ctrl+C to stop)")
    print()

    # Handle Ctrl+C gracefully
    running = True
    def _stop(sig, frame):
        nonlocal running
        print("\nStopping.")
        running = False
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    chunk_count = 0
    detecting = True  # lockout flag — False while processing a command
    try:
        with mic.recorder(samplerate=SAMPLE_RATE, channels=1) as recorder:
            while running:
                audio = recorder.record(numframes=CHUNK_SAMPLES)
                if not detecting:
                    # Consume audio to drain the buffer but don't run detection
                    continue
                # soundcard returns float32 [-1, 1]; convert to int16 for openWakeWord
                audio_int16 = (audio[:, 0] * 32767).astype(np.int16)
                preds = oww.predict(audio_int16)
                score = preds.get(model_name, 0.0)
                chunk_count += 1
                if chunk_count % 50 == 0:  # heartbeat every ~4s
                    sys.stdout.write(f"\r[{datetime.now().strftime('%H:%M:%S')}] listening... (score={score:.3f})")
                    sys.stdout.flush()
                if score >= DETECTION_THRESHOLD:
                    detecting = False  # lock out BEFORE beep to prevent re-trigger
                    ts_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    print(f"\nWAKE WORD DETECTED at {ts_str} (score={score:.3f})")
                    oww.reset()  # reset model state after detection

                    # Mute Sonos + TV before recording
                    saved_volume = mute_audio()

                    # Activation chime (after mute so it's clearly audible)
                    play_chime(speaker)

                    # Record up to CAPTURE_SECONDS; stop after 1.5s of sustained silence
                    print(f"Recording command (up to {CAPTURE_SECONDS}s, stops after 0.8s silence)...")
                    captured_chunks = []
                    silence_streak = 0
                    peak_rms = 0.0
                    for chunk_idx in range(CAPTURE_CHUNKS):
                        if not running:
                            break
                        chunk = recorder.record(numframes=CHUNK_SAMPLES)
                        captured_chunks.append(chunk[:, 0])
                        rms = float(np.sqrt(np.mean(chunk[:, 0] ** 2)))
                        if rms > peak_rms:
                            peak_rms = rms
                        # Only apply silence detection after minimum recording window
                        if chunk_idx >= MIN_CAPTURE_CHUNKS:
                            if rms < SILENCE_THRESHOLD:
                                silence_streak += 1
                                if silence_streak >= SILENCE_CHUNKS:
                                    print(f"0.8s silence detected at chunk {chunk_idx}, stopping early.")
                                    break
                            else:
                                silence_streak = 0

                    if not captured_chunks:
                        restore_audio(saved_volume)
                        oww.reset()
                        detecting = True
                        continue

                    # Save as 16kHz mono WAV
                    audio_data = np.concatenate(captured_chunks)
                    audio_rms = float(np.sqrt(np.mean(audio_data ** 2)))
                    save_wav(audio_data, WAV_PATH)
                    duration_s = len(audio_data) / SAMPLE_RATE
                    print(f"Saved {duration_s:.1f}s audio to {WAV_PATH} | RMS={audio_rms:.4f} peak_rms={peak_rms:.4f}")

                    # Minimum volume check — skip transcription if recording is too quiet
                    if peak_rms < MIN_VOICE_RMS:
                        print(f"[skip] Audio too quiet (peak_rms={peak_rms:.4f} < {MIN_VOICE_RMS}), likely no speech.")
                        play_beep(speaker, BEEP2_FREQ)
                        restore_audio(saved_volume)
                        oww.reset()
                        detecting = True
                        continue

                    # Transcribe with ElevenLabs Scribe STT (fi)
                    print("Transcribing with ElevenLabs Scribe...")
                    text = transcribe_with_elevenlabs(WAV_PATH)

                    # Confirmation beep
                    play_beep(speaker, BEEP2_FREQ)

                    if text and len(text.split()) >= 1:
                        print(f"Transcript: {text!r}")
                        restore_audio(saved_volume)
                        inject_message(f"[Voice: {text}]")
                    elif text:
                        print(f"Transcript empty after strip, ignoring: {text!r}")
                        restore_audio(saved_volume)
                    else:
                        print("No transcript (silence or error).")
                        restore_audio(saved_volume)

                    # Drain buffered audio accumulated during processing (beep + TTS)
                    # before re-enabling detection to prevent feedback re-trigger.
                    print("[lockout] Draining mic buffer (1.5s)...")
                    drain_deadline = time.monotonic() + 1.5
                    while time.monotonic() < drain_deadline:
                        recorder.record(numframes=CHUNK_SAMPLES)
                    oww.reset()
                    detecting = True
                    print("[lockout] Detection re-enabled.")
    except Exception as e:
        print(f"\nError during capture: {e}")
        raise

    print("Wake word listener stopped.")


if __name__ == "__main__":
    main()
