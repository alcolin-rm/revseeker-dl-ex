# sldl_runner.py
import asyncio
import csv
import re
from pathlib import Path
from typing import List, Dict, Optional, Callable

SLDL_BIN = Path(__file__).parent / "sockseek.exe"
INPUT_DIR = Path(__file__).parent / "sldl_input"
LOG_DIR = Path(__file__).parent / "logs"
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "downloads"

for d in (INPUT_DIR, LOG_DIR, DEFAULT_OUTPUT_DIR):
    d.mkdir(exist_ok=True)


# ──────────────────────────────────────────────────────────────
# TRACK LIST PARSING
# ──────────────────────────────────────────────────────────────

def parse_track_list(text: str) -> List[Dict]:
    tracks = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        line = re.sub(r'^\d+[\.\)]\s*', '', line)
        parts = re.split(r'\s+[-–—]\s+', line, maxsplit=1)
        if len(parts) != 2:
            continue
        artist, rest = parts[0].strip(), parts[1].strip()

        album = ""
        m = re.search(r'\(([^)]+)\)\s*$', rest)
        if m:
            album = m.group(1).strip()
            rest = rest[:m.start()].strip()

        if artist and rest:
            tracks.append({"artist": artist, "title": rest, "album": album})
    return tracks


def write_csv(tracks: List[Dict], job_id: str) -> Path:
    csv_path = INPUT_DIR / f"{job_id}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["Artist", "Title", "Album"])
        writer.writeheader()
        for t in tracks:
            writer.writerow({
                "Artist": t["artist"],
                "Title": t["title"],
                "Album": t["album"],
            })
    return csv_path


# ──────────────────────────────────────────────────────────────
# LOG PARSING
# ──────────────────────────────────────────────────────────────

RE_CLI_SUMMARY = re.compile(
    r'Completed:\s+(\d+)\s+succeeded,\s+(\d+)\s+failed',
    re.IGNORECASE,
)
RE_FINAL_SUMMARY = re.compile(
    r'Downloaded\s+(\d+),\s+Failed\s+(\d+)\s+of\s+Total\s+(\d+)',
    re.IGNORECASE,
)
RE_SONG_SUCCESS = re.compile(
    r'SongJob:\s+succeeded:\s+(.+?):',
    re.IGNORECASE,
)
RE_SONG_DOWNLOADING = re.compile(
    r'SongJob:\s+downloading:\s+(.+?):',
    re.IGNORECASE,
)


def _parse_line(
    line: str,
    results: Dict,
    tracks: List[Dict],
    progress_cb: Optional[Callable],
):
    m = RE_CLI_SUMMARY.search(line)
    if m:
        results["downloaded"] = int(m.group(1))
        results["failed"] = int(m.group(2))
        if progress_cb:
            progress_cb(results["downloaded"], results["total"], "Complete")
        return

    m = RE_FINAL_SUMMARY.search(line)
    if m:
        results["downloaded"] = int(m.group(1))
        results["failed"] = int(m.group(2))
        results["total"] = int(m.group(3))
        if progress_cb:
            progress_cb(results["downloaded"], results["total"], "Complete")
        return

    if RE_SONG_SUCCESS.search(line):
        results["successes"] = results.get("successes", 0) + 1
        if progress_cb:
            progress_cb(results["successes"], len(tracks), line.strip())
        return

    m = RE_SONG_DOWNLOADING.search(line)
    if m:
        if progress_cb:
            progress_cb(
                results.get("successes", 0),
                results["total"],
                f"Downloading: {m.group(1)}",
            )
        return


# ──────────────────────────────────────────────────────────────
# MAIN RUNNER
# ──────────────────────────────────────────────────────────────

async def run_sldl(
    tracks: List[Dict],
    job_id: str,
    folder_name: str = "",
    output_dir: str = "",
    album_mode: bool = False,
    progress_cb: Optional[Callable[[int, int, str], None]] = None,
    log_cb: Optional[Callable[[str], None]] = None,
) -> Dict:
    csv_path = write_csv(tracks, job_id)
    log_path = LOG_DIR / f"{job_id}.log"
    config_path = Path(__file__).parent / "sockseek.conf"

    base = Path(output_dir) if output_dir else DEFAULT_OUTPUT_DIR
    final_dir = base / (folder_name or job_id)
    final_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        str(SLDL_BIN),
        str(csv_path),
        "--input-type", "csv",
        "--config", str(config_path),
        "--log-file", str(log_path),
        "-o", str(final_dir),
        "--name-format", "{artist} - {title}",
        "--concurrent-searches", "1",
        "--concurrent-jobs", "2",
        "--search-timeout", "15000",
        "--max-stale-time", "60000",
        "--fast-search",
        "--fast-search-min-up-speed", "500000",
        "--pref-strict-title",
        "--pref-strict-artist",
        "--pref-strict-album",
        "--pref-min-bitrate", "320",
        "--pref-format", "flac,mp3",
        "--fails-to-downrank", "1",
        "--fails-to-ignore", "2",
        "--max-retries", "5",
        "--skip-existing",
    ]

    if album_mode:
        cmd.append("--album")
        cmd.append("--browse-folder")

    if log_cb:
        log_cb(f"$ {' '.join(cmd)}")

    print(f"[sockseek] Running: {' '.join(cmd)}")
    for i, c in enumerate(cmd):
        print(f"  cmd[{i}] = {c!r}"),
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(Path(__file__).parent),
    )

    results = {
        "downloaded": 0,
        "failed": 0,
        "successes": 0,
        "total": len(tracks),
        "lines": [],
        "log_path": str(log_path),
        "exit_code": None,
    }

    async def read_stdout():
        assert proc.stdout is not None
        async for raw_line in proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").rstrip()
            if not line:
                continue
            results["lines"].append(line)
            if log_cb:
                log_cb(line)
            _parse_line(line, results, tracks, progress_cb)

    try:
        await asyncio.wait_for(read_stdout(), timeout=60 * 60)
    except asyncio.TimeoutError:
        print("[sockseek] Timeout — killing process")
        proc.kill()

    exit_code = await proc.wait()
    results["exit_code"] = exit_code

    if log_path.exists():
        try:
            log_text = log_path.read_text(encoding="utf-8", errors="replace")
            for line in log_text.splitlines():
                if log_cb:
                    log_cb(line)
                _parse_line(line, results, tracks, progress_cb)
        except Exception as e:
            print(f"[sockseek] Failed to read log file: {e}")

    if progress_cb:
        progress_cb(
            results["downloaded"],
            results["total"],
            f"Done — {results['downloaded']} downloaded, {results['failed']} failed",
        )

    print(f"[sockseek] Exited with code {exit_code}")
    return results