import rateLimit from 'express-rate-limit';

/** Independent stores: successful owner traffic does not spend the failure
 * allowance. Authentication success is authority verification, not HTTP status
 * (e.g. a valid owner may request an expired consent continuation). */
export function createAdminLimiters() {
  const common = { windowMs: 60_000, standardHeaders: true, legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Administration rate limit reached. Wait for Retry-After before trying again.' } };
  return {
    total: rateLimit({ ...common, max: 60 }),
    failures: rateLimit({ ...common, max: 10, skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.locals.ownerAuthenticated === true }),
    consent: rateLimit({ ...common, max: 60, keyGenerator: req => String(req.cookies.gbrain_admin) }),
  };
}
