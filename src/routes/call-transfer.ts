import { Router, Request, Response } from 'express';
import { config, log } from '../config';
import { supabase } from '../clients/supabase';
import { livekitEnabled, sipClient } from '../clients/livekit';
import { authenticateInternal } from '../middleware/auth';
import { isValidUUID } from '../middleware/validation';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Transfer a live call to another phone number
router.post('/api/calls/:callLogId/transfer', authenticateInternal, asyncHandler(async (req: Request, res: Response) => {
  const { callLogId } = req.params;
  const { transfer_to } = req.body;

  if (!isValidUUID(callLogId)) {
    return res.status(400).json({ error: 'Invalid call log ID format' });
  }

  if (!transfer_to || !transfer_to.match(/^\+?[1-9]\d{1,14}$/)) {
    return res.status(400).json({ error: 'Invalid transfer_to phone number' });
  }

  if (!livekitEnabled || !sipClient) {
    return res.status(503).json({ error: 'LiveKit not configured for call transfer' });
  }

  // Look up call log to get room_name
  const { data: callLog, error: fetchError } = await supabase
    .from('b2b_call_logs')
    .select('id, room_name, business_id')
    .eq('id', callLogId)
    .single();

  if (fetchError || !callLog) {
    return res.status(404).json({ error: 'Call log not found' });
  }

  if (!callLog.room_name) {
    return res.status(400).json({ error: 'Call has no active room' });
  }

  try {
    // Create a new SIP participant in the existing LiveKit room
    await sipClient.createSipParticipant(
      config.livekitSipTrunkId,
      transfer_to,
      callLog.room_name,
      {
        participantIdentity: `transfer-${Date.now()}`,
        participantName: 'Transfer',
        playDialtone: false,
      }
    );

    // Update call log outcome to TRANSFERRED
    await supabase
      .from('b2b_call_logs')
      .update({ call_outcome: 'TRANSFERRED' })
      .eq('id', callLogId);

    log.info('Call transferred', { callLogId, transferTo: transfer_to, room: callLog.room_name });
    res.json({ success: true, message: 'Call transfer initiated' });
  } catch (error) {
    log.error('Failed to transfer call', error);
    res.status(500).json({ error: 'Failed to initiate call transfer' });
  }
}));

export default router;
