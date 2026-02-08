import { SipClient, RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';
import { config } from '../config';

// LiveKit clients (initialized if config is present)
export const livekitEnabled = !!(config.livekitUrl && config.livekitApiKey && config.livekitApiSecret && config.livekitSipTrunkId);
export let sipClient: SipClient | null = null;
export let roomClient: RoomServiceClient | null = null;
export let agentDispatch: AgentDispatchClient | null = null;

if (livekitEnabled) {
  sipClient = new SipClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);
  roomClient = new RoomServiceClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);
  agentDispatch = new AgentDispatchClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);
  console.log('✅ LiveKit integration enabled');
  console.log(`   Agent: ${config.livekitAgentName}`);
} else {
  console.log('⚠️ LiveKit not configured - using basic Telnyx TTS for calls');
}
