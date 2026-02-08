import { Type } from '@google/genai';
import { log } from '../config';
import { googleAI } from '../clients/google-ai';

export const VALID_CALL_OUTCOMES = ['ANSWERED', 'CONFIRMED', 'RESCHEDULED', 'CANCELED', 'VOICEMAIL', 'NO_ANSWER', 'FAILED'] as const;

export async function analyzeTranscriptWithGemini(
  transcript: Array<{ role: string; content: string }> | null
): Promise<{ summary: string; call_outcome: string } | null> {
  if (!googleAI) {
    log.debug('Gemini transcript analysis skipped: no API key');
    return null;
  }

  if (!transcript || !Array.isArray(transcript)) {
    log.debug('Gemini transcript analysis skipped: no transcript');
    return null;
  }

  // Filter to only agent/user conversation messages (exclude system)
  const conversationMessages = transcript.filter(
    (msg) => msg.role === 'agent' || msg.role === 'user'
  );

  if (conversationMessages.length < 2) {
    log.debug('Gemini transcript analysis skipped: too few messages', { count: conversationMessages.length });
    return null;
  }

  try {
    const formattedTranscript = conversationMessages
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n');

    const response = await googleAI.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analyze this phone call transcript between an AI appointment reminder agent and a customer.\n\nTranscript:\n${formattedTranscript}\n\nProvide a brief summary and determine the call outcome.`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: {
              type: Type.STRING,
              description: 'A concise 1-3 sentence summary of the call from the business owner perspective. Focus on what happened and the result.',
            },
            call_outcome: {
              type: Type.STRING,
              description: 'The outcome of the call.',
              enum: [...VALID_CALL_OUTCOMES],
            },
          },
          required: ['summary', 'call_outcome'],
        },
      },
    });

    const text = response.text;
    if (!text) {
      log.error('Gemini transcript analysis: empty response');
      return null;
    }

    const parsed = JSON.parse(text);

    if (!parsed.summary || !parsed.call_outcome) {
      log.error('Gemini transcript analysis: missing fields', parsed);
      return null;
    }

    if (!VALID_CALL_OUTCOMES.includes(parsed.call_outcome)) {
      log.error('Gemini transcript analysis: invalid call_outcome', { call_outcome: parsed.call_outcome });
      return null;
    }

    log.info('Gemini transcript analysis complete', {
      summary_length: parsed.summary.length,
      call_outcome: parsed.call_outcome,
    });

    return { summary: parsed.summary, call_outcome: parsed.call_outcome };
  } catch (error) {
    log.error('Gemini transcript analysis failed', error);
    return null;
  }
}
