/* =========================================================================
 * 施策取り込みツール（PDF → measures.js スニペット生成）— UI部分
 * 抽出ロジックは ../assets/js/extract.js (window.CTAExtract) を共用。
 * ========================================================================= */

const PREVIEW_METRIC_LABELS = {
  mcvr: "MCVR", ef: "EF完了率", cvr: "CVR", ctr: "CTR",
  significance: "有意差", sampleSize: "サンプル数"
};

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + (kind || "");
}

function renderPreview(m) {
  const badge = { win: ["✅", "勝ち"], draw: ["➖", "引き分け"], loss: ["❌", "負け"] }[m.result];
  const metricEntries = Object.entries(m.metrics).slice(0, 3);
  const metaHTML = metricEntries.map(([k, v]) => {
    const short = String(v).split("（")[0].split("(")[0].trim();
    return `<div class="meta-item"><div class="meta-lbl">${esc(PREVIEW_METRIC_LABELS[k] || k)}</div><div class="meta-val">${esc(short)}</div></div>`;
  }).join("");
  const list = (a) => a.length ? `<ul class="blk-list">${a.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : '<p class="muted">（なし）</p>';

  $("preview").innerHTML = `
    <div class="card-wrap" style="max-width:300px">
      <div class="card"><div class="card-body">
        <div class="card-top">
          <span class="result-badge ${m.result}">${badge[0]} ${badge[1]}</span>
          <span class="type-tag">${esc(m.type)}</span>
          <span class="card-id">${esc(m.id)}</span>
        </div>
        <div class="card-title">${esc(m.title)}</div>
        <div class="card-period">📅 ${esc(m.period)}</div>
        <div class="card-meta">${metaHTML}</div>
      </div></div>
    </div>
    <div class="detail">
      <div class="detail-sec"><h4>仮説</h4><p>${esc(m.hypothesis)}</p></div>
      <div class="detail-sec"><h4>📋 事実（機械抽出）</h4>${list(m.factuals)}</div>
      <div class="detail-sec"><h4>🤔 AI推論候補（考察の自動仕分け）</h4>${list(m.hypothesisInsights)}</div>
      <div class="detail-sec"><h4>🎯 要因サマリ</h4><p>${esc(m.rootCause)}</p></div>
      <div class="detail-sec"><h4>次アクション</h4>${list(m.nextActions)}</div>
    </div>`;
}

function buildWarnings(m) {
  const w = [];
  w.push("<strong>判定（勝ち/負け）</strong>はPDFに無いため自動推定です（案C＝採用判断で確定してください）");
  w.push("<strong>事実 vs AI推論の仕分け</strong>は語尾での粗い自動分類です。必ず人＋Claudeで見直してください");
  w.push("<strong>デザイン観点(designInsights)</strong>は自動生成不可。CTユーザー前提で追記が必要です");
  if (m.type === "要分類") w.push("<strong>施策タイプ</strong>を推定できませんでした（\"要分類\"）");
  if (/要記入/.test(m.id)) w.push("<strong>施策No.</strong>を抽出できませんでした");
  if (/要記入/.test(m.period)) w.push("<strong>検証期間</strong>を抽出できませんでした");
  if (Object.keys(m.metrics).some(k => /改善率・要確認/.test(m.metrics[k])))
    w.push("<strong>改善率</strong>はシートの分母定義が不明なため \"要確認\" 付き（A比か前後比かを確認）");
  return w;
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) { setStatus("PDFファイルを選んでください。", "err"); return; }
  if (!window.CTAExtract) { setStatus("抽出ロジック(extract.js)の読み込みに失敗しました。", "err"); return; }
  setStatus("解析中… " + file.name, "");
  try {
    const buf = await file.arrayBuffer();
    const measure = await CTAExtract.buildMeasure(buf, file.name);
    renderPreview(measure);
    $("snippet").value = CTAExtract.toSnippet(measure);
    $("warnings").innerHTML = buildWarnings(measure).map(x => `<li>${x}</li>`).join("");
    $("result-area").style.display = "";
    setStatus(`抽出完了: ${measure.id}（${file.name}）— 下のスニペットを確認・レビューしてください`, "ok");
  } catch (e) {
    console.error(e);
    setStatus("解析に失敗しました: " + e.message +
      "（Chromeのfile://でworkerが起動しない場合はFirefoxで開くか、フォルダで `python3 -m http.server` を実行してhttp経由で開いてください）", "err");
  }
}

function copySnippet() {
  const ta = $("snippet");
  ta.select();
  try {
    navigator.clipboard.writeText(ta.value);
    setStatus("スニペットをコピーしました。data/measures.js の MEASURES 配列末尾に貼り付けてください。", "ok");
  } catch (e) {
    document.execCommand("copy");
    setStatus("コピーしました（fallback）。", "ok");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const input = $("file-input");
  const drop = $("drop");
  input.addEventListener("change", e => handleFile(e.target.files[0]));
  drop.addEventListener("click", () => input.click());
  ["dragover", "dragenter"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev =>
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => handleFile(e.dataTransfer.files[0]));
  $("copy-btn").addEventListener("click", copySnippet);
  if (!window.pdfjsLib) setStatus("pdf.js の読み込みに失敗しました。vendor/pdfjs を確認してください。", "err");
});
