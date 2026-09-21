module.exports = function mountBudgetRoutes(app, ctx) {
  const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
  app.post("/api/prompt-stats", (req, res) => {
    const text = String((req.body && req.body.text) || "");
    const lastResults = Array.isArray(req.body.lastResults) ? req.body.lastResults : [];
    const att = lastResults.map((r) => `$ ${r.cmd} [${r.code}]\n${r.stdout || ""}\n${r.stderr || ""}`).join("\n");
    const parts = {
      system: String((ctx.lib && ctx.lib.SYSTEM) || "").length,
      context: ctx.contextText ? ctx.contextText(ctx.loadContext()) : 0,
      attachment: att.length,
      user: text.length,
    };
    const chars = parts.system + parts.context + parts.attachment + parts.user + 220;
    const tokens = Math.ceil(chars / 4);
    res.json({
      chars,
      tokens,
      numCtx: NUM_CTX,
      pct: Math.round((tokens / NUM_CTX) * 100),
      parts: {
        system: Math.ceil(parts.system / 4),
        context: Math.ceil(parts.context / 4),
        attachment: Math.ceil(parts.attachment / 4),
        user: Math.ceil(parts.user / 4),
      },
    });
  });
};
