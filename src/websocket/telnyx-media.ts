import { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { log } from '../config';
import { telnyxStreams, sendAudioToGemini, closeGeminiSession } from '../services/gemini-session';

export function setupTelnyxMediaWebSocket(server: Server) {
  // WebSocket server for Telnyx media streams
  const wss = new WebSocketServer({ server, path: '/media-stream' });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url || '', `ws://${req.headers.host}`);
    const streamId = url.searchParams.get('stream_id') || `stream-${Date.now()}`;
    const callControlId = url.searchParams.get('call_control_id') || '';

    log.info('Telnyx media stream connected', { streamId, callControlId });

    telnyxStreams.set(streamId, { callControlId, ws });

    ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.event === 'media' && message.media?.payload) {
          // Forward audio from Telnyx to Gemini
          await sendAudioToGemini(callControlId, message.media.payload);
        } else if (message.event === 'start') {
          log.info('Telnyx media stream started', { streamId, callControlId: message.start?.call_control_id });
          // Update callControlId if provided in start message
          if (message.start?.call_control_id) {
            const stream = telnyxStreams.get(streamId);
            if (stream) {
              stream.callControlId = message.start.call_control_id;
            }
          }
        } else if (message.event === 'stop') {
          log.info('Telnyx media stream stopped', { streamId });
        }
      } catch (error) {
        log.error('Error processing Telnyx media', error);
      }
    });

    ws.on('close', () => {
      log.info('Telnyx media stream disconnected', { streamId });
      telnyxStreams.delete(streamId);

      // Also close the Gemini session
      if (callControlId) {
        closeGeminiSession(callControlId);
      }
    });

    ws.on('error', (error) => {
      log.error('Telnyx media stream error', { streamId, error: error.message });
    });
  });

  return wss;
}
