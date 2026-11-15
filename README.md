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
  does one whose configured password the server rejects or cannot read. A
  `bindDNTemplate` profile asks for a username and a password (see [Per-user
  login](#per-user-login)). An
  untrusted TLS certificate shows its chain and fingerprints; "Trust this CA"
  stores it in a UI profile (for a yaml profile, copy the PEM into `caPEM` or
  point `caFile` at it).
- **Tree** (left): lazy, keyboard-driven (arrows, Home/End, `*`, type-ahead).
  A container shows its first 200 children; a bigger one ends with
  "More entries…", which lists all of them as a one-level search.
- **Search** (center): RFC 4515 filter editor with highlighting, completion
  from the schema and inline errors, or a visual builder; base DN, scope and
  columns sit next to it. Results load 500 at a time; sorting by column and
  export to CSV or LDIF act on the rows loaded so far. A page the server cut
  with a size or time limit, or one past ldapui's caps on a single response
  (5000 entries, 64 MiB of attribute values), shows what arrived and is
  marked truncated ("The search stopped early"); a listing cut by a cap has
  no further pages. One server message (an entry) over 64 MiB fails the
  request instead. Recent and saved
  searches are kept per connection in the browser. A filter can test a
  password or secret attribute for presence (`(userPassword=*)`) but not
  match on its values: equality, substring, ordering, approximate and
  extensible matches on one, and extensible matches without an attribute
  type (`(:octetStringMatch:=x)`, which test every attribute), are refused
  with 400 `secret_filter`.
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
  values it matches. An attribute with more than 10 000 values (the `member`
  list of a huge group) arrives truncated to its first 10 000, noted
  "Showing the first 10,000 values"; LDIF and CSV exports of such an entry
  also hold only the first 10 000. Edit still adds and deletes single
  values, and Apply touches only those. Member of searches `member`,
  `uniqueMember` and `memberUid`; an equality index on each keeps it fast.
  Member of and Members list at most 10 000 groups or members: a longer list
  is truncated there and marked incomplete.
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
  that body size (see [Behind a reverse proxy](#behind-a-reverse-proxy)).
  One Apply also takes at most 1000 entries and 1000 changes per entry, one New child or Clone at most 1000 attributes, and either at
  most 10 000 values in all; a bigger request is refused with 400
  `request_too_large`, naming the limit. Where the server cannot delete or
  add one value (`jpegPhoto` has no equality rule), Apply reads the
  attribute and writes back the values it will hold: a value someone else
  adds between the two is lost.
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

### Signing in with your own username

A profile with `bindDNTemplate` instead of `bindDN` asks each person for a
username and password at connect, and binds as the template with `{user}`
replaced by the username. The template contains `{user}` exactly once and
cannot be combined with `bindDN`, `passwordEnv` or `passwordFile`. Both keys
below are read from `connections.yaml` only; profiles saved in the UI cannot
have them.

```yaml
connections:
  - name: people # OpenLDAP: the full DN
    url: ldap://ldap.example.org:389
    startTLS: true
    baseDN: dc=example,dc=org
    bindDNTemplate: uid={user},ou=people,dc=example,dc=org
  - name: corp-ad # Active Directory: a UPN (or a down-level name, CORP\{user})
    url: ldaps://dc1.corp.example:636
    baseDN: dc=corp,dc=example
    bindDNTemplate: "{user}@corp.example"
    identityUser: localpart
```

The username must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (ASCII letters,
digits, `.`, `_` and `-`, starting with a letter or digit, at most 64
characters), so it cannot change the structure of the DN; in a template that
contains `=` it is also escaped as a DN value.

`identityUser` (`exact` or `localpart`, needs `bindDNTemplate`) ties the
username to the user an authenticating proxy verified (see
`--identity-header` under [Logs and accountability](#logs-and-accountability)):
a connect needs that identity, and the username must equal it, compared
case-insensitively. `exact` takes the identity as is; `localpart` takes the
part before the last `@` (`alice@corp.example` gives `alice`). The connect
dialog fills in the username and does not let it be changed. [Per-user
login](#per-user-login) has the whole flow and its errors.

## Saved connections

Profiles created in the UI are kept, without passwords, in `profiles.json`
in `--data-dir`; without a data dir the UI cannot save profiles. At most 200
profiles can be saved, each at most 4 KiB as JSON not counting `caPEM`, which
has its own limit of 16 KiB; saving one more profile, or a bigger one, fails
with 409 `profile_limit`. Saves are written to a temporary file, synced and
renamed, so a crash never leaves a partial file.

On a writable data dir, a `profiles.json` that does not parse or holds an
invalid profile does not stop the server: it is moved to `profiles.json.bad`
(replacing an older one), the server starts with no saved profiles and logs
the warning `profiles file was invalid and was moved aside` with its `path`
and the parse or validation `error`. On a read-only data dir it cannot be
moved, so it is a startup error, and so is a file the server cannot read
(permissions).

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
| `--auth-token-file` | `LDAPUI_AUTH_TOKEN_FILE` | none; a file holding the token, such as a mounted Secret; one trailing newline (`\n` or `\r\n`) is dropped |
| `--allowed-hosts` | `LDAPUI_ALLOWED_HOSTS` | none; `localhost`, `127.0.0.1` and `::1` are always allowed; comma-separated extras |
| `--session-idle` | `LDAPUI_SESSION_IDLE` | `30m` |
| `--session-max-age` | `LDAPUI_SESSION_MAX_AGE` | `8h` |
| `--secure-cookies` | `LDAPUI_SECURE_COOKIES` | `false` (set behind a TLS proxy or ingress) |
| `--identity-header` | `LDAPUI_IDENTITY_HEADER` | none; a header an authenticating proxy sets to the user, logged as `user` (see [Logs and accountability](#logs-and-accountability)) |
| `--trusted-proxies` | `LDAPUI_TRUSTED_PROXIES` | none; comma-separated CIDRs or IPs of the proxies whose `--identity-header` is trusted; required with `--identity-header` |
| `--version` | | prints `ldapui <version>` and exits |

A flag beats its variable, and an empty variable counts as unset
(`LDAPUI_DATA_DIR=""` disables saving). A variable that does not parse
(`LDAPUI_SECURE_COOKIES=yes`, `LDAPUI_SESSION_IDLE=30`) is a startup error
even when its flag is set. `--auth-token` or `--auth-token-file`
on the command line overrides both token variables. Both flags at once, or
both variables at once, are a startup error, and so is a token file that is
missing or holds an invalid token (at least 16 characters from
`A-Z a-z 0-9 . _ ~ -`); the error names the file, never the token.

A browser's open connections live in a session on the server, closed after
`--session-idle` without use. Each connection is also closed
`--session-max-age` after it was connected, however active; connecting that
profile again starts the count again, an automatic reconnect after a dropped
connection does not. Every successful connect moves the browser to a new
session ID and keeps its other connections, each with its own count, so an
ID seen before a connect is worthless after it. A request from another tab
at the same instant can find its session gone; that tab reconnects. A
session holds at most 8 connections: one more connect fails with 409
`too_many_connections` until one is disconnected. The server holds at most
1000 sessions; one more closes the connections of the least recently used.

Five wrong passwords (LDAP result 49, invalid credentials) for one bind DN
within 60 seconds refuse further connects as that DN with 429
`too_many_attempts` and a `Retry-After` header in seconds, until 60 seconds
after the first of them. Connects as that DN still waiting for the server
count too, so a burst of them at once gets no more than five tries: a connect
refused before five have failed gets `Retry-After: 1`. A successful connect
clears the count; other failures, such as a server that cannot be reached, do
not count. The limit is per account on each server: it is keyed by the
server and the bind DN (see below), not by client address, since behind a
proxy every client has the same address. A successful connect as the same DN
to another server does not clear the count. It applies to every connect with a typed password, on a `bindDN`
profile as on a `bindDNTemplate` one. A connect with the configured password
(`passwordEnv` or `passwordFile`) and an anonymous one are never refused, so a
wrong service password cannot lock its DN for everyone. In return, anyone who
can reach ldapui can keep one account from connecting through ldapui, a
minute at a time; the directory's own lockout policy is separate and
unaffected. The counts are kept in memory, per process, like sessions, for at
most 10,000 bind DNs; past that the oldest are dropped.

The count is per account as the bind DN names it, after normalizing spacing,
case and escapes: `uid=alice,ou=people,dc=example,dc=org`,
`UID=Alice, ou=People,dc=example,dc=org` and
`uid=\61lice,ou=people,dc=example,dc=org` share one count, and so do
`alice@corp.example` and `ALICE@corp.example`. The server is the URL's host,
ignoring case, and port, 389 for `ldap://` and 636 for `ldaps://` when the
URL has none: `ldap://Dc1` and `ldap://dc1:389` share one count. Attribute
OIDs (`0.9.2342.19200300.100.1.1=alice` for `uid=alice`), Active Directory's
other names for one account (its UPN, `DOMAIN\user` and its DN) and other
names for one server (its IP address) still count separately, and a saved
connection can name an account or a server any of those ways. So
where guessing passwords through ldapui matters, run with fixed profiles
only: `LDAPUI_DATA_DIR=""` disables saved connections, and the profiles in
`connections.yaml` each name one form.

The server runs at most 64 API requests at once, and at most 4 of one
session; the others wait their turn. A request that waits more than 10
seconds gets 503 `busy` with `Retry-After: 1`; the UI retries a read that
gets it up to 3 times, a second apart, and never retries a write. Once
running, an API request has 2 minutes before it ends with 504 `timeout`. An
Apply has 4 minutes and stops between entries instead: when its time runs
out or its browser goes away, a modify already sent to the server finishes,
the entries before the stop stay applied, and the response is a 200 that
lists them and names the next entry as failed with `timeout` (`canceled`
when the browser went away).

The probes `GET /healthz` and `GET /readyz` answer `ok` without the token or
the Host check, so a kubelet can call them by pod IP. With `--base-path
/ldap` they answer at both `/healthz` and `/ldap/healthz` (and the same for
`/readyz`).

On SIGTERM or Ctrl-C the server stops accepting connections and waits up to
25 seconds for running requests. Then it closes the rest, logs `shutdown
drain timed out` and exits 0. A second Ctrl-C exits at once. The drain fits
the 30 second default grace period of a Kubernetes pod.

`connections.yaml`, the `passwordEnv` variables, the token (also from
`--auth-token-file`) and every other flag and variable are read at startup:
restart after changing them. `passwordFile` and `caFile` are read at every
connect, so a rotated Secret is used at the next connect. Mount ConfigMaps
and Secrets as directories, not with `subPath`, which never sees an update.

## Logs and accountability

ldapui logs to stdout, one `key=value` line per event. The lines below,
except `auth failed`, end with who made them:

- `session`: the first 8 hex characters of the SHA-256 of the browser's
  session cookie, empty without one. A connect gives the browser a new
  session ID: its `connected` line carries the new one, and the one the
  request came with in `previous`. It ties one browser's lines together
  across connects; the session ID itself is never logged.
- `remote`: the client address and port. Behind a proxy this is the proxy:
  match it with the proxy's access log.
- `user`: the `--identity-header` value, see below.

The lines:

| Message | Fields |
|---|---|
| `connected`, `connect failed` | `profile`, `bindDN`; `connected` adds `previous` (the `session` fingerprint of the cookie the request carried, empty without one), `connect failed` adds `error` |
| `connect throttled` | `profile`, `bindDN`: a connect refused with 429 `too_many_attempts` |
| `connect refused` | `profile`, `code`, `bindDN` (empty): a connect refused with 403 `identity_required` or `identity_mismatch` (see [Per-user login](#per-user-login)) |
| `disconnected` | `profile`, `bindDN` |
| `identity changed` | `profile`, `bindDN`: a request on an `identityUser` connection with another trusted identity or none; the connection is closed (see [Per-user login](#per-user-login)) |
| `modified` | `profile`, `dn`, `changes` (how many), `attrs` (the attribute of each change), `bindDN` |
| `added` | `profile`, `dn`, `attributes` (how many), `bindDN` |
| `renamed` | `profile`, `dn`, `newDN`, `bindDN` |
| `password set` | `profile`, `dn`, `method`, `bindDN` |
| `deleted` | `profile`, `dn`, `bindDN` |
| `modify rejected`, `add rejected`, `rename rejected`, `password rejected`, `delete rejected` | the fields of the write, `code`, `ldapResultCode`, `bindDN`; an unexpected error also logs `<op> failed` with `error` |
| `profile saved` | `name`, `oldURL` (empty for a new profile), `url`, `readOnly`, `insecureSkipVerify` |
| `auth failed` | `remote` only: a request refused with 401 for a missing or wrong token |

`bindDN` is the DN the connection bound as: the profile's `bindDN`, or for a
`bindDNTemplate` profile the template with the username filled in; empty for
an anonymous bind. Attribute values, passwords, tokens and
session IDs are never logged, and a DN that does not parse or has a secret
attribute in an RDN is logged as `<redacted>`.

At startup the server logs `listening` with `version`, `addr`, `basePath`,
`profiles` (how many from `connections.yaml`), `saved` (how many saved
connections it loaded) and `dataDir` (empty when saving is disabled). A
generated token adds the login link, and inside Kubernetes
(`KUBERNETES_SERVICE_HOST` is set) a warning: a generated token changes on
every restart and differs per replica, so set `LDAPUI_AUTH_TOKEN` or
`LDAPUI_AUTH_TOKEN_FILE` from a Secret. A shutdown that runs out of time
logs the warning `shutdown drain timed out` with `after`.

The directory's own audit log sees only the bind DN. A profile bound as a
shared service account (`passwordEnv` or `passwordFile`) makes every write
that account's, and with one shared token only `session` and `remote` tell
people apart. For per-person accountability, use [per-user
login](#per-user-login): everyone binds as themselves with their own
password, and both the directory and ldapui log their DN.

Behind an authenticating proxy, ldapui can also log the user the proxy
verified. For example, ingress-nginx asks oauth2-proxy (run with
`--set-xauthrequest`) about every request through
`nginx.ingress.kubernetes.io/auth-url` and passes the user on with
`nginx.ingress.kubernetes.io/auth-response-headers: X-Auth-Request-Email`:

```sh
ldapui --identity-header X-Auth-Request-Email --trusted-proxies 10.244.0.0/16
```

`10.244.0.0/16` stands for the cluster's pod network, which differs between
Kubernetes clusters: use yours. This trusts every pod in it, so it assumes a
NetworkPolicy that lets only the ingress controller reach ldapui, like the one
under [Kubernetes](#kubernetes).

The value is logged as `user`, cut to 256 bytes, on the lines that carry
`session`, and only for requests whose client address is in
`--trusted-proxies`. On its own it grants nothing, and the token still
applies; on a profile with `identityUser` it decides which username a person
may sign in as (see [Per-user login](#per-user-login)). Any client can send
any header, so the value means something only when the proxy replaces it on
every request (ingress-nginx and nginx's
`proxy_set_header` do) and nothing else can reach ldapui from a trusted
address: list only the proxy's addresses, and keep other clients off the
ldapui port (a NetworkPolicy, or a loopback listener next to the proxy).
`--identity-header` without `--trusted-proxies` is a startup error, and so
is `Authorization`, `Proxy-Authorization` or `Cookie` as the header: they
carry credentials.

## Running for a team

ldapui keeps sessions in memory and saved connections in one file with one
writer, so a shared instance is one process. In Kubernetes, run one replica
with `strategy: Recreate`: a second replica does not know the first one's
sessions, and the default rolling update starts the new pod while the old
one still holds the data dir, so the new pod exits (see [Saved
connections](#saved-connections)) and the rollout stalls. Every restart
ends all sessions, and users connect again.

- **Fixed profiles with per-user login** is the recommended setup for a
  shared instance: put every connection in `connections.yaml` with a
  `bindDNTemplate` (see [Per-user login](#per-user-login)), set
  `LDAPUI_DATA_DIR=""`, and keep the token or an SSO proxy in front (with
  `--identity-header` and `identityUser`, the proxy also decides which
  username each person may sign in as). Everyone then works as themselves,
  and no service account password is stored in the deployment. Saving in
  the UI fails with 409 `saving_disabled`, and connect opens
  only the profiles from that file, so nobody can make the server open
  connections to other hosts and ports it reaches, or change a shared
  profile so that the next person's password goes to a server of their
  choosing. No volume is needed.
- **With UI-saved profiles** anyone who has the token can do both; every
  save is logged as `profile saved`, with the old and the new URL. Mount a
  volume at `/data`: in Kubernetes a PVC with `securityContext.fsGroup:
  65532`, which makes a root-owned volume writable for the image's user
  (UID 65532). A `hostPath` ignores `fsGroup`, and the `restricted` policy
  refuses it. An `emptyDir` forgets the profiles when the pod is replaced.
  Without a volume, the image's `VOLUME /data` gets a directory that lives
  only as long as the container, so saves are lost at its next restart.
- **Back up `profiles.json`** (it holds no passwords), and always before an
  upgrade: after a rollback, the older version drops the settings it does
  not know at its next save.
- **The token** comes from a Secret through `LDAPUI_AUTH_TOKEN_FILE` (or
  `LDAPUI_AUTH_TOKEN`). A generated one changes at every restart, which
  logs everyone out, and is printed only in the log. The token file is read
  at startup: restart after rotating it.
- **Memory**: ldapui uses about 10 MiB, plus about 55 MiB for each Apply of
  4 MiB of photos in flight. A large read holds up to 64 MiB of values per
  response, several times over while it is converted and encoded. Set a memory
  limit and `GOMEMLIMIT` to about 80% of it, for example 512Mi and 400MiB.
  Go does not read the container's limit by itself. `GOMEMLIMIT` makes the
  garbage collector work harder near the limit, which makes an OOM kill
  less likely, but it does not prevent one when live memory exceeds the
  limit. An OOM kill ends everyone's session.

What is read at startup and what at every connect, the probes and the
shutdown drain are described under [Flags](#flags), who did what under [Logs
and accountability](#logs-and-accountability).

### Per-user login

A profile with `bindDNTemplate` (see [Signing in with your own
username](#signing-in-with-your-own-username)) lets everyone sign in to the
directory as themselves: one profile serves the whole team, and each person
types their own username and password. It is the recommended mode for a
team. The directory's access rules apply to each person rather than to a
shared account, the directory's audit log and ldapui's logs name the person
who made each change, and no service account password has to be stored in
the deployment.

A connect to such a profile goes like this:

1. The browser sends the profile, the username and the password.
2. ldapui checks, in this order, that there is a username; with
   `identityUser`, that the request carries a trusted identity and that the
   username is the one it maps to; that the username matches
   `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; and that there is a password. Nothing
   reaches the directory before every check has passed. An empty password
   would be an unauthenticated bind (RFC 4513), which many servers accept as
   anonymous, so it is refused here.
3. ldapui binds as the template with the username filled in, for example
   `uid=alice,ou=people,dc=example,dc=org`. A wrong password is 401
   `invalid_credentials`, as on any profile. Five of them in 60 seconds
   refuse that DN with 429 `too_many_attempts` until the 60 seconds are
   over (see [Flags](#flags)).
4. The connection's lines in the log (`connected`, `connect failed`, every
   write and `disconnected`) carry that DN as `bindDN`.

The connect dialog of such a profile has a visible Username field above the
password, marked `autocomplete="username"` so that a password manager offers
the accounts it saved; ldapui itself does not remember the username. With
`identityUser`, when the request carries a trusted identity, the field is
filled in with the username it maps to and is read-only; without one, the
field is empty and connect fails with `identity_required`. Once connected, the
workspace header shows `Signed in as` and the DN the connection bound as,
for example `Signed in as uid=alice,ou=people,dc=example,dc=org`, or the UPN
for a template like `{user}@corp.example`. Profiles with a fixed `bindDN`
do not show this line. Two people signed in to the same profile from two
browsers each have their own connection: one's disconnect or wrong password
does not touch the other's.

With `identityUser`, the username is tied to the user an authenticating
proxy verified. With oauth2-proxy in front of ldapui, as under [Logs and
accountability](#logs-and-accountability):

```yaml
connections:
  - name: corp-ad
    url: ldaps://dc1.corp.example:636
    baseDN: dc=corp,dc=example
    bindDNTemplate: "{user}@corp.example"
    identityUser: localpart
```

```sh
ldapui --config connections.yaml \
  --identity-header X-Auth-Request-Email --trusted-proxies 10.244.0.0/16
```

Someone signed in to oauth2-proxy as `alice@corp.example` can connect to
`corp-ad` only as `alice` (or `Alice`: the comparison ignores case, and the
bind uses the username as typed), and the connect dialog fills that in. The
password is still the directory's: the proxy decides who may sign in, the
directory checks the password. A request without the header, or from an
address outside `--trusted-proxies`, cannot connect to the profile. Every
later request on that connection must carry the same identity: one with
another identity or with none, for example from a shared browser after the
proxy sign-in changed to someone else, closes the connection, and the UI
asks to connect again.

| Code | Status | When | The connect dialog says |
|---|---|---|---|
| `username_required` | 400 | no username | Enter your username. |
| `identity_required` | 403 | `identityUser` is set and the request carries no trusted identity | Open ldapui through its sign-in proxy to use this connection. |
| `identity_mismatch` | 403 | the username is not the one the identity maps to | Use the username you signed in to the proxy with. |
| `invalid_username` | 400 | the username does not match the pattern above | A username has only letters, digits, ".", "_" and "-", starts with a letter or digit and is at most 64 characters long. |
| `password_required` | 400 | no password | this profile needs a password |
| `too_many_attempts` | 429 | five wrong passwords for this DN in 60 seconds, counting connects to this DN that are still under way; `Retry-After` gives the seconds to wait | Too many failed sign-ins for this account. Wait a minute and try again. |

The password a person typed stays in the server's memory, with their
connection, so that ldapui can reconnect after a dropped connection without
asking again. It is forgotten at disconnect, when the session expires after
`--session-idle` without use, or `--session-max-age` after that connection
was connected. If the directory stops accepting it (changed or reset),
ldapui closes the connection at the next reconnect instead of retrying, and
asks to sign in again.

### Behind a reverse proxy

Set up the proxy and ldapui together:

- **A token**, from `LDAPUI_AUTH_TOKEN_FILE` or `LDAPUI_AUTH_TOKEN`.
  `--allowed-hosts` makes ldapui generate one, but a new one at every
  restart. Without `--allowed-hosts`, a proxy that forwards `Host:
  localhost` or `127.0.0.1` to a loopback listener looks like a local
  browser, which needs no token.
- **The Host header**: set `--allowed-hosts` to the host name users open,
  and have the proxy pass the browser's `Host` on (nginx: `proxy_set_header
  Host $host`; Traefik and ingress-nginx do so by default). Any other Host
  gets 403 `host_not_allowed`.
- **`--secure-cookies`** when the proxy terminates TLS. ldapui does not
  trust `X-Forwarded-Proto`, which any client that reaches it directly could
  send, so without the flag its cookies lack `Secure` although the browser
  uses HTTPS.
- **Body size and read timeout**: Apply, New child and Clone send up to
  8 MiB, and an Apply may run 4 minutes; ldapui cuts off any request after
  5 minutes. nginx and ingress-nginx allow 1 MiB and wait 60 seconds by default: a
  bigger body gets 413, and a longer Apply gets 504 from the proxy. When the
  proxy closes the connection, ldapui stops before the next entry, so some
  entries are written and the browser does not learn which.
- **`Origin` and `Sec-Fetch-Site`** reach ldapui as the browser sent them.
  Its cross-origin check reads them, and a proxy that clears or rewrites
  them turns the check off.
- **A sub-path**: run ldapui with `--base-path /ldap` and keep the prefix at
  the proxy: no `rewrite-target` (ingress-nginx), `StripPrefix` (Traefik)
  or URI after the address in `proxy_pass` (nginx). A prefix that only one
  side knows serves a blank page.
- **Only the app**: the probes `/healthz` and `/readyz` skip the token and
  the Host check, for the kubelet. The nginx and Traefik examples do not
  route them; an Ingress cannot leave a path out, and through it they tell
  only that an ldapui runs there (they answer `ok`).
- **Only through the proxy**: listen on loopback
  (`LDAPUI_LISTEN=127.0.0.1:8080`) with the proxy on the same host, or let
  only the ingress controller in with a NetworkPolicy (see
  [Kubernetes](#kubernetes)). Otherwise a client that reaches the port
  skips the proxy and what it checks, such as a single sign-on.
- **The login link** (`/?token=...`) is meant for a local quick start:
  through a proxy, the token lands in the proxy's access log, and it does
  not expire. Before you give people the link, keep the query string out of
  the access log (the nginx example does), or have an authenticating proxy
  add `Authorization: Bearer <token>` to the requests it lets through, so
  that nobody handles the token. With a token set, ldapui prints no link.

nginx, terminating TLS, with ldapui on `127.0.0.1:8080`
(`LDAPUI_ALLOWED_HOSTS=ldapui.corp.example`, `LDAPUI_SECURE_COOKIES=true`
and a token):

```nginx
# The query string holds the login token, DNs and filters: log the path only.
log_format ldapui '$remote_addr - [$time_local] "$request_method $uri $server_protocol" '
                  '$status $body_bytes_sent';

server {
    listen 443 ssl;
    server_name ldapui.corp.example;
    ssl_certificate     /etc/ssl/ldapui.pem;
    ssl_certificate_key /etc/ssl/ldapui.key;
    access_log /var/log/nginx/ldapui.log ldapui;

    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:8080;   # no URI after the address: keeps the path
        proxy_set_header Host $host;        # not the default $proxy_host
        proxy_read_timeout 300s;
        # Leave Origin and Sec-Fetch-Site alone, and do not cache.
    }
    location ~ ^/(healthz|readyz)$ {
        return 404;
    }
}
```

Traefik (file provider) keeps the Host header and sets no body size limit
or backend timeout by default:

```yaml
http:
  routers:
    ldapui:
      rule: "Host(`ldapui.corp.example`) && !Path(`/healthz`) && !Path(`/readyz`)"
      entryPoints: [websecure]
      service: ldapui
      tls: {}
  services:
    ldapui:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8080"
```

For a sub-path, match `PathPrefix(`/ldap`)` without a `StripPrefix`
middleware and run ldapui with `--base-path /ldap`.

ingress-nginx, for the Service in [Kubernetes](#kubernetes):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ldapui
  namespace: ldapui
  annotations:
    # Apply, New child and Clone send up to 8 MiB; the default is 1m.
    nginx.ingress.kubernetes.io/proxy-body-size: 8m
    # An Apply may run 4 minutes; the default is 60 seconds.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    # No rewrite-target. For a sub-path, set LDAPUI_BASE_PATH to it.
spec:
  ingressClassName: nginx
  tls:
    - hosts: [ldapui.corp.example]
      secretName: ldapui-tls
  rules:
    - host: ldapui.corp.example
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: {name: ldapui, port: {name: http}}
```

### Kubernetes

The manifest below runs ldapui under the `restricted` Pod Security Standard
(`runAsNonRoot`, `readOnlyRootFilesystem`, all capabilities dropped,
`seccompProfile: RuntimeDefault`), with the token and a bind password in a
Secret, `connections.yaml` and the directory's CA in a ConfigMap, a PVC for
UI-saved profiles, and a NetworkPolicy that lets in only the ingress
controller (ingress-nginx here: adjust the labels to yours). For fixed
profiles only, uncomment `LDAPUI_DATA_DIR` and drop the PVC, the `data`
volume and its mount. Pin the image by digest in production.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ldapui
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
---
# The placeholders fail closed: ldapui does not start until auth-token holds
# a real token. Better, create the Secret with
#   kubectl -n ldapui create secret generic ldapui \
#     --from-literal=auth-token="$(openssl rand -hex 32)" \
#     --from-file=corp-ad=./corp-ad.password
apiVersion: v1
kind: Secret
metadata:
  name: ldapui
  namespace: ldapui
type: Opaque
stringData:
  auth-token: "<openssl rand -hex 32>"
  corp-ad: "<bind password of cn=reader>"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ldapui-connections
  namespace: ldapui
data:
  connections.yaml: |
    connections:
      - name: corp-ad
        url: ldaps://dc1.corp.example:636
        baseDN: dc=corp,dc=example
        bindDN: cn=reader,ou=svc,dc=corp,dc=example
        # Read at every connect: a rotated Secret is used without a restart.
        passwordFile: /etc/ldapui/secrets/corp-ad
        caFile: /etc/ldapui/config/corp-ca.pem
        environment: prod
  corp-ca.pem: |
    -----BEGIN CERTIFICATE-----
    (the directory's CA certificate)
    -----END CERTIFICATE-----
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ldapui-data
  namespace: ldapui
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ldapui
  namespace: ldapui
spec:
  # Sessions live in memory and the data dir has one writer: one replica,
  # and Recreate, so that two pods never run at once.
  replicas: 1
  strategy:
    type: Recreate
  revisionHistoryLimit: 3
  selector:
    matchLabels: {app.kubernetes.io/name: ldapui}
  template:
    metadata:
      labels: {app.kubernetes.io/name: ldapui}
      annotations:
        # connections.yaml and the token are read at startup: bump this (or
        # use a Kustomize configMapGenerator or a Helm checksum) to roll out
        # a change.
        ldapui/config-revision: "1"
    spec:
      automountServiceAccountToken: false
      enableServiceLinks: false
      # ldapui waits up to 25 s for running requests after SIGTERM.
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        # Makes a root-owned volume (EBS, PD, Azure Disk) writable for 65532.
        fsGroup: 65532
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: ldapui
          image: ghcr.io/cicdteam/ldap-ui:<version>
          args: [--config=/etc/ldapui/config/connections.yaml]
          env:
            - {name: LDAPUI_AUTH_TOKEN_FILE, value: /etc/ldapui/secrets/auth-token}
            # The host name users open; ldapui answers 403 to any other Host.
            - {name: LDAPUI_ALLOWED_HOSTS, value: ldapui.corp.example}
            - {name: LDAPUI_SECURE_COOKIES, value: "true"}
            # About 80% of the memory limit: Go does not read the limit.
            - {name: GOMEMLIMIT, value: 400MiB}
            # Fixed profiles only: uncomment this, and drop the PVC and the
            # data volume and its mount.
            # - {name: LDAPUI_DATA_DIR, value: ""}
          ports:
            - {name: http, containerPort: 8080}
          readinessProbe:
            httpGet: {path: /readyz, port: http}
            periodSeconds: 10
          livenessProbe:
            httpGet: {path: /healthz, port: http}
            periodSeconds: 20
            failureThreshold: 3
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {memory: 512Mi}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
          volumeMounts:
            # Directories, not subPath: a subPath file never sees an update.
            - {name: config, mountPath: /etc/ldapui/config, readOnly: true}
            - {name: secrets, mountPath: /etc/ldapui/secrets, readOnly: true}
            - {name: data, mountPath: /data}
      volumes:
        - name: config
          configMap: {name: ldapui-connections}
        - name: secrets
          # 0440 is enough: fsGroup gives the group read access.
          secret: {secretName: ldapui, defaultMode: 0440}
        - name: data
          persistentVolumeClaim: {claimName: ldapui-data}
---
# Only the ingress controller reaches ldapui. The kubelet's probes come from
# the node, which a NetworkPolicy does not block.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ldapui
  namespace: ldapui
spec:
  podSelector:
    matchLabels: {app.kubernetes.io/name: ldapui}
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: ingress-nginx}
          podSelector:
            matchLabels: {app.kubernetes.io/name: ingress-nginx}
      ports:
        - {protocol: TCP, port: http}
---
apiVersion: v1
kind: Service
metadata:
  name: ldapui
  namespace: ldapui
spec:
  selector: {app.kubernetes.io/name: ldapui}
  ports:
    - {name: http, port: 80, targetPort: http}
```

### systemd

On a Linux server, run ldapui as a service on loopback behind a reverse
proxy on the same host, such as the nginx example above. The binary is
static: `make build` builds `bin/ldapui`, or copy `/ldapui` out of the
image. The unit runs it as a dynamic user in a sandbox, with saved
connections in `/var/lib/ldapui` (0700); for fixed profiles only, change
its `LDAPUI_DATA_DIR` line to `Environment=LDAPUI_DATA_DIR=`.

```ini
# /etc/systemd/system/ldapui.service
# Setup:
#   install -m 0755 ldapui /usr/local/bin/ldapui
#   groupadd --system ldapui-secrets
#   install -d -m 0755 /etc/ldapui
#   install -m 0644 connections.yaml /etc/ldapui/      # no secrets in it
#   install -m 0600 ldapui.env /etc/ldapui/            # root only; systemd reads it
#   install -d -m 0750 -g ldapui-secrets /etc/ldapui/secrets
#   install -m 0640 -g ldapui-secrets corp-ad /etc/ldapui/secrets/   # passwordFile
[Unit]
Description=ldapui, a web UI for LDAP directories
Documentation=https://github.com/cicdteam/ldap-ui
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/ldapui --config=/etc/ldapui/connections.yaml
Environment=LDAPUI_LISTEN=127.0.0.1:8080
Environment=LDAPUI_DATA_DIR=%S/ldapui
Environment=LDAPUI_SECURE_COOKIES=true
# About 80% of MemoryMax: the Go runtime does not read MemoryMax by itself.
Environment=GOMEMLIMIT=400MiB
# LDAPUI_AUTH_TOKEN, LDAPUI_ALLOWED_HOSTS and the passwordEnv variables.
EnvironmentFile=/etc/ldapui/ldapui.env
# Lets the service read the passwordFile files under /etc/ldapui/secrets.
SupplementaryGroups=ldapui-secrets

DynamicUser=yes
StateDirectory=ldapui
StateDirectoryMode=0700
UMask=0077
Restart=on-failure
RestartSec=2s
# ldapui waits up to 25 s for running requests after SIGTERM.
TimeoutStopSec=30s
MemoryMax=512M
TasksMax=256
# Set here: the syscall filter below stops Go from raising the soft limit.
LimitNOFILE=8192

NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateUsers=yes
PrivateIPC=yes
ProtectHostname=yes
ProtectClock=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RemoveIPC=yes
DevicePolicy=closed
KeyringMode=private
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
```

`/etc/ldapui/ldapui.env` (root, 0600):

```sh
LDAPUI_AUTH_TOKEN=<openssl rand -hex 32>
LDAPUI_ALLOWED_HOSTS=ldapui.corp.example
```

Without the token, ldapui generates one at every start, and journald keeps
the login link. Passwords for `passwordFile` profiles go in
`/etc/ldapui/secrets/` (`root:ldapui-secrets`, 0640).

## Operations

- **Logs** go to stdout, one `key=value` line per event (see [Logs and
  accountability](#logs-and-accountability)): `kubectl -n ldapui logs
  deploy/ldapui`, or `journalctl -u ldapui` for the systemd unit. A startup
  error is one line on stderr that starts with `ldapui:`, and the process
  exits with status 1; for a pod in CrashLoopBackOff, add `--previous` to
  `kubectl logs`.
- **A broken `profiles.json`** is moved to `profiles.json.bad` next to it
  (`/data` in the image, `/var/lib/ldapui` with the unit), and ldapui starts
  without saved profiles and logs `profiles file was invalid and was moved
  aside` with its `path` and `error`. The next broken file replaces it. To
  put a fixed copy back, stop ldapui first, because it rewrites the file
  from its own list at the next save. In Kubernetes: scale the Deployment to
  0, mount the PVC in a helper pod with the same `securityContext` (on the
  same node for a ReadWriteOnce volume), copy the file in with `kubectl cp`,
  delete the helper and scale back to 1.
- **Debugging** the image, which has no shell: attach a debug container
  that runs as the app's user. `--custom` sets that user even when the pod
  sets none, because the `restricted` policy refuses busybox's root.

  ```sh
  echo '{"securityContext":{"runAsUser":65532,"runAsGroup":65532}}' > debug.json
  kubectl -n ldapui debug -it <pod> --profile=restricted --target=ldapui \
    --image=busybox --custom=debug.json
  ```

  The app's files are under `/proc/1/root/` there, for example
  `/proc/1/root/data/profiles.json.bad`.

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
