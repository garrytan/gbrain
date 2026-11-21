import type { Migration } from './types.ts';

// v314 keeps pre-existing duplicate promotions and skips its unique index.
// Only retire the single-column index where the expected unique index can
// serve the same guest-page lookup. Leave custom or invalid indexes alone.
export const v331: Migration = {
  version: 331,
  name: 'guest_promotion_prefix_index',
  idempotent: true,
  sql: `DO $idx$ BEGIN
    IF to_regclass('public.guest_promotions_guest_page_idx') IS NULL
       OR to_regclass('public.guest_promotions_link_key') IS NULL THEN
      RETURN;
    END IF;
    LOCK TABLE public.guest_promotions IN ACCESS EXCLUSIVE MODE;
    IF pg_get_indexdef(to_regclass('public.guest_promotions_guest_page_idx')) =
        'CREATE INDEX guest_promotions_guest_page_idx ON public.guest_promotions USING btree (guest_page_id)'
        AND EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indexrelid = to_regclass('public.guest_promotions_link_key')
            AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
            AND pg_get_indexdef(i.indexrelid) =
                'CREATE UNIQUE INDEX guest_promotions_link_key ON public.guest_promotions USING btree (guest_page_id, target_source_id, target_slug)'
        ) THEN
      DROP INDEX public.guest_promotions_guest_page_idx;
    END IF;
  END $idx$;`,
};
