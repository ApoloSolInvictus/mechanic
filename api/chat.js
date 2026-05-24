const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.4-mini";

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
- Si en una fase futura se te da una URL publica verificada de una imagen tecnica, puedes incluirla como [DIAGRAMA: https://...].
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

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-10)
    .map((message) => {
      const role = String(message?.role || "").toLowerCase();
      const content = cleanText(message?.content, 4000);
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
    return sendJson(res, 200, {
      response: response || "No pude generar una respuesta util. Intenta reformular la consulta con mas detalles del vehiculo.",
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
