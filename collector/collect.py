#!/usr/bin/env python3
"""
TravelAI 데이터 수집기
실행: python collect.py
"""

import argparse
import io
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import yt_dlp
from dotenv import load_dotenv
from faster_whisper import WhisperModel
from openai import AzureOpenAI, OpenAI

# Windows 콘솔 UTF-8
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

load_dotenv()

# ─── ffmpeg 경로 자동 탐색 ────────────────────────────────────────────────────
def _find_ffmpeg_dir() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return str(Path(found).parent)
    home = Path.home()
    candidates: list[Path] = [
        home / "AppData/Local/Microsoft/WinGet/Links",
        home / "AppData/Local/Programs/ffmpeg/bin",
        Path("C:/ffmpeg/bin"),
        Path("C:/Program Files/ffmpeg/bin"),
    ]
    winget_pkgs = home / "AppData/Local/Microsoft/WinGet/Packages"
    if winget_pkgs.exists():
        for pkg in winget_pkgs.glob("Gyan.FFmpeg*"):
            for bin_dir in pkg.rglob("bin"):
                if (bin_dir / "ffmpeg.exe").exists():
                    candidates.insert(0, bin_dir)
    for c in candidates:
        if (Path(c) / "ffmpeg.exe").exists():
            return str(c)
    return None

FFMPEG_DIR = _find_ffmpeg_dir()
if FFMPEG_DIR:
    os.environ["PATH"] = FFMPEG_DIR + os.pathsep + os.environ.get("PATH", "")
else:
    print("  [경고] ffmpeg을 찾을 수 없습니다. --ffmpeg-location 옵션을 사용합니다.")

# ─── 설정 ─────────────────────────────────────────────────────────────────────
YOUTUBE_API_KEY       = os.getenv("YOUTUBE_API_KEY")
OPENAI_API_KEY        = os.getenv("OPENAI_API_KEY")
AZURE_OPENAI_KEY      = os.getenv("AZURE_OPENAI_KEY")
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT")
AZURE_OPENAI_DEPLOY   = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini")
AZURE_OPENAI_VERSION  = os.getenv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")

def make_openai_client():
    """Azure 키가 있으면 AzureOpenAI, 없으면 표준 OpenAI 사용."""
    if AZURE_OPENAI_KEY and AZURE_OPENAI_ENDPOINT and "여기에" not in AZURE_OPENAI_KEY:
        print("  [API] Azure OpenAI 사용")
        return AzureOpenAI(
            api_key=AZURE_OPENAI_KEY,
            azure_endpoint=AZURE_OPENAI_ENDPOINT,
            api_version=AZURE_OPENAI_VERSION,
        ), AZURE_OPENAI_DEPLOY
    print("  [API] 표준 OpenAI 사용")
    return OpenAI(api_key=OPENAI_API_KEY), "gpt-4o-mini"

DEFAULT_KO      = 10
DEFAULT_LOCAL   = 10
MIN_VIEW_COUNT  = 30_000
GPT_BATCH_SIZE  = 20
MAX_TRANSCRIPT  = None  # 제한 없음
WHISPER_MODEL   = "small"
OUTPUT_DIR      = Path("output")
TMP_DIR         = Path("tmp")
OUTPUT_DIR.mkdir(exist_ok=True)
TMP_DIR.mkdir(exist_ok=True)

LANG_OPTIONS = {
    "1": ("Japanese",   "일본어"),
    "2": ("Thai",       "태국어"),
    "3": ("English",    "영어"),
    "4": ("French",     "프랑스어"),
    "5": ("Spanish",    "스페인어"),
    "6": ("Italian",    "이탈리아어"),
    "7": ("Vietnamese", "베트남어"),
    "8": ("Chinese",    "중국어"),
}

NEARBY_CITIES = {
    "Japanese":   ["오사카","大阪","교토","京都","고베","神戸","나고야","名古屋",
                   "후쿠오카","福岡","삿포로","札幌","나라","奈良","히로시마","広島"],
    "Thai":       ["방콕","Bangkok","치앙마이","Chiang Mai","푸켓","Phuket","파타야","Pattaya"],
    "English":    ["뉴욕","New York","런던","London","시드니","Sydney","멜버른","Melbourne"],
    "French":     ["파리","Paris","리옹","Lyon","마르세유","Marseille","니스","Nice"],
    "Spanish":    ["마드리드","Madrid","바르셀로나","Barcelona","세비야","Sevilla"],
    "Italian":    ["로마","Roma","밀라노","Milano","베네치아","Venezia","피렌체","Firenze"],
    "Vietnamese": ["하노이","Hanoi","다낭","Da Nang","호이안","Hoi An","나트랑","Nha Trang"],
    "Chinese":    ["베이징","北京","상하이","上海","청두","成都","시안","西安","광저우","广州"],
}

LANG_QUERIES = {
    "Japanese":   {"food": "{c} グルメ",   "hotel": "{c} ホテル",   "spot": "{c} 観光スポット"},
    "Thai":       {"food": "{c} ร้านอาหาร", "hotel": "{c} โรงแรม",  "spot": "{c} สถานที่ท่องเที่ยว"},
    "English":    {"food": "{c} best food", "hotel": "{c} best hotel", "spot": "{c} tourist spots"},
    "French":     {"food": "{c} restaurants","hotel":"{c} hôtels",  "spot": "{c} attractions"},
    "Spanish":    {"food": "{c} restaurantes","hotel":"{c} hoteles","spot": "{c} atracciones"},
    "Italian":    {"food": "{c} ristoranti", "hotel":"{c} hotel",   "spot": "{c} attrazioni"},
    "Vietnamese": {"food": "{c} quán ăn",   "hotel": "{c} khách sạn","spot":"{c} du lịch"},
    "Chinese":    {"food": "{c} 美食",       "hotel": "{c} 酒店",    "spot": "{c} 景点"},
}

# ─── 출력 유틸 ─────────────────────────────────────────────────────────────────
def pr(msg, end="\n"):
    print(msg, end=end, flush=True)

def progress(current, total, label=""):
    filled = int(20 * current / total) if total else 0
    bar = "■" * filled + "□" * (20 - filled)
    pr(f"\r  [{bar}] {current}/{total} {label}    ", end="")

# ─── Whisper 모델 ─────────────────────────────────────────────────────────────
_whisper_model = None

def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        pr("  [Whisper] 모델 로딩 중...")
        _whisper_model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
        pr("  [Whisper] 로딩 완료")
    return _whisper_model

# ─── YouTube API ──────────────────────────────────────────────────────────────
def search_videos(query: str, max_results: int = 20) -> list[dict]:
    two_years_ago = (datetime.now(timezone.utc) - timedelta(days=730)).strftime("%Y-%m-%dT%H:%M:%SZ")
    params = {
        "part": "snippet", "q": query, "type": "video",
        "maxResults": max_results, "publishedAfter": two_years_ago,
        "order": "relevance", "key": YOUTUBE_API_KEY,
    }
    r = requests.get("https://www.googleapis.com/youtube/v3/search", params=params, timeout=10)
    r.raise_for_status()
    return r.json().get("items", [])

def get_video_details(video_ids: list[str]) -> list[dict]:
    params = {"part": "snippet,statistics,contentDetails", "id": ",".join(video_ids), "key": YOUTUBE_API_KEY}
    r = requests.get("https://www.googleapis.com/youtube/v3/videos", params=params, timeout=10)
    r.raise_for_status()
    return r.json().get("items", [])

def parse_duration(iso: str) -> int:
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m: return 0
    h, mn, s = (int(x or 0) for x in m.groups())
    return h * 3600 + mn * 60 + s

# ─── 영상 필터링 ──────────────────────────────────────────────────────────────
def is_relevant(video: dict) -> bool:
    # 쇼츠 제외 (60초 이하)
    if video["duration_sec"] < 60:
        return False
    # 30분 초과 제외
    if video["duration_sec"] > 1800:
        return False
    # 최소 조회수
    if video["view_count"] < MIN_VIEW_COUNT:
        return False
    return True

def collect_and_filter(city_ko, city_local, lang, target_ko, target_local):
    cat_queries = LANG_QUERIES.get(lang, {})
    all_videos: dict[str, dict] = {}

    ko_queries    = [f"{city_ko} 맛집", f"{city_ko} 호텔", f"{city_ko} 관광지"]
    local_queries = [cat_queries.get(k, "").format(c=city_local) for k in ("food", "hotel", "spot")]

    def run_queries(queries, label):
        for q in queries:
            if not q.strip(): continue
            pr(f"  → '{q}' 검색 중...", end="")
            try:
                items = search_videos(q, max_results=25)
                ids = [i["id"]["videoId"] for i in items if "videoId" in i.get("id", {})]
                if not ids:
                    pr(" 0개")
                    continue
                details = get_video_details(ids)
                before = len(all_videos)
                for v in details:
                    vid = v["id"]
                    if vid in all_videos: continue
                    snippet = v.get("snippet", {})
                    stats   = v.get("statistics", {})
                    content = v.get("contentDetails", {})
                    all_videos[vid] = {
                        "id":           vid,
                        "title":        snippet.get("title", ""),
                        "channel":      snippet.get("channelTitle", ""),
                        "description":  snippet.get("description", "")[:600],
                        "view_count":   int(stats.get("viewCount", 0)),
                        "duration_sec": parse_duration(content.get("duration", "")),
                        "lang_label":   label,
                    }
                pr(f" {len(all_videos) - before}개 추가 (누적 {len(all_videos)}개)")
                time.sleep(0.3)
            except Exception as e:
                pr(f" 오류: {e}")

    run_queries(ko_queries,    "한국어")
    run_queries(local_queries, "현지어")

    filtered = [v for v in all_videos.values() if is_relevant(v)]
    pr(f"\n  필터 후: {len(all_videos)}개 → {len(filtered)}개")

    ko_list    = sorted([v for v in filtered if v["lang_label"] == "한국어"],
                        key=lambda x: x["view_count"], reverse=True)[:target_ko]
    local_list = sorted([v for v in filtered if v["lang_label"] == "현지어"],
                        key=lambda x: x["view_count"], reverse=True)[:target_local]
    return ko_list + local_list

# ─── 자막 수집 ────────────────────────────────────────────────────────────────
def fetch_timedtext(video_id: str) -> str | None:
    for lang in ("ko", "ja", "en", "th", "vi", "zh-Hans"):
        try:
            url = f"https://www.youtube.com/api/timedtext?v={video_id}&lang={lang}&fmt=json3"
            r = requests.get(url, timeout=6)
            if not r.ok: continue
            data = r.json()
            text = " ".join(
                "".join(s.get("utf8", "") for s in e.get("segs", []))
                for e in data.get("events", []) if e.get("segs")
            ).strip()
            if len(text) > 80:
                return text[:MAX_TRANSCRIPT] if MAX_TRANSCRIPT else text
        except Exception:
            continue
    return None

def download_audio(video_id: str) -> Path | None:
    out_path = TMP_DIR / f"{video_id}.mp3"
    if out_path.exists():
        return out_path

    last_pct = [0]
    def progress_hook(d):
        if d["status"] == "downloading":
            pct_str = d.get("_percent_str", "").strip().replace("%", "")
            try:
                pct = int(float(pct_str))
                if pct - last_pct[0] >= 10:
                    pr(f"\r    오디오 다운로드 {pct}%...", end="")
                    last_pct[0] = pct
            except Exception:
                pass
        elif d["status"] == "finished":
            pr(f"\r    오디오 다운로드 완료          ")

    ydl_opts = {
        "format": "bestaudio/best",
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "96"}],
        "outtmpl": str(TMP_DIR / f"{video_id}.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [progress_hook],
    }
    if FFMPEG_DIR:
        ydl_opts["ffmpeg_location"] = FFMPEG_DIR
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        return out_path if out_path.exists() else None
    except Exception as e:
        pr(f"\r    오디오 다운로드 실패: {e}          ")
        return None

def transcribe_whisper(audio_path: Path) -> str | None:
    try:
        model = get_whisper_model()
        segments, _ = model.transcribe(str(audio_path), beam_size=5)
        text = " ".join(seg.text for seg in segments).strip()
        if not text:
            return None
        return text[:MAX_TRANSCRIPT] if MAX_TRANSCRIPT else text
    except Exception as e:
        pr(f"    Whisper 실패: {e}")
        return None

def get_transcript(video: dict) -> tuple[str | None, str]:
    vid = video["id"]
    text = fetch_timedtext(vid)
    if text:
        return text, "timedtext"

    pr(f"    → Whisper 변환 중...")
    audio = download_audio(vid)
    if audio:
        text = transcribe_whisper(audio)
        try: audio.unlink(missing_ok=True)
        except Exception: pass
        if text:
            return text, "whisper"
    return None, "none"

# ─── GPT 분석 ─────────────────────────────────────────────────────────────────
def analyze_batch(videos: list[dict], city: str, client, model: str):
    videos_text = "\n\n---\n\n".join(
        f"[영상 {i+1}]\nvideoId: {v['id']}\n제목: {v['title']}\n채널: {v['channel']}\n"
        f"언어: {v['lang_label']}\n조회수: {v['view_count']:,}\n설명: {v['description']}\n"
        + (f"자막: {v['transcript']}" if v.get("transcript") else "")
        for i, v in enumerate(videos)
    )
    prompt = f"""아래는 "{city}" 여행 유튜브 영상 {len(videos)}개의 정보야. 한국어 영상과 현지어 영상이 섞여 있어.

**중요: 모든 영상(한국어·일본어·영어 등 언어 무관)에서 장소를 빠짐없이 추출해야 해.**
현지어(일본어 등)로 된 자막도 반드시 분석하고, 장소명과 내용은 모두 한국어로 번역해서 작성해줘.

추출 대상: 맛집/레스토랑, 숙소/호텔, 관광지/명소
같은 장소가 여러 영상에서 언급되면 하나로 합치고, 영상별 리뷰를 reviews 배열에 각각 담아줘.

무시: 전자기기, 앱, 식품 등 여행지와 무관한 협찬·광고

## 영상 데이터:
{videos_text}

## 출력 형식 (JSON 배열만, 다른 텍스트 없이):
[
  {{
    "name": "장소명 (한국어 번역)",
    "name_local": "현지어명",
    "category": "food | hotel | spot",
    "price": "가격대",
    "rating": "평점",
    "tips": "방문 팁 (한국어)",
    "reviews": [
      {{
        "channel": "채널명",
        "video_title": "영상 제목",
        "experience": "경험 요약 (한국어로 번역, 1-2문장)",
        "sentiment": "긍정 | 중립 | 부정",
        "confidence": 0.0
      }}
    ]
  }}
]

확실하지 않은 정보는 null. confidence는 0.0~1.0."""

    resp = client.chat.completions.create(
        model=model, max_tokens=8192,
        messages=[{"role": "user", "content": prompt}],
    )
    usage = resp.usage
    text  = resp.choices[0].message.content.strip()
    match = re.search(r"\[[\s\S]*\]", text)
    places = json.loads(match.group()) if match else []
    return places, usage.prompt_tokens, usage.completion_tokens

def merge_places(batches):
    merged: dict[str, dict] = {}
    for batch in batches:
        for place in batch:
            key = re.sub(r"\s+", "", place.get("name", "")).lower()
            if not key: continue
            if key not in merged:
                merged[key] = {**place, "reviews": list(place.get("reviews", []))}
            else:
                existing = {r["video_id"] for r in merged[key]["reviews"]}
                for r in place.get("reviews", []):
                    if r["video_id"] not in existing:
                        merged[key]["reviews"].append(r)
    return sorted(merged.values(), key=lambda p: len(p["reviews"]), reverse=True)

# ─── GPT 도시명 처리 ──────────────────────────────────────────────────────────
def resolve_city(city_input: str, lang: str, client, model: str) -> tuple[str, str]:
    lang_names = {
        "Japanese":"일본어","Thai":"태국어","English":"영어","French":"프랑스어",
        "Spanish":"스페인어","Italian":"이탈리아어","Vietnamese":"베트남어","Chinese":"중국어(간체)",
    }
    resp = client.chat.completions.create(
        model=model, max_tokens=60,
        messages=[{"role":"user","content":
            f'"{city_input}"의 올바른 한국어 도시명과 {lang_names.get(lang,lang)} 표기를 JSON으로 반환해줘.\n'
            f'{{"ko":"한국어명","local":"현지어명"}}'}],
    )
    text  = resp.choices[0].message.content.strip()
    match = re.search(r"\{.*?\}", text, re.DOTALL)
    if match:
        data = json.loads(match.group())
        return data.get("ko", city_input), data.get("local", city_input)
    return city_input, city_input

def save_json(data: dict, path: Path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    pr(f"  [저장] {path}")

# ─── 대화형 입력 ──────────────────────────────────────────────────────────────
def interactive_input() -> tuple[str, str, int, int]:
    pr("\n" + "="*50)
    pr("  TravelAI 데이터 수집기")
    pr("="*50)

    city = input("\n  수집할 도시명을 입력하세요: ").strip()
    while not city:
        city = input("  도시명을 입력해주세요: ").strip()

    pr("\n  현지 언어를 선택하세요:")
    for k, (_, label) in LANG_OPTIONS.items():
        pr(f"    {k}. {label}")
    while True:
        sel = input("  선택 (1-8, 기본값 1): ").strip() or "1"
        if sel in LANG_OPTIONS:
            lang = LANG_OPTIONS[sel][0]
            pr(f"  → {LANG_OPTIONS[sel][1]} 선택됨")
            break
        pr("  1~8 중에서 선택해주세요.")

    try:
        n_ko = int(input(f"\n  한국어 영상 수 (기본값 {DEFAULT_KO}): ").strip() or DEFAULT_KO)
    except ValueError:
        n_ko = DEFAULT_KO

    try:
        n_local = int(input(f"  현지어 영상 수 (기본값 {DEFAULT_LOCAL}): ").strip() or DEFAULT_LOCAL)
    except ValueError:
        n_local = DEFAULT_LOCAL

    return city, lang, n_ko, n_local

# ─── 메인 ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="TravelAI 데이터 수집기")
    parser.add_argument("--city")
    parser.add_argument("--lang", default=None, choices=list(LANG_QUERIES.keys()))
    parser.add_argument("--videos-ko",   type=int, default=None)
    parser.add_argument("--videos-local",type=int, default=None)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    if not YOUTUBE_API_KEY:
        pr("❌ .env 파일에 YOUTUBE_API_KEY를 설정해주세요")
        return
    if not OPENAI_API_KEY and not AZURE_OPENAI_KEY:
        pr("❌ .env 파일에 OPENAI_API_KEY 또는 AZURE_OPENAI_KEY를 설정해주세요")
        return

    # 인자 없으면 대화형 입력
    if args.city:
        city_input = args.city
        lang       = args.lang or "Japanese"
        n_ko       = args.videos_ko    or DEFAULT_KO
        n_local    = args.videos_local or DEFAULT_LOCAL
    else:
        city_input, lang, n_ko, n_local = interactive_input()

    client, model = make_openai_client()
    run_start = time.time()
    tok_in    = 0
    tok_out   = 0

    date_str  = datetime.now().strftime("%Y-%m-%d")
    safe_name = re.sub(r"[^\w가-힣]", "_", city_input)
    out_path  = OUTPUT_DIR / f"{safe_name}_{date_str}.json"

    pr(f"\n  도시     : {city_input}")
    pr(f"  언어     : {lang}")
    pr(f"  영상     : 한국어 {n_ko}개 + 현지어 {n_local}개")
    pr(f"  출력파일 : {out_path}\n")

    progress_data = {}
    if args.resume and out_path.exists():
        with open(out_path, encoding="utf-8") as f:
            progress_data = json.load(f)
    processed_ids   = set(progress_data.get("processed_video_ids", []))
    accumulated     = progress_data.get("_batches", [])

    # ── 1. 도시명 처리 ──
    pr("[1/4] 도시명 처리 중...")
    city_ko, city_local = resolve_city(city_input, lang, client, model)
    pr(f"  한국어: {city_ko} / 현지어: {city_local}\n")

    # ── 2. 영상 수집 ──
    pr("[2/4] YouTube 영상 수집 중...")
    videos = collect_and_filter(city_ko, city_local, lang, n_ko, n_local)
    videos = [v for v in videos if v["id"] not in processed_ids]
    total  = len(videos)
    pr(f"  처리할 영상: {total}개\n")

    stats = {"timedtext": 0, "whisper": 0, "none": 0}

    if total > 0:
        # ── 3. 자막 수집 ──
        pr("[3/4] 자막 수집 중...")
        transcript_start = time.time()

        for i, video in enumerate(videos, 1):
            title_short = video["title"][:45]
            pr(f"\n  [{i}/{total}] {title_short}")
            t0 = time.time()
            transcript, source = get_transcript(video)
            video["transcript"]        = transcript
            video["transcript_source"] = source
            stats[source] += 1
            elapsed = time.time() - t0

            if transcript:
                pr(f"    ✓ {source} ({len(transcript)}자) [{elapsed:.1f}초]")
            else:
                pr(f"    - 자막 없음 [{elapsed:.1f}초]")

        transcript_sec = time.time() - transcript_start
        pr(f"\n  자막 통계: timedtext {stats['timedtext']}개 / whisper {stats['whisper']}개 / 없음 {stats['none']}개")
        pr(f"  자막 소요: {transcript_sec/60:.1f}분")

        # 자막 중간 저장 (GPT 실패해도 자막 보존)
        save_json({
            "city": city_ko, "city_local": city_local, "lang": lang,
            "collected_at": date_str,
            "processed_video_ids": list(processed_ids),
            "_videos_with_transcripts": videos,
            "_batches": accumulated,
            "places": [],
        }, out_path)
        pr("")

        # ── 4. GPT 분석 ──
        pr("[4/4] GPT 분석 중...")
        total_batches = (total + GPT_BATCH_SIZE - 1) // GPT_BATCH_SIZE

        for b_start in range(0, total, GPT_BATCH_SIZE):
            batch     = videos[b_start:b_start + GPT_BATCH_SIZE]
            batch_num = b_start // GPT_BATCH_SIZE + 1
            pr(f"  배치 {batch_num}/{total_batches} ({len(batch)}개)...", end="")
            try:
                places, ti, to = analyze_batch(batch, city_ko, client, model)
                tok_in  += ti
                tok_out += to
                accumulated.append(places)
                processed_ids.update(v["id"] for v in batch)
                pr(f" {len(places)}개 장소 | 토큰 {ti+to:,}")

                save_json({
                    "city": city_ko, "city_local": city_local, "lang": lang,
                    "collected_at": date_str,
                    "processed_video_ids": list(processed_ids),
                    "_batches": accumulated,
                    "places": merge_places(accumulated),
                }, out_path)
            except Exception as e:
                pr(f" GPT 오류: {e}")
                time.sleep(5)

    # ── 최종 저장 ──
    final_places = merge_places(accumulated)
    food  = sum(1 for p in final_places if p["category"] == "food")
    hotel = sum(1 for p in final_places if p["category"] == "hotel")
    spot  = sum(1 for p in final_places if p["category"] == "spot")
    total_sec = time.time() - run_start
    cost_usd  = tok_in * 2.50 / 1_000_000 + tok_out * 10.00 / 1_000_000

    save_json({
        "city": city_ko, "city_local": city_local, "lang": lang,
        "collected_at": date_str,
        "stats": {
            "videos_processed": len(processed_ids),
            "places_total": len(final_places),
            "food": food, "hotel": hotel, "spot": spot,
            "transcript_timedtext": stats.get("timedtext", 0),
            "transcript_whisper":   stats.get("whisper", 0),
            "transcript_none":      stats.get("none", 0),
            "tokens_input":  tok_in,
            "tokens_output": tok_out,
            "cost_usd":  round(cost_usd, 4),
            "cost_krw":  round(cost_usd * 1400, 1),
            "elapsed_sec": round(total_sec, 1),
        },
        "places": final_places,
    }, out_path)

    pr(f"\n{'='*50}")
    pr(f"  완료!")
    pr(f"  총 소요      : {total_sec/60:.1f}분")
    pr(f"  추출 장소    : {len(final_places)}개 (맛집 {food} / 호텔 {hotel} / 관광지 {spot})")
    pr(f"  사용 토큰    : 입력 {tok_in:,} / 출력 {tok_out:,}")
    pr(f"  비용         : ${cost_usd:.4f} ≈ {round(cost_usd*1400)}원")
    pr(f"  저장 위치    : {out_path}")
    pr(f"{'='*50}\n")


if __name__ == "__main__":
    main()
