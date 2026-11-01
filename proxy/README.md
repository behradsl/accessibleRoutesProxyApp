# FAM mobile proxy

The phone app keeps calling Rahkaran paths such as `/Services/FAM/EntranceService.svc/login`. Point the app at this portal address instead of the Rahkaran server. This script forwards only the calls listed in `routes.json` to the internal Rahkaran address in `config.json`.

The public site stays on IIS, which already has the HTTPS certificate. IIS starts `node.exe`. The script listens on `127.0.0.1` only.

## Files you edit

`config.json`

- `erpBaseUrl` is the internal Rahkaran base, for example `http://10.1.1.20/0407.4`. The phone never sees this address.
- `publicBaseUrl` is the address typed into the phone, without `/Services/...`, for example `https://portal.example.com/0407.4`.
- `publicPathPrefix` is the IIS application path. Use the same virtual directory Rahkaran uses, usually `/0407.4`.
- `timeoutMs` is how long to wait for Rahkaran. `180000` is three minutes, because some list calls ask for a very large page.
- `maxBodyBytes` is the largest request body to forward. The matching IIS limit is in `web.config`.

`routes.json` is the allow list. Each entry is a method and a path:

```json
{ "method": "POST", "path": "/Services/FAM/EntranceService.svc/GetAcquisitionReceiptList" }
```

After either file changes, recycle this IIS application pool.

The API note did not include URLs for the warehouse voucher list, barcode print, asset inventory, or asset search. Those calls are not in `routes.json`. When the phone uses one, `proxy.log` shows `REJECT`, the method, and the path. Copy that method and path into a new line. The path has to look like `/Services/Area/Name.svc/Method`. A wildcard, `..`, or a path without the method name makes the script refuse to start, which keeps the rest of Rahkaran closed.

## Install on the portal server

1. Open `FamMobileProxy.exe`. If Visual C++ or Node.js is missing, the program installs the copies it carries and asks for administrator approval. The server does not need internet for that. Node.js lands in `C:\Program Files\nodejs\node.exe`. The window itself already contains a copy, so Start works even if that install is declined. If you install Node somewhere else, change `processPath` in `web.config` once.
2. Copy this folder to the portal server. Leave `logs` in place.
3. In the program, set the public address to `https://the-portal-domain/FAMmobileService` and the path prefix to `/FAMmobileService`. Press Start. Start installs URL Rewrite and Application Request Routing from copies inside the program when IIS does not already have them, adds only that path on the IIS site that already has the domain, and forwards it to the local listener. Stop removes that path. The other applications on the site stay in place. Nothing is downloaded.
4. On the portal server, open `erpBaseUrl` in a browser and confirm Rahkaran answers on the private network. The phone's server address is `publicBaseUrl`.

## When something fails

Read `proxy.log` in this folder. A line looks like:

```text
2026-10-27T12:00:00.000Z REJECT POST /Services/FAM/EntranceService.svc/SomeMethod
2026-10-27T12:00:01.000Z 200 POST /Services/FAM/TransactionProcessingService.svc/login
2026-10-27T12:00:02.000Z 502 GET /Services/FAM/TransactionProcessingService.svc/GetAssetGroup ECONNREFUSED
```

The log has the method and the path. It does not have the request body, cookies, or the Authorization header.

- `REJECT` means that method and path are not in `routes.json`, or the URL has a query string such as `?wsdl`. Add a real mobile call by copying a line in `routes.json`.
- `413` means the body is larger than `maxBodyBytes`.
- `502` in `proxy.log` means Node is running and could not reach Rahkaran. Check `erpBaseUrl`, that the Rahkaran service is running, and that the firewall allows this server to reach it. The phone sees `The service is temporarily unavailable.` and does not see the internal host name.
- No new line in `proxy.log`, and IIS returns 502.3, means Node did not start. Open the newest file in `logs`. A bad `config.json` or `routes.json` is reported there.
- Login works and the next call does not: Rahkaran's `Set-Cookie` still has an internal `Domain`. That removal is `stripCookieDomain` in `proxy.js`.
- A redirect sends the phone to the internal host: `rewriteLocation` in `proxy.js` should replace `erpBaseUrl` with `publicBaseUrl`.

Do not log request bodies if you change the script. The login body contains the password.

## After a code change

From this folder:

```text
node --test
```

One attempt is made to Rahkaran. Do not add a retry around the save or delete calls. A second attempt could create a second receipt.
