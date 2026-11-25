export PATH=$HOME_REAL/.bun/bin:/home/ubuntu/.bun/bin:/home/ubuntu/.cargo/bin:$PATH
export GBRAIN_SELF_UPGRADE_MODE=off GBRAIN_SWEEP=0
unset DATABASE_URL
G() { bun /code/garrytan/gbrain/src/cli.ts "$@"; }
