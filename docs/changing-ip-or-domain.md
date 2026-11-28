**English** · [Русский](changing-ip-or-domain.ru.md)

# Changing IP or Domain

What to do when the server's public IP or its domain changes. The database does
not care about the address — only DNS, the TLS certificate and the TVs'
bookmarks do.

## Only the IP changed, domain stays

Typical case: the provider gave you a new IP, or you moved to another machine
under the same DuckDNS name.

1. Point the DNS record at the new IP. For DuckDNS this is one field on the
   site — the change propagates in a minute or two.
2. Open ports 80 and 443 on the new host (firewall and, if any, the cloud
   provider's security group).
3. If the server itself moved to a different machine, copy the project and the
   database — see [Moving to a New Server](moving-to-a-new-server.md).
4. Check: `curl https://<your-domain>/msx/start.json` should answer.

The certificate does **not** need reissuing — it is tied to the domain name, not
the IP. `./kptv.sh restart` is not strictly needed, but does not hurt.

## The domain changed

1. Reissue the certificate for the new name — the same certbot command as in
   the README (Install, step 3), just with the new `-d`. Keep the fixed
   `--cert-name kptv` so nginx finds it.
2. Set `SERVER_HOST=<new-domain>` in `.env`, then `./kptv.sh restart`.
3. Point the TVs at the new address (below).

## Pointing the TVs at a new address

- **MSX (Tizen):** MSX → Settings → Start Parameter →
  `https://<your-domain>/msx/start.json`.
- **TV browser:** open `https://<your-domain>/client/?id=<device-id>` once per
  TV (ids are listed in the admin panel — tunnel in with
  `ssh -L 8001:localhost:8001 user@<server>`, then http://localhost:8001);
  afterwards the plain `/client/` URL is enough.

The `?id=` step matters: the client keeps its device id in localStorage per
origin, so on a new address it would otherwise generate a fresh id and land on
the activation screen.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| TV says the site is unreachable | DNS still points at the old IP — check `nslookup <your-domain>` from any machine |
| Certificate warning in the browser | the cert is for the old domain — reissue it for the name the TVs actually open |
| Activation screen on the TV | the TV lost its device id (new origin) — use the `?id=<device-id>` URL once, or just activate it again |
