import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL_CHAIN = ["glm-5-turbo", "glm-4.7", "glm-4.7-flash"];
const MAX_TOKENS = 50000;
const TIMEOUT_MS = 480000;
const MAX_RETRIES = 3;

const SYSTEM_PROMPT = `你是專門分析青少年雙相情緒障礙（adolescent bipolar disorder）研究文獻的資深研究員。你的任務是：
1. 從提供的論文資料中，精準提取出臨床重要性與新穎性的論文
2. 每篇論文都必須提供繁體中文摘要、分類、以及 PICO 分析
3. 評估每篇論文的臨床實用性（高/中/低）
4. 確保輸出適合醫療專業人員快速閱讀

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業術語精確
- 每篇論文都包含：中文標題、一句話精要摘要、PICO 分析、臨床實用性、分類標籤
- 最後提供今日 TOP 3（最重要/最具臨床意義的論文）
- 輸出格式必須是純 JSON，不要用 markdown code block 包裹。`;

function buildUserPrompt(dateStr, paperCount, papersText) {
  return `以下是 ${dateStr} 從 PubMed 搜尋到的最新青少年雙相情緒障礙研究（共 ${paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block 包裹）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今日文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名稱",
      "summary": "一句話精要摘要（繁體中文，突出核心發現與臨床意涵）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "說明實用性的簡短一句話",
      "tags": ["標籤1", "標籤2"],
      "url": "文章連結",
      "emoji": "適當emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名稱",
      "summary": "一句話精要摘要",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "藥物治療": 3,
    "精神心理治療": 2
  }
}

以下是原始文獻資料：
${papersText}

請挑選最重要 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下分類中選擇：藥物治療、精神心理治療、自殺防治、成癮物質、焦慮症、強迫症、創傷後壓力症、睡眠與晝夜節律、神經影像、認知功能、遺傳學、家族風險、長期追蹤、診斷與鑑別診斷、社會決定因素、校園功能、家庭介入、數位精神醫學、人工智能、電生理、發炎標記、副作用與安全性、情緒調節、兒童與青少年精神醫學、亞洲研究、台灣研究、系統性回顧。
注意：輸出純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;
}

function robustJsonParse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline > -1) cleaned = cleaned.slice(firstNewline + 1);
    cleaned = cleaned.replace(/```\s*$/, "");
  }
  cleaned = cleaned.trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart > -1 && jsonEnd > jsonStart) {
      const candidate = cleaned.slice(jsonStart, jsonEnd + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        const fixed = candidate
          .replace(/,\s*([}\]])/g, "$1")
          .replace(/[\x00-\x1f]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? c : ""))
          .replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
        try {
          return JSON.parse(fixed);
        } catch {
          console.error("[WARN] Could not repair JSON, returning null");
          return null;
        }
      }
    }
    return null;
  }
}

async function callZhipuAPI(apiKey, papersData) {
  const dateStr = papersData.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const papersText = JSON.stringify(papersData.papers || [], null, 2);
  const prompt = buildUserPrompt(dateStr, papersData.count || 0, papersText);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const resp = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
            temperature: 0.3,
            top_p: 0.9,
            max_tokens: MAX_TOKENS,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (resp.status === 429) {
          const wait = 60000 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        resp.ok || (() => { throw new Error(`HTTP ${resp.status}: ${resp.statusText}`); })();

        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error("Empty response content");

        const result = robustJsonParse(content);
        if (!result) {
          console.error(`[WARN] JSON parse failed on attempt ${attempt + 1}`);
          if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        console.error(`[INFO] Analysis complete: ${result.top_picks?.length || 0} top picks, ${result.all_papers?.length || 0} total`);
        return result;
      } catch (e) {
        if (e.name === "TimeoutError") {
          console.error(`[WARN] ${model} timed out on attempt ${attempt + 1}`);
        } else {
          console.error(`[ERROR] ${model} failed: ${e.message}`);
        }
        if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateHtml(analysis) {
  const dateStr = analysis.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const parts = dateStr.split("-");
  const dateDisplay = parts.length === 3 ? `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日` : dateStr;
  const weekdayIdx = new Date(dateStr + "T00:00:00+08:00").getDay();
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const weekday = weekdays[weekdayIdx] || "";

  const summary = escapeHtml(analysis.market_summary || "");
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;

  let topPicksHtml = "";
  for (const pick of topPicks) {
    const tagsHtml = (pick.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const util = pick.clinical_utility || "中";
    const utilityClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    const pico = pick.pico || {};
    let picoHtml = "";
    if (pico.population || pico.intervention || pico.comparison || pico.outcome) {
      picoHtml = `
            <div class="pico-grid">
              <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(pico.population || "-")}</span></div>
              <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(pico.intervention || "-")}</span></div>
              <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(pico.comparison || "-")}</span></div>
              <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(pico.outcome || "-")}</span></div>
            </div>`;
    }
    topPicksHtml += `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${pick.rank || ""}</span>
            <span class="emoji-icon">${pick.emoji || "\uD83D\uDCD4"}</span>
            <span class="${utilityClass}">${escapeHtml(util)}實用性</span>
          </div>
          <h3>${escapeHtml(pick.title_zh || pick.title_en || "")}</h3>
          <p class="journal-source">${escapeHtml(pick.journal || "")} &middot; ${escapeHtml(pick.title_en || "")}</p>
          <p>${escapeHtml(pick.summary || "")}</p>
          ${picoHtml}
          <div class="card-footer">
            ${tagsHtml}
            <a href="${escapeHtml(pick.url || "#")}" target="_blank">閱讀原文 &rarr;</a>
          </div>
        </div>`;
  }

  let allPapersHtml = "";
  for (const paper of allPapers) {
    const tagsHtml = (paper.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const util = paper.clinical_utility || "中";
    const utilityClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    allPapersHtml += `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${paper.emoji || "\uD83D\uDCD4"}</span>
            <span class="${utilityClass} utility-sm">${escapeHtml(util)}</span>
          </div>
          <h3>${escapeHtml(paper.title_zh || paper.title_en || "")}</h3>
          <p class="journal-source">${escapeHtml(paper.journal || "")}</p>
          <p>${escapeHtml(paper.summary || "")}</p>
          <div class="card-footer">
            ${tagsHtml}
            <a href="${escapeHtml(paper.url || "#")}" target="_blank">PubMed &rarr;</a>
          </div>
        </div>`;
  }

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${escapeHtml(k)}</span>`).join("");
  let topicBarsHtml = "";
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const widthPct = Math.round((count / maxCount) * 100);
      topicBarsHtml += `
            <div class="topic-row">
              <span class="topic-name">${escapeHtml(topic)}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Adolescent Bipolar Daily &middot; 青少年雙相情緒障礙文獻日報 &middot; ${dateDisplay}（週${weekday}）</title>
<meta name="description" content="${dateDisplay} 青少年雙相情緒障礙文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: #fdf9f2; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .links-banner { margin-top: 48px; display: flex; flex-direction: column; gap: 12px; animation: fadeUp 0.5s ease 0.4s both; }
  .link-card { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .link-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .link-icon { font-size: 28px; flex-shrink: 0; }
  .link-info { flex: 1; }
  .link-name { font-size: 15px; font-weight: 700; color: var(--text); }
  .link-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .link-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } .links-banner { gap: 8px; } .link-card { padding: 14px 18px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">\uD83E\uDDE0</div>
    <div class="header-text">
      <h1>Adolescent Bipolar Daily &middot; 青少年雙相情緒障礙文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">\uD83D\uDCC5 ${dateDisplay}（週${weekday}）</span>
        <span class="badge badge-count">\uD83D\uDCDA ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>\uD83D\uDCCA 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">\u2B50</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ""}

  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">\uD83D\uDCC0</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : ""}

  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">\uD83D\uDCCA</span>主題分佈</div>${topicBarsHtml}</div>` : ""}

  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">\uD83C\uDFF7\uFE0F</span>關鍵字</div><div class="keywords">${keywordsHtml}</div></div>` : ""}

  <div class="links-banner">
    <a href="https://www.leepsyclinic.com/" class="link-card" target="_blank">
      <span class="link-icon">\uD83C\uDFE5</span>
      <span class="link-info">
        <span class="link-name">李政洋身心診所</span>
        <span class="link-desc">專業身心科醫療服務</span>
      </span>
      <span class="link-arrow">&rarr;</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="link-card" target="_blank">
      <span class="link-icon">\uD83D\uDCDC</span>
      <span class="link-info">
        <span class="link-name">訂閱電子報</span>
        <span class="link-desc">獲得最新精神醫學知識</span>
      </span>
      <span class="link-arrow">&rarr;</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="link-card" target="_blank">
      <span class="link-icon">\u2615</span>
      <span class="link-info">
        <span class="link-name">Buy Me a Coffee</span>
        <span class="link-desc">支持本研究日報持續運作</span>
      </span>
      <span class="link-arrow">&rarr;</span>
    </a>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：Zhipu AI GLM</span>
    <span><a href="https://github.com/u8901006/adolescent-bipolar-disorder">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

function updateProcessedPmids(papersData) {
  const dataPath = resolve(__dirname, "..", "data", "processed_pmids.json");
  let existing = new Set();
  if (existsSync(dataPath)) {
    try {
      const raw = JSON.parse(readFileSync(dataPath, "utf-8"));
      existing = new Set(Array.isArray(raw) ? raw : []);
    } catch { /* empty */ }
  }
  for (const p of papersData.papers || []) {
    if (p.pmid) existing.add(p.pmid);
  }
  writeFileSync(dataPath, JSON.stringify([...existing], null, 2), "utf-8");
  console.error(`[INFO] Updated processed PMIDs: ${existing.size} total`);
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = resolve(__dirname, "..", "papers.json");
  let outputPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) inputPath = resolve(__dirname, "..", args[++i]);
    if (args[i] === "--output" && args[i + 1]) outputPath = resolve(__dirname, "..", args[++i]);
  }

  const apiKey = process.env.ZHIPU_API_KEY || "";
  if (!apiKey) {
    console.error("[ERROR] No API key. Set ZHIPU_API_KEY env var.");
    process.exit(1);
  }

  if (!outputPath) {
    console.error("[ERROR] --output is required");
    process.exit(1);
  }

  const papersData = JSON.parse(readFileSync(inputPath, "utf-8"));

  if (!papersData.papers?.length) {
    console.error("[WARN] No papers found, generating empty report");
    const emptyAnalysis = {
      date: papersData.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
      market_summary: "今日 PubMed 暫無新的青少年雙相情緒障礙相關文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
    const html = generateHtml(emptyAnalysis);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, html, "utf-8");
    console.error(`[INFO] Empty report saved to ${outputPath}`);
    return;
  }

  const analysis = await callZhipuAPI(apiKey, papersData);
  if (!analysis) {
    console.error("[ERROR] AI analysis failed");
    process.exit(1);
  }

  const html = generateHtml(analysis);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, "utf-8");
  console.error(`[INFO] Report saved to ${outputPath}`);

  updateProcessedPmids(papersData);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
