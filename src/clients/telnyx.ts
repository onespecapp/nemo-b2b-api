import Telnyx from 'telnyx';
import { config } from '../config';

export const telnyx = new Telnyx({ apiKey: config.telnyxApiKey });
