# Hosting on the Sirix cPanel server (sirixmonitoring.com)

This server is cPanel on CloudLinux. The account shell has no root, no system Node and
no Node selector, so the Debian installer in `deploy/install.sh` does not apply. The app
is hosted the same way as fleet.sirixmonitoring.com: a systemd service runs the backend
on a local port and Apache reverse-proxies the public subdomain to it.

Node 22 is already installed for the account at `/home/sirixmonitoring/.local/node`.
The code is cloned at `/home/sirixmonitoring/sondage`.

## 1. Subdomain and DNS (cPanel, no root needed) — DONE 2026-11-12

- Subdomain `sondage.sirixmonitoring.com` exists in cPanel
  (document root `/home/sirixmonitoring/sondage.sirixmonitoring.com`, unused by the app).
- Cloudflare A record `sondage` -> `144.217.171.18` (this server), grey cloud.
- AutoSSL has issued a Let's Encrypt certificate; https already answers (cPanel default page
  until the proxy below is installed).

## 2. Service and proxy (needs root / WHM terminal)

```bash
mkdir -p /home/sirixmonitoring/sondage-data
chown sirixmonitoring:sirixmonitoring /home/sirixmonitoring/sondage-data
cp /home/sirixmonitoring/sondage/deploy/cpanel/sirix-survey.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sirix-survey
systemctl status sirix-survey        # should say active (running)
curl -s http://127.0.0.1:3100/ | head -5

D=sondage.sirixmonitoring.com
for k in ssl std; do
  mkdir -p /etc/apache2/conf.d/userdata/$k/2_4/sirixmonitoring/$D
  cp /home/sirixmonitoring/sondage/deploy/cpanel/proxy.conf /etc/apache2/conf.d/userdata/$k/2_4/sirixmonitoring/$D/
done
/scripts/rebuildhttpdconf && /scripts/restartsrv_httpd
```

Plain http -> https is handled by cPanel: Domains > sondage.sirixmonitoring.com > **Force HTTPS
Redirect** (enabled 2026-11-12, also settable with
`uapi SSL toggle_ssl_redirect_for_domains domains=sondage.sirixmonitoring.com state=1`).

Then open https://sondage.sirixmonitoring.com/admin and create the administrator account.

## Email (sending the links and report notices)

The app sends mail through a cPanel mailbox on the main domain, **no-reply@sirixmonitoring.com**, over
SSL/TLS on port 465 of this server (`vps.hebergementwebdci.com`, whose certificate is valid). The main
domain's SPF already lists this server's IP and cPanel's DKIM key for sirixmonitoring.com is published, so
the messages satisfy the domain's strict DMARC policy (`adkim=s; aspf=s`) without any DNS change.
Mail *to* that address goes to Microsoft 365 (the domain's MX), where the mailbox does not exist: set a
**Reply-To** (e.g. HR) in the Email tab so replies reach a real person.

The mailbox password is stored in the app's settings table (database). To rotate it: cPanel > Email
Accounts > no-reply@sirixmonitoring.com > Manage > new password, then paste the new one in the Email tab.

## Updating the app later

```bash
cd /home/sirixmonitoring/sondage && git pull
```

then click **Restart the app** in the admin (Settings & demo data > Maintenance), which works because the
service file sets `ALLOW_RESTART=1` and `Restart=always`. Root alternative: `systemctl restart sirix-survey`.

Logs: `journalctl -u sirix-survey -f`. Backup: copy `/home/sirixmonitoring/sondage-data/survey.db`
(stop the service first, or copy the `.db`, `.db-wal` and `.db-shm` files together).

## If root is not available

cPanel's Application Manager (Passenger) is enabled on this server but no system Node
package (`ea-nodejs*`) is installed, so Passenger cannot start a Node app here until the
host installs one. The alternative is to deploy from this GitHub repo to Railway, Render
or Fly.io with a persistent volume, as described in the main README.
