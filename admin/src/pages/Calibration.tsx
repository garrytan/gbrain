/**
 * v0.36.0.0 (T15 / E6) — Calibration tab.
 *
 * Fetches the active calibration profile + 4 server-rendered SVG charts.
 * Layout: Linear calm clarity (per D23 mockup variant-B) — single column,
 * generous whitespace, ONE big sparkline as hero, then patterns, then
 * domain bars, then abandoned threads.
 *
 * Per D23 — SVG markup comes from the server (image/svg+xml endpoint).
 * Admin SPA renders inside a TrustedSVG wrapper that uses
 * dangerouslySetInnerHTML. XSS posture: server-side escapeXml() on all
 * caller-controlled strings + requireAdmin middleware on the endpoint.
 */

import React, { useEffect, useState } from 'react';
import { api } from '../api';

interface CalibrationProfileSummary {
  holder: string;
  source_id: string;
  generated_at: string;
  published: boolean;
  total_resolved: number;
  brier: number | null;
  accuracy: number | null;
  partial_rate: number | null;
  grade_completion: number;
  pattern_statements: string[];
  active_bias_tags: string[];
  voice_gate_passed: boolean;
  voice_gate_attempts: number;
}

interface ChartSvgProps {
  type: string;
  ariaLabel: string;
}

function TrustedSVG({ markup }: { markup: string }) {
  return (
    <div
      style={{ width: '100%', overflow: 'auto' }}
      // Server-rendered SVG (image/svg+xml) gated by requireAdmin middleware.
      // All caller-controlled strings pass through escapeXml() server-side.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

function ChartSvg({ type, ariaLabel }: ChartSvgProps) {
  const [markup, setMarkup] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    api
      .calibrationChart(type)
      .then(svg => {
        if (!cancelled) setMarkup(svg);
      })
      .catch(err => {
        if (!cancelled) setError(err.message ?? 'fetch failed');
      });
    return () => {
      cancelled = true;
    };
  }, [type]);

  if (error) {
    return (
      <div style={{ padding: 16, color: 'var(--error)' }} role="alert">
        {ariaLabel}: {error}
      </div>
    );
  }
  if (!markup) {
    return <div style={{ padding: 16, color: 'var(--text-muted)' }}>{ariaLabel} loading...</div>;
  }
  return <TrustedSVG markup={markup} />;
}

export function CalibrationPage() {
  const [profile, setProfile] = useState<CalibrationProfileSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    api
      .calibrationProfile()
      .then(p => {
        setProfile(p);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message ?? 'fetch failed');
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div style={{ padding: 24, color: 'var(--text-secondary)' }}>Loading calibration profile…</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--error)' }} role="alert">
        Could not load calibration profile: {error}
      </div>
    );
  }
  if (!profile) {
    return (
      <div style={{ padding: 24, maxWidth: 700 }}>
        <h1 style={{ marginBottom: 16 }}>Calibration</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          No calibration profile yet. Builds after 5+ resolved takes.
        </p>
        <pre
          style={{
            background: 'var(--bg-secondary)',
            padding: 12,
            borderRadius: 4,
            color: 'var(--text-primary)',
            marginTop: 12,
            fontFamily: 'var(--font-mono)',
          }}
        >
          gbrain dream --phase calibration_profile
        </pre>
      </div>
    );
  }

  const generated = new Date(profile.generated_at);
  const generatedAgo = Math.floor((Date.now() - generated.getTime()) / (1000 * 60 * 60 * 24));

  return (
    <div style={{ padding: 32, maxWidth: 720 }}>
      <h1 style={{ marginBottom: 8 }}>Calibration</h1>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
        Holder: {profile.holder}
        {' · '}
        Updated {generatedAgo === 0 ? 'today' : `${generatedAgo}d ago`}
        {profile.published && ' · published'}
        {profile.grade_completion < 0.9 && ` · ~${Math.round(profile.grade_completion * 100)}% graded`}
        {!profile.voice_gate_passed && ' · voice gate fell back to template'}
      </div>

      <section style={{ marginBottom: 32 }}>
        <ChartSvg type="brier-trend" ariaLabel="Brier trend" />
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12, fontWeight: 400 }}>
          Pattern statements
        </h2>
        <ChartSvg type="pattern-statements" ariaLabel="Pattern statements" />
      </section>

      <section style={{ marginBottom: 32 }}>
        <ChartSvg type="domain-bars" ariaLabel="Per-domain accuracy" />
      </section>

      <section style={{ marginBottom: 32 }}>
        <ChartSvg type="abandoned-threads" ariaLabel="Abandoned threads" />
      </section>

      {profile.active_bias_tags.length > 0 && (
        <section style={{ marginBottom: 32, color: 'var(--text-muted)', fontSize: 13 }}>
          Active bias tags: {profile.active_bias_tags.join(', ')}
        </section>
      )}
    </div>
  );
}
