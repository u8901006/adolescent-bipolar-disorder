import { readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(__dirname, "..", "docs");

function generateIndex() {
  const files = readdirSync(docsDir)
    .filter((f) => f.startsWith("bipolar-") && f.endsWith(".html") && f !== "index.html")
    .sort()
    .reverse();

  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

  let linksHtml = "";
  for (const name of files.slice(0, 60)) {
    const dateStr = name.replace("bipolar-", "").replace(".html", "");
    let dateDisplay = dateStr;
    let weekday = "";
    try {
      const d = new Date(dateStr + "T00:00:00+08:00");
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      dateDisplay = `${y}年${m}月${day}日`;
      weekday = `週${weekdays[d.getDay()]}`;
    } catch { /* empty */ }
    linksHtml += `<li><a href="${name}">\uD83D\uDCC5 ${dateDisplay}（${weekday}）</a></li>\n`;
  }

  const total = files.length;

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Adolescent Bipolar Daily \u00B7 青少年雙相情緒障礙文獻日報</title>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; }
  .container { position: relative; z-index: 1; max-width: 640px; margin: 0 auto; padding: 80px 24px; }
  .logo { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { text-align: center; font-size: 24px; color: var(--text); margin-bottom: 8px; }
  .subtitle { text-align: center; color: var(--accent); font-size: 14px; margin-bottom: 48px; }
  .count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: var(--text); text-decoration: none; display: block; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; transition: all 0.2s; font-size: 15px; }
  a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  footer { margin-top: 56px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { display: inline; padding: 0; background: none; border: none; color: var(--muted); }
  footer a:hover { color: var(--accent); }
</style>
</head>
<body>
<div class="container">
  <div class="logo">\uD83E\uDDE0</div>
  <h1>Adolescent Bipolar Daily</h1>
  <p class="subtitle">青少年雙相情緒障礙文獻日報 \u00B7 每日自動更新</p>
  <p class="count">共 ${total} 期日報</p>
  <ul>${linksHtml}</ul>
  <footer>
    <p>Powered by PubMed + Zhipu AI \u00B7 <a href="https://github.com/u8901006/adolescent-bipolar-disorder">GitHub</a></p>
  </footer>
</div>
</body>
</html>`;

  writeFileSync(resolve(docsDir, "index.html"), html, "utf-8");
  console.error(`[INFO] Index page generated (${total} reports)`);
}

generateIndex();
