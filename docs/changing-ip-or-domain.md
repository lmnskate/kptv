# Changing IP or Domain

What to do when the server's public IP or its domain changes. The database
does not care about the address — only DNS, the TLS certificate and the
TVs' bookmarks do.

## Only the IP changed, the domain stays

Typical case: the provider gave you a new IP, or you moved to another
machine with the same DuckDNS name.

1. Update the DNS record: point the domain at the new IP. For DuckDNS this
   is one field on the site (or its API) — the change propagates in a
   minute or two.
2. Open ports 80 and 443 on the new host (firewall and, if any, the cloud
   provider's security group).
3. If the server itself moved to a different machine — copy the project
   and the database over, see
   [Moving to a New Server](moving-to-a-new-server.md).
4. `./kptv.sh restart` is not strictly needed if nothing else changed,
   but it does not hurt.
5. Check: `curl https://<your-domain>/msx/start.json` should answer.

The certificate does **not** need reissuing — it is tied to the domain name,
not the IP.

## The domain changed

1. Issue a certificate for the new name, same as in the README
   (Domain and TLS section). Reuse the fixed cert name `kptv`:

   ```bash
   sudo certbot certonly --standalone -d <new-domain> --cert-name kptv \
       --config-dir "$PWD/data/letsencrypt" \
       --work-dir "$PWD/data/letsencrypt/work" \
       --logs-dir "$PWD/data/letsencrypt/logs"
   ```

   Stop nginx first if it holds port 80: `docker compose stop nginx`
   (and start it back after: `docker compose start nginx`).

2. Set `SERVER_HOST=<new-domain>` in `.env` and `./kptv.sh restart`.
3. Point the TVs at the new address (see below).

## Pointing the TVs at a new address

- **MSX (Tizen):** MSX → Settings → Start Parameter →
  `https://<your-domain>/msx/start.json`.
- **TV browser:** open `https://<your-domain>/client/?id=<device-id>` once
  per TV (device ids: `./kptv.sh admin list`), then the plain `/client/`
  URL is enough.

The `?id=` step matters: the client keeps its device id in localStorage per
origin, so after an address change it would otherwise generate a fresh id
and land on the activation screen.

## Troubleshooting

- **TV says the site is unreachable** — the DNS record still points at the
  old IP. Check with `nslookup <your-domain>` from any machine.
- **Certificate warning in the browser** — the cert is for the old domain.
  Reissue it for the name the TVs actually open (see above).
- **Activation screen on the TV** — the TV lost its device id (new origin).
  Use the `?id=<device-id>` URL once, or just activate it again.
