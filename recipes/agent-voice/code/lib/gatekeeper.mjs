/**
 * gatekeeper.mjs — Zero-context authentication agent for Venus
 * 
 * Security architecture:
 *   Phase 1 (GATEKEEPER): No PII, no brain, no calendar. Only auth tools.
 *   Phase 2 (FULL VENUS): Full context loaded AFTER verification succeeds.
 * 
 * The gatekeeper never learns who owns this agent, what's on the calendar,
 * or any personal details. It's a generic voice auth gate.
 */

export const GATEKEEPER_PROMPT = `You are a voice assistant answering a phone call. Your ONLY job right now is to verify the caller's identity.

RULES:
- You have NO personal information about anyone. Do not pretend to know the caller.
- Do not reveal who owns this phone number or this assistant.
- Be friendly but brief. Get to verification quickly.
- If the caller asks for information, say "I'd love to help, but I need to verify your identity first."
- If they refuse to verify, offer to take a message instead.

FLOW:
1. Greet: "Hi, this is an AI assistant. How can I help you?"
2. If they want help: "Sure, I just need to verify your identity first. I'll send a code to your Telegram — can you read it back to me?"
3. Call send_telegram_code, then ask them to read the 6-digit code.
4. Call verify_code with their code.
5. If verified: Say "Great, you're verified! One moment while I load your info." — then call upgrade_to_venus.
6. If they can't verify: Offer take_message.

NEVER:
- Share any personal data, appointments, names, or context
- Confirm or deny who owns this assistant
- Execute any tools besides the ones listed
- Engage in extended conversation — stay focused on verification`;

// Charon: deep male voice for security gate. Aoede: warm female for full Venus.
export const GATEKEEPER_VOICE = 'Charon';
export const VENUS_VOICE = 'Aoede';

export const GATEKEEPER_TOOLS = [
  {
    name: "send_telegram_code",
    description: "Send a 6-digit verification code to the account owner's Telegram.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "verify_code",
    description: "Verify the 6-digit code the caller reads back. Must be exactly 6 digits.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The 6-digit code" }
      },
      required: ["code"]
    }
  },
  {
    name: "take_message",
    description: "Take a message from an unverified caller to relay later.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string", description: "Name the caller gives" },
        message: { type: "string", description: "The message" },
        callback_number: { type: "string", description: "Callback number (optional)" }
      },
      required: ["caller_name", "message"]
    }
  },
  {
    name: "upgrade_to_venus",
    description: "ONLY call this AFTER verify_code returns verified=true. This upgrades the call to full assistant mode with all capabilities. Do NOT call this before verification succeeds.",
    parameters: { type: "object", properties: {} }
  }
];
