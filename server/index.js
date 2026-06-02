require("dotenv").config();          // 프로젝트 루트의 .env 파일 자동 로드
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ── RAG 환경변수 ──────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;  // anon key (읽기 전용)

// 클라이언트 지연 초기화
let _gemini   = null;
let _supabase = null;

function getGemini() {
  if (!_gemini) {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY 환경변수가 설정되지 않았습니다.");
    _gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
  }
  return _gemini;
}

function getSupabase() {
  if (!_supabase) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("SUPABASE_URL 또는 SUPABASE_KEY 환경변수가 설정되지 않았습니다.");
    _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return _supabase;
}

// ── 인증키 (환경변수 우선, 하드코딩 폴백) ────────────────────
const DATA_GO_KR_KEY = process.env.DATA_GO_KR_KEY ||
  "74888f61216f843cfa35821955d4d11f3c18a4c2c0d766e8aabd9f9103dd82c5";
const YOUTH_KEY = process.env.YOUTH_KEY ||
  "54e72035-7ec7-4803-948a-c8d1a60cca5f";
const WELFARE_KEY = process.env.WELFARE_KEY ||
  "758954077e0c61c99e6fa5f2cc45de5a53723e91674d12ab64e72fcf67c93236";

const API_TIMEOUT = 5000; // 5초 타임아웃

// HTML 응답 여부 확인 (API 키 오류나 잘못된 URL일 때 HTML을 반환하는 경우)
function isValidJson(data) {
  if (data === null || data === undefined) return false;
  if (typeof data === "string" && data.trim().startsWith("<")) return false;
  return true;
}

// 공통 API 호출 래퍼
async function callApi(url, params) {
  try {
    const response = await axios.get(url, { params, timeout: API_TIMEOUT });
    return isValidJson(response.data) ? response.data : null;
  } catch (err) {
    console.error(`API 오류 [${url}]:`, err.message);
    return null;
  }
}

// ✅ 보조금24 API
// 실제 endpoint는 data.go.kr 포털에서 serviceKey 승인 후 확인
app.get("/api/subsidy", async (req, res) => {
  const data = await callApi("https://api.odcloud.kr/api/15113968/v1/uddi:e7a38fd0-e38f-4c1f-91b6-b8b0bcc0e8f1", {
    serviceKey: DATA_GO_KR_KEY,
    page: 1,
    perPage: 20,
  });
  res.json(data ?? { data: [] });
});

// ✅ 중앙부처복지서비스 API
app.get("/api/welfare/central", async (req, res) => {
  const data = await callApi("https://api.odcloud.kr/api/15090532/v1/uddi:2aa7a9de-b60c-494f-90eb-5d3ac47a7cdb", {
    serviceKey: WELFARE_KEY,
    page: 1,
    perPage: 20,
  });
  res.json(data ?? { data: [] });
});

// ✅ 지자체복지서비스 API
app.get("/api/welfare/local", async (req, res) => {
  const data = await callApi("https://api.odcloud.kr/api/15108347/v1/uddi:6b72c6e8-de73-415d-a4d4-97a3c3f93b5c", {
    serviceKey: WELFARE_KEY,
    page: 1,
    perPage: 20,
  });
  res.json(data ?? { data: [] });
});

// ✅ 공공임대주택 API
app.get("/api/housing", async (req, res) => {
  const data = await callApi("https://api.odcloud.kr/api/15058476/v1/uddi:f0c1f4c5-e29b-4f9d-a7c8-3c4a3f5d9f3e", {
    serviceKey: DATA_GO_KR_KEY,
    page: 1,
    perPage: 20,
  });
  res.json(data ?? { data: [] });
});

// 온통청년 — 카테고리별 병렬 수집 후 plcyNo 기준 중복 제거
const YOUTH_CATEGORIES = ["일자리", "주거", "교육", "금융", "복지문화"];
const YOUTH_PAGE_SIZE  = 100; // 카테고리당 최대 100건 → 최대 500건

async function fetchAllYouthPolicies() {
  const results = await Promise.allSettled(
    YOUTH_CATEGORIES.map((cat) =>
      callApi("https://www.youthcenter.go.kr/go/ythip/getPlcy", {
        apiKeyNm: YOUTH_KEY,
        pageNum:  1,
        pageSize: YOUTH_PAGE_SIZE,
        rtnType:  "json",
        lclsfNm:  cat,
      })
    )
  );

  const seen   = new Set();
  const merged = [];

  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const list = r.value?.result?.youthPolicyList ?? [];
    for (const item of list) {
      const id = item.plcyNo;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      merged.push(item);
    }
  }

  return { result: { youthPolicyList: merged } };
}

// ✅ 온통청년 청년정책 API — /go/ythip/getPlcy
//    응답 구조: { resultCode, result: { pagging, youthPolicyList: [...] } }
app.get("/api/youth", async (req, res) => {
  const data = await fetchAllYouthPolicies();
  res.json(data);
});

// ✅ 전체 공고 한번에 가져오기
// data.go.kr API(보조금24·복지서비스·공공임대)는 포털에서 정확한 endpoint URL과
// serviceKey 승인을 받은 후 아래 형식으로 추가:
//   callApi("https://api.odcloud.kr/api/{dataset_id}/v1/{resource_id}", { serviceKey, page, perPage })
app.get("/api/announcements", async (req, res) => {
  const youth = await fetchAllYouthPolicies();

  res.json({
    subsidy: null,
    central: null,
    local:   null,
    housing: null,
    youth,
  });
});

// ══════════════════════════════════════════════════════════════
//  RAG AI 채팅 엔드포인트
//  POST /api/ai/chat
//  검색 우선순위:
//    1) OpenAI 임베딩 + Supabase 벡터 검색 (embeddings 설정 시)
//    2) 온통청년 API 직접 키워드 검색 (폴백, OpenAI 없어도 동작)
// ══════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `
너는 '디딤온'의 AI 도우미야. 보호종료 자립준비청년(18~29세)의 자립을 따뜻하게 돕는 역할을 해.

[답변 원칙]
1. 반드시 아래에 제공된 [참고 문서] 내용만을 근거로 답변해.
2. 문서에 없는 정보는 절대 만들어내지 말고, "현재 제공된 정보에서는 찾을 수 없어요. 관련 기관에 직접 문의해보는 걸 추천해요 😊"라고 안내해.
3. 지원사업을 안내할 때는 반드시 다음 항목을 포함해:
   - 지원 대상 (누가 받을 수 있는지)
   - 지원 내용 (얼마나, 어떤 혜택인지)
   - 신청 방법 (어디서, 어떻게 신청하는지)
   - 마감일 또는 신청 기간 (있다면)
4. 말투는 따뜻하고 친근하게. 딱딱한 공문서 말투 대신 대화하듯 자연스럽게 써줘.
5. 답변은 200~400자 내외로 간결하게. 필요하면 ■ 또는 • 로 구조화해줘.
6. 마지막에는 "더 궁금한 게 있으면 언제든 물어봐요!" 같은 격려 문구를 자연스럽게 붙여줘.
`.trim();

// ── 벡터 검색 (Gemini 임베딩 + Supabase) ─────────────────────
// 주의: Supabase 문서도 Gemini text-embedding-004 (768차원)으로
//       재임베딩되어 있어야 정확한 검색이 가능합니다.

async function embedQuestion(question) {
  const model = getGemini().getGenerativeModel({ model: "text-embedding-004" });
  const result = await model.embedContent({
    content: { parts: [{ text: question }], role: "user" },
    taskType: "RETRIEVAL_QUERY",
  });
  return result.embedding.values;
}

async function searchByVector(embedding, userCategory) {
  const supabase = getSupabase();
  const filterCategory = userCategory?.length === 1 ? userCategory[0] : null;

  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    match_threshold: 0.4,
    match_count: 4,
    filter_category: filterCategory,
  });
  if (error) throw new Error(`Supabase: ${error.message}`);

  if (filterCategory && (!data || data.length < 2)) {
    const { data: fb, error: fbErr } = await supabase.rpc("match_documents", {
      query_embedding: embedding,
      match_threshold: 0.4,
      match_count: 4,
      filter_category: null,
    });
    if (fbErr) throw new Error(`Supabase fallback: ${fbErr.message}`);
    const seen = new Set((data || []).map((d) => d.id));
    const merged = [...(data || [])];
    for (const doc of fb || []) {
      if (!seen.has(doc.id)) merged.push(doc);
      if (merged.length >= 4) break;
    }
    return merged;
  }
  return data || [];
}

// ── 온통청년 API 키워드 검색 (폴백) ──────────────────────────

// 불필요한 조사·어미 제거 후 핵심 키워드 추출
function extractKeywords(question) {
  return question
    .split(/[\s,.!?]+/)
    .map((w) => w.replace(/[은는이가을를에서으로도의]+$/, ""))
    .filter((w) => w.length > 1 && !["있어", "해줘", "알려", "주세요", "어떤", "하나", "추천", "뭐가", "뭐야", "관련", "지원"].includes(w));
}

function getCategoryFromQuestion(question) {
  if (/주거|임대|전세|월세|주택|집/.test(question)) return "주거";
  if (/취업|일자리|고용|채용|구직|알바/.test(question)) return "일자리";
  if (/교육|학업|장학|학비|훈련/.test(question)) return "교육";
  if (/금융|저축|대출|수당|지원금|현금/.test(question)) return "금융";
  return "";
}

function mapYouthCategory(lclsfNm = "") {
  if (lclsfNm.includes("일자리")) return "employment";
  if (lclsfNm.includes("주거")) return "housing";
  if (lclsfNm.includes("교육")) return "education";
  if (lclsfNm.includes("금융")) return "finance";
  return "culture";
}

function formatYouthDate(ymd = "") {
  const t = ymd.trim();
  return t.length === 8 ? `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}` : (t || "");
}

function policyToDoc(policy) {
  const parts = [
    policy.plcyExplnCn,
    policy.plcySprtCn  && `■ 지원 내용\n${policy.plcySprtCn}`,
    policy.plcyAplyMthdCn && `■ 신청 방법\n${policy.plcyAplyMthdCn}`,
  ].filter(Boolean);

  return {
    content:  parts.join("\n\n") || policy.plcyNm,
    category: mapYouthCategory(policy.lclsfNm),
    metadata: {
      title:  policy.plcyNm,
      source: policy.sprvsnInstCdNm || "온통청년",
      date:   formatYouthDate(policy.bizPrdBgngYmd),
      end_date: formatYouthDate(policy.bizPrdEndYmd) || policy.bizPrdEtcCn || "",
      keywords: policy.plcyKywdNm || "",
    },
  };
}

async function searchByKeyword(question) {
  const data = await callApi("https://www.youthcenter.go.kr/go/ythip/getPlcy", {
    apiKeyNm: YOUTH_KEY, pageNum: 1, pageSize: 30, rtnType: "json",
  });

  const list = data?.result?.youthPolicyList;
  if (!list?.length) return [];

  const keywords = extractKeywords(question);
  const catHint  = getCategoryFromQuestion(question);

  const scored = list.map((p) => {
    const text = [p.plcyNm, p.plcyExplnCn, p.plcyKywdNm, p.lclsfNm, p.mclsfNm, p.plcySprtCn]
      .filter(Boolean).join(" ");

    let score = keywords.reduce((s, w) => s + (text.includes(w) ? 2 : 0), 0);
    if (catHint && p.lclsfNm?.includes(catHint)) score += 3;

    return { p, score };
  });

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  // 매칭이 전혀 없으면 전체에서 상위 4개라도 반환
  return top.map((x) => policyToDoc(x.p));
}

// ── Gemini 호출 ───────────────────────────────────────────────

async function callGemini(question, docs, userCategory) {
  const contextBlocks = docs
    .map((d, i) => {
      const meta = d.metadata ?? {};
      const period = meta.end_date
        ? `${meta.date || ""}${meta.date && meta.end_date ? " ~ " : ""}${meta.end_date}`
        : (meta.date || "-");
      return `[문서 ${i + 1}] 제목: ${meta.title ?? "-"} | 출처: ${meta.source ?? "미상"} | 기간: ${period}\n${d.content}`;
    })
    .join("\n\n---\n\n");

  const categoryHint = userCategory?.length > 0
    ? `\n\n사용자의 관심 분야: ${userCategory.join(", ")}`
    : "";

  const model = getGemini().getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: SYSTEM_PROMPT,
  });

  const result = await model.generateContent(
    `[참고 문서]\n${contextBlocks}${categoryHint}\n\n[질문]\n${question}`
  );

  return result.response.text();
}

// ✅ POST /api/ai/chat
app.post("/api/ai/chat", async (req, res) => {
  const { question, userCategory = [] } = req.body ?? {};

  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "question 필드가 필요합니다." });
  }

  const q = question.trim();

  try {
    let docs = [];
    let searchMode = "api";

    // 1순위: Gemini 임베딩 + Supabase 벡터 검색
    if (GEMINI_API_KEY && SUPABASE_URL && SUPABASE_KEY) {
      try {
        const embedding = await embedQuestion(q);
        docs = await searchByVector(embedding, userCategory);
        if (docs.length > 0) searchMode = "vector";
      } catch (vecErr) {
        console.warn(`[ai/chat] 벡터 검색 실패 (${vecErr.message}) → 키워드 검색으로 전환`);
      }
    }

    // 2순위: 온통청년 API 키워드 검색 (폴백)
    if (docs.length === 0) {
      docs = await searchByKeyword(q);
    }

    console.log(`[ai/chat] mode=${searchMode} docs=${docs.length} q="${q.slice(0, 30)}"`);

    if (docs.length === 0) {
      return res.json({
        answer: "죄송해요, 관련 정보를 찾지 못했어요. 더 구체적으로 질문해주시면 도움이 될 것 같아요 😊",
        sources: [],
      });
    }

    let answer;
    try {
      answer = await callGemini(q, docs, userCategory);
    } catch (genErr) {
      const genMsg = genErr.message ?? "";
      console.warn("[ai/chat] Gemini 생성 실패 →  문서 요약 폴백:", genMsg.slice(0, 80));

      // Gemini 오류 시 검색된 문서를 직접 요약해서 반환
      const fallback = docs
        .slice(0, 3)
        .map((d) => {
          const t = d.metadata?.title ?? "관련 정책";
          const src = d.metadata?.source ?? "";
          const period = [d.metadata?.date, d.metadata?.end_date].filter(Boolean).join(" ~ ");
          return `• ${t}${src ? ` (${src})` : ""}${period ? ` | ${period}` : ""}\n  ${d.content.slice(0, 150)}…`;
        })
        .join("\n\n");
      answer = `관련 정책 정보를 찾았어요 😊\n\n${fallback}\n\n더 자세한 내용은 각 기관에 문의해보세요!`;
    }

    const sources = [...new Set(docs.map((d) => d.metadata?.source).filter(Boolean))];
    res.json({ answer, sources });
  } catch (err) {
    const msg = err.message ?? "";
    console.error("[ai/chat] 오류:", msg);

    if (msg.includes("환경변수")) {
      return res.status(503).json({ error: `서버 설정 오류: ${msg}` });
    }
    if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota") || err.status === 429) {
      return res.status(429).json({ error: "RATE_LIMITED" });
    }
    if (
      msg.includes("API_KEY_SERVICE_BLOCKED") ||
      msg.includes("SERVICE_DISABLED") ||
      msg.includes("has not been used in project") ||
      msg.includes("API_KEY_INVALID") ||
      msg.includes("invalid api key") ||
      (err.status === 403)
    ) {
      return res.status(403).json({ error: "GEMINI_API_DISABLED" });
    }
    res.status(500).json({ error: "AI 응답 생성 중 오류가 발생했습니다." });
  }
});

// ══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});
