# gdoc-ingest — Como usar (Rafael)

> Skill v0.5.0. Ingestão automática de Google Workspace docs no brain.

## TL;DR

**Você não precisa fazer nada.** Cole link Drive em qualquer canal Slack monitorado, eu indexo silenciosamente. Sexta 15h te aviso o que precisa de triagem.

## Os 4 modos

### 1. Captura ad-hoc (você cola link)

Cole no Slack:
```
https://docs.google.com/spreadsheets/d/...
```

Eu detecto, ingiro em background, página vai pra `docs/inbox/<slug>` com status `draft-index`. Sem barulho no chat.

### 2. Comando explícito

```
ingest gdoc <url>
salva esse link <url>
indexa esse doc
```

Mesmo fluxo, mas com confirmação visível.

### 3. Crawler semanal (automático, sex 17h)

Cron varre seu Drive: docs/sheets/slides/PDFs modificados nos últimos 7 dias que ainda não estão indexados. Indexa tudo, ping Slack.

### 4. CLI manual

```bash
~/.bun/bin/bun run ~/gbrain/skills/gdoc-ingest/scripts/gdoc-ingest.mjs "<url>" --commit
```

## Triagem semanal (sex 15h BRT)

Sexta 15h vou postar:
```
📋 Triagem semanal docs/inbox
N documento(s) aguardando confirmação de slug.
Top recentes:
• docs/inbox/relatorio-x | Relatório X
• docs/inbox/playbook-y | Playbook Y
...
```

Você responde:
- ✅ confirma → move pra `docs/<disciplina>/<tema>/<slug>`, status: oficial
- ✏️ corrige slug → "muda pra docs/ops/df/relatorio-2026-04"
- 🗑️ descarta → soft-delete
- 🔗 sucessor → marca predecessor como arquivado

## Buscar um doc

```
gbrain__search("playbook fechamento")
gbrain__query("relatório DF abril 2026")
gbrain__get_page("docs/ops/df/relatorio-mensal-2026-04")
```

Resultado tem: resumo, owner, status, link Drive direto.

## Frontmatter de cada página

```yaml
---
type: document
title: "Nome humano"
status: draft-index | oficial | arquivado | stale-untriaged
disciplina: ops | fiscal | contabil | rh | tech | comercial | juridico | exec
tema: df | inativos | fechamento | gestao | metas | etc
secondary_tags: [df, fte, backlog]
kind: doc | sheet | slide | pdf
owner: rafael.reis@contabilizei.com.br
url_drive: https://docs.google.com/...
file_id: abc123
mimetype: application/vnd.google-apps.spreadsheet
last_modified_drive: 2026-05-06T20:30:20Z
indexed_at: 2026-05-06T23:24:26Z
indexed_via: slack-paste | drive-crawler | manual-cli
raw_char_count: 17408
sheet_stats: { totalTabs: 29, readTabs: 3, priorityTab: "Areas Rafa" }
---
```

## Iron Law (back-links automáticos)

Quando ingiro um doc, *toda pessoa/projeto mencionada que JÁ tem página no brain* recebe um back-link FROM ela TO o doc. 

Notability gate: não crio páginas novas pra entidades — isso é decisão sua na triagem.

## Sucessor detection

Se o título do novo doc sugere ser uma versão mais recente (ex: "Relatório Mar 2026" e existe "Relatório Feb 2026" no brain), eu flago `successorOf` no payload. Você decide se arquiva o antigo.

## Crons ativos

| Cron | Schedule | O que faz |
|------|----------|-----------|
| `gdoc-crawler-weekly` | Sex 17h BRT | Varre Drive 7 dias, ingere novos |
| `gdoc-inbox-triagem-ping` | Sex 15h BRT | Lista pending, ping Slack |
| `gdoc-inbox-stale-check` | Diário 09h BRT | Tag stale-untriaged em items >60d |

```bash
# Ver status
launchctl list | grep gdoc

# Ver logs
tail -f ~/.gbrain/gdoc-*.log

# Rodar manualmente
~/.gbrain/gdoc-crawler-weekly.sh
```

## Filtrar busca por tipo doc

GBrain query é semantic — pode prefixar:
```
gbrain__query("doc relatório DF")
gbrain__query("documento gestão contábil")
```

Ou filtrar slug:
```bash
psql "$DATABASE_URL" -c "SELECT slug, title FROM pages WHERE slug LIKE 'docs/%';"
```

## Dúvidas comuns

**Q: Mesmo doc colado 2x cria 2 páginas?**
A: Não. Slug é determinístico pelo título → idempotente. Re-ingest sobrescreve.

**Q: PDFs com OCR?**
A: PDFs nativos texto: extraídos via `pdftotext`. PDFs scaneados: precisam reprocessar via `PdfParse` no agent runtime.

**Q: Sheet com 50 abas?**
A: Lemos só priority + 2 outras (~3 tabs total) = 50×26 cells cada. Resto fica não-lido mas catalogado nos `sheet_stats.totalTabs`. Se quiser ler aba específica, abrir essa aba no browser e re-colar URL com `?gid=N`.

**Q: PII no doc?**
A: Heurística de extração NÃO filtra. LLM no triage (sonnet-4-6) é responsável por flag/redact.

**Q: Doc privado revogado?**
A: Próximo ingest vai falhar. Não há health check periódico ainda (Sprint futuro).

## Skill version

v0.5.0 — Sprint 5 (PDF + crons) + Sprint 6 (Iron Law + sucessor) + Sprint 7 (evals + hardening) — 06/05/2026

```
~/.bun/bin/bun test ~/gbrain/test/gdoc-ingest.test.ts
# 64 pass, 0 fail, 299 expect()
```
