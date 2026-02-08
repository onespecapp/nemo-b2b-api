import { GoogleGenAI } from '@google/genai';
import { config } from '../config';

// Initialize Google GenAI client if API key is available
export const googleAI = config.googleAiApiKey ? new GoogleGenAI({ apiKey: config.googleAiApiKey }) : null;
