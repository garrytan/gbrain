/**
 * Child-process preload for doctor goldens that print a calendar day: when
 * `$GBRAIN_TEST_CLOCK_OFFSET_MS` is set, the process clock reads the real
 * clock shifted by that many milliseconds. The harness computes one offset per
 * doctor home (test/helpers/doctor-json-golden.ts `makeDoctorHome({ clock })`),
 * so every CLI process of a fixture shares one clock that starts at the fixed
 * instant and keeps moving forward across processes: the fixture's writes and
 * the doctor runs that read them land on the same day whatever day the suite
 * runs. PGLite runs in-process and reads the same clock. A no-op without the
 * variable. Loaded with `bun --preload`.
 */
const raw = process.env.GBRAIN_TEST_CLOCK_OFFSET_MS;

if (raw) {
  const offset = Number(raw);
  if (!Number.isFinite(offset)) throw new Error(`GBRAIN_TEST_CLOCK_OFFSET_MS is not a number: ${raw}`);
  const RealDate = Date;
  class OffsetClockDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [string]));
    }
    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = OffsetClockDate as DateConstructor;
}
