/**
 * POST /integrations/slack/interactions for `gbrain serve --http`: Slack's interactivity Request URL for the slack
 * notification sink's Accept / Reject buttons. Anonymous by necessity (Slack carries no gbrain credential): every
 * request must carry a valid Slack signature (notifications/slack-interactions.ts), is rate limited per IP, and only
 * queues the click; the decision runs from the outbox. 404 while no interactive slack sink has a signing secret, 401
 * for a missing or bad signature, 200 (empty body) otherwise. Expose only this path publicly
 * (docs/integrations/notification-sinks.md#exposing-the-interactions-endpoint).
 */
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { ServeHttpContext } from './serve-http.ts';
import { receiveSlackInteraction, SLACK_INTERACTIONS_PATH } from '../core/notifications/slack-interactions.ts';

export function mountSlackInteractions(app: Express, ctx: Pick<ServeHttpContext, 'engine'>): void {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  app.post(SLACK_INTERACTIONS_PATH, limiter, express.raw({ type: '*/*', limit: '256kb' }), async (req: Request, res: Response) => {
    const signature = req.header('X-Slack-Signature');
    const timestamp = req.header('X-Slack-Request-Timestamp');
    if (!signature || !timestamp) { res.status(401).json({ error: 'missing_signature' }); return; }
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    try {
      const outcome = await receiveSlackInteraction(ctx.engine, { body, timestamp, signature });
      if (outcome.status === 404) { res.status(404).json({ error: 'not_found' }); return; }
      if (outcome.status === 401) { res.status(401).json({ error: 'invalid_signature' }); return; }
      res.status(200).end();
    } catch (error) {
      console.error(`[notify] slack interaction failed: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ error: 'internal_error' });
    }
  });
}
