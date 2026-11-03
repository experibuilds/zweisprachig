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
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: { type: "OBJECT", properties: { de: { type: "STRING" }, en: { type: "STRING" } }, required: ["de", "en"] },
        temperature: 0.7,
      },
    });
    const { out, rateLimited } = await callWithFallback(models, key, body);
    if (!out) return res.status(rateLimited ? 429 : 502).json({ error: rateLimited ? "Model rate limit" : "Model request failed" });
    return res.status(200).json({ de: String(out.de || ""), en: String(out.en || "") });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Could not write the update" });
  }
}

// Retry transient errors / bad JSON once, then move to the next model.
// 429 = that model's quota is used up → skip straight to the next model.
// Whole call is capped by DEADLINE_MS so the user never waits a minute.
const RETRIES = 1, DEADLINE_MS = 25_000, RETRY_STATUS = new Set([500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parse(data) {
  const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
  const out = JSON.parse(raw.replace(/```json|```/g, "").trim());
  if (!out.de && !out.en) throw new Error("empty output");
  return out;
}

async function callWithFallback(models, key, body) {
  const end = Date.now() + DEADLINE_MS;
  let rateLimited = false;
  for (const model of models) {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const left = end - Date.now();
      if (left < 1500) return { out: null, rateLimited };
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body,
            signal: AbortSignal.timeout(Math.min(12_000, left)),
          }
        );
        if (r.ok) {
          try { return { out: parse(await r.json()), model }; }
          catch (e) { console.error("Bad model output", model, e.message); }
        } else {
          console.error("Gemini error", model, r.status, (await r.text()).slice(0, 300));
          if (r.status === 429) { rateLimited = true; break; }
          if (!RETRY_STATUS.has(r.status)) break; // e.g. 404 unknown model
        }
      } catch (e) {
        console.error("Gemini fetch failed", model, e.name);
      }
      if (attempt < RETRIES) await sleep(400 + Math.random() * 300);
    }
  }
  return { out: null, rateLimited };
}
