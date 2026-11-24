# pumpfun-entry

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/wawanmol/pumpfun-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/wawanmol/pumpfun-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Diver — a diversified small-stake momentum scalper for the Pump.fun Replay Sprint. It trades 10 SOL of paper money on a 24h pump.fun replay: many small 0.05 SOL positions on coins showing broad, accelerating buy pressure, each with a mechanical stop loss, trailing stop, take-profit, time limit and flow-fade exit. No pyramids, no discretion.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/replay/v2` on stdin/stdout (see `vendor/makefun-bot.ts`). Grade it locally with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/pumpfun-entry --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wawan-mol&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
