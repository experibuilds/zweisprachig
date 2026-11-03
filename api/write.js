// Serverless function: turns rough notes into a bilingual Slack update via Gemini (free tier).
const hits = new Map(); // simple per-instance rate limit
const LIMIT = 10, WINDOW_MS = 60_000;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return res.status(429).json({ error: "Too many requests" });
  recent.push(now); hits.set(ip, recent);

  const { notes = "", tone = "casual", emoji = "some" } = req.body || {};
  const text = String(notes).trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: "Notes are empty" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing GEMINI_API_KEY" });
  const primary = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS || "gemini-flash-lite-latest,gemini-2.5-flash")
    .split(",").map(m => m.trim()).filter(Boolean);
  const models = [...new Set([primary, ...fallbacks])];

  const toneTxt = {
    casual: "casual and friendly, like a colleague you like",
    funny: "light and witty with one small joke, still professional",
    neutral: "clear and neutral, professional",
  }[tone] || "casual and friendly";
  const emojiTxt = emoji === "none" ? "Use no emoji." : "Use 1-3 fitting emoji.";

  const prompt = `You turn a software developer's rough notes into a short Slack message for their German-speaking team.
Tone: ${toneTxt}. ${emojiTxt}
Rules: keep every fact from the notes (PR numbers, times, names) and invent nothing. Use Slack formatting: *bold* sparingly, "• " bullets when there are 3+ items. Max ~90 words per language. German must be natural, idiomatic, informal "ihr/euch" (not a literal translation). English must be natural too.
Return ONLY JSON: {"de":"German message","en":"English message"}

Notes:
"""${text}"""`;

  try {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
    });
    const { r, rateLimited } = await callWithFallback(models, key, body);
    if (!r) return res.status(rateLimited ? 429 : 502).json({ error: rateLimited ? "Model rate limit" : "Model request failed" });
    const data = await r.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const out = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return res.status(200).json({ de: String(out.de || ""), en: String(out.en || "") });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not write the update" });
  }
}

// Retry transient errors (429/5xx/network) with backoff, then move to the next model.
const RETRIES = 2, RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callWithFallback(models, key, body) {
  let rateLimited = false;
  for (const model of models) {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body,
            signal: AbortSignal.timeout(15_000),
          }
        );
        if (r.ok) return { r, model };
        if (r.status === 429) rateLimited = true;
        console.error("Gemini error", model, r.status, (await r.text()).slice(0, 300));
        if (!RETRY_STATUS.has(r.status)) break; // e.g. 404 unknown model → next model
      } catch (e) {
        console.error("Gemini fetch failed", model, e.name);
      }
      if (attempt < RETRIES) await sleep(400 * 2 ** attempt + Math.random() * 200);
    }
  }
  return { r: null, rateLimited };
}
