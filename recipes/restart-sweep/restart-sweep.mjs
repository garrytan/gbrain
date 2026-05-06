#!/usr/bin/env node

/**
 * Restart Message Sweep Script
 * 
 * Detects Telegram messages that were dropped during gateway restarts.
 * When the OpenClaw gateway restarts, messages that were received by webhook 
 * but not yet processed by the agent get dropped. This script identifies these gaps.
 * 
 * Since we use webhooks (not long-polling), we can't use Telegram's getUpdates
 * to fetch missed messages. Instead, we analyze OpenClaw's session state to
 * identify sessions with potential dropped messages.
 */

import fs from 'fs/promises';
import path from 'path';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCallback);

// Configuration from environment
const OWNER_IDS = process.env.OPENCLAW_OWNER_IDS?.split(',').map(id => id.trim()) || [];
const TELEGRAM_GROUP_ID = process.env.OPENCLAW_TELEGRAM_GROUP || '';
const ALERT_TOPIC = process.env.OPENCLAW_ALERT_TOPIC || '';
const RESTART_THRESHOLD_MINUTES = 30; // Look for gaps in this time window
const MIN_SEVERITY_FOR_ALERT = 1; // Only alert if this many or more dropped messages

class MessageSweepDetector {
    constructor() {
        this.sessions = null;
        this.restartTime = null;
        this.alertMode = this.determineAlertMode();
    }

    determineAlertMode() {
        if (TELEGRAM_GROUP_ID && ALERT_TOPIC) {
            return 'telegram';
        } else if (TELEGRAM_GROUP_ID) {
            return 'telegram_stdout';
        } else {
            return 'stdout';
        }
    }

    async run() {
        try {
            console.log('🔍 Starting restart message sweep detection...');
            
            if (OWNER_IDS.length === 0) {
                console.warn('⚠️  No OPENCLAW_OWNER_IDS configured. Set this environment variable.');
            }
            
            if (!TELEGRAM_GROUP_ID) {
                console.warn('⚠️  No OPENCLAW_TELEGRAM_GROUP configured. Alerts will only go to stdout.');
            }
            
            // Get the latest restart time
            this.restartTime = await this.getLastRestartTime();
            console.log(`📅 Last restart detected at: ${new Date(this.restartTime).toISOString()}`);

            // Get current session state
            this.sessions = await this.getSessionState();
            console.log(`📊 Found ${this.sessions.length} total sessions`);

            // Filter to relevant Telegram sessions
            const telegramSessions = this.filterTelegramSessions(this.sessions);
            console.log(`📱 Found ${telegramSessions.length} Telegram sessions`);

            // Detect potentially dropped messages
            const droppedMessages = await this.detectDroppedMessages(telegramSessions);
            
            if (droppedMessages.length > 0) {
                console.log(`⚠️  Found ${droppedMessages.length} potentially dropped messages`);
                await this.alertOnDroppedMessages(droppedMessages);
            } else {
                console.log('✅ No dropped messages detected');
            }

            await this.logResults(droppedMessages);

        } catch (error) {
            console.error('❌ Error in message sweep:', error);
            await this.logError(error);
        }
    }

    async getLastRestartTime() {
        try {
            // Try to get restart time from bootstrap log
            const logPath = '/tmp/bootstrap-services.log';
            const logContent = await fs.readFile(logPath, 'utf8');
            
            // Find the most recent gateway startup
            const gatewayLines = logContent.split('\n')
                .filter(line => line.includes('Gateway token synced') || line.includes('✅ OpenClaw gateway'))
                .reverse(); // Most recent first
                
            if (gatewayLines.length > 0) {
                // Extract timestamp from log line like "2026-05-06 12:53:45 Gateway token synced to .env"
                const match = gatewayLines[0].match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                if (match) {
                    return new Date(match[1] + ' UTC').getTime();
                }
            }
            
            // Fallback: use current time minus threshold window
            return Date.now() - (RESTART_THRESHOLD_MINUTES * 60 * 1000);
            
        } catch (error) {
            console.warn('⚠️  Could not determine restart time from logs, using fallback');
            return Date.now() - (RESTART_THRESHOLD_MINUTES * 60 * 1000);
        }
    }

    async getSessionState() {
        try {
            const { stdout } = await exec('openclaw sessions --json');
            const sessionData = JSON.parse(stdout);
            return sessionData.sessions || [];
        } catch (error) {
            console.error('❌ Failed to get session state:', error);
            throw error;
        }
    }

    filterTelegramSessions(sessions) {
        if (!TELEGRAM_GROUP_ID) {
            return [];
        }
        
        return sessions.filter(session => {
            return session.key &&
                   session.key.includes('telegram:group:' + TELEGRAM_GROUP_ID) &&
                   session.kind === 'group';
        });
    }

    async detectDroppedMessages(telegramSessions) {
        const droppedMessages = [];
        
        // Only check recent sessions (within restart threshold)
        const recentRestartWindow = this.restartTime - (5 * 60 * 1000); // 5 minutes before restart
        const afterRestartWindow = this.restartTime + (10 * 60 * 1000); // 10 minutes after restart
        
        for (const session of telegramSessions) {
            try {
                const sessionUpdated = session.updatedAt;
                
                // Check for sessions with aborted last run (more reliable indicator)
                if (session.abortedLastRun) {
                    const topicMatch = session.key.match(/:topic:(\d+)/);
                    const topic = topicMatch ? topicMatch[1] : 'unknown';
                    
                    droppedMessages.push({
                        sessionKey: session.key,
                        topic: topic,
                        lastUpdate: new Date(sessionUpdated).toISOString(),
                        sessionId: session.sessionId,
                        abortedLastRun: true,
                        reason: 'Session aborted on last run'
                    });
                    continue;
                }
                
                // Look for sessions that were active just before restart but not after
                // More conservative: only flag if session was updated in the 5 minutes before restart
                // but hasn't been updated in the 15 minutes after restart
                if (sessionUpdated >= recentRestartWindow && 
                    sessionUpdated < this.restartTime &&
                    Date.now() > afterRestartWindow) {
                    
                    // Extract topic from session key
                    const topicMatch = session.key.match(/:topic:(\d+)/);
                    const topic = topicMatch ? topicMatch[1] : 'unknown';
                    
                    droppedMessages.push({
                        sessionKey: session.key,
                        topic: topic,
                        lastUpdate: new Date(sessionUpdated).toISOString(),
                        timeSinceUpdate: Math.floor((Date.now() - sessionUpdated) / 1000 / 60),
                        sessionId: session.sessionId,
                        suspiciousGap: true,
                        reason: 'Active before restart, silent after'
                    });
                }
                
            } catch (error) {
                console.warn(`⚠️  Error analyzing session ${session.key}:`, error);
            }
        }
        
        return droppedMessages;
    }

    async alertOnDroppedMessages(droppedMessages) {
        try {
            let alertText = `⚠️ Found ${droppedMessages.length} unprocessed message(s) after restart:\\n\\n`;
            
            for (const msg of droppedMessages.slice(0, 10)) { // Limit to first 10
                alertText += `• Topic ${msg.topic}: ${msg.reason} (last update: ${msg.lastUpdate})\\n`;
                
                if (msg.timeSinceUpdate) {
                    alertText += `  ${msg.timeSinceUpdate} minutes ago\\n`;
                }
            }
            
            if (droppedMessages.length > 10) {
                alertText += `\\n... and ${droppedMessages.length - 10} more`;
            }
            
            // Send alert based on configured mode
            switch (this.alertMode) {
                case 'telegram':
                    await this.sendTelegramAlert(alertText);
                    break;
                case 'telegram_stdout':
                    console.log('📢 Would send Telegram alert, but no topic configured:');
                    console.log(alertText.replace(/\\n/g, '\n'));
                    break;
                default:
                    console.log('📢 Alert:');
                    console.log(alertText.replace(/\\n/g, '\n'));
            }
            
        } catch (error) {
            console.error('❌ Failed to send alert:', error);
        }
    }

    async sendTelegramAlert(alertText) {
        // Use OpenClaw CLI to send alert
        const escapedMessage = alertText.replace(/'/g, "'\"'\"'");
        const command = `openclaw message send --channel telegram --target ${TELEGRAM_GROUP_ID} --thread-id ${ALERT_TOPIC} --message '${escapedMessage}'`;
        
        await exec(command);
        console.log('📢 Alert sent to Telegram');
    }

    async logResults(droppedMessages) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            restartTime: new Date(this.restartTime).toISOString(),
            droppedMessageCount: droppedMessages.length,
            droppedMessages: droppedMessages
        };
        
        try {
            await fs.appendFile('/tmp/restart-sweep.log', JSON.stringify(logEntry) + '\\n');
            console.log(`📝 Results logged to /tmp/restart-sweep.log`);
        } catch (error) {
            console.warn('⚠️  Failed to write log file:', error);
        }
    }

    async logError(error) {
        const errorEntry = {
            timestamp: new Date().toISOString(),
            error: error.message,
            stack: error.stack
        };
        
        try {
            await fs.appendFile('/tmp/restart-sweep.log', 'ERROR: ' + JSON.stringify(errorEntry) + '\\n');
        } catch (logError) {
            console.error('Failed to log error:', logError);
        }
    }
}

// Run the detector if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const detector = new MessageSweepDetector();
    detector.run().catch(console.error);
}

export default MessageSweepDetector;