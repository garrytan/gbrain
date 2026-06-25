#!/usr/bin/env python3
"""
extract_transcript.py — orchestrator for the gbrain `transcribe` skill.

Takes a video URL or local file path, returns a JSON object with the
transcript and metadata. Tries the cheapest path first:

  YouTube URL  → youtube-transcript-api (free, instant)
                 ↓ fall through if no captions
                 yt-dlp + mlx-whisper (local, free, ~10 min/hr on M-series)
  Other URL    → yt-dlp + mlx-whisper
  Local file   → mlx-whisper (with optional ffmpeg conversion)

Caches by SHA-1 of input so re-runs are instant. File-lock prevents
concurrent mlx-whisper runs from thrashing the GPU.

Output: single JSON object on stdout. Exit codes:
  0=ok  1=user_error  2=transient  3=hard_failure

Cache location precedence:
  TRANSCRIBE_CACHE_DIR  >  $GBRAIN_HOME/transcribe  >  ~/.gbrain/transcribe

Platform note: mlx-whisper requires Apple Silicon. On other platforms,
swap the `transcribe_mlx()` call for `faster-whisper`:
    from faster_whisper import WhisperModel
    model = WhisperModel("base.en", device="cpu")
    segments, _ = model.transcribe(audio_path)
    return " ".join(s.text for s in segments).strip()
"""

from __future__ import annotations
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def _resolve_cache_root() -> Path:
    override = os.environ.get("TRANSCRIBE_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    gbrain_home = os.environ.get("GBRAIN_HOME")
    if gbrain_home:
        return Path(gbrain_home).expanduser() / "transcribe"
    return Path.home() / ".gbrain" / "transcribe"


CACHE_ROOT = _resolve_cache_root()
CACHE_DIR = CACHE_ROOT / "cache"
LOCK_PATH = Path(tempfile.gettempdir()) / "transcribe.lock"
TELEMETRY_PATH = CACHE_ROOT / "telemetry.jsonl"
DEFAULT_MODEL = "mlx-community/whisper-base.en-mlx"

MODEL_ALIASES = {
    "base.en": "mlx-community/whisper-base.en-mlx",
    "small.en": "mlx-community/whisper-small.en-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large": "mlx-community/whisper-large-v3-mlx",
}

YOUTUBE_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?v=|embed/|v/|shorts/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)


def now() -> float:
    return time.monotonic()


def sha1_hex(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:16]


def log_telemetry(record: dict) -> None:
    record["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        TELEMETRY_PATH.parent.mkdir(parents=True, exist_ok=True)
        with TELEMETRY_PATH.open("a") as f:
            f.write(json.dumps(record) + "\n")
    except OSError:
        pass


def detect_input_type(inp: str) -> str:
    if YOUTUBE_RE.search(inp):
        return "youtube_url"
    if inp.startswith(("http://", "https://")):
        return "url"
    p = Path(inp).expanduser()
    if p.exists() and p.is_file():
        return "local_file"
    return "unknown"


def youtube_video_id(url: str) -> str | None:
    m = YOUTUBE_RE.search(url)
    return m.group(1) if m else None


def cleanup_old_cache(max_age_days: int = 7) -> None:
    if not CACHE_DIR.exists():
        return
    cutoff = time.time() - max_age_days * 86400
    for p in CACHE_DIR.iterdir():
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


@contextlib.contextmanager
def file_lock(path: Path):
    """Block until we hold an exclusive lock on `path`. Released on exit."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fp = path.open("w")
    try:
        fcntl.flock(fp.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
        fp.close()


def try_youtube_captions(video_id: str) -> tuple[str, str] | None:
    """Return (transcript_text, source_label) or None if unavailable."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import (
            TranscriptsDisabled,
            NoTranscriptFound,
            VideoUnavailable,
        )
    except ImportError:
        return None

    api = YouTubeTranscriptApi()
    try:
        try:
            fetched = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
        except (NoTranscriptFound, TranscriptsDisabled, VideoUnavailable):
            return None
        text = " ".join(s.text for s in fetched.snippets).strip()
        if not text:
            return None
        return text, "youtube-transcript-api"
    except Exception:
        return None


def yt_dlp_metadata(url: str) -> dict:
    """Get title, duration, uploader without downloading."""
    try:
        import yt_dlp
    except ImportError:
        return {}
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        return {
            "title": info.get("title"),
            "duration": info.get("duration"),
            "uploader": info.get("uploader") or info.get("channel"),
            "webpage_url": info.get("webpage_url") or url,
        }
    except Exception:
        return {}


def download_audio(url: str, out_template: str) -> str:
    """Download with yt-dlp, return path to extracted mp3. Retries on 429."""
    try:
        import yt_dlp
    except ImportError as e:
        raise RuntimeError(f"yt-dlp not installed: {e}")

    opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "128",
        }],
        "quiet": True,
        "no_warnings": True,
        "retries": 3,
        "fragment_retries": 3,
        "extractor_retries": 3,
    }

    last_err: Exception | None = None
    for attempt, delay in enumerate([0, 5, 15, 45]):
        if delay:
            time.sleep(delay)
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
            base = out_template.rsplit(".", 1)[0]
            mp3 = base + ".mp3"
            if not Path(mp3).exists():
                for cand in Path(mp3).parent.glob(Path(base).name + ".*"):
                    if cand.suffix == ".mp3":
                        return str(cand)
                raise FileNotFoundError(f"expected {mp3} after download")
            return mp3
        except Exception as e:
            last_err = e
            if attempt < 3:
                continue
            break
    raise RuntimeError(f"yt-dlp failed after retries: {last_err}")


def convert_to_wav(src: str, dst: str) -> str:
    """Use ffmpeg to convert any audio/video file to 16kHz mono wav."""
    ffmpeg = shutil.which("ffmpeg") or str(Path.home() / "anaconda3" / "bin" / "ffmpeg")
    if not Path(ffmpeg).exists():
        raise RuntimeError("ffmpeg not found")
    subprocess.run(
        [ffmpeg, "-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return dst


def transcribe_mlx(audio_path: str, model_id: str) -> str:
    """Run mlx-whisper. Returns the transcript text."""
    try:
        import mlx_whisper
    except ImportError as e:
        raise RuntimeError(f"mlx-whisper not installed: {e}")

    result = mlx_whisper.transcribe(audio_path, path_or_hf_repo=model_id)
    return (result.get("text") or "").strip()


def resolve_model(name: str | None) -> str:
    if not name:
        return DEFAULT_MODEL
    if name in MODEL_ALIASES:
        return MODEL_ALIASES[name]
    if "/" in name:
        return name
    return DEFAULT_MODEL


def get_cached(cache_key: str) -> str | None:
    p = CACHE_DIR / f"{cache_key}.txt"
    if p.exists():
        try:
            return p.read_text(encoding="utf-8")
        except OSError:
            return None
    return None


def write_cache(cache_key: str, text: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = CACHE_DIR / f"{cache_key}.txt"
    p.write_text(text, encoding="utf-8")
    return p


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Extract transcript from video/audio.")
    parser.add_argument("input", help="YouTube URL, generic URL, or local file path")
    parser.add_argument("--model", default=None,
                        help="Whisper model alias (base.en, small.en, medium) or HF repo ID")
    parser.add_argument("--no-cache", action="store_true",
                        help="Bypass transcript cache for this run")
    parser.add_argument("--force-whisper", action="store_true",
                        help="Skip youtube-transcript-api fast path; always run mlx-whisper")
    args = parser.parse_args(argv)

    cleanup_old_cache()
    t0 = now()
    inp = args.input.strip()
    input_type = detect_input_type(inp)
    cache_key = sha1_hex(inp)
    model_id = resolve_model(args.model)

    result: dict = {
        "status": "error",
        "input": inp,
        "input_type": input_type,
        "title": None,
        "duration_seconds": None,
        "transcript": None,
        "engine": None,
        "model": None,
        "cache_path": None,
        "cache_hit": False,
        "wall_time_seconds": None,
        "error": None,
        "exit_code": 3,
    }

    if input_type == "unknown":
        result["error"] = f"Cannot interpret input: {inp!r}. Expected YouTube URL, http(s) URL, or path to existing file."
        result["exit_code"] = 1
        print(json.dumps(result, indent=2))
        return 1

    cached = None if args.no_cache else get_cached(cache_key)
    if cached is not None:
        result.update({
            "status": "success",
            "transcript": cached,
            "engine": "cache",
            "cache_path": str(CACHE_DIR / f"{cache_key}.txt"),
            "cache_hit": True,
            "wall_time_seconds": round(now() - t0, 3),
            "exit_code": 0,
        })
        if input_type in ("youtube_url", "url"):
            meta = yt_dlp_metadata(inp)
            result["title"] = meta.get("title")
            result["duration_seconds"] = meta.get("duration")
        print(json.dumps(result, indent=2))
        log_telemetry({**result, "transcript_len": len(cached)})
        return 0

    transcript_text: str | None = None
    engine_used: str | None = None

    try:
        with file_lock(LOCK_PATH):
            if input_type == "youtube_url":
                vid = youtube_video_id(inp)
                meta = yt_dlp_metadata(inp)
                result["title"] = meta.get("title")
                result["duration_seconds"] = meta.get("duration")

                if not args.force_whisper and vid:
                    cap = try_youtube_captions(vid)
                    if cap:
                        transcript_text, engine_used = cap

                if transcript_text is None:
                    tmpdir = Path(tempfile.mkdtemp(prefix="transcribe_"))
                    out_tmpl = str(tmpdir / "audio.%(ext)s")
                    mp3 = download_audio(inp, out_tmpl)
                    transcript_text = transcribe_mlx(mp3, model_id)
                    engine_used = "mlx-whisper"
                    result["model"] = model_id
                    shutil.rmtree(tmpdir, ignore_errors=True)

            elif input_type == "url":
                meta = yt_dlp_metadata(inp)
                result["title"] = meta.get("title")
                result["duration_seconds"] = meta.get("duration")
                tmpdir = Path(tempfile.mkdtemp(prefix="transcribe_"))
                out_tmpl = str(tmpdir / "audio.%(ext)s")
                mp3 = download_audio(inp, out_tmpl)
                transcript_text = transcribe_mlx(mp3, model_id)
                engine_used = "mlx-whisper"
                result["model"] = model_id
                shutil.rmtree(tmpdir, ignore_errors=True)

            elif input_type == "local_file":
                src = str(Path(inp).expanduser().resolve())
                result["title"] = Path(src).stem
                tmpdir = Path(tempfile.mkdtemp(prefix="transcribe_"))
                wav = str(tmpdir / "audio.wav")
                convert_to_wav(src, wav)
                transcript_text = transcribe_mlx(wav, model_id)
                engine_used = "mlx-whisper"
                result["model"] = model_id
                shutil.rmtree(tmpdir, ignore_errors=True)

    except KeyboardInterrupt:
        result["error"] = "interrupted by user"
        result["exit_code"] = 2
        print(json.dumps(result, indent=2))
        log_telemetry(result)
        return 2
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
        result["exit_code"] = 3
        print(json.dumps(result, indent=2))
        log_telemetry(result)
        return 3

    if not transcript_text or not transcript_text.strip():
        result["error"] = "empty transcript returned"
        result["exit_code"] = 3
        print(json.dumps(result, indent=2))
        log_telemetry(result)
        return 3

    cache_path = write_cache(cache_key, transcript_text)
    result.update({
        "status": "success",
        "transcript": transcript_text,
        "engine": engine_used,
        "cache_path": str(cache_path),
        "cache_hit": False,
        "wall_time_seconds": round(now() - t0, 3),
        "exit_code": 0,
    })
    print(json.dumps(result, indent=2))
    log_telemetry({**result, "transcript_len": len(transcript_text)})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
