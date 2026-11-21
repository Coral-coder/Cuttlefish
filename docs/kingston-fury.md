# Driving Kingston FURY Beast RGB memory at higher frame rates

## The problem

FURY Beast/Renegade RGB modules have a small RGB controller on the DIMM's SMBus. The DDR4 controller sits at `0x58+slot` and the DDR5 controller at `0x60+slot`. Colours are written one byte at a time over SMBus:

| Register | Meaning |
|---|---|
| `0x08` | `0x53` = begin transaction, `0x44` = end / apply |
| `0x09` | mode (`0x10` = direct) |
| `0x0B` | index, `0x0C` direction, `0x20` brightness (0–100) |
| `0x50 + 3·i … 0x52 + 3·i` | R, G, B of LED *i* (LED 0 is the bottom LED). 12 LEDs on DDR5, 10 on DDR4 |
| `0x01…0x04` (word read, high byte) | `"FURY"` signature inside a transaction |
| `0x06` (word read, high byte) | model code (`0x10/0x15` Beast DDR5, `0x11` Renegade, `0x12` Beast White, `0x23/0x21` Beast DDR4) |

A full frame is 36 colour bytes per stick, plus begin and apply. Existing software is slow for these reasons:

* **OpenRGB** sleeps **10 ms after every register group** it writes (`FURY_DELAY`). With 36 colour registers per frame, one stick runs at roughly 2–3 FPS.
* **The SignalRGB plugin** treats each stick as its own device. Every frame it waits 3 ms after begin, writes each changed byte, waits 3 ms after apply, then pauses another **10 ms**. With four sticks in turn, that adds up to about 64 ms of fixed sleeping per round, plus transaction time.
* On Windows, the SMBus driver's default mode **sleeps while waiting for each transaction to complete**. With the ~1 ms timer granularity, every byte costs at least about 1 ms even though the bus transfer takes about 0.2–0.5 ms at 100 kHz.

## What Cuttlefish does

Implementation: `src/devicehost/fury.js`

1. **One transaction window for all sticks.** Cuttlefish writes begin to every stick, settles once, writes all data, writes apply to every stick, and settles once. Four sticks cost the same fixed delay as one.
2. **Delta writes.** A register cache skips any byte that has not changed. A static or slow effect costs almost nothing.
3. **Error-ordered writes with an optional budget.** Pending writes are sorted by how much they change the colour. In *turbo* mode at most N bytes are sent per frame. Large changes go first, small ones follow in later frames, so motion stays smooth and latency stays bounded.
4. **Busy-wait SMBus completion (turbo).** The PawnIO module's sleep mode switches to busy-wait (`ioctl_set_sleep_mode`, 0 = always busy). This removes the timer-granularity floor per byte.
5. **Auto-tune with read-back verification.** Devices → FURY → *Auto-tune timing* steps the settle delay down (10 → 5 → 3 → 2 → 1 → 0 ms). After random frames it reads registers back, keeps the shortest delay with zero mismatches, and adds a margin. Settle delays then reflect what your modules actually need.
6. **Separate SMBus host process.** Memory runs in its own process and render loop, so slow bus transactions never hold back USB devices.

Profiles (Settings → RGB memory):

| Profile | Settle | Retries | Budget | SMBus wait |
|---|---|---|---|---|
| safe | 10 ms | 5 × 10 ms | none | sleep |
| balanced (default) | 3 ms | 4 × 3 ms | none | sleep |
| turbo | 1 ms | 3 × 2 ms | 24 bytes/frame | busy-wait |

**Expected result, not yet measured:** full-change frames on 2–4 DDR5 sticks should reach roughly 25–60 FPS in turbo, versus 2–5 FPS today. Typical effects only change a fraction of the bytes each frame. The Devices page shows the live update rate and write and failure counters, so you can see the real numbers on your machine.

## Safety

* Detection writes nothing until the SPD hub (DDR5, `0x50+slot` reads `0x51`) or DDR4 SPD type byte (`0x0C`) confirms a module in that slot. The controller must then return the `"FURY"` signature.
* The SMBus layer refuses all plugin writes to `0x50–0x57` (SPD/SPD5 hub), `0x36/0x37` (SPD page select) and `0x18–0x1F` (thermal sensors).
* Every transaction holds the system-wide `Global\Access_SMBUS.HTP.Method` mutex that HWiNFO, OpenRGB and similar tools use, so Cuttlefish never interleaves with them.
* If writes start failing, *safe* restores OpenRGB-equivalent timing.

## Requirements

* [PawnIO](https://pawnio.eu) driver. Settings → *Install PawnIO* runs `winget install namazso.PawnIO`.
* The SMBus modules (`SmbusI801.bin` for Intel, `SmbusPIIX4.bin` for AMD) are bundled with the installer and are downloaded on demand if missing.
* Cuttlefish runs elevated, which is why it starts through a highest-privilege scheduled task at login.
