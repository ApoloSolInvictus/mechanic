const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const GOOGLE_IMAGE_SEARCH_URL = "https://www.googleapis.com/customsearch/v1";
const OPENVERSE_IMAGE_SEARCH_URL = "https://api.openverse.org/v1/images/";
const WIKIMEDIA_IMAGE_SEARCH_URL = "https://commons.wikimedia.org/w/api.php";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_IMAGE_COUNT = 3;

const SYSTEM_PROMPT = `
Eres INFINITI PITS, un asistente tecnico de mecanica automotriz para duenos de vehiculos, talleres y mecanicos profesionales.

Al responder:
- Usa el idioma del usuario.
- Pide ano, marca, modelo, motor, transmision y codigo DTC cuando falten datos criticos.
- Distingue entre orientacion general y especificaciones que deben verificarse con manual OEM.
- No inventes pares de apriete, diagramas, boletines ni procedimientos exactos si no estas seguro.
- Para mecanicos, da pasos de diagnostico, pruebas con multimetro/manometro/escaner, valores esperados cuando sean razonablemente conocidos y advertencias de seguridad.
- Para duenos de vehiculo, explica en lenguaje claro, prioriza seguridad y recomienda taller cuando haya riesgo.
- Si el usuario pide un flujo, puedes responder con un bloque \`\`\`mermaid.
- Si la respuesta se apoya en imagenes, explica que son referencias visuales y que las especificaciones finales deben verificarse con el manual OEM del vehiculo exacto.
`.trim();

function setCorsHeaders(req, res) {
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = req.headers.origin;
  const allowOrigin =
    configuredOrigins.length === 0
      ? "*"
      : configuredOrigins.includes(requestOrigin)
        ? requestOrigin
        : configuredOrigins[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    return req.body.trim() ? JSON.parse(req.body) : {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  return rawBody ? JSON.parse(rawBody) : {};
}

function cleanText(value, maxLength = 6000) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function stripGeneratedVisualHtml(value) {
  return String(value || "")
    .replace(/<div class="pits-visual-results"[\s\S]*?<\/div>/gi, "")
    .replace(/<figure[\s\S]*?<\/figure>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-10)
    .map((message) => {
      const role = String(message?.role || "").toLowerCase();
      const content = cleanText(stripGeneratedVisualHtml(message?.content), 4000);
      if (!content) return null;

      return {
        role: role === "assistant" || role === "ai" ? "assistant" : "user",
        content,
      };
    })
    .filter(Boolean);
}

function extractResponseText(openaiResponse) {
  if (typeof openaiResponse.output_text === "string" && openaiResponse.output_text.trim()) {
    return openaiResponse.output_text.trim();
  }

  const parts = [];
  for (const item of openaiResponse.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

async function readOpenAIJson(response) {
  const rawBody = await response.text();
  if (!rawBody) return {};

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    return { error: { message: rawBody } };
  }
}

function getMaxOutputTokens() {
  const value = Number.parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || "1400", 10);
  return Number.isFinite(value) && value > 0 ? value : 1400;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getImageCount() {
  const value = Number.parseInt(process.env.IMAGE_SEARCH_COUNT || String(DEFAULT_IMAGE_COUNT), 10);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IMAGE_COUNT;
  return Math.min(value, 6);
}

function isSalesPrompt(message) {
  return /agente de ventas|director de ventas|sales_prompt|ventas cuantico|maximus/i.test(message);
}

function extractVisualQueryText(message) {
  const userInputMatch = message.match(/USER INPUT:\s*"?([\s\S]*?)"?\s*$/i);
  const rawText = userInputMatch ? userInputMatch[1] : message;

  return cleanText(rawText, 260)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function shouldSearchImages(message) {
  if (process.env.IMAGE_SEARCH_ENABLED === "false") return false;
  if (isSalesPrompt(message)) return false;

  const text = extractVisualQueryText(message).toLowerCase();
  if (!text) return false;

  return /auto|carro|vehiculo|vehículo|motor|engine|moto|motorcycle|cuadraciclo|atv|utv|quad|obd|dtc|codigo|código|falla|fallo|sensor|fusible|relay|rel[eé]|buj[ií]a|bobina|alternador|arranque|bateria|batería|ecu|ecm|pcm|transmisi[oó]n|transmission|freno|brake|suspensi[oó]n|direcci[oó]n|wiring|cableado|electrico|eléctrico|diagrama|diagram|manual|taller|partes|parts|torque|apriete/.test(text);
}

function buildImageSearchQuery(message) {
  const visualText = extractVisualQueryText(message);
  return `${visualText} manual de taller espanol diagrama partes motor electrico auto moto cuadraciclo ATV UTV`.trim();
}

function getImageProvider() {
  const provider = String(process.env.IMAGE_SEARCH_PROVIDER || "auto").toLowerCase();
  if (["auto", "google", "openverse", "wikimedia"].includes(provider)) return provider;
  return "auto";
}

function isSafeHttpUrl(value) {
  if (typeof value !== "string") return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch (error) {
    return false;
  }
}

function normalizeImageResult(result) {
  const url = result.url || result.link;
  if (!isSafeHttpUrl(url)) return null;

  const sourceUrl = result.sourceUrl || result.contextLink || result.foreign_landing_url || url;
  const thumbnail = result.thumbnail || result.thumbnailLink || result.thumburl || url;

  return {
    title: cleanText(result.title || "Diagrama tecnico", 160),
    url,
    thumbnail: isSafeHttpUrl(thumbnail) ? thumbnail : url,
    sourceUrl: isSafeHttpUrl(sourceUrl) ? sourceUrl : url,
    source: cleanText(result.source || result.displayLink || result.provider || "web", 80),
    provider: cleanText(result.provider || "web", 40),
    license: cleanText(result.license || result.licenseLabel || "", 80),
    attribution: cleanText(result.attribution || "", 300),
  };
}

function dedupeImages(images, limit) {
  const seen = new Set();
  const unique = [];

  for (const image of images) {
    const normalized = normalizeImageResult(image);
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    unique.push(normalized);
    if (unique.length >= limit) break;
  }

  return unique;
}

async function searchGoogleImages(query, limit) {
  if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_ENGINE_ID) {
    return [];
  }

  const params = new URLSearchParams({
    key: process.env.GOOGLE_SEARCH_API_KEY,
    cx: process.env.GOOGLE_SEARCH_ENGINE_ID,
    q: query,
    searchType: "image",
    safe: "active",
    num: String(Math.min(limit, 10)),
  });

  if (process.env.GOOGLE_IMAGE_RIGHTS) {
    params.set("rights", process.env.GOOGLE_IMAGE_RIGHTS);
  }

  const response = await fetchWithTimeout(`${GOOGLE_IMAGE_SEARCH_URL}?${params.toString()}`);
  if (!response.ok) return [];

  const data = await response.json();
  return (data.items || []).map((item) => ({
    title: item.title,
    url: item.link,
    thumbnail: item.image?.thumbnailLink,
    sourceUrl: item.image?.contextLink,
    source: item.displayLink,
    provider: "google",
  }));
}

async function searchOpenverseImages(query, limit) {
  const params = new URLSearchParams({
    q: query,
    page_size: String(limit),
    license: "cc0,by,by-sa",
  });

  const response = await fetchWithTimeout(`${OPENVERSE_IMAGE_SEARCH_URL}?${params.toString()}`, {
    headers: {
      "User-Agent": "InfinitiPits/1.0 (https://pits.infiniti-ia.com)",
    },
  });
  if (!response.ok) return [];

  const data = await response.json();
  return (data.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    thumbnail: item.thumbnail,
    sourceUrl: item.foreign_landing_url,
    source: item.source || item.provider,
    provider: "openverse",
    license: [item.license, item.license_version].filter(Boolean).join(" "),
    attribution: item.attribution,
  }));
}

function getWikimediaMetadataValue(metadata, key) {
  const value = metadata?.[key]?.value;
  return typeof value === "string" ? value.replace(/<[^>]*>/g, "").trim() : "";
}

async function searchWikimediaImages(query, limit) {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "1200",
    format: "json",
    origin: "*",
  });

  const response = await fetchWithTimeout(`${WIKIMEDIA_IMAGE_SEARCH_URL}?${params.toString()}`, {
    headers: {
      "User-Agent": "InfinitiPits/1.0 (https://pits.infiniti-ia.com)",
    },
  });
  if (!response.ok) return [];

  const data = await response.json();
  return Object.values(data.query?.pages || {}).map((page) => {
    const info = page.imageinfo?.[0] || {};
    const metadata = info.extmetadata || {};

    return {
      title: String(page.title || "").replace(/^File:/, ""),
      url: info.thumburl || info.url,
      thumbnail: info.thumburl || info.url,
      sourceUrl: info.descriptionurl,
      source: "Wikimedia Commons",
      provider: "wikimedia",
      license: getWikimediaMetadataValue(metadata, "LicenseShortName"),
      attribution: getWikimediaMetadataValue(metadata, "Attribution") || getWikimediaMetadataValue(metadata, "Artist"),
    };
  });
}

async function searchTechnicalImages(message) {
  const limit = getImageCount();
  if (limit === 0 || !shouldSearchImages(message)) return { images: [], query: "" };

  const query = buildImageSearchQuery(message);
  const provider = getImageProvider();
  const searches = [];

  if (provider === "google" || provider === "auto") {
    searches.push(() => searchGoogleImages(query, limit));
  }
  if (provider === "openverse" || provider === "auto") {
    searches.push(() => searchOpenverseImages(query, limit));
  }
  if (provider === "wikimedia" || provider === "auto") {
    searches.push(() => searchWikimediaImages(query, limit));
  }

  const images = [];
  for (const search of searches) {
    try {
      images.push(...await search());
    } catch (error) {
      console.error("Image search error", error);
    }

    if (dedupeImages(images, limit).length >= limit) break;
  }

  return { images: dedupeImages(images, limit), query };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderImageResultsHtml(images) {
  if (!images.length) return "";

  const cards = images
    .map((image, index) => {
      const title = escapeHtml(image.title || `Imagen tecnica ${index + 1}`);
      const imageUrl = escapeHtml(image.url);
      const sourceUrl = escapeHtml(image.sourceUrl || image.url);
      const source = escapeHtml(image.source || image.provider || "web");
      const license = image.license ? ` · ${escapeHtml(image.license)}` : "";

      return `<figure style="margin:14px 0 0;padding:10px;border:1px solid rgba(148,163,184,.35);border-radius:8px;background:rgba(15,23,42,.55);"><img src="${imageUrl}" alt="${title}" loading="lazy" style="display:block;max-width:100%;max-height:360px;margin:0 auto;border-radius:6px;object-fit:contain;background:#fff;" /><figcaption style="margin-top:8px;font-size:11px;line-height:1.45;color:#cbd5e1;">Imagen ${index + 1}: ${title} · ${source}${license} · <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;">fuente</a></figcaption></figure>`;
    })
    .join("");

  return `\n\n<div class="pits-visual-results" style="margin-top:14px;"><strong>Referencias visuales encontradas en la web:</strong>${cards}</div>`;
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 500, {
      error: "Missing OPENAI_API_KEY",
      response: "El backend de Vercel esta instalado, pero falta configurar OPENAI_API_KEY en las variables de entorno.",
    });
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: "Invalid JSON body",
      response: "No pude leer la solicitud del chat. Revisa el formato JSON enviado al backend.",
    });
  }

  const message = cleanText(body.message);
  if (!message) {
    return sendJson(res, 400, {
      error: "Missing message",
      response: "Enviame una consulta mecanica para poder ayudarte.",
    });
  }

  const input = [
    ...normalizeHistory(body.history),
    {
      role: "user",
      content: message,
    },
  ];

  const openaiPayload = {
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    instructions: SYSTEM_PROMPT,
    input,
    max_output_tokens: getMaxOutputTokens(),
  };

  if (process.env.OPENAI_ENABLE_WEB_SEARCH === "true") {
    openaiPayload.tools = [{ type: "web_search_preview" }];
  }

  try {
    const imageSearchPromise = searchTechnicalImages(message);
    const openaiResult = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(openaiPayload),
    });

    const data = await readOpenAIJson(openaiResult);
    if (!openaiResult.ok) {
      console.error("OpenAI API error", data);
      return sendJson(res, 502, {
        error: "OpenAI API error",
        response: "El motor IA respondio con un error temporal. Intentalo de nuevo en unos segundos.",
      });
    }

    const response = extractResponseText(data);
    const imageSearch = await imageSearchPromise;
    const responseText = response || "No pude generar una respuesta util. Intenta reformular la consulta con mas detalles del vehiculo.";
    const visualHtml = renderImageResultsHtml(imageSearch.images);

    return sendJson(res, 200, {
      response: `${responseText}${visualHtml}`,
      text: responseText,
      images: imageSearch.images,
      image_query: imageSearch.query,
      model: openaiPayload.model,
    });
  } catch (error) {
    console.error("Chat handler error", error);
    return sendJson(res, 500, {
      error: "Server error",
      response: "El backend tuvo un problema procesando la consulta. Revisa los logs de Vercel para mas detalle.",
    });
  }
};
