import { WebSocket } from 'ws';
import { Modality } from '@google/genai';
import { config, log } from '../config';
import { googleAI } from '../clients/google-ai';
import { GeminiSession } from '../types';

// Active Gemini sessions indexed by call control ID
export const geminiSessions = new Map<string, GeminiSession>();

// Active Telnyx WebSocket connections indexed by stream ID
export const telnyxStreams = new Map<string, { callControlId: string; ws: WebSocket }>();

export async function createGeminiLiveSession(callControlId: string, systemPrompt: string): Promise<GeminiSession | null> {
  if (!googleAI) {
    log.error('Google AI client not initialized - missing GOOGLE_AI_API_KEY');
    return null;
  }

  try {
    log.info('Creating Gemini Live session', { callControlId });

    const liveSession = await googleAI.live.connect({
      model: 'gemini-2.0-flash-live-001',
      callbacks: {
        onopen: () => {
          log.info('Gemini Live session opened', { callControlId });
        },
        onmessage: (message: any) => {
          handleGeminiMessage(callControlId, message);
        },
        onerror: (error: any) => {
          log.error('Gemini Live session error', { callControlId, error });
        },
        onclose: () => {
          log.info('Gemini Live session closed', { callControlId });
          geminiSessions.delete(callControlId);
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: 'Aoede', // Pleasant female voice
            },
          },
        },
      },
    });

    const session: GeminiSession = {
      callControlId,
      liveSession,
      systemPrompt,
    };

    geminiSessions.set(callControlId, session);
    log.info('Gemini Live session created successfully', { callControlId });

    return session;
  } catch (error) {
    log.error('Failed to create Gemini Live session', error);
    return null;
  }
}

export function handleGeminiMessage(callControlId: string, message: any) {
  try {
    // Find the Telnyx stream for this call
    let telnyxStream: { callControlId: string; ws: WebSocket } | undefined;
    for (const [streamId, stream] of telnyxStreams) {
      if (stream.callControlId === callControlId) {
        telnyxStream = stream;
        break;
      }
    }

    if (!telnyxStream) {
      log.debug('No Telnyx stream found for Gemini response', { callControlId });
      return;
    }

    // Check if this is an audio response
    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData?.data) {
          // Send audio to Telnyx
          const audioData = part.inlineData.data;

          // Telnyx expects audio in base64 format wrapped in a media message
          const mediaMessage = {
            event: 'media',
            media: {
              payload: audioData, // Already base64 encoded from Gemini
            },
          };

          if (telnyxStream.ws.readyState === WebSocket.OPEN) {
            telnyxStream.ws.send(JSON.stringify(mediaMessage));
            log.debug('Sent audio to Telnyx', { callControlId, size: audioData.length });
          }
        }
      }
    }

    // Check if the turn is complete
    if (message.serverContent?.turnComplete) {
      log.debug('Gemini turn complete', { callControlId });
    }
  } catch (error) {
    log.error('Error handling Gemini message', error);
  }
}

export async function sendAudioToGemini(callControlId: string, audioData: string) {
  const session = geminiSessions.get(callControlId);
  if (!session) {
    log.debug('No Gemini session for audio', { callControlId });
    return;
  }

  try {
    // Send audio to Gemini Live session
    // Telnyx streams PCMU (G.711 μ-law) at 8kHz
    await session.liveSession.sendRealtimeInput({
      audio: {
        data: audioData,
        mimeType: 'audio/pcmu',
      },
    });
  } catch (error) {
    log.error('Error sending audio to Gemini', error);
  }
}

export async function closeGeminiSession(callControlId: string) {
  const session = geminiSessions.get(callControlId);
  if (session) {
    try {
      await session.liveSession.close();
    } catch (error) {
      log.debug('Error closing Gemini session', error);
    }
    geminiSessions.delete(callControlId);
    log.info('Gemini session closed', { callControlId });
  }
}
