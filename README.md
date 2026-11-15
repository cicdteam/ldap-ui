# ldapui

A local web UI for browsing OpenLDAP and Active Directory.

## Run with Docker

Release images for amd64 and arm64 are published as
`ghcr.io/cicdteam/ldap-ui:<version>` (for example `1.0.0`) and `:latest`.

The quickest start:

```sh
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/cicdteam/ldap-ui:latest
```

The container listens beyond loopback, so ldapui prints a login link with a
random token at startup; open it, then add your directories with
**New connection**. Set `LDAPUI_AUTH_TOKEN` to choose the token (at least 16
characters from `A-Z a-z 0-9 . _ ~ -`). Without a volume, the connections you
add are lost when the container is removed.

Connections come from two places, and you can use either or both: the ones
you create in the UI (kept in `/data`, passwords never stored) and the fixed
ones in a [`connections.yaml`](#connectionsyaml) you mount. A fuller run that
keeps UI connections across restarts and loads a `connections.yaml`:

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -v ldapui-data:/data \
  -v "$PWD/connections.yaml:/etc/ldapui/connections.yaml:ro" \
  -e LDAPUI_CONFIG=/etc/ldapui/connections.yaml \
  ghcr.io/cicdteam/ldap-ui:latest
```

To run your own build instead, `make image` builds `ldapui:dev`; use that name
in place of the published one.

The UI's hashed assets are served gzipped and cached for a year, so no ingress compression or caching setup is needed.
`/api` responses are never cached (`Cache-Control: no-store`), and the UI refuses to be framed by other pages.

`make image-multiarch` builds `ldapui:dev-amd64` and `ldapui:dev-arm64` with
buildx and checks each (architecture, `--version`, `/healthz`, unpacked size
under 40 MiB); set `IMAGE` to tag them for a registry. On a host without amd64
(or arm64) emulation, pass `PLATFORMS=linux/arm64` (or `linux/amd64`) to check
one platform.

Demo with a sample OpenLDAP and Samba AD: `make demo-start`, then open
<http://127.0.0.1:8080/?token=demo-token-not-secret>. It has two profiles on the
OpenLDAP directory, `demo` (dev, editable) and `demo-prod` (prod, read-only),
and `demo-ad` (Samba AD over LDAPS, editable, bound as Administrator; demo
people 001-040 bind with `Demo-Passw0rd!`, 041-045 are disabled). The
directories reset on every start. `make demo-stop` stops it; `make demo-start DEMO_PORT=8090` picks another port.
`make help` lists all targets.

## Using the UI

- **Connections** (`/`): profiles from `connections.yaml` (marked `yaml`) and
  ones saved in the UI. Passwords are never stored: a profile with a bind DN
  but no `passwordEnv`/`passwordFile` asks for one at connect time, and so
  does one whose configured password the server rejects or cannot read. An
  untrusted TLS certificate shows its chain and fingerprints; "Trust this CA"
  stores it in a UI profile (for a yaml profile, copy the PEM into `caPEM` or
  point `caFile` at it).
- **Tree** (left): lazy, keyboard-driven (arrows, Home/End, `*`, type-ahead).
  A container shows its first 200 children; a bigger one ends with
  "More entries…", which lists all of them as a one-level search.
- **Search** (center): RFC 4515 filter editor with highlighting, completion
  from the schema and inline errors, or a visual builder; base DN, scope and
  columns sit next to it. Results load 500 at a time; sorting by column and
  export to CSV or LDIF act on the rows loaded so far. Recent and saved
  searches are kept per connection in the browser.
- **Inspector** (right): attributes grouped as MUST, MAY and operational, with
  decoded AD values (SIDs, GUIDs, dates, `userAccountControl` flags), clickable
  DNs, photos, a Download button on binary values (on any profile), and a
  raw-values switch; direct and nested membership with the "via" group; the
  entry as LDIF (non-ASCII text such as Cyrillic names is shown decoded, marked
  `utf-8`, here and in the Review and Actions dialogs; values with edge spaces,
  line breaks, control or invisible characters stay base64; Copy LDIF and
  downloads keep base64, as RFC 2849 requires).
  The Members list appears for groups that use `member` or
  `uniqueMember` (not for a posixGroup's `memberUid`); Member of also lists
  the posixGroups whose `memberUid` holds the entry's `uid`. Values of
  password and secret attributes never leave the server (their names and a
  count of hidden values are shown). Long value lists show the first 100
  values and grow by 1000 on request; the attribute filter also narrows the
  values it matches. Member of searches `member`, `uniqueMember` and
  `memberUid`; an equality index on each keeps it fast.
- **Status bar** (bottom): the server address, whether the connection is
  encrypted (TLS, StartTLS, not encrypted, certificate not verified), the
  server type and the number of staged changes.
- Every view has a URL (`/c/<profile>/entry?dn=...`,
  `/c/<profile>/search?filter=...`), so links and reloads work.

| Shortcut | Action |
|---|---|
| ⌘K / Ctrl+K | Command palette: go to a DN, find an entry by name, saved searches, switch connection, actions |
| `/` | Focus the filter editor (outside text fields) |
| ⌘↵ / Ctrl+Enter | Run the search (in the editor) |
| ⇧⌥F / Shift+Alt+F | Format the filter (in the editor) |
| `E` | Edit mode in the inspector (ignored while focus is in a text field, the tree, the results list or a dialog) |
| ⌘S / Ctrl+S | Review the staged changes |
| ⌘Z / Ctrl+Z, ⌘⇧Z / Ctrl+Shift+Z | Undo, redo a staged change (outside text fields) |
| `N`, `C`, `R` or F2, `P`, `Delete` or ⌘⌫ / Ctrl+Backspace | New child, Clone, Rename/Move, Set password, Delete the open entry (ignored while focus is in a text field, the tree, the results list or a dialog) |

⌘K / Ctrl+K and ⇧⌥F / Shift+Alt+F match the physical key, so they also work
on non-Latin keyboard layouts.

### Editing

- **Edit** (`E` in the inspector) turns attribute values into fields; a value
  commits on Enter. Changes are staged, not written: added, changed, deleted
  and stale values are marked in the inspector, the header shows
  "N changes", and staged entries get a dot in the tree and in the results.
  The batch is kept per connection for the browser tab and survives a reload.
- **Review** (⌘S / Ctrl+S, or the header badge) shows the batch as LDIF to
  read or copy; **Apply** writes it. A prod profile asks you to type its name
  first. A read-only profile (prod by default, or `readOnly: true`) has no
  Edit, and the server refuses its writes.
- If an entry changed since you read it, the apply stops at that entry:
  "Reload entry" marks the staged changes that no longer fit as stale,
  "Drop stale changes" removes them. A value the server rejects shows its
  error at the field. Entries that applied leave the batch.
- ⌘Z / Ctrl+Z undoes a staged change and ⌘⇧Z / Ctrl+Shift+Z redoes it
  (outside text fields). Disconnecting or closing the tab with unapplied
  changes asks first.
- **Actions** (in the inspector, or the command palette): **New child** (`N`),
  **Clone** (`C`), **Rename/Move** (`R` or F2) and **Delete** (`Delete` or
  ⌘⌫ / Ctrl+Backspace). Each opens a dialog with the DN and the LDIF it
  writes, and writes at once; it is not staged. A prod profile asks for its
  name first; a read-only profile has no Actions, and the server refuses these
  writes too.
- **New child** picks a structural class (common ones first), auxiliary
  classes, the RDN attribute and value, and asks for the MUST attributes.
  **Clone** starts from the entry, staged changes included, binary values
  (photos) and attributes with options too, without the RDN value, operational
  and secret attributes, the attributes that identify one entry (`uid`, `mail`,
  `uidNumber`, `employeeNumber`, `sAMAccountName`, `userPrincipalName`,
  `objectGUID`, `objectSid`, `mS-DS-ConsistencyGuid`) and certificates
  (`userCertificate`, `userSMIMECertificate`, any attribute of certificate
  syntax). Binary fields in both list their values with a delete button and
  take files through "+ Upload file…".
- **Rename/Move** changes the RDN, the parent, or both; "Keep old RDN value as
  an attribute" is off by default and not offered on Active Directory.
  **Delete** removes an entry without children after you type its RDN. Both
  wait until staged changes of the entry and the entries below it are applied
  or discarded.
- **Set password…** (`P`, in Actions and the command palette) is offered for
  entries whose classes allow `userPassword`, which needs the schema (on
  Active Directory, for `user` entries only). It asks for the new password
  twice and sets it at once: it is never staged, kept in the browser or
  logged, and the dialog shows no LDIF. A prod profile asks for its name
  first. On OpenLDAP the server hashes it by its own policy through the
  Password Modify operation (the default, when the server offers it), or
  ldapui stores it as SSHA. Active Directory takes it as `unicodePwd`, only
  over ldaps:// or StartTLS.
- **Membership** in Edit, on the Membership tab: "Add to group…" in Member of
  (also in the command palette) and "Add member…" in Members suggest groups
  or entries by name; direct memberships have a remove button, nested ones
  say which group they come through. These are staged changes of the group's
  `member`, `uniqueMember` or `memberUid` (posixGroup, by the entry's `uid`),
  reviewed and applied with the rest of the batch. A plain posixGroup keeps
  its members in `memberUid` and has no Members list to edit: it is joined
  and left from its members' Member of. A posixGroup that is also a
  `groupOfNames` (RFC 2307bis) is edited as `member`, in its Members list
  too, like any groupOfNames. Removing the last member of a group whose class
  requires one (`groupOfNames`, `groupOfUniqueNames`) is flagged at that
  attribute on the Attributes tab, and Apply waits; this needs the schema.
- In Edit, `objectClass` takes auxiliary classes ("+ class") and lets you
  remove them; the structural class and its superclasses are locked. The
  required attributes the added classes introduce appear as empty rows to
  fill; attributes a removed class leaves without a class show `Not allowed
  without <class>; delete it`, and Apply waits until you delete them. This
  needs the schema.
- **Binary values** (`jpegPhoto`, certificates, any `;binary` attribute or one
  that holds binary values already): in Edit, "+ Upload file…" stages a file
  of up to 1 MiB (photos show a preview) and each binary value has a delete
  button; replacing one is a delete and an upload. Certificates are written
  as `userCertificate;binary` (RFC 4522). Apply, New child and Clone send at
  most 8 MiB in one request: a reverse proxy in front of ldapui must allow
  that body size. Where the server cannot delete or add one value
  (`jpegPhoto` has no equality rule), Apply reads the attribute and writes
  back the values it will hold: a value someone else adds between the two is
  lost.
- **Attributes with options** (`cn;lang-de`, `description;lang-ru`) are
  attributes of their own, edited apart from `cn`. "+ attribute" takes a name
  with options (letters, digits and hyphens; not `range=`), suggests the
  names the entry's classes allow, and opens the file chooser on Enter for a
  binary one. A required attribute is met by a value of any of its variants.
- A batch too large for the tab's session storage (several photos) stays in
  the tab only: Review says it will not survive a reload.
- Not editable here: secrets other than the entry's password. RDN values
  change through Rename/Move, not in place.

## connections.yaml

```yaml
connections:
  - name: corp-ad
    url: ldaps://dc1.corp.example:636
    baseDN: dc=corp,dc=example
    bindDN: cn=reader,ou=svc,dc=corp,dc=example
    passwordEnv: CORP_AD_PASSWORD # or passwordFile, or type it in the UI
    caFile: /etc/ldapui/corp-ca.pem
    environment: prod # prod profiles are read-only by default
```

## Saved connections

Profiles created in the UI are kept, without passwords, in `profiles.json`
in `--data-dir`; without a data dir the UI cannot save profiles. At most 200
profiles can be saved, each at most 4 KiB as JSON not counting `caPEM`, which
has its own limit of 16 KiB; saving one more profile, or a bigger one, fails
with 409 `profile_limit`. Saves are written to a temporary file, synced and
renamed, so a crash never leaves a partial file.

A `profiles.json` that does not parse or holds an invalid profile does not
stop the server: it is moved to `profiles.json.bad` (replacing an older one),
the server starts with no saved profiles and logs the warning `profiles file
was invalid and was moved aside` with its `path`. A file the server cannot
read (permissions) is a startup error.

Run one ldapui process per data dir. The server locks `.lock` in it (Linux,
macOS and the BSDs), and a second process on the same directory exits with
`data dir ... is in use by another ldapui process`. A data dir that does not
exist is a startup error. One that is read-only or not writable for the
server's user still starts: the saved profiles are listed, saving fails, and
the server runs without the lock and logs the warning `data dir is not
writable; saving profiles will fail` with its `dir`.

## Flags

| Flag | Env | Default |
|---|---|---|
| `--listen` | `LDAPUI_LISTEN` | `127.0.0.1:8080` |
| `--base-path` | `LDAPUI_BASE_PATH` | none |
| `--config` | `LDAPUI_CONFIG` | none |
| `--data-dir` | `LDAPUI_DATA_DIR` | none (`/data` in the image) |
| `--auth-token` | `LDAPUI_AUTH_TOKEN` | generated when not on loopback or when `--allowed-hosts` is set |
| `--allowed-hosts` | `LDAPUI_ALLOWED_HOSTS` | none; `localhost`, `127.0.0.1` and `::1` are always allowed; comma-separated extras |
| `--session-idle` | | `30m` |
| `--secure-cookies` | `LDAPUI_SECURE_COOKIES` | `false` (set behind a TLS proxy or ingress) |
| `--identity-header` | `LDAPUI_IDENTITY_HEADER` | none; a header an authenticating proxy sets to the user, logged as `user` (see [Logs and accountability](#logs-and-accountability)) |
| `--trusted-proxies` | `LDAPUI_TRUSTED_PROXIES` | none; comma-separated CIDRs or IPs of the proxies whose `--identity-header` is logged; required with `--identity-header` |
| `--version` | | prints `ldapui <version>` and exits |

Behind a reverse proxy, always set `--auth-token` or `LDAPUI_AUTH_TOKEN`: a
proxy that forwards `Host: localhost` or `127.0.0.1` looks like a local
browser, which needs no token when ldapui listens on loopback.
`--allowed-hosts` without a token generates a new one on every restart, so
set one explicitly to keep it stable. A request that runs longer than 5
minutes is cut off.

A browser's open connections live in a session on the server, closed after
`--session-idle` without use. Every successful connect moves the browser to a
new session ID and keeps its connections, so an ID seen before a connect is
worthless after it. A request from another tab at the same instant can
find its session gone; that tab reconnects. A session holds at most 8
connections: one more connect fails with 409 `too_many_connections` until one
is disconnected. The server holds at most 1000 sessions; one more closes the
connections of the least recently used.

The server runs at most 64 API requests at once, and at most 4 of one
session; the others wait their turn. A request that waits more than 10
seconds gets 503 `busy` with `Retry-After: 1`. Once running, an API request
has 2 minutes and an Apply 4 minutes before it ends with `timeout` (504). An
Apply whose time runs out, or whose browser goes away, stops between entries:
a modify already sent to the server finishes, the entries before the stop
stay applied, and the response lists them and names the next entry as failed
with `timeout`.

## Logs and accountability

ldapui logs to stdout, one `key=value` line per event. The lines below,
except `auth failed`, end with who made them:

- `session`: the first 8 hex characters of the SHA-256 of the browser's
  session cookie, empty without one. A connect gives the browser a new
  session ID, and its `connected` line carries the new one. It ties one
  browser's lines together from one connect to the next; the session ID
  itself is never logged.
- `remote`: the client address and port. Behind a proxy this is the proxy:
  match it with the proxy's access log.
- `user`: the `--identity-header` value, see below.

The lines:

| Message | Fields |
|---|---|
| `connected`, `connect failed` | `profile`, `bindDN`, and `error` when it failed |
| `disconnected` | `profile`, `bindDN` |
| `modified` | `profile`, `dn`, `changes` (how many), `attrs` (the attribute of each change), `bindDN` |
| `added` | `profile`, `dn`, `attributes` (how many), `bindDN` |
| `renamed` | `profile`, `dn`, `newDN`, `bindDN` |
| `password set` | `profile`, `dn`, `method`, `bindDN` |
| `deleted` | `profile`, `dn`, `bindDN` |
| `modify rejected`, `add rejected`, `rename rejected`, `password rejected`, `delete rejected` | the fields of the write, `code`, `ldapResultCode`, `bindDN`; an unexpected error also logs `<op> failed` with `error` |
| `profile saved` | `name`, `oldURL` (empty for a new profile), `url`, `readOnly`, `insecureSkipVerify` |
| `auth failed` | `remote` only: a request refused with 401 for a missing or wrong token |

`bindDN` is the profile's bind DN. Attribute values, passwords, tokens and
session IDs are never logged, and a DN that does not parse or has a secret
attribute in an RDN is logged as `<redacted>`.

The directory's own audit log sees only the bind DN. A profile bound as a
shared service account (`passwordEnv` or `passwordFile`) makes every write
that account's, and with one shared token only `session` and `remote` tell
people apart. For per-person accountability, give each person a profile with
their own bind DN and no configured password: they type their password at
connect, and both the directory and ldapui log their DN.

Behind an authenticating proxy, ldapui can also log the user the proxy
verified. With oauth2-proxy (`--set-xauthrequest`) behind ingress-nginx
(`nginx.ingress.kubernetes.io/auth-response-headers: X-Auth-Request-Email`):

```sh
ldapui --identity-header X-Auth-Request-Email --trusted-proxies 10.42.0.0/16
```

The value is logged as `user`, cut to 256 bytes, on the lines that carry
`session`, and only for requests whose client address is in
`--trusted-proxies`. It is a log field only: it grants nothing, and the token
still applies. Any client can send any header, so the value means something
only when the proxy replaces it on every request (ingress-nginx and nginx's
`proxy_set_header` do) and nothing else can reach ldapui from a trusted
address: list only the proxy's addresses, and keep other clients off the
ldapui port (a NetworkPolicy, or a loopback listener next to the proxy).
`--identity-header` without `--trusted-proxies` is a startup error.

## Development

`make check` runs Go fmt, vet, lint, vuln and unit tests plus the web checks
(`make web-check`: typecheck, ESLint, Prettier, Vitest, npm audit).
`make test-integration` needs Docker; it runs OpenLDAP and Samba AD. `make
web` builds the UI into `web/dist`, which the Go binary embeds (`make build`
does both).

`make e2e` runs the Playwright suite against a fresh OpenLDAP and Samba AD
(Docker) and the built binary on 127.0.0.1:18091, using the locally installed
Google Chrome; it is not part of `make check`.

Both suites (`make test-integration` and `make e2e`) reach Samba AD
(`smblds/smblds`) over LDAPS with the test CA in `deploy/ad-test/tls/` (test
fixtures, not secrets; the CA key was discarded).

UI development with hot reload:

```sh
docker compose -f deploy/docker-compose.yml up -d openldap
DEMO_LDAP_PASSWORD=adminpassword go run ./cmd/ldapui --config deploy/connections.dev.yaml
cd web && npm ci && npm run dev   # http://localhost:5173, /api is proxied to :8080
```

The demo directory (`deploy/demo-ldif/gen.sh`) has 250 people, nested groups
with a cycle, DNs with escaped commas and non-ASCII characters, photos on the
first 20 people, a certificate on `user001`, and names and descriptions with
language options on the first five. The AD demo, under `OU=Demo`, has 50
people with titles and departments (001-040 enabled with `Demo-Passw0rd!`,
041-045 disabled, 046-050 without a password), nested groups (`user001` is in
Everyone via Staff via Engineering), and All Bulk, a group of 1600 users,
above AD's 1500-value range limit.

### Samba AD vs Active Directory

The AD tests run against Samba, which differs from Windows AD in ways they
cannot cover:

- Samba returns all values of a plain read without ranging. The follow-up
  range requests are tested against Samba from a ranged first request, but a
  range the server forces on a plain read is covered by unit tests only.
- No Kerberos or NTLM binds; ldapui uses simple binds only.
- Password policy errors carry the same `0000052D` code, but the reason after
  it may be worded differently.
- No global catalog.
