import { Request } from 'express';

// Extended Request type with user info
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    business_id?: string;
    email?: string;
  };
}

export interface BusinessHoursDay {
  open: string;
  close: string;
  closed: boolean;
}

export interface BusinessHours {
  monday: BusinessHoursDay;
  tuesday: BusinessHoursDay;
  wednesday: BusinessHoursDay;
  thursday: BusinessHoursDay;
  friday: BusinessHoursDay;
  saturday: BusinessHoursDay;
  sunday: BusinessHoursDay;
}

export interface FAQEntry {
  question: string;
  answer: string;
}

export interface ReceptionistConfig {
  receptionist_enabled: boolean;
  receptionist_greeting: string | null;
  business_hours: BusinessHours;
  services: string[];
  faqs: FAQEntry[];
  transfer_phone: string | null;
  receptionist_instructions: string | null;
}

export interface Message {
  id: string;
  business_id: string;
  call_log_id: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  message: string;
  reason: string | null;
  urgency: 'normal' | 'urgent' | 'low';
  read: boolean;
  created_at: string;
  updated_at: string;
}

export interface ServiceEntry {
  name: string;
  description?: string;
  price_min?: number;
  price_max?: number;
  duration_min?: number;
  is_emergency?: boolean;
}

export interface InboundCallMetadata {
  call_type: 'inbound_receptionist';
  business_id: string;
  business_name: string;
  receptionist_greeting: string | null;
  services: (string | ServiceEntry)[];
  faqs: FAQEntry[];
  business_hours: BusinessHours;
  transfer_phone: string | null;
  receptionist_instructions: string | null;
  call_log_id: string;
  caller_phone: string;
  is_after_hours: boolean;
  voice_preference: string;
  booking_enabled: boolean;
  default_appointment_duration: number;
  booking_advance_days: number;
  business_category: string;
}
