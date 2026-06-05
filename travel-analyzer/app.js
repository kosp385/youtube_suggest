// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  selectedCats: new Set(['food', 'hotel', 'spot']),
  selectedLangs: new Set(['ko', 'local']),
  currentData: [],
  isRunning: false,
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // API 키 로컬스토리지 복원
  const savedApiKey = localStorage.getItem('openai_api_key') || localStorage.getItem('claude_api_key');
  const savedYtKey  = localStorage.getItem('yt_api_key');
  if (savedApiKey) document.getElementById('apiKey').value = savedApiKey;
  if (savedYtKey)  document.getElementById('ytKey').value  = savedYtKey;

  // API 키 자동 저장
  document.getElementById('apiKey').addEventListener('change', e => {
    localStorage.setItem('openai_api_key', e.target.value);
  });
  document.getElementById('ytKey').addEventListener('change', e => {
    localStorage.setItem('yt_api_key', e.target.value);
  });

  // 카테고리 버튼 토글
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleSet(state.selectedCats, btn.dataset.cat, btn, 1));
  });

  // 언어 버튼 토글
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleSet(state.selectedLangs, btn.dataset.lang, btn, 1));
  });

  // Enter 키로 분석 시작
  document.getElementById('cityInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') runAnalysis();
  });
});

function toggleSet(set, value, btn, minSize) {
  if (set.has(value)) {
    if (set.size > minSize) { set.delete(value); btn.classList.remove('active'); }
  } else {
    set.add(value);
    btn.classList.add('active');
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showState(id) {
  ['emptyState', 'loadingState', 'resultsState'].forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
}

function log(text, type = '') {
  const body = document.getElementById('logBody');
  const line = document.createElement('div');
  line.className = 'log-line ' + type;
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function setLogStatus(status, text) {
  const dot = document.getElementById('logDot');
  const title = document.getElementById('logTitle');
  dot.className = 'log-dot ' + status;
  title.textContent = text;
}

function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), duration);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resetUI() {
  showState('emptyState');
  state.currentData = [];
}

// ─── YouTube API ──────────────────────────────────────────────────────────────
async function searchYouTube(query, apiKey, maxResults = 10) {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const publishedAfter = oneYearAgo.toISOString();

  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults,
    publishedAfter,
    key: apiKey,
    relevanceLanguage: 'ko',
    order: 'relevance',
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) throw new Error(`YouTube API 오류: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

async function getVideoDetails(videoIds, apiKey) {
  const params = new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id: videoIds.join(','),
    key: apiKey,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
  if (!res.ok) throw new Error(`YouTube API 오류: ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

async function getCaptions(videoId, apiKey) {
  const params = new URLSearchParams({
    part: 'snippet',
    videoId,
    key: apiKey,
  });

  const res = await fetch(`https://www.googleapis.com/youtube/v3/captions?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.items || [];
}

// 자막 텍스트 가져오기 (timedtext 비공개 API + CORS 프록시, 실패 시 null)
async function fetchTranscript(videoId) {
  for (const lang of ['ko', 'ja', 'en']) {
    try {
      const targetUrl = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}&fmt=json3`;
      const proxyUrl  = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.events) continue;
      const text = data.events
        .filter(e => e.segs)
        .flatMap(e => e.segs.map(s => s.utf8 || ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 80) return text.slice(0, 3000);
    } catch (_) { /* timeout or CORS, try next lang */ }
  }
  return null;
}

// 협찬 의심 키워드 필터
function isSponsoredSuspect(title, description) {
  const keywords = [
    '협찬', '광고', 'AD', 'ad', 'Sponsored', 'sponsored', 'PR', '유료광고',
    '제품 제공', '협조', 'paid partnership', '#ad', '#sponsored', '#협찬',
  ];
  const text = (title + ' ' + description).toLowerCase();
  return keywords.some(k => text.includes(k.toLowerCase()));
}

// ─── OpenAI GPT API ───────────────────────────────────────────────────────────
async function analyzeWithClaude(videosText, city, categories, apiKey) {
  const catLabels = [];
  if (categories.has('food'))  catLabels.push('맛집/레스토랑');
  if (categories.has('hotel')) catLabels.push('숙소/호텔');
  if (categories.has('spot'))  catLabels.push('관광지/명소');

  const prompt = `아래는 "${city}" 여행 유튜브 영상들의 제목·설명·자막 정보야.

${catLabels.join(', ')} 카테고리에 해당하는 장소를 모두 추출해줘.
같은 장소가 여러 채널에서 언급됐다면 하나의 항목으로 합치고, 채널별 리뷰를 reviews 배열에 각각 담아줘.

무시해야 할 것:
- 전자기기, 앱, 식품 등 여행지와 무관한 제품 협찬·광고

## 영상 데이터:
${videosText}

## 출력 형식 (JSON 배열만 출력, 다른 텍스트 없이):
[
  {
    "name": "장소명 (한국어)",
    "nameLocal": "현지어 장소명 (있으면)",
    "category": "food | hotel | spot",
    "price": "가격대 (예: ¥1,000~, 무료, 중간 등)",
    "rating": "언급된 평점 또는 추정 (예: 4.7)",
    "tips": "종합 방문 팁 (있으면)",
    "isSponsored": false,
    "reviews": [
      {
        "channel": "채널명",
        "experience": "이 채널에서 언급된 경험 (1-2문장)",
        "sentiment": "긍정 | 중립 | 부정",
        "confidence": 0.0
      }
    ]
  }
]

confidence는 0.0~1.0. 확실하지 않은 정보는 null로 표시.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || `OpenAI API 오류: ${res.status}`);
  }

  const data = await res.json();
  const text = data.choices[0].message.content.trim();

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('GPT 응답에서 JSON을 찾을 수 없습니다');
  return JSON.parse(jsonMatch[0]);
}

// ─── 도시명 검증 ─────────────────────────────────────────────────────────────
async function validateCity(city, lang, apiKey) {
  const langNames = {
    Japanese: '일본어', Thai: '태국어', English: '영어', French: '프랑스어',
    Spanish: '스페인어', Italian: '이탈리아어', Vietnamese: '베트남어', Chinese: '중국어',
  };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        messages: [{ role: 'user', content:
          `여행 앱 도시명 입력: "${city}" (현지 언어 설정: ${langNames[lang] || lang})

오타나 비슷한 발음으로 입력된 도시명인지 판단하고, 올바른 도시명을 추정해줘.

JSON만 반환 (다른 텍스트 없이):
{
  "normalizedCity": "올바른 한국어 도시명",
  "isTypo": true 또는 false,
  "confirmMessage": "오타 의심 시에만 작성. 해당 나라 문화에 맞는 자연스러운 한국어로. 예: 혹시 일본 오사카(大阪)를 찾으신 건가요? / isTypo false면 null"
}` }],
      }),
    });
    if (!res.ok) return { normalizedCity: city, isTypo: false };
    const data = await res.json();
    const match = data.choices[0].message.content.trim().match(/\{[\s\S]*\}/);
    if (!match) return { normalizedCity: city, isTypo: false };
    return JSON.parse(match[0]);
  } catch {
    return { normalizedCity: city, isTypo: false };
  }
}

function showConfirm(message) {
  return new Promise(resolve => {
    const body = document.getElementById('logBody');
    const div = document.createElement('div');
    div.className = 'log-confirm';
    div.innerHTML = `
      <span class="confirm-msg">${message}</span>
      <div class="confirm-btns">
        <button class="confirm-btn confirm-yes">예</button>
        <button class="confirm-btn confirm-no">아니오 (다시 입력)</button>
      </div>`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    div.querySelector('.confirm-yes').addEventListener('click', () => { div.remove(); resolve(true); });
    div.querySelector('.confirm-no').addEventListener('click', () => { div.remove(); resolve(false); });
  });
}

// ─── 도시명 현지어 번역 ────────────────────────────────────────────────────────
async function translateCityName(city, targetLang, apiKey) {
  const langNames = {
    Japanese: '일본어', Thai: '태국어', English: '영어', French: '프랑스어',
    Spanish: '스페인어', Italian: '이탈리아어', Vietnamese: '베트남어', Chinese: '중국어(간체)',
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 20,
      messages: [{ role: 'user', content: `"${city}"를 ${langNames[targetLang]}로 번역해줘. 도시명만 답해줘. 예: 오사카 → 大阪` }],
    }),
  });
  if (!res.ok) return city;
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ─── Main Analysis ────────────────────────────────────────────────────────────
async function runAnalysis() {
  const city    = document.getElementById('cityInput').value.trim();
  const apiKey  = document.getElementById('apiKey').value.trim();
  const ytKey   = document.getElementById('ytKey').value.trim();
  const lang    = document.getElementById('localLang').value;

  if (!city) { showToast('도시명을 입력해주세요'); document.getElementById('cityInput').focus(); return; }
  if (!apiKey) { showToast('Claude API 키를 입력해주세요'); document.getElementById('apiKey').focus(); return; }
  if (!ytKey) { showToast('YouTube API 키를 입력해주세요'); document.getElementById('ytKey').focus(); return; }
  if (state.isRunning) return;

  state.isRunning = true;
  document.getElementById('runBtn').disabled = true;
  document.getElementById('logBody').innerHTML = '';
  showState('loadingState');
  setLogStatus('running', '분석 중...');

  try {
    // 도시명 검증
    log(`[검증] 도시명 확인 중...`);
    const validation = await validateCity(city, lang, apiKey);
    let resolvedCity = validation.normalizedCity || city;

    if (validation.isTypo && validation.confirmMessage) {
      const confirmed = await showConfirm(validation.confirmMessage);
      if (!confirmed) {
        state.isRunning = false;
        document.getElementById('runBtn').disabled = false;
        showState('emptyState');
        document.getElementById('cityInput').value = '';
        document.getElementById('cityInput').focus();
        return;
      }
      log(`[검증] "${city}" → "${resolvedCity}" 수정`, 'ok');
    } else {
      log(`[검증] "${resolvedCity}" 확인`, 'ok');
    }

    const cats = state.selectedCats;
    const langs = state.selectedLangs;
    const catNames = { food: '맛집', hotel: '호텔', spot: '관광지' };
    const selectedCatNames = [...cats].map(c => catNames[c]).join(', ');

    // 검색 쿼리 생성
    const queries = [];

    // 현지어 검색 시 도시명도 번역
    let localCity = resolvedCity;
    if (langs.has('local')) {
      log(`[번역] "${resolvedCity}" → ${lang}로 번역 중...`);
      localCity = await translateCityName(resolvedCity, lang, apiKey);
      log(`[번역] "${localCity}"`, 'ok');
    }

    const langMap = {
      Japanese: { food: `${localCity} グルメ おすすめ`, hotel: `${localCity} ホテル おすすめ`, spot: `${localCity} 観光スポット` },
      Thai:     { food: `${localCity} ร้านอาหาร แนะนำ`, hotel: `${localCity} โรงแรม แนะนำ`, spot: `${localCity} สถานที่ท่องเที่ยว` },
      English:  { food: `${localCity} best restaurants`, hotel: `${localCity} best hotels`, spot: `${localCity} tourist attractions` },
      French:   { food: `${localCity} meilleurs restaurants`, hotel: `${localCity} meilleurs hôtels`, spot: `${localCity} attractions touristiques` },
      Spanish:  { food: `${localCity} mejores restaurantes`, hotel: `${localCity} mejores hoteles`, spot: `${localCity} atracciones` },
      Italian:  { food: `${localCity} migliori ristoranti`, hotel: `${localCity} migliori hotel`, spot: `${localCity} attrazioni` },
      Vietnamese: { food: `${localCity} quán ăn ngon`, hotel: `${localCity} khách sạn đẹp`, spot: `${localCity} địa điểm du lịch` },
      Chinese:  { food: `${localCity} 美食推荐`, hotel: `${localCity} 酒店推荐`, spot: `${localCity} 旅游景点` },
    };

    if (langs.has('ko')) {
      cats.forEach(cat => {
        queries.push({ q: `${resolvedCity} ${catNames[cat]} 추천`, label: `한국어 ${catNames[cat]}` });
      });
    }
    if (langs.has('local') && langMap[lang]) {
      cats.forEach(cat => {
        queries.push({ q: langMap[lang][cat], label: `현지어 ${catNames[cat]}` });
      });
    }

    log(`[시작] "${resolvedCity}" 분석 · ${selectedCatNames} · ${queries.length}개 쿼리`);
    await sleep(300);

    // 영상 수집
    let allVideos = [];
    let totalFound = 0;
    let sponsoredCount = 0;

    for (const query of queries) {
      log(`[YouTube] "${query.q}" 검색 중...`);
      try {
        const items = await searchYouTube(query.q, ytKey, 8);
        totalFound += items.length;
        log(`[YouTube] ${items.length}개 발견 (${query.label})`, 'ok');

        // 영상 상세 정보
        const ids = items.map(v => v.id.videoId).filter(Boolean);
        if (ids.length > 0) {
          const details = await getVideoDetails(ids, ytKey);
          // 자막 병렬 fetch (최대 5개, 실패 허용)
          const topIds = ids.slice(0, 5);
          const transcripts = await Promise.all(topIds.map(id => fetchTranscript(id)));
          const transcriptMap = Object.fromEntries(topIds.map((id, i) => [id, transcripts[i]]));
          const transcriptCount = transcripts.filter(Boolean).length;
          if (transcriptCount > 0) log(`[자막] ${transcriptCount}/${topIds.length}개 자막 수집`, 'ok');

          details.forEach(v => {
            const title = v.snippet?.title || '';
            const desc  = v.snippet?.description || '';
            const isSponsored = isSponsoredSuspect(title, desc);
            if (isSponsored) {
              sponsoredCount++;
              log(`[필터] 협찬 의심: "${title.slice(0, 40)}..."`, 'warn');
            }
            allVideos.push({
              id: v.id,
              title,
              description: desc.slice(0, 500),
              transcript: transcriptMap[v.id] || null,
              channelTitle: v.snippet?.channelTitle || '',
              publishedAt: v.snippet?.publishedAt || '',
              viewCount: v.statistics?.viewCount || '0',
              likeCount: v.statistics?.likeCount || '0',
              isSponsored,
              lang: query.label,
            });
          });
        }
        await sleep(200);
      } catch (e) {
        log(`[오류] ${query.label} 검색 실패: ${e.message}`, 'err');
      }
    }

    const validVideos = allVideos.filter(v => !v.isSponsored);
    log(`[필터] 총 ${totalFound}개 → 협찬 ${sponsoredCount}개 제외 → ${validVideos.length}개 분석 대상`, 'info');
    await sleep(400);

    if (validVideos.length === 0) {
      throw new Error('분석 가능한 영상이 없습니다. YouTube API 키를 확인해주세요.');
    }

    // Claude 분석
    log(`[GPT] ${validVideos.length}개 영상 분석 중...`);
    await sleep(300);

    const withTranscript = validVideos.filter(v => v.transcript).length;
    if (withTranscript > 0) log(`[자막] 총 ${withTranscript}개 영상 자막 포함`, 'info');

    const videosText = validVideos.map((v, i) => {
      const base = `[영상 ${i + 1}] (${v.lang})\n제목: ${v.title}\n채널: ${v.channelTitle}\n설명: ${v.description}\n조회수: ${Number(v.viewCount).toLocaleString()}`;
      return v.transcript ? `${base}\n자막: ${v.transcript}` : base;
    }).join('\n\n---\n\n');

    const places = await analyzeWithClaude(videosText, resolvedCity, cats, apiKey);
    log(`[GPT] ${places.length}개 장소 추출 완료`, 'ok');
    await sleep(300);

    // 데이터 저장
    state.currentData = places.map(p => ({
      ...p,
      city: resolvedCity,
      analyzedAt: new Date().toISOString(),
      videoCount: validVideos.length,
      totalVideoCount: totalFound,
      sponsoredFiltered: sponsoredCount,
    }));

    log(`[완료] 분석 성공! ${places.length}개 추천 장소`, 'ok');
    setLogStatus('done', '분석 완료');
    await sleep(600);

    renderResults(resolvedCity, state.currentData, totalFound, sponsoredCount, validVideos.length);

  } catch (e) {
    log(`[오류] ${e.message}`, 'err');
    setLogStatus('error', '오류 발생');
    showToast('오류: ' + e.message, 4000);
  } finally {
    state.isRunning = false;
    document.getElementById('runBtn').disabled = false;
  }
}

// ─── Demo Mode ────────────────────────────────────────────────────────────────
const DEMO_DATA = {
  city: '도쿄',
  totalVideoCount: 48,
  sponsoredFiltered: 3,
  videoCount: 45,
  analyzedAt: new Date().toISOString(),
  places: [
    { name: '이치란 라멘 시부야점', nameLocal: '一蘭 渋谷店', category: 'food', reason: '진한 돈코츠 국물과 1인 칸막이 좌석이 특징인 라멘 전문점. 현지 유튜버와 한국 여행자 모두 도쿄 필수 방문지로 손꼽음. 심야에도 줄을 서는 인기 맛집.', price: '¥980~', rating: '4.7', tips: '피크타임 저녁 7~9시는 대기 필수. 오픈 직후나 자정 이후 방문 추천.', mentionCount: 8, isSponsored: false },
    { name: '츠키지 장외시장', nameLocal: '築地場外市場', category: 'food', reason: '새벽부터 열리는 신선한 해산물 시장. 참치 덮밥과 굴구이가 특히 인기. 현지 유튜버들이 "도쿄 아침 코스 1순위"로 꼽는 곳으로, 일찍 방문할수록 신선도가 좋음.', price: '¥1,500~', rating: '4.8', tips: '오전 8~10시 방문 권장. 일부 가게는 월요일 휴무.', mentionCount: 11, isSponsored: false },
    { name: '긴자 스시 코바야시', nameLocal: '銀座 寿司小林', category: 'food', reason: '미쉐린 1스타 오마카세 스시집. 현지 미식 유튜버들이 "도쿄 최고의 가성비 오마카세"로 소개. 계절 식재료를 활용한 코스가 화제.', price: '¥15,000~', rating: '4.9', tips: '최소 1개월 전 예약 필수. 영어 메뉴 없음 — 구글 번역 준비.', mentionCount: 5, isSponsored: false },
    { name: '파크 하얏트 도쿄', nameLocal: 'Park Hyatt Tokyo', category: 'hotel', reason: '영화 "사랑도 통역이 되나요" 배경지로 유명한 신주쿠 럭셔리 호텔. 52층 뷰가 압도적이며 뉴욕 바의 야경은 도쿄 최고 수준. 한국 여행 유튜버 단골 추천 숙소.', price: '¥50,000~', rating: '4.9', tips: '뉴욕 바는 투숙객이 아니어도 이용 가능. 일몰 시간대 방문 추천.', mentionCount: 9, isSponsored: false },
    { name: '도미 인 아키하바라', nameLocal: 'ドーミーイン秋葉原', category: 'hotel', reason: '가성비 좋은 일본 비즈니스 호텔 체인. 천연온천 노천탕과 심야 라멘 서비스가 포함되어 있어 한국 여행자들에게 인기. 아키하바라와 우에노 접근성이 좋음.', price: '¥10,000~', rating: '4.5', tips: '천연온천은 23시까지. 체크인 시 라멘 쿠폰 수령 가능.', mentionCount: 6, isSponsored: false },
    { name: '센소지', nameLocal: '浅草寺', category: 'spot', reason: '도쿄에서 가장 오래된 사원으로 아사쿠사의 상징. 이른 아침 방문 시 인파가 적고 사진이 잘 찍힌다는 팁이 영상마다 공통으로 등장. 나카미세 거리 쇼핑과 함께 코스 추천.', price: '무료', rating: '4.6', tips: '오전 7시 이전 방문 시 관광객 없이 한산. 운세 뽑기(오미쿠지) 체험 추천.', mentionCount: 14, isSponsored: false },
    { name: '팀랩 플래닛 도요스', nameLocal: 'teamLab Planets TOYOSU', category: 'spot', reason: '몰입형 디지털 아트 전시관. 현지 SNS와 한국 여행 유튜버 모두 "도쿄 필수 체험"으로 꼽으며, 특히 수면 위를 걷는 체험이 화제. 비주얼 콘텐츠에 최적화된 공간.', price: '¥3,200', rating: '4.8', tips: '주말은 2~3주 전 사전 예약 필수. 흰 양말 지참 권장.', mentionCount: 10, isSponsored: false },
    { name: '신주쿠 골든가이', nameLocal: '新宿ゴールデン街', category: 'spot', reason: '좁은 골목에 200여 개 소규모 바가 밀집한 레트로 거리. 현지 유튜버들이 "관광객이 모르는 신주쿠"로 소개. 각 바마다 독특한 테마와 마스터가 있어 로컬 경험 가능.', price: '¥1,000~', rating: '4.5', tips: '대부분 바는 저녁 7시 이후 오픈. 1인 입장비(チャージ) ¥500~1,000 별도.', mentionCount: 7, isSponsored: false },
  ],
};

async function runDemo() {
  if (state.isRunning) return;
  state.isRunning = true;
  document.getElementById('demoBtn').disabled = true;
  document.getElementById('logBody').innerHTML = '';
  showState('loadingState');
  setLogStatus('running', '데모 실행 중...');

  log('[데모] API 없이 샘플 데이터로 실행합니다');
  await sleep(500);
  log('[YouTube] "도쿄 맛집 추천" 검색 중...');
  await sleep(700);
  log('[YouTube] 18개 발견 (한국어 맛집)', 'ok');
  await sleep(400);
  log('[YouTube] "도쿄 호텔 추천" 검색 중...');
  await sleep(600);
  log('[YouTube] 15개 발견 (한국어 호텔)', 'ok');
  await sleep(400);
  log('[YouTube] "東京 グルメ おすすめ" 검색 중...');
  await sleep(700);
  log('[YouTube] 15개 발견 (현지어 맛집)', 'ok');
  await sleep(300);
  log('[필터] 협찬 의심: "【PR】銀座最高級レストラン紹介..."', 'warn');
  log('[필터] 협찬 의심: "【AD】도쿄 호텔 협찬 리뷰..."', 'warn');
  log('[필터] 협찬 의심: "Sponsored: Tokyo Best Hotels..."', 'warn');
  await sleep(400);
  log('[필터] 총 48개 → 협찬 3개 제외 → 45개 분석 대상', 'info');
  await sleep(500);
  log('[Claude] 45개 영상 분석 중...');
  await sleep(1200);
  log('[Claude] 8개 장소 추출 완료', 'ok');
  await sleep(300);
  log('[완료] 분석 성공! 8개 추천 장소', 'ok');
  setLogStatus('done', '분석 완료');
  await sleep(600);

  state.currentData = DEMO_DATA.places.map(p => ({
    ...p,
    city: DEMO_DATA.city,
    analyzedAt: DEMO_DATA.analyzedAt,
    videoCount: DEMO_DATA.videoCount,
    totalVideoCount: DEMO_DATA.totalVideoCount,
    sponsoredFiltered: DEMO_DATA.sponsoredFiltered,
  }));

  renderResults(DEMO_DATA.city, state.currentData, DEMO_DATA.totalVideoCount, DEMO_DATA.sponsoredFiltered, DEMO_DATA.videoCount);
  state.isRunning = false;
  document.getElementById('demoBtn').disabled = false;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderResults(city, data, totalVideos, sponsoredCount, analyzedVideos) {
  document.getElementById('resultsCity').textContent = `${city} 추천 장소`;
  document.getElementById('resultsMeta').textContent =
    `영상 ${totalVideos}개 검색 · 협찬 ${sponsoredCount}개 필터링 · ${analyzedVideos}개 분석 · ${data.length}개 장소 추출`;

  const food  = data.filter(p => p.category === 'food').length;
  const hotel = data.filter(p => p.category === 'hotel').length;
  const spot  = data.filter(p => p.category === 'spot').length;

  document.getElementById('statsRow').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">추천 장소</div>
      <div class="stat-val">${data.length}</div>
      <div class="stat-sub">총 추출</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">맛집</div>
      <div class="stat-val">${food}</div>
      <div class="stat-sub">식당 · 카페</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">호텔</div>
      <div class="stat-val">${hotel}</div>
      <div class="stat-sub">숙소 · 리조트</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">관광지</div>
      <div class="stat-val">${spot}</div>
      <div class="stat-sub">명소 · 체험</div>
    </div>
  `;

  renderPlaces(data);
  showState('resultsState');
}

function renderPlaces(data) {
  const badgeClass = { food: 'badge-food', hotel: 'badge-hotel', spot: 'badge-spot' };
  const badgeLabel = { food: '맛집', hotel: '호텔', spot: '관광지' };
  const sentimentIcon  = { '긍정': 'ti-mood-smile', '중립': 'ti-mood-neutral', '부정': 'ti-mood-sad' };
  const sentimentColor = { '긍정': '#4ade80', '중립': 'var(--text-3)', '부정': '#f87171' };

  document.getElementById('placesGrid').innerHTML = data.map(p => {
    const reviews = Array.isArray(p.reviews) ? p.reviews : [];
    const mentionCount = reviews.length || p.mentionCount || 0;

    const reviewsHtml = reviews.map(r => {
      const conf = r.confidence != null ? Math.round(r.confidence * 100) : null;
      const confColor = r.confidence >= 0.8 ? '#4ade80' : r.confidence >= 0.5 ? 'var(--amber)' : '#f87171';
      return `
        <div class="review-item">
          <div class="review-header">
            <span class="review-channel"><i class="ti ti-brand-youtube"></i>${r.channel || '알 수 없음'}</span>
            <div style="display:flex;gap:8px;align-items:center;">
              ${r.sentiment ? `<span style="font-size:11px;color:${sentimentColor[r.sentiment] || 'var(--text-3)'}"><i class="ti ${sentimentIcon[r.sentiment] || 'ti-mood-neutral'}" style="font-size:12px;vertical-align:-2px;margin-right:2px;"></i>${r.sentiment}</span>` : ''}
              ${conf != null ? `<span style="font-size:11px;color:${confColor}">${conf}%</span>` : ''}
            </div>
          </div>
          <div class="review-text">${r.experience || ''}</div>
        </div>`;
    }).join('');

    return `
    <div class="place-card" data-cat="${p.category}">
      <div class="place-card-header">
        <div>
          <div class="place-name">${p.name}</div>
          ${p.nameLocal ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px;">${p.nameLocal}</div>` : ''}
        </div>
        <span class="badge ${badgeClass[p.category] || ''}">${badgeLabel[p.category] || p.category}</span>
      </div>
      <div class="place-meta-row">
        ${p.rating ? `<span class="place-meta-item"><i class="ti ti-star"></i>${p.rating}</span>` : ''}
        ${p.price  ? `<span class="place-meta-item"><i class="ti ti-cash"></i>${p.price}</span>` : ''}
        ${mentionCount ? `<span class="place-meta-item"><i class="ti ti-video"></i>${mentionCount}개 채널</span>` : ''}
        ${p.isSponsored ? `<span class="place-meta-item" style="color:var(--amber)"><i class="ti ti-alert-triangle"></i>협찬 의심</span>` : ''}
      </div>
      ${reviews.length ? `<div class="reviews-list">${reviewsHtml}</div>` : ''}
      ${p.tips ? `<div class="place-tips"><i class="ti ti-bulb" style="font-size:13px;vertical-align:-2px;margin-right:4px;"></i>${p.tips}</div>` : ''}
    </div>`;
  }).join('');
}

function filterResults(cat, btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const filtered = cat === 'all' ? state.currentData : state.currentData.filter(p => p.category === cat);
  renderPlaces(filtered);
}

// ─── Export ───────────────────────────────────────────────────────────────────
function exportJSON() {
  if (!state.currentData.length) { showToast('저장할 데이터가 없습니다'); return; }
  const json = JSON.stringify(state.currentData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `travel_${state.currentData[0]?.city || 'data'}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('JSON 파일로 저장되었습니다');
}

async function copyJSON() {
  if (!state.currentData.length) { showToast('복사할 데이터가 없습니다'); return; }
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.currentData, null, 2));
    showToast('클립보드에 복사되었습니다');
  } catch (e) {
    showToast('복사 실패: ' + e.message);
  }
}
