# Paint Party Kits – setup guide

This puts mypaintpartykits.com live on your Oracle server, next to n8n, without changing n8n.

How it fits together: the website runs in its own Docker container on a private port (3010). Your existing Nginx receives visitors for mypaintpartykits.com and passes them to it. Certbot adds the free HTTPS certificate.

Commands in boxes are run **on the server** (over SSH) unless the step says "on your computer."

---

## 1. Point the domain at your server

1. On the server, get its public IP address:

   ```bash
   curl -4 ifconfig.me
   ```

2. Log in where you bought mypaintpartykits.com and open its **DNS settings**. Create (or edit) these two records, using the IP from above:

   | Type | Host / Name | Value |
   |------|-------------|-------|
   | A    | `@`         | your server IP |
   | A    | `www`       | your server IP |

   Delete any other A or CNAME records for `@` or `www` (for example a "parking page" record).

3. Wait until the domain points to your server. This is usually a few minutes, sometimes up to an hour. Check with:

   ```bash
   getent hosts mypaintpartykits.com
   ```

   When it prints your server IP, continue.

> **Email still works.** These changes don't touch your email records (MX), so sales@ keeps working.

---

## 2. Get the website onto the server (from GitHub)

**If the GitHub repository is public**, skip to "Download it" below.

**If it's private** (recommended), give the server read-only access with a deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ppk_deploy -N "" -C "ppk-server"
cat ~/.ssh/ppk_deploy.pub
```

Copy the line it prints. On GitHub, open the repository, then **Settings → Deploy keys → Add deploy key**. Paste it, name it "Oracle server," leave "Allow write access" **unchecked**, and save. Then on the server:

```bash
cat >> ~/.ssh/config <<'CFG'
Host github-ppk
  HostName github.com
  User git
  IdentityFile ~/.ssh/ppk_deploy
  IdentitiesOnly yes
CFG
chmod 600 ~/.ssh/config
```

**Download it:**

```bash
# private repository:
git clone git@github-ppk:moshebraunwork/mypaintpartykits.git ~/paint-party-kits
# or, public repository:
# git clone https://github.com/moshebraunwork/mypaintpartykits.git ~/paint-party-kits
```

If it asks "Are you sure you want to continue connecting?", type `yes`.

---

## 3. Create the settings file

```bash
cd ~/paint-party-kits
cp .env.example .env
openssl rand -hex 32
```

Copy the long random line that `openssl` printed, then open the settings file:

```bash
nano .env
```

- **ADMIN_PASSWORD**: choose your wife's admin password (at least 10 characters).
- **SESSION_SECRET**: paste the random line.
- Leave the Web3Forms key and emails as they are.

Save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**.

---

## 4. Start the website

```bash
cd ~/paint-party-kits
mkdir -p data
docker compose up -d --build
```

The first build takes a few minutes. Then check it's running:

```bash
docker compose ps
curl -s http://127.0.0.1:3010/api/store | head -c 120; echo
```

You should see the container as **running** (after about 30 seconds, **healthy**) and a line starting with `{"products":`.

If something's wrong, look at the logs: `docker compose logs --tail 50`

---

## 5. Connect Nginx

```bash
cd ~/paint-party-kits
sudo cp nginx/mypaintpartykits.conf /etc/nginx/sites-available/mypaintpartykits.conf
sudo ln -sf /etc/nginx/sites-available/mypaintpartykits.conf /etc/nginx/sites-enabled/
sudo nginx -t
```

Only if it says **syntax is ok** and **test is successful**:

```bash
sudo systemctl reload nginx
```

Now `http://mypaintpartykits.com` (without the "s") should show the shop.

> If `sudo nginx -t` reports a problem, **don't reload**. Remove the link with `sudo rm /etc/nginx/sites-enabled/mypaintpartykits.conf` and send me the error. n8n keeps running either way.

---

## 6. Turn on HTTPS

Check that Certbot is installed (it probably is, for n8n):

```bash
certbot --version || sudo apt-get install -y certbot python3-certbot-nginx
```

Then get the certificate:

```bash
sudo certbot --nginx -d mypaintpartykits.com -d www.mypaintpartykits.com
```

If it asks whether to redirect HTTP to HTTPS, choose **redirect**. Certbot renews the certificate automatically.

Open **https://mypaintpartykits.com**. You should see the shop with a padlock.

---

## 7. First-time setup in the admin

Go to **https://mypaintpartykits.com/admin** and sign in with `sales@mypaintpartykits.com` and the password from step 3.

1. **Delivery** tab: enter your home ZIP, adjust the distances and prices, tap **Generate ZIP list**, review the list, then tap **Save delivery settings**. Until this is saved, customers only see pickup.
2. **Items** tab: check the Chanukah kit's price and discount. When editing an item you can add up to 10 photos (the first is the main one) and options such as Color or Size. If an option has more than one choice, customers must pick one before adding to cart, and their choice shows in the order, the email and the Orders tab. The bulk discount counts all options of an item together.
3. **Seasonal look** tab: adjust the banner if you like.

---

## 8. Test the emails

1. On the shop, add a kit, check out, and place a test order with your own email.
2. Check the sales@ inbox **and the spam folder**. If it's in spam, mark it "Not spam" so future orders arrive normally.
3. Send a test from the **Contact** page too.
4. Delete or mark the test order "Done" in the admin's **Orders** tab.

Every order and message is also saved in the admin, so nothing is lost even if an email goes missing.

**Optional but recommended:** in your Web3Forms dashboard, open the form's settings and restrict it to the domain `mypaintpartykits.com`, so the key can't be used from other websites.

---

## Everyday care

**Change the admin password:** edit `.env` (`nano ~/paint-party-kits/.env`), then:

```bash
cd ~/paint-party-kits && docker compose up -d
```

**Back up** the database and photos (everything lives in the `data` folder):

```bash
cd ~/paint-party-kits
docker compose exec web node -e "require('better-sqlite3')('/app/data/store.db').backup('/app/data/backup.db').then(()=>console.log('ok'))"
tar czf ~/ppk-backup-$(date +%F).tgz data
```

Keep a copy of that `.tgz` file somewhere other than the server (for example, download it with `scp`).

**Install an update:** after the new code is pushed to GitHub, run:

```bash
cd ~/paint-party-kits && git pull && docker compose up -d --build
```

Your `.env` and `data` folder aren't in GitHub, so they're never overwritten.

**See errors:** `cd ~/paint-party-kits && docker compose logs --tail 100`

**Restart:** `cd ~/paint-party-kits && docker compose restart`

**Analytics:** the admin's **Analytics** tab shows how many people visited the shop, page views, which kits they looked at, where visitors came from (Google, Instagram, etc.), phones vs. computers, busiest hours, and how many added to cart, sent an order request or a message. Counting is anonymous and starts from the day this update is installed. Your own visits while signed in to the admin aren't counted.

**Tip:** when you share the shop link somewhere, add `?utm_source=` and a name so Analytics shows exactly where visitors came from, for example `https://mypaintpartykits.com/?utm_source=whatsapp` or `?utm_source=flyer`.
