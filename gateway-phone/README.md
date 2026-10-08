# Abhyaas SMS gateway phone

An Android phone with a SIM card turns student SMS into requests to the teacher's laptop and texts the replies back. `gateway.mjs` runs in Termux and has no dependencies.

Every 3s it reads the SMS inbox and posts each new SMS to the laptop, then sends the reply. Every 5s it sends questions the laptop queued (pushes). Every 30s it sends a heartbeat, which shows **Phone gateway: connected** on the laptop's `/phone` page.

## 1. Install the apps (F-Droid only)

Install **Termux** and **Termux:API** from [F-Droid](https://f-droid.org/). Don't use the Play Store builds: they are outdated, and the two apps must come from the same source.

Open Termux and run:

```sh
pkg update
pkg install termux-api nodejs git
git clone https://github.com/kushalbista3/Abhyaas.git
cd Abhyaas/gateway-phone
```

## 2. Give Termux:API the SMS permission

- **Android 13 and newer:** Android blocks SMS permission for apps installed outside the Play Store until you allow it. Go to Settings → Apps → Termux:API → ⋮ (top right) → **Allow restricted settings**.
- Then go to Settings → Apps → Termux:API → Permissions and allow **SMS**. If you will use `SIM_SLOT`, allow **Phone** too.
- Check it in Termux. This should print a JSON list of your latest SMS:

  ```sh
  termux-sms-list -l 1
  ```

## 3. Keep it running

- Go to Settings → Apps → **Termux** → Battery → **Unrestricted**. Do the same for **Termux:API**.
- In Termux run `termux-wake-lock`, or tap **Acquire wakelock** in the Termux notification. Otherwise Android pauses Termux when the screen is off.
- Keep the phone on the charger during class.

## 4. Connect the phone and the laptop

The phone and the laptop must be on the same network. Use either of these:

- **Hotspot (no Wi-Fi needed):** turn on the phone's hotspot and connect the laptop to it. SMS still uses the mobile network.
- **The same Wi-Fi network** for both.

On the **laptop (macOS)**, let the server accept connections. Go to System Settings → Network → Firewall → Options, then add `node` and set it to allow incoming connections. Or run this in Terminal:

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(which node)"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(which node)"
```

## 5. Run

Start the server on the laptop (`npm run dev`). It prints the laptop's LAN address and the exact command to run, for example:

```
LAN: http://192.168.43.12:3001 (en0)
On the gateway phone, in Termux (inside gateway-phone/):
  LAPTOP_URL=http://192.168.43.12:3001 node gateway.mjs
```

On the phone, in `Abhyaas/gateway-phone`, run that command:

```sh
LAPTOP_URL=http://192.168.43.12:3001 node gateway.mjs
```

On a dual-SIM phone, choose the SIM that sends replies with `SIM_SLOT`:

```sh
SIM_SLOT=1 LAPTOP_URL=http://192.168.43.12:3001 node gateway.mjs
```

Open `http://localhost:5173/phone` on the laptop. Within 30 seconds it should say **Phone gateway: connected**.

If the laptop's address changes (a new hotspot, a different Wi-Fi), restart the server and use the new command it prints.

## What it does on first start

On first start the gateway marks every SMS already in the inbox as seen and does not answer old messages. Only SMS that arrive after that are posted to the laptop. It stores the last SMS it handled in `.last-id`, so a restart picks up where it left off.

## Safety

- **No double grading.** Each SMS goes to the laptop once. If sending the reply fails, the gateway resends the same reply up to 5 times over about 2 minutes. It never asks the laptop again, so the answer is not graded twice. Replies still to send are kept in `.pending.json` and survive a restart.
- **Never sends twice.** A queued message is marked "sending" on disk before it is sent. If the gateway stops in the middle, that message is reported as failed and is not sent again.
- **Masked logs.** Phone numbers are masked (`98******01`) and message text is not printed.
- **Skips service senders.** SMS from names like NTC, Ncell or BANK, and from short codes, are skipped.

## Log lines

| Line | Meaning |
|---|---|
| `Connected to laptop at ...` | The laptop answered. |
| `Laptop not reachable at ... Retrying.` | Wrong address, a different network, or the laptop firewall is blocking it. New SMS wait and are sent once the laptop is back. |
| `termux-sms-list gave unreadable output` | The SMS permission is missing. See step 2. |
| `termux-sms-list not found` | Run `pkg install termux-api` and install the Termux:API app. |
| `In  98******01 -> reply ready` | A student SMS was graded. |
| `Out 98******01 reply sent` | The reply went out. |
| `Out ... reply failed (try N). Resending in Ns.` | The SIM or network refused the SMS. The gateway will retry. |

Nothing is printed while it's idle, and each problem is printed only once until it is fixed.

## Reset

Stop with Ctrl+C. To start fresh, so that the current inbox counts as "already seen" again:

```sh
rm -f .last-id .pending.json
```
