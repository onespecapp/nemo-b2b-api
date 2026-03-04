import axios from "axios";

const ALLOWED_OUTCOMES = new Set([
  "BOOKED",
  "MESSAGE_TAKEN",
  "TRANSFERRED",
  "CONFIRMED",
  "RESCHEDULED",
  "CANCELED",
  "ANSWERED",
  "NO_ANSWER",
  "VOICEMAIL",
  "DECLINED",
  "FAILED",
  "BUSY"
]);

function normalizeCategory(value) {
  if (!value || typeof value !== "string") {
    return "";
  }
  return value.trim().toUpperCase();
}

function isDealershipCategory(category) {
  return [
    "AUTO_REPAIR",
    "AUTOMOTIVE",
    "AUTO",
    "AUTO_SALES",
    "AUTO_DEALERSHIP",
    "CAR_DEALERSHIP",
    "DEALERSHIP",
    "OTHER"
  ].includes(category);
}

function extractGeminiText(responseData) {
  const parts = responseData?.candidates?.[0]?.content?.parts || [];
  const firstTextPart = parts.find((part) => typeof part?.text === "string");
  return (firstTextPart?.text || "").trim();
}

function parseJsonFromText(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeOutcome(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!normalized) {
    return null;
  }
  return ALLOWED_OUTCOMES.has(normalized) ? normalized : null;
}

function normalizeUrgency(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "urgent" ? "urgent" : "normal";
}

function normalizeSummary(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 600);
}

function normalizeMessageObject(message, fallbackCallerName, fallbackCallerPhone) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const shouldCreate = message.should_create !== false;
  const body = typeof message.message === "string" ? message.message.trim() : "";

  if (!shouldCreate || !body) {
    return null;
  }

  return {
    message: body.slice(0, 2000),
    reason: typeof message.reason === "string" ? message.reason.trim().slice(0, 500) : null,
    urgency: normalizeUrgency(message.urgency),
    caller_name:
      typeof message.caller_name === "string" && message.caller_name.trim()
        ? message.caller_name.trim().slice(0, 150)
        : fallbackCallerName || null,
    caller_phone:
      typeof message.caller_phone === "string" && message.caller_phone.trim()
        ? message.caller_phone.trim().slice(0, 40)
        : fallbackCallerPhone || null
  };
}

function buildTranscriptLines(transcript) {
  return transcript
    .filter((item) => item && typeof item.content === "string" && item.content.trim())
    .map((item) => {
      const role = item.role === "assistant" ? "assistant" : "caller";
      const text = item.content.trim().replace(/\s+/g, " ").slice(0, 500);
      return `${role}: ${text}`;
    });
}

function buildTranscriptText(transcript, maxChars = 24000) {
  const lines = buildTranscriptLines(transcript);
  if (lines.length === 0) {
    return "";
  }

  const selected = [];
  let used = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const nextSize = used + line.length + 1;
    if (selected.length > 0 && nextSize > maxChars) {
      break;
    }
    selected.push(line);
    used = nextSize;
  }

  selected.reverse();
  return selected.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

async function callGeminiJson({ apiKey, model, prompt, timeoutMs, maxOutputTokens = 500, temperature = 0.1 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model || "gemini-2.5-flash"
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await axios.post(
    url,
    {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: "application/json",
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: timeoutMs
    }
  );

  const text = extractGeminiText(response.data);
  return parseJsonFromText(text);
}

function buildFallbackMessageFromFacts(facts, fallbackCallerName, fallbackCallerPhone) {
  if (!facts || typeof facts !== "object" || facts.follow_up_requested !== true) {
    return null;
  }

  const detail =
    typeof facts.follow_up_details === "string" && facts.follow_up_details.trim()
      ? facts.follow_up_details.trim()
      : "";

  if (!detail) {
    return null;
  }

  return {
    message: detail.slice(0, 2000),
    reason: "Caller requested follow-up",
    urgency: normalizeUrgency(facts.urgency),
    caller_name: fallbackCallerName || null,
    caller_phone: fallbackCallerPhone || null
  };
}

function buildFactsPrompt({ businessName, businessCategory, transcriptText }) {
  const lines = [
    "You extract factual details from call transcripts for an AI receptionist system.",
    `Business name: ${businessName || "Unknown business"}.`,
    `Business category: ${businessCategory || "GENERAL"}.`,
    "Return only valid JSON with this exact shape:",
    '{"call_intent":"string|null","facts":"string[]","follow_up_requested":boolean,"follow_up_details":"string|null","urgency":"normal|urgent","outcome_hint":"BOOKED|MESSAGE_TAKEN|TRANSFERRED|CONFIRMED|RESCHEDULED|CANCELED|ANSWERED|NO_ANSWER|VOICEMAIL|DECLINED|FAILED|BUSY|UNKNOWN"}',
    "Rules:",
    "- facts must be short concrete bullet-style facts from the transcript.",
    "- outcome_hint should be UNKNOWN if unclear.",
    "- follow_up_requested=true only when caller explicitly/implicitly asks for callback or message."
  ];

  if (isDealershipCategory(businessCategory)) {
    lines.push(
      "- For call_intent, use one of: SALES_NEW, SALES_USED, TEST_DRIVE, TRADE_IN, FINANCE, SERVICE, PARTS, STATUS, GENERAL, SPAM, UNKNOWN.",
      "- Capture vehicle details in facts if present: year/make/model/trim, mileage, stock number, VIN.",
      "- Mark urgency as urgent for safety-critical service issues (brakes, stranded, overheating, accident/tow)."
    );
  } else {
    lines.push(
      "- For call_intent, use concise labels like APPOINTMENT, SERVICE, BILLING, GENERAL, SPAM, UNKNOWN."
    );
  }

  lines.push("Transcript:", transcriptText);
  return lines.join("\n");
}

function buildFinalPrompt({ businessName, businessCategory, transcriptText, facts }) {
  const lines = [
    "You analyze call transcripts for a business AI receptionist.",
    `Business name: ${businessName || "Unknown business"}.`,
    `Business category: ${businessCategory || "GENERAL"}.`,
    "Return only valid JSON with this exact shape:",
    '{"summary":"string|null","call_outcome":"BOOKED|MESSAGE_TAKEN|TRANSFERRED|CONFIRMED|RESCHEDULED|CANCELED|ANSWERED|NO_ANSWER|VOICEMAIL|DECLINED|FAILED|BUSY|null","message":{"should_create":boolean,"message":"string","reason":"string|null","urgency":"normal|urgent","caller_name":"string|null","caller_phone":"string|null"}}',
    "Rules:",
    "- summary: 1-2 short sentences, max 300 chars.",
    "- call_outcome: choose the best matching outcome from enum; use ANSWERED when uncertain.",
    "- message.should_create=true only if caller asked for callback, message-taking, or follow-up.",
    "- If no message, set should_create=false and message fields to null/empty."
  ];

  if (isDealershipCategory(businessCategory)) {
    lines.push(
      "- Prefer summary format: intent + key vehicle/deal detail + clear next step.",
      "- message.reason should mention dealership lane when possible (sales, service, finance, trade-in, parts)."
    );
  }

  lines.push(`Extracted facts JSON: ${JSON.stringify(facts || null)}`, "Transcript:", transcriptText);
  return lines.join("\n");
}

export async function postProcessTranscriptWithGemini({
  apiKey,
  model,
  transcript,
  businessName,
  businessCategory,
  callerName,
  callerPhone,
  timeoutMs = 9000
}) {
  if (!apiKey || !Array.isArray(transcript) || transcript.length === 0) {
    return null;
  }

  const transcriptText = buildTranscriptText(transcript);
  if (!transcriptText) {
    return null;
  }

  const normalizedCategory = normalizeCategory(businessCategory) || "AUTO_REPAIR";
  const factsPrompt = buildFactsPrompt({
    businessName,
    businessCategory: normalizedCategory,
    transcriptText
  });

  let facts = null;
  try {
    facts = await callGeminiJson({
      apiKey,
      model,
      prompt: factsPrompt,
      timeoutMs,
      maxOutputTokens: 450,
      temperature: 0.0
    });
  } catch {
    facts = null;
  }

  const finalPrompt = buildFinalPrompt({
    businessName,
    businessCategory: normalizedCategory,
    transcriptText,
    facts
  });

  try {
    const json = await callGeminiJson({
      apiKey,
      model,
      prompt: finalPrompt,
      timeoutMs,
      maxOutputTokens: 500,
      temperature: 0.1
    });

    if (!json || typeof json !== "object") {
      return null;
    }

    const fallbackMessage = buildFallbackMessageFromFacts(facts, callerName, callerPhone);

    return {
      summary: normalizeSummary(json.summary),
      callOutcome: normalizeOutcome(json.call_outcome) || normalizeOutcome(facts?.outcome_hint) || "ANSWERED",
      message: normalizeMessageObject(json.message, callerName, callerPhone) || fallbackMessage
    };
  } catch {
    return null;
  }
}
