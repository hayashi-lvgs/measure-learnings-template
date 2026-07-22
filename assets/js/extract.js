/* =========================================================================
 * PDF → MEASURES 抽出ロジック（共通）
 * -------------------------------------------------------------------------
 * サイト本体(index.html)の「即カード化」と 取り込みツール(tools/import.html)の
 * 両方から使う純粋ロジック。DOM操作は含めない。window.CTAExtract に公開する。
 *
 * pdf.js は各ページで先に読み込むこと。worker のパスはページ相対で異なるため、
 * 各ページが window.PDFJS_WORKER_SRC を先に定義しておく。
 *
 * ⚠️ 方針: 「全自動・機械抽出のみ」。事実 vs AI推論の判断・判定(勝ち/負け)・
 *   デザイン観点はブラウザ内JSでは正しく作れない。生成物には autoExtracted:true
 *   （要レビュー）フラグを立て、人＋Claudeで仕上げる前提。
 * ========================================================================= */
(function (global) {
  "use strict";

  if (global.pdfjsLib && global.PDFJS_WORKER_SRC) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = global.PDFJS_WORKER_SRC;
  }

  // -------------------------------------------------------------- PDF → 行復元
  // pdf.js のテキストアイテム(座標付き)を、行(Y)でまとめ列(X)で並べて
  // pdftotext -layout 相当の「ラベル\t値」行を復元する。
  async function pdfToLines(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const rows = {};
      tc.items.forEach(it => {
        if (!it.str || !it.str.trim()) return;
        const x = it.transform[4];
        const y = it.transform[5];
        const key = Math.round(y / 3) * 3; // 近いYを同一行に束ねる
        (rows[key] = rows[key] || []).push({ x, w: it.width || 0, s: it.str });
      });
      Object.keys(rows).map(Number).sort((a, b) => b - a).forEach(y => {
        const parts = rows[y].sort((a, b) => a.x - b.x);
        let line = "", prevEnd = null;
        parts.forEach(pt => {
          if (prevEnd !== null) {
            const gap = pt.x - prevEnd;
            if (gap > 12) line += "\t";
            else if (gap > 2) line += " ";
          }
          line += pt.s;
          prevEnd = pt.x + pt.w;
        });
        lines.push(line);
      });
      lines.push("\f"); // ページ区切り
    }
    return lines;
  }

  // -------------------------------------------------------------- フィールド抽出
  const LABELS = [
    "施策No.", "施策名", "対象箇所", "デバイス", "媒体", "デザインドック",
    "施策背景", "課題", "ターゲット", "仮説", "KPI", "サブKPI", "備考",
    "検証方法", "対照期間", "検証期間", "結果_実績値", "結果_改善率",
    "検定方法", "検定結果", "考察", "学び / 気づき", "学び/気づき", "NA", "その他備考",
    "検証結果", "最終記入日", "記入者", "Asana", "Figma", "Optimizely", "Figma URL"
  ];
  const norm = s => (s || "").replace(/[\s　]/g, "");
  const NORM_LABELS = LABELS.map(norm);
  // 複数行セルを持つフィールドだけ継続行を許可（単一値ラベルが後続の表を巻き込むのを防ぐ）
  const MULTILINE = new Set(["施策背景", "考察", "NA", "検証結果", "結果_改善率", "結果_実績値", "学び/気づき", "課題", "ターゲット"]);

  function extractFields(lines) {
    const fields = {};
    let current = null;
    for (const raw of lines) {
      if (raw === "\f") { continue; }
      const cols = raw.split("\t").map(c => c.trim()).filter(Boolean);
      if (!cols.length) continue;
      const firstNorm = norm(cols[0]);
      let matched = null;
      for (let i = 0; i < NORM_LABELS.length; i++) {
        if (firstNorm === NORM_LABELS[i] || firstNorm.startsWith(NORM_LABELS[i])) {
          matched = LABELS[i]; break;
        }
      }
      if (matched) {
        const value = cols.slice(1).join(" ").trim();
        const key = matched.replace(/\s/g, "");
        fields[key] = (fields[key] ? fields[key] + "\n" : "") + value;
        current = MULTILINE.has(key) ? key : null; // 複数行フィールドのみ継続を許可
      } else if (current) {
        fields[current] += "\n" + cols.join(" ");
      }
    }
    Object.keys(fields).forEach(k => {
      fields[k] = fields[k].split("\n").map(s => s.trim()).filter(Boolean).join("\n");
    });
    return fields;
  }

  // シート上の見出し・体裁だけの行（本文でない）
  const NOISE = new Set(["参考ラフ", "参考データ", "下表参照", "参考", "備考", "その他備考", "施策概要"]);
  function toBullets(v) {
    if (!v) return [];
    return v.split(/\n|・/)
      .map(s => s.replace(/^[・\-\s　└]+/, "").trim())
      .filter(s => s && !NOISE.has(s));
  }

  // -------------------------------------------------------------- ヒューリスティック
  function guessType(text) {
    const t = text || "";
    if (/MV|サムネ/.test(t)) return "UI変更（MV削除）";
    if (/一本化|(CTA|ボタン).{0,6}削除/.test(t)) return "CTA削減（選択肢一本化）";
    if (/クリエイティブ(変更|刷新)/.test(t)) return "クリエイティブ変更";
    if (/同化|擬態/.test(t)) return "記事同化型CTA挿入";
    if (/バナー/.test(t)) return "バナー挿入";
    if (/FV|ファーストビュー/.test(t)) return "UI変更（FV改善）";
    if (/UI/.test(t)) return "UI変更";
    return "要分類";
  }
  function guessResult(kenteiKekka) {
    // PDFに採用可否(案C判定)は無い。検定結果からの粗い推定にとどめ、必ず要レビュー。
    if (/有意差あり|優位な差(があった|あり)/.test(kenteiKekka || "")) return "win";
    return "draw";
  }
  function guessDevices(v) {
    const out = [];
    if (/SP/i.test(v || "")) out.push("SP");
    if (/PC/i.test(v || "")) out.push("PC");
    return out.length ? out : ["SP"];
  }
  function normId(idRaw, fileName) {
    // 施策No.欄に「英字接頭辞+数字」があればその接頭辞をそのまま使う（例 CTA-123 / ABC 456）
    let m = (idRaw || "").match(/([A-Za-z]{2,6})[-\s]?(\d{3,6})/);
    if (m) return m[1].toUpperCase() + "-" + m[2];
    // 無ければ site.js の idPrefix（未設定なら "ID"）+ ファイル名中の数字
    const prefix = (global.SITE && global.SITE.idPrefix) || "ID";
    m = (fileName || "").match(/(\d{3,6})/);
    return m ? prefix + "-" + m[1] : prefix + "-要記入";
  }

  // -------------------------------------------------------------- デザイン観点の候補生成
  // ⚠️ designInsights はサイトの核（CTユーザー前提の設計原則）。機械では正しく書けない。
  //   ここでは考察・学びから ✅/⚠️/❌ の「候補」を語尾で粗く分類して種を出すだけ。
  //   各行に「🔧候補」を付け curated と区別する。人＋Claude での書き直しが前提。
  const NEG = /(悪化|低下|下がっ|逆効果|スルー|埋没|打ち消|妨げ|されなかった|されず|ならなかった|劣[っる]|微減|失敗|ノイズ)/;
  const POS = /(改善|向上|効いた|優位|上がっ|引き寄せ|短縮|近づ|促進|増加|クリックされ(た|やすく))/;
  function classifyInsight(text) {
    if (NEG.test(text)) return "bad";      // 否定・悪化を先に判定（「改善されなかった」等を拾う）
    if (POS.test(text)) return "good";
    return "caution";                       // 不確実なものは注意扱い（安全側）
  }
  function guessDesignInsights(manabi, kousatsu) {
    const seen = new Set();
    const cands = [];
    // 学び/気づき を優先、次に考察。重複・短すぎる行は除外。
    [...manabi, ...kousatsu].forEach(t => {
      const s = t.trim();
      if (s.length < 8 || seen.has(s)) return;
      seen.add(s);
      cands.push({ type: classifyInsight(s), text: "🔧候補: " + s });
    });
    return cands.slice(0, 5); // ノイズ抑制のため上限5件
  }

  // -------------------------------------------------------------- 数値抽出
  function extractNumbers(fullText) {
    const out = {};
    const rate = (name) => {
      // 「CVR」が「MCVR」に部分マッチするのを防ぐため直前が英字でないことを要求
      const re = new RegExp("(?<![A-Za-z])" + name + "改善率[：: ]*([-+]?\\d+(?:\\.\\d+)?%)");
      const m = fullText.match(re);
      return m ? m[1] : null;
    };
    const mcvr = rate("MCVR"), ef = rate("EF完了率"), cvr = rate("CVR");
    if (mcvr) out.mcvr = mcvr + "（改善率・要確認）";
    if (ef) out.ef = ef + "（改善率・要確認）";
    if (cvr) out.cvr = cvr + "（改善率・要確認）";
    const rates = [];
    [["MCVR", mcvr], ["EF完了率", ef], ["CVR", cvr]].forEach(([n, v]) => { if (v) rates.push(`${n}改善率: ${v}`); });
    const chi = fullText.match(/カイ二乗検定[\s\t]*([\d.]+)[\s\t]+([\d.]+)[\s\t]+([\d.]+)/);
    const ss = {};
    ["A", "B", "C"].forEach(p => {
      const m = fullText.match(new RegExp("(?:^|\\s)" + p + "[\\s\\t]+(\\d{1,3}(?:,\\d{3})+)"));
      if (m) ss[p] = m[1];
    });
    return { out, rates, chi, ss };
  }

  // -------------------------------------------------------------- 本体
  async function buildMeasure(arrayBuffer, fileName) {
    const lines = await pdfToLines(arrayBuffer);
    const fullText = lines.join("\n");
    const f = extractFields(lines);

    const id = normId(f["施策No."], fileName);
    const title = f["施策名"] || "（施策名を記入）";
    const devices = guessDevices(f["デバイス"]);
    const kentei = f["検定結果"] || "";
    const result = guessResult(kentei);

    let period = "（検証期間を記入）";
    const per = f["検証期間"] || "";
    const dates = per.match(/\d{4}\/\d{1,2}\/\d{1,2}/g) || [];
    const days = (per.match(/日数[\s\t]*(\d+)/) || [])[1];
    if (dates.length >= 2) period = `${dates[0]}〜${dates[1]}${days ? `（${days}日間）` : ""}`;
    else if (dates.length === 1) period = dates[0];

    const nums = extractNumbers(fullText);

    const factuals = [];
    if (kentei) factuals.push("検定結果: " + kentei.replace(/\n/g, " / "));
    nums.rates.forEach(r => factuals.push(r));
    if (nums.chi) factuals.push(`カイ二乗検定 p値: ${nums.chi[1]} / ${nums.chi[2]} / ${nums.chi[3]}`);
    if (Object.keys(nums.ss).length) {
      factuals.push("サンプル数: " + Object.entries(nums.ss).map(([k, v]) => `${k} ${v}`).join(" / "));
    }
    toBullets(f["検証結果"]).forEach(b => factuals.push(b));
    if (!factuals.length) factuals.push("（PDFから事実を抽出できませんでした。手動で記入してください）");

    const kousatsu = toBullets(f["考察"]);
    const hypothesisInsights = [];
    const factFromKousatsu = [];
    const AI_HINT = /(可能性|考えられ|かもしれ|と思われ|と推測|だろう|のでは)/;
    kousatsu.forEach(b => (AI_HINT.test(b) ? hypothesisInsights : factFromKousatsu).push(b));
    factFromKousatsu.forEach(b => factuals.push(b));

    const metrics = {};
    Object.assign(metrics, nums.out);
    if (kentei) metrics.significance = kentei.replace(/\n/g, " / ");

    const manabi = toBullets(f["学び/気づき"]);
    const rootCause = [...manabi, ...toBullets(f["検証結果"])]
      .join(" / ") || "（要因を記入してください）";

    return {
      id, title,
      type: guessType(title + " " + (f["施策背景"] || "")),
      pages: [f["対象箇所"] || "記事詳細ページ"],
      devices, result,
      adoptionLabel: "（採用判断＝案C を記入してください）",
      period,
      hypothesis: (f["仮説"] || "（仮説を記入）").replace(/\n/g, " "),
      hypothesisIsAI: false,
      background: (f["施策背景"] || "").replace(/\n/g, " "),
      factuals, hypothesisInsights, rootCause, metrics,
      nextActions: toBullets(f["NA"]),
      designInsights: guessDesignInsights(manabi, kousatsu), // 🔧候補（要レビュー・CTユーザー前提で書き直す）
      autoExtracted: true   // ★機械抽出・未レビューの目印
    };
  }

  // -------------------------------------------------------------- スニペット整形
  function toSnippet(m) {
    const arr = (a) => a.length
      ? "[\n" + a.map(s => `      ${JSON.stringify(s)}`).join(",\n") + "\n    ]"
      : "[]";
    const di = (m.designInsights && m.designInsights.length)
      ? "[\n" + m.designInsights.map(d => `      { type: '${d.type}', text: ${JSON.stringify(d.text)} }`).join(",\n") + "\n    ]"
      : "[]";
    const metrics = Object.keys(m.metrics).length
      ? "{\n" + Object.entries(m.metrics).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join(",\n") + "\n    }"
      : "{}";
    return `  {
    id: ${JSON.stringify(m.id)},
    title: ${JSON.stringify(m.title)},
    type: ${JSON.stringify(m.type)},
    pages: ${JSON.stringify(m.pages)},
    devices: ${JSON.stringify(m.devices)},
    result: ${JSON.stringify(m.result)}, // ⚠️要レビュー: PDFに採用判断は無く自動推定
    adoptionLabel: ${JSON.stringify(m.adoptionLabel)},
    period: ${JSON.stringify(m.period)},
    hypothesis: ${JSON.stringify(m.hypothesis)},
    hypothesisIsAI: false,
    background: ${JSON.stringify(m.background)},
    factuals: ${arr(m.factuals)},
    hypothesisInsights: ${arr(m.hypothesisInsights)}, // ⚠️要レビュー: 考察の自動仕分け
    rootCause: ${JSON.stringify(m.rootCause)},
    metrics: ${metrics},
    nextActions: ${arr(m.nextActions)},
    designInsights: ${di}, // ⚠️🔧候補（自動生成）: CTユーザー前提で書き直し、🔧候補: を外す
    autoExtracted: true // ★機械抽出・未レビュー。仕上げ後にこの行を削除
  }`;
  }

  global.CTAExtract = { buildMeasure, toSnippet, extractFields, pdfToLines };
})(window);
