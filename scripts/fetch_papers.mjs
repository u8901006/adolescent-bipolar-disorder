import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const HEADERS = { "User-Agent": "AdolescentBipolarBot/1.0 (research aggregator)" };

const DISEASE_BLOCK = [
  '"Bipolar Disorder"[Mesh]',
  '"bipolar disorder"[tiab]',
  '"bipolar disorders"[tiab]',
  "bipolar[tiab]",
  '"bipolar depression"[tiab]',
  "mania[tiab]",
  "manic[tiab]",
  "hypomania[tiab]",
  "hypomanic[tiab]",
  "cyclothymi*[tiab]",
].join(" OR ");

const YOUTH_BLOCK = [
  '"Adolescent"[Mesh]',
  '"Child"[Mesh]',
  "adolescent*[tiab]",
  "teen*[tiab]",
  "teenager*[tiab]",
  "youth[tiab]",
  "youths[tiab]",
  "juvenile*[tiab]",
  "pediatric[tiab]",
  "paediatric[tiab]",
  "child*[tiab]",
  '"young people"[tiab]',
  '"early onset"[tiab]',
  '"childhood onset"[tiab]',
  '"adolescent onset"[tiab]',
].join(" OR ");

const HIGH_SPECIFICITY = [
  '"adolescent bipolar disorder"[tiab]',
  '"pediatric bipolar disorder"[tiab]',
  '"paediatric bipolar disorder"[tiab]',
  '"childhood bipolar disorder"[tiab]',
  '"early-onset bipolar disorder"[tiab]',
  '"juvenile bipolar disorder"[tiab]',
  '"youth bipolar disorder"[tiab]',
  '"bipolar disorder in adolescents"[tiab]',
  '"bipolar disorder in youth"[tiab]',
].join(" OR ");

function buildQuery(days) {
  const since = new Date(Date.now() - days * 86400000);
  const y = since.getUTCFullYear();
  const m = String(since.getUTCMonth() + 1).padStart(2, "0");
  const d = String(since.getUTCDate()).padStart(2, "0");
  const sinceStr = `${y}/${m}/${d}`;
  const datePart = `"${sinceStr}"[Date - Publication] : "3000"[Date - Publication]`;
  const core = `(${DISEASE_BLOCK}) AND (${YOUTH_BLOCK})`;
  const specific = `OR (${HIGH_SPECIFICITY})`;
  const exclude = 'NOT ("animals"[Mesh] NOT "humans"[Mesh])';
  return `(${core} ${specific}) AND ${datePart} ${exclude}`;
}

async function searchPapers(query, retmax = 50) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = `${PUBMED_FETCH}?db=pubmed&id=${pmids.join(",")}&retmode=xml`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    const xml = await resp.text();
    return parsePubMedXml(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function extractCdataTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}

function parsePubMedXml(xml) {
  const papers = [];
  const articleBlocks = xml.split(/<PubmedArticle>/).slice(1);

  for (const block of articleBlocks) {
    const medlineEnd = block.indexOf("</PubmedArticle>");
    const content = medlineEnd > 0 ? block.slice(0, medlineEnd) : block;

    const pmid = extractTag(content, "PMID");
    const title = extractCdataTag(content, "ArticleTitle") || extractTag(content, "ArticleTitle");

    const abstractSections = [];
    const absRe = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = absRe.exec(content)) !== null) {
      const labelMatch = absMatch[0].match(/Label="([^"]*)"/);
      const label = labelMatch ? labelMatch[1] : "";
      const text = absMatch[1].replace(/<[^>]+>/g, "").trim();
      if (label && text) abstractSections.push(`${label}: ${text}`);
      else if (text) abstractSections.push(text);
    }
    const abstract = abstractSections.join(" ").slice(0, 2000);

    const journal = extractTag(content, "Title");

    const year = extractTag(content, "Year");
    const month = extractTag(content, "Month");
    const day = extractTag(content, "Day");
    const dateStr = [year, month, day].filter(Boolean).join(" ");

    const keywords = [];
    const kwRe = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRe.exec(content)) !== null) {
      const kw = kwMatch[1].trim();
      if (kw) keywords.push(kw);
    }

    if (title) {
      papers.push({
        pmid,
        title,
        journal,
        date: dateStr,
        abstract,
        url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
        keywords,
      });
    }
  }
  return papers;
}

function loadProcessedPmids() {
  const path = resolve(__dirname, "..", "data", "processed_pmids.json");
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveProcessedPmids(pmids) {
  const path = resolve(__dirname, "..", "data", "processed_pmids.json");
  const arr = [...pmids];
  writeFileSync(path, JSON.stringify(arr, null, 2), "utf-8");
}

function getTaipeiDate() {
  const now = new Date(Date.now() + 8 * 3600000);
  return now.toISOString().slice(0, 10);
}

async function main() {
  const args = process.argv.slice(2);
  let days = 7;
  let maxPapers = 50;
  let outputPath = resolve(__dirname, "..", "papers.json");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) days = parseInt(args[++i], 10);
    if (args[i] === "--max-papers" && args[i + 1]) maxPapers = parseInt(args[++i], 10);
    if (args[i] === "--output" && args[i + 1]) outputPath = resolve(__dirname, "..", args[++i]);
  }

  const processedPmids = loadProcessedPmids();
  console.error(`[INFO] Already processed: ${processedPmids.size} PMIDs`);

  const query = buildQuery(days);
  console.error(`[INFO] Searching PubMed for last ${days} days...`);

  const pmids = await searchPapers(query, maxPapers);
  console.error(`[INFO] Found ${pmids.length} papers`);

  if (!pmids.length) {
    const output = { date: getTaipeiDate(), count: 0, papers: [] };
    writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
    console.error("[INFO] No papers found");
    return;
  }

  const papers = await fetchDetails(pmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const newPapers = papers.filter((p) => !processedPmids.has(p.pmid));
  console.error(`[INFO] New papers (not yet summarized): ${newPapers.length}`);

  const output = {
    date: getTaipeiDate(),
    count: newPapers.length,
    papers: newPapers,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved ${newPapers.length} new papers to ${outputPath}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
