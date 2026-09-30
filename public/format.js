(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoopFormat = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function codeKind(text) {
    var t = String(text || "").trim();
    if (/^(package\s+\w+|public\s+(class|static)|class\s+\w+)/.test(t) && /[{;]/.test(t)) return "java";
    if (/^#include\b/.test(t) || /^int\s+main\s*\(/.test(t)) return "c";
    if (/^def\s+\w+\s*\(/.test(t)) return "python";
    if (/^(function|const|let|class)\s/.test(t) && /[{;]/.test(t)) return "javascript";
    if (/^(for|while|if)\s*\(/.test(t) && /\{/.test(t)) return /\b(int|String|void)\b|System\.out/.test(t) ? "java" : "javascript";
    if (/public\s+class\s+\w+/.test(t) && (t.match(/[{;}]/g) || []).length >= 2) return "java";
    if (/#include\s*[<"]/.test(t) && /[{;}]/.test(t)) return "c";
    return "";
  }

  function prettyBraces(src) {
    var s = String(src || "").trim();
    if (s.split("\n").filter(Boolean).length > 3) return s;
    var out = "";
    var pad = 0;
    var quote = "";
    var paren = 0;
    var buf = "";
    function push(line) {
      var bit = String(line || "").trim();
      if (!bit) return;
      out += (out ? "\n" : "") + "  ".repeat(Math.max(0, pad)) + bit;
    }
    function flush() {
      if (buf.trim()) push(buf);
      buf = "";
    }
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (quote) {
        buf += c;
        if (c === quote && s.charAt(i - 1) !== "\\") quote = "";
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        buf += c;
        continue;
      }
      if (c === "(") {
        paren++;
        buf += c;
        continue;
      }
      if (c === ")") {
        paren = Math.max(0, paren - 1);
        buf += c;
        continue;
      }
      if (c === "{") {
        buf = buf.replace(/\s+$/, "") + " {";
        flush();
        pad++;
        continue;
      }
      if (c === "}") {
        flush();
        pad = Math.max(0, pad - 1);
        push("}");
        continue;
      }
      if (c === ";" && paren === 0) {
        buf += ";";
        flush();
        continue;
      }
      buf += c;
    }
    flush();
    return out || s;
  }

  function prettyPython(src) {
    var s = String(src || "").trim();
    if (s.indexOf("\n") !== -1) return s;
    return s.replace(/:\s+/, ":\n  ");
  }

  function alignPairs(block) {
    var lines = String(block || "").split("\n");
    if (lines.length < 2) return "";
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*([A-Za-z][^:=\n]{0,28}?)\s*([:=])\s*(\S.*)$/);
      if (!m) return "";
      rows.push([m[1].trim(), m[2], m[3].trim()]);
    }
    var w = 0;
    rows.forEach(function (r) { if (r[0].length > w) w = r[0].length; });
    return rows.map(function (r) {
      return r[0] + " ".repeat(w - r[0].length) + " " + r[1] + " " + r[2];
    }).join("\n");
  }

  function alignPipes(block) {
    var lines = String(block || "").split("\n").filter(function (l) { return l.trim(); });
    if (lines.length < 2 || !lines.every(function (l) { return l.indexOf("|") !== -1; })) return "";
    var rows = lines.map(function (l) {
      return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
    }).filter(function (r) { return !r.every(function (c) { return /^:?-+:?$/.test(c); }); });
    if (rows.length < 2) return "";
    var cols = 0;
    rows.forEach(function (r) { if (r.length > cols) cols = r.length; });
    if (cols < 2) return "";
    var width = [];
    var c;
    for (c = 0; c < cols; c++) {
      width[c] = 0;
      rows.forEach(function (r) { width[c] = Math.max(width[c], (r[c] || "").length); });
    }
    return rows.map(function (r) {
      var cells = [];
      for (c = 0; c < cols; c++) {
        var cell = r[c] || "";
        cells.push(cell + " ".repeat(Math.max(0, width[c] - cell.length)));
      }
      return cells.join("  ").replace(/\s+$/, "");
    }).join("\n");
  }

  function alignLayout(text) {
    return String(text || "").split(/\n{2,}/).map(function (block) {
      return alignPipes(block) || alignPairs(block) || block;
    }).join("\n\n");
  }

  function fence(kind, code) {
    var body = kind === "python" ? prettyPython(code) : prettyBraces(code);
    return "```" + kind + "\n" + body + "\n```";
  }

  function formatAnswer(text) {
    var raw = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!raw || raw.indexOf("```") !== -1) return raw;
    var kind = codeKind(raw);
    if (kind && /^(package|public|class|#include|int\s+main|def\s|function|const|let|for|while|if)\b/.test(raw)) return fence(kind, raw);
    var at = raw.search(/\bpublic\s+class\b|\b#include\b|\bdef\s+\w+\s*\(|\bfunction\s+\w+\s*\(/);
    if (at > 0) {
      var prose = raw.slice(0, at).trim();
      var code = raw.slice(at).trim();
      var inner = codeKind(code);
      if (inner) return alignLayout(prose) + "\n\n" + fence(inner, code);
    }
    return alignLayout(raw);
  }

  return { formatAnswer: formatAnswer, prettyBraces: prettyBraces, alignLayout: alignLayout };
});
