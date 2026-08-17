# Deployment & Operations

Runbook สำหรับ host bot จริง. อ่านไฟล์นี้แล้วกู้/ย้าย/แก้ระบบได้เอง.

## 1. ทำไมต้อง host ในไทย (geo-block)

TU API `bookyourcourtapi.psm.tu.ac.th` (49.229.83.38) **บล็อก IP ต่างประเทศ** — เชื่อมต่อจาก cloud นอกไทย = connection timeout.

พิสูจน์แล้ว (2026-07-25):

| จาก | ผล |
|---|---|
| Mac ในไทย (residential IP) | ✅ HTTP 302 ใน 0.29s |
| DigitalOcean Singapore VPS | ❌ connection timeout (DNS ได้ IP ไทยแต่ต่อไม่ติด) |

**ผลลัพธ์การตัดสินใจ:** bot ต้องรันจาก **IP ไทยเท่านั้น**. Cloud VPS สิงคโปร์/US/EU ใช้ไม่ได้แม้ latency ต่ำ.

เลือก host หลัก = **Ubuntu Server (Docker + systemd)** — ดูแลง่าย, restart อัตโนมัติ, ไม่ต้องพึ่ง GUI session. Legacy: **Mac mini M4 ที่บ้าน** ก็ใช้ได้ (launchd, Thai residential IP, 24/7).

ทางเลือกอื่นที่ใช้ได้ (ทั้งหมดต้อง Thai IP): Thai VPS (Netway/Z.com/AWS ap-southeast-7 Bangkok), Raspberry Pi บ้าน, โน้ตบุ๊กเก่าบ้าน.

## 2. Ubuntu Server: Docker Compose + systemd (Primary)

การ deploy บน Ubuntu จะเก็บ Bun และ dependencies ของแอปไว้ใน Docker image โดยให้ `systemd` timers บน host เรียก Compose jobs แบบรันจบแล้วออก 2 ตัว.

### สถาปัตยกรรม runtime

| Timer | เวลา | Compose job | หน้าที่ |
|---|---|---|---|
| `com.botbookyoucourt.race` | Sun,Mon,Tue 06:55 | `run` | pre-auth แล้วรอถึง `fireAt` 07:00:00 → gate ด้วย `listCourts` จนวันเป้าหมายเปิด → ยิงแบบ paced (2s/account, 1s/IP) จนถึง `deadline` 07:05 |
| `com.botbookyoucourt.fallback` | Sun,Mon,Tue 07:10 | `run --now` | เก็บตกถ้า race แพ้ (demand ต่ำ คอร์ตมักว่างถึง ~08:24) |

กลไกกันพลาด:
- **Single-instance lock** — `run.sh` จับ `state/.run.lock` (`mkdir` atomic + เช็ค pid stale) ก่อนรัน. ถ้ามี instance อื่นถืออยู่ → `exit 0` เงียบ (ไม่ ping healthcheck fail). กันเคส 2 process ยิงชนกัน (agent ซ้ำ / fallback ทับ race ที่ยังค้าง) ที่จะทำให้บอทจองแข่งกันเองจน quota เต็ม แล้วรายงาน false-`❌`.
- **Idempotent marker** — จองสำเร็จ → เขียน `state/booked-<targetDate>.json` เก็บ `(account, hour, bookingCode)`. `run` โหลด marker ก่อน → skip task ที่ได้แล้ว, auth เฉพาะ account ที่ค้าง. fallback จึงไม่จองซ้ำ/ไม่แจ้ง false-❌.
- **Telegram** — แจ้งผลทุกครั้ง (✅/❌) + แจ้ง crash. เงียบ = ผิดปกติ.
- **Dead-man switch (healthchecks.io)** — `scripts/docker-run.sh` ping `/start` + success + `/$code`. ถ้าเครื่องตาย/timer ไม่ยิง → healthchecks ไม่ได้ ping ตาม cron → เด้งเตือนเอง.
- **Mutual exclusion** — `flock --nonblock /run/lock/botbookyoucourt.lock` ป้องกัน race กับ fallback รันซ้อนกัน.
- **Persistent timers** — `Persistent=true` ทำให้ timer ไล่ยิงรอบที่พลาดหลัง reboot.

เวลา race ตั้งใน `config.json` → `race.fireAt` / `race.deadline`. จังหวะยิงคุมด้วย `race.accountIntervalMs` (ช่องว่างขั้นต่ำต่อ account) / `race.ipIntervalMs` (ต่อ IP รวมทุก account) / `race.rateLimitBackoffMs` (โดน "จองถี่เกินไป" → หยุดพักเพิ่ม) / `race.gatePollIntervalMs` (ความถี่ poll เช็คว่าวันเป้าหมายเปิดหรือยัง). วันเป้าหมายมาจาก `advanceDaysCandidates` (default `[5,6]` — ตั้งแต่ 2026-08 window จริงไม่แน่ชัด บอทเลย race ทุก candidate ที่ตรง `schedule`). วัน/slot/ลำดับ court อยู่ใน `config.json` → `schedule`.

> **Issue #5 (2026-08-16):** server เพิ่ม anti-bot rate limit ("จองถี่เกินไป / Booking too frequent") และวัน D+6 ไม่เปิดตอน 07:00 อีกต่อไป. บอทเดิมยิง ~13 req/s ใส่วันที่ยังไม่เปิด → โดนบล็อกยกกระบิ. แก้โดย: gate ด้วย `listCourts` ก่อนยิงจริง + pacing สุภาพ + backoff เมื่อโดน limit + race ทั้ง D+5 และ D+6.

## 3. Setup บน Mac mini

> ⚠️ รันบนเครื่องส่วนตัวเท่านั้น — เครื่องทำงานที่มี corporate MITM proxy (Netskope/Zscaler) จะทำให้ทุก HTTPS request ล้ม (`self signed certificate in certificate chain`) รวมถึง Telegram alert → fail เงียบ. และ laptop ที่หลับได้จะยิง launchd สายจนเลย deadline.

```sh
git clone https://github.com/TERIOS000/NetRunner2.0.git
cd NetRunner2.0
cp .env.example .env   # กรอก credentials + telegram + HEALTHCHECK_URL
zsh scripts/setup-macmini.sh
```

ตั้งเพิ่มด้วยมือ:
- **healthchecks.io check** → Cron `55 6 * * 0,1`, TZ Asia/Bangkok, Grace 30 min–1h
- **Auto-login** (System Settings → Users & Groups) — LaunchAgent รันใน GUI session

`setup-macmini.sh` ทำ: ลง bun · `bun install` · `sudo pmset -a sleep 0 disksleep 0 autorestart 1 powernap 0` · gen plist + `launchctl load -w` · `status` smoke test.

### ทดสอบ (Mac legacy)

```sh
zsh scripts/test-schedule.sh          # safe dry-run
zsh scripts/test-schedule.sh --live   # live: kickstart fallback agent
```

### Operations (Mac legacy)

```sh
# ดู agent ที่ load + สถานะ
launchctl list | grep botbookyoucourt              # ใช้ได้เฉพาะใน GUI/Aqua session
# ⚠️ ผ่าน ssh: launchctl list เห็นเปล่า (คนละ session domain) — ใช้ gui domain แทน
launchctl print gui/$(id -u) | grep -iE 'book|=> (en|dis)abled'

# log
tail -f logs/$(date +%F).log          # log แอปรายวัน
tail -n 40 logs/launchd.out.log logs/launchd.err.log

# reload หลังแก้ config/โค้ด
git pull && bun install
launchctl unload ~/Library/LaunchAgents/com.botbookyoucourt.race.plist
launchctl load -w ~/Library/LaunchAgents/com.botbookyoucourt.race.plist

# ปิดชั่วคราว
launchctl unload ~/Library/LaunchAgents/com.botbookyoucourt.{race,fallback}.plist
```

## 4. Troubleshooting

### Ubuntu / Docker

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| healthchecks แดง เช้า Sun/Mon | เครื่องดับ/เน็ตล่ม/timer ไม่ยิง | `systemctl status '*botbookyoucourt*'`, `journalctl` |
| Telegram เงียบ | bot ไม่ได้รัน หรือ Docker network ล่ม | `docker compose run --rm status` |
| `docker compose run` timeout | host ไม่มี IP ไทย / network ใช้ไม่ได้ | `curl -m10 https://bookyourcourtapi.psm.tu.ac.th/` ต้องได้ 302 |
| `flock: failed to execute` | Docker ถูกลบ/ย้าย path | ติดตั้ง Docker ใหม่ แล้วรัน `sh scripts/setup-ubuntu.sh` |
| Docker permission error | user ปัจจุบันไม่มีสิทธิ์เข้า Docker daemon | `sudo usermod -aG docker $USER` แล้ว logout/login |
| `status` / `dry-run` ได้ผลแต่ timer ไม่ยิง | timer disabled หรือ timezone ผิด | `sudo systemctl list-timers 'botbookyoucourt-*'` |
| `CreateOrEdit: Internal server error` | user TU หมดอายุ | ต่ออายุ user กับ TU; เอา account ออกจาก `config.json` ชั่วคราว |
| จองไม่ได้แต่ไม่มี error ชัด | race แพ้ (คนอื่นเร็วกว่า) | fallback 07:10 เก็บตก; ถ้ายัง = จองมือ |

แก้ปัญหาเบื้องต้น:

```sh
docker compose config                     # validate compose file
docker compose build --no-cache           # force rebuild image
docker compose run --rm status            # smoke test
sudo systemctl reset-failed 'botbookyoucourt-*'   # clear failed state
```

ย้าย checkout ไป path ใหม่ต้องรัน `sh scripts/setup-ubuntu.sh` ซ้ำ.

### Mac / launchd (legacy)

| อาการ | สาเหตุ | แก้ |
|---|---|---|
| healthchecks แดง เช้า Sun/Mon | เครื่อง/เน็ต/ไฟดับ, agent ไม่ยิง | จองมือทันที (คอร์ตมักว่างถึง ~08:24) แล้วเช็คเครื่อง |
| Telegram เงียบเช้า Sun/Mon | เหมือนข้างบน (bot ไม่ได้รัน) | ดู `launchd.err.log`, `launchctl list` |
| `run` ค้างนาน ไม่มี log | connect API timeout = ไม่ได้อยู่ IP ไทย / เน็ตหลุด | ยืนยัน `curl -m10 https://bookyourcourtapi.psm.tu.ac.th/` ได้ 302 |
| `❌ ... token` ทุก account | creds ใน `.env` ผิด/หมดอายุ | อัปเดต `.env`, ทดสอบ `bun src/index.ts status` |
| `self signed certificate in certificate chain` ทุก request (TU + Telegram พร้อมกัน) | เครื่องมี corporate MITM proxy (เช่น Netskope/Zscaler) — bun ไม่ trust CA ของ proxy | อย่ารัน bot บนเครื่องทำงาน; ถ้าจำเป็นชั่วคราว: export CA ของ proxy เป็น .pem แล้วตั้ง `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` ใน plist/run.sh |
| `CreateOrEdit: Internal server error` ทั้งที่ auth ผ่าน | user TU ของ account นั้นหมดอายุ (ไม่มีสิทธิ์จอง) | ต่ออายุ user กับ TU; ระหว่างรอ เอา account ออกจาก `config.json` กัน bot ยิง 500 ฟรี |
| log `no attempt made` | run เริ่มหลัง `deadline` 07:05 (เครื่องหลับแล้ว launchd ยิงตอนตื่น) | เช็ค pmset (แถวล่าง) + ต้องมี fallback agent 07:10 (`launchctl list \| grep botbook` ต้องเห็น 2 ตัว) |
| `❌ ... จองถี่เกินไป / Booking too frequent` ซ้ำๆ | โดน anti-bot rate limit — pacing ยังถี่เกิน limit ปัจจุบันของ server | เพิ่ม `race.accountIntervalMs`/`ipIntervalMs` ใน `config.json`; log จะมี `[code=... http=...]` ท้าย error ไว้ investigate |
| `❌ ... booking window ... never opened before deadline` | วันเป้าหมายไม่เปิดในช่วง race — window ของ server เปลี่ยนอีก | เช็คด้วย `bun run status --date <date>` ว่าวันไหนคืนตาราง court แล้วปรับ `advanceDaysCandidates`/launchd days |
| จองไม่ได้แต่ไม่มี error ชัด | slot ถูกคนอื่นแย่ง (race แพ้) | fallback 07:10 เก็บตก; ถ้ายัง = จองมือ |
| log ซ้ำทุกบรรทัด 2 รอบ / จองสำเร็จแล้วยังได้ `❌ FAILED` | มี launchd agent ซ้ำยิงเวลาเดียวกัน → 2 instance ชนกันเอง จน quota เต็ม (issue #4) | `launchctl print gui/$(id -u) \| grep book` ต้องเหลือแค่ `race`+`fallback`; ลบ agent เกิน (`launchctl bootout gui/$(id -u)/<label>` + `rm ~/Library/LaunchAgents/<label>.plist`). `run.sh` มี lock กันชั้นสองแล้ว |
| เครื่องหลับตอน 06:55 | pmset ไม่ได้ตั้ง / เครื่องรีบูตแล้วไม่ auto-login | `pmset -g \| grep sleep` ต้อง 0; เปิด auto-login |
| agent ไม่ทำงานหลังรีบูต | ไม่ได้ auto-login | เปิด auto-login |

## 5. Windows (พัฒนา/ทดสอบ)

Windows ไม่ใช่ production — ใช้สำหรับเทส config, dry-run, หรือจองมือตอน dev เท่านั้น. production จริงรันบน Ubuntu (Docker+systemd) หรือ Mac mini (launchd, legacy).

### ปัญหา TLS ของ Bun บน Windows

Bun บน Windows มี bug TLS กับ TU API: `unknown certificate verification error` ตั้งแต่ Bun 1.3.14 (ล่าสุด) — ไม่ใช่ปัญหา cert หมดอายุ, proxy, หรือ config. `NODE_TLS_REJECT_UNAUTHORIZED=0` และ `SSL_CERT_FILE` ก็ไม่ช่วย. Node (v24) และ curl ต่อได้ปกติ.

นอกจากนี้ Bun บน Windows ต่อ `api.telegram.org` ไม่ได้อีก (`Unable to connect`) ทั้งที่ curl/Node ต่อได้ — Telegram notification จะ fail เงียบ.

วิธีแก้: ใช้ Node รันแทน Bun.

### Setup

```powershell
bun install          # ลง dependencies (ใช้ Bun)
bun run build        # compile TypeScript → dist/
```

`config.json` อ่านตอน runtime → แก้ config แล้วไม่ต้อง build ใหม่. build ใหม่เฉพาะตอนแก้โค้ด `.ts`.

### คำสั่ง

```powershell
# safe — ไม่จอง
node dist/index.js status
node dist/index.js status -- --date <YYYY-MM-DD>
node dist/index.js dry-run

# จองทันที (60s deadline)
node dist/index.js run --now

# โหมดจริง: รอถึง fireAt แล้วยิงจนถึง deadline (ต้องรันช่วง 06:55-07:02 ICT)
node dist/index.js run

# จองมือ 1 slot
node dist/index.js book --date <YYYY-MM-DD> --hour <6-22> --court <1-5>

# ยกเลิก
node dist/index.js cancel --account <name> --code <bookingCode>

# ลบ marker บังคับจองวันนั้นใหม่
Remove-Item state/booked-<YYYY-MM-DD>.json
```

### ข้อควรระวัง

- ต้อง **IP ไทย** เท่านั้น (เหมือนทุก platform). Windows ที่ต่อเน็ตบ้านในไทยใช้ได้, VPN ไทยก็ได้. ใช้ `curl.exe https://ipinfo.io/json` เช็ค `"country": "TH"` ก่อน.
- ถ้าต่อผ่านเน็ตมหา'ลัย TU → IP ไทยอยู่แล้ว, BUT อาจมี proxy/firewall ที่บล็อกบางพอร์ต. ทดสอบด้วย `curl.exe -I https://bookyourcourtapi.psm.tu.ac.th/` — ต้องได้ `HTTP/1.1 302 Found`.
- Telegram notification ใช้ได้ (Node ต่อ `api.telegram.org` ได้ต่างจาก Bun).

## 6. อ้างอิง

- **Schedule:** run **Sun,Mon,Tue** — แต่ละ run race ทุก candidate `today+5` / `today+6` ที่ weekday ตรง `schedule` (window จริงไม่แน่ชัดตั้งแต่ 2026-08, gate เป็นตัวตัดสินว่าวันไหนเปิด).
- **Race timing** (`config.json`): pre-auth ตอน agent ตื่น 06:55 → `fireAt` 07:00:00 → gate ด้วย `listCourts` → ยิง paced 2s/account จนถึง `deadline` 07:05.
- **Play slot:** Sat+Sun 17:00–19:00, court priority `[5, 4, any]` (2 ชม. = 2 accounts เพราะ 1 จอง/user/วัน).
- **Court map:** 01→39, 02→40, 03→41, 04→51, 05→52 · `sportTypeId=3` · `sportStationId=4`.
- **Grid values:** `1`=ว่าง, `-1`=ถูกจอง, `null`/`.`=ปิด.
- **Host:** Ubuntu Server (Docker + systemd, primary) หรือ Mac mini (launchd, legacy) — ทั้งคู่ต้อง Thai IP. repo private `TERIOS000/NetRunner2.0`.
