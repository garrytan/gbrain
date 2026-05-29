import { describe, expect, test } from 'bun:test';
import {
  readArgs,
  renderTenantPlan,
  resolveTenantPlan,
} from '../scripts/saas-tenant-plan.ts';

describe('SaaS tenant plan args', () => {
  test('parses plan options', () => {
    expect(readArgs(['deploy/saas/tenant-brains.example.yml', '--check', '--json'])).toEqual({
      planPath: 'deploy/saas/tenant-brains.example.yml',
      check: true,
      json: true,
      help: false,
    });
  });

  test('rejects unknown flags and extra positionals', () => {
    expect(() => readArgs(['tenant.yml', '--wat'])).toThrow(/Unknown flag/);
    expect(() => readArgs(['tenant.yml', 'other.yml'])).toThrow(/Unexpected positional/);
  });
});

describe('SaaS tenant plan model', () => {
  test('resolves multiple brains for one company tenant', () => {
    const plan = resolveTenantPlan({
      company: { id: 'acme', name: 'Acme' },
      provider: { name: 'railway', environment: 'production' },
      brains: [
        { id: 'company', manifest: 'company.yml', env_file: '.env.company' },
        {
          id: 'finance',
          manifest: 'finance.yml',
          railway_service: 'finance-web',
          railway_worker_service: 'finance-worker',
        },
      ],
    });

    expect(plan.companyId).toBe('acme');
    expect(plan.brains).toHaveLength(2);
    expect(plan.brains[0].railwayService).toBe('acme-company-brain-web');
    expect(plan.brains[1].railwayService).toBe('finance-web');
    expect(plan.brains[1].railwayWorkerService).toBe('finance-worker');
  });

  test('rejects duplicate brain ids', () => {
    expect(() => resolveTenantPlan({
      company: { id: 'acme' },
      brains: [
        { id: 'company', manifest: 'one.yml' },
        { id: 'company', manifest: 'two.yml' },
      ],
    })).toThrow(/duplicate brain/);
  });

  test('renders Railway web and worker rollout commands', () => {
    const rendered = renderTenantPlan(resolveTenantPlan({
      company: { id: 'acme', name: 'Acme' },
      brains: [{
        id: 'company',
        public_url: 'https://brain.acme.test',
        env_file: '.env.acme',
        manifest: 'company.yml',
      }],
    }));

    expect(rendered).toContain('company tenant -> brains -> sources -> folders');
    expect(rendered).toContain('railway up --service acme-company-brain-web');
    expect(rendered).toContain('CORTEX_PROCESS=worker');
    expect(rendered).toContain('RAILWAY_PUBLIC_DOMAIN');
    expect(rendered).toContain('bun run smoke:saas-live -- --base-url https://brain.acme.test');
    expect(rendered).toContain('curl https://brain.acme.test/health');
  });
});
