import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock environment variables for testing
const mockEnv = {
  OPENCLAW_OWNER_IDS: '123456789,987654321',
  OPENCLAW_TELEGRAM_GROUP: '-1001234567890',
  OPENCLAW_ALERT_TOPIC: '12345'
};

// Set up environment before importing
Object.assign(process.env, mockEnv);

// Dynamic import after env setup
const MessageSweepDetector = (await import('../restart-sweep.mjs')).default;

describe('MessageSweepDetector', () => {
  let detector: InstanceType<typeof MessageSweepDetector>;
  
  beforeEach(() => {
    detector = new MessageSweepDetector();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should determine telegram alert mode when both group and topic configured', () => {
      expect(detector.alertMode).toBe('telegram');
    });

    it('should determine telegram_stdout mode when only group configured', () => {
      const originalTopic = process.env.OPENCLAW_ALERT_TOPIC;
      delete process.env.OPENCLAW_ALERT_TOPIC;
      
      const detectorNoTopic = new MessageSweepDetector();
      expect(detectorNoTopic.alertMode).toBe('telegram_stdout');
      
      process.env.OPENCLAW_ALERT_TOPIC = originalTopic;
    });

    it('should determine stdout mode when no telegram config', () => {
      const originalGroup = process.env.OPENCLAW_TELEGRAM_GROUP;
      delete process.env.OPENCLAW_TELEGRAM_GROUP;
      
      const detectorNoGroup = new MessageSweepDetector();
      expect(detectorNoGroup.alertMode).toBe('stdout');
      
      process.env.OPENCLAW_TELEGRAM_GROUP = originalGroup;
    });
  });

  describe('filterTelegramSessions', () => {
    it('should filter Telegram group sessions correctly', () => {
      const sessions = [
        {
          key: 'agent:main:telegram:group:-1001234567890:topic:12345',
          kind: 'group',
          sessionId: 'abc123'
        },
        {
          key: 'agent:main:discord:channel:123456',
          kind: 'channel',
          sessionId: 'def456'
        },
        {
          key: 'agent:main:telegram:group:-1001234567890:topic:67890',
          kind: 'group',
          sessionId: 'ghi789'
        },
        {
          key: 'agent:main:telegram:group:-9999999999:topic:99999',
          kind: 'group',
          sessionId: 'jkl012'
        }
      ];
      
      const filtered = detector.filterTelegramSessions(sessions);
      
      expect(filtered).toHaveLength(2);
      expect(filtered[0].key).toContain('telegram:group:-1001234567890');
      expect(filtered[1].key).toContain('telegram:group:-1001234567890');
      expect(filtered[0].kind).toBe('group');
      expect(filtered[1].kind).toBe('group');
    });

    it('should return empty array when TELEGRAM_GROUP_ID not configured', () => {
      const originalGroup = process.env.OPENCLAW_TELEGRAM_GROUP;
      delete process.env.OPENCLAW_TELEGRAM_GROUP;
      
      const detectorNoGroup = new MessageSweepDetector();
      const sessions = [
        {
          key: 'agent:main:telegram:group:-1001234567890:topic:12345',
          kind: 'group',
          sessionId: 'abc123'
        }
      ];
      
      const filtered = detectorNoGroup.filterTelegramSessions(sessions);
      
      expect(filtered).toHaveLength(0);
      
      process.env.OPENCLAW_TELEGRAM_GROUP = originalGroup;
    });

    it('should return empty array when no matching sessions exist', () => {
      const sessions = [
        {
          key: 'agent:main:discord:channel:123456',
          kind: 'channel',
          sessionId: 'def456'
        }
      ];
      
      const filtered = detector.filterTelegramSessions(sessions);
      
      expect(filtered).toHaveLength(0);
    });
  });

  describe('detectDroppedMessages', () => {
    beforeEach(() => {
      // Set a fixed restart time for testing
      detector.restartTime = new Date('2026-05-06T12:53:45Z').getTime();
    });

    it('should detect sessions with abortedLastRun', async () => {
      const sessions = [
        {
          key: 'agent:main:telegram:group:-1001234567890:topic:12345',
          sessionId: 'abc123',
          updatedAt: new Date('2026-05-06T12:55:00Z').getTime(),
          abortedLastRun: true
        }
      ];
      
      const dropped = await detector.detectDroppedMessages(sessions);
      
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({
        sessionKey: 'agent:main:telegram:group:-1001234567890:topic:12345',
        topic: '12345',
        sessionId: 'abc123',
        abortedLastRun: true,
        reason: 'Session aborted on last run'
      });
    });

    it('should detect suspicious gaps (active before restart, silent after)', async () => {
      const sessions = [
        {
          key: 'agent:main:telegram:group:-1001234567890:topic:67890',
          sessionId: 'def456',
          // 2 minutes before restart (within 5-minute window)
          updatedAt: new Date('2026-05-06T12:51:45Z').getTime(),
          abortedLastRun: false
        }
      ];
      
      // Mock current time to be 15 minutes after restart (past 10-minute window)
      const originalDateNow = Date.now;
      Date.now = vi.fn(() => new Date('2026-05-06T13:08:45Z').getTime());
      
      try {
        const dropped = await detector.detectDroppedMessages(sessions);
        
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toMatchObject({
          sessionKey: 'agent:main:telegram:group:-1001234567890:topic:67890',
          topic: '67890',
          sessionId: 'def456',
          suspiciousGap: true,
          reason: 'Active before restart, silent after'
        });
      } finally {
        // Restore Date.now
        Date.now = originalDateNow;
      }
    });

    it('should extract topic ID from session key', async () => {
      const sessions = [
        {
          key: 'agent:main:telegram:group:-1001234567890:topic:99888',
          sessionId: 'xyz789',
          updatedAt: new Date('2026-05-06T12:55:00Z').getTime(),
          abortedLastRun: true
        }
      ];
      
      const dropped = await detector.detectDroppedMessages(sessions);
      
      expect(dropped[0].topic).toBe('99888');
    });

    it('should handle malformed session keys gracefully', async () => {
      const sessions = [
        {
          key: 'malformed:session:key',
          sessionId: 'bad123',
          updatedAt: new Date('2026-05-06T12:55:00Z').getTime(),
          abortedLastRun: true
        }
      ];
      
      const dropped = await detector.detectDroppedMessages(sessions);
      
      expect(dropped[0].topic).toBe('unknown');
    });
  });

  describe('log parsing logic', () => {
    it('should extract timestamp from Gateway token synced log', () => {
      const logLine = '2026-05-06 12:53:45 Gateway token synced to .env';
      const match = logLine.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      
      expect(match).toBeTruthy();
      expect(match![1]).toBe('2026-05-06 12:53:45');
    });

    it('should extract timestamp from OpenClaw gateway log', () => {
      const logLine = '2026-05-06 12:53:45 ✅ OpenClaw gateway started';
      const match = logLine.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      
      expect(match).toBeTruthy();
      expect(match![1]).toBe('2026-05-06 12:53:45');
    });

    it('should extract topic from session key', () => {
      const sessionKey = 'agent:main:telegram:group:-1001234567890:topic:12345';
      const topicMatch = sessionKey.match(/:topic:(\d+)/);
      
      expect(topicMatch).toBeTruthy();
      expect(topicMatch![1]).toBe('12345');
    });
  });
});