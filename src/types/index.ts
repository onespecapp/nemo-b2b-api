import { Request } from 'express';

// Extended Request type with user info
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    business_id?: string;
    email?: string;
  };
}

export interface GeminiSession {
  callControlId: string;
  liveSession: any;
  systemPrompt: string;
}
